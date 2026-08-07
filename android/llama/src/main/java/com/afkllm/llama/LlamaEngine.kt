package com.afkllm.llama

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.coroutines.coroutineContext

data class ChatTurn(val role: String, val content: String)

data class SamplingParams(
    val temperature: Float = 0.7f,
    val topP: Float = 0.95f,
    val maxTokens: Int = 128,
    val think: Boolean = false
)

interface LlamaEngine {
    val isNativeBackend: Boolean
    val isLoaded: Boolean
    val modelPath: String?
    /** true when linked with real llama.cpp (not stub). */
    val hasRealLlama: Boolean
    suspend fun load(path: String): Result<Unit>
    suspend fun unload()
    fun complete(messages: List<ChatTurn>, params: SamplingParams): Flow<String>
    fun cancel()
}

class NativeLlamaEngine : LlamaEngine {
    @Volatile
    private var path: String? = null

    override val isNativeBackend: Boolean
        get() = NativeLlama.isLibraryLoaded()

    override val hasRealLlama: Boolean
        get() = NativeLlama.isLibraryLoaded() && NativeLlama.nativeAvailable()

    override val isLoaded: Boolean
        get() = NativeLlama.isLibraryLoaded() && NativeLlama.nativeIsLoaded()

    override val modelPath: String?
        get() = path

    override suspend fun load(path: String): Result<Unit> = withContext(Dispatchers.IO) {
        if (!NativeLlama.isLibraryLoaded()) {
            return@withContext Result.failure(
                IllegalStateException(NativeLlama.libraryError ?: "libafkllm_llama not loaded")
            )
        }
        val status = NativeLlama.nativeLoad(path)
        if (status.startsWith("ok")) {
            this@NativeLlamaEngine.path = path
            Result.success(Unit)
        } else {
            Result.failure(IllegalStateException(status))
        }
    }

    override suspend fun unload() = withContext(Dispatchers.IO) {
        if (NativeLlama.isLibraryLoaded()) NativeLlama.nativeUnload()
        path = null
    }

    override fun cancel() {
        if (NativeLlama.isLibraryLoaded()) NativeLlama.nativeCancel()
    }

    override fun complete(messages: List<ChatTurn>, params: SamplingParams): Flow<String> = flow {
        if (!isLoaded) {
            emit("Model not loaded. Open Settings → Model → Load.")
            return@flow
        }
        if (!hasRealLlama) {
            emit("Native stub only (no llama.cpp). Rebuild with third_party/llama.cpp.")
            return@flow
        }

        val prompt = buildPrompt(messages, params.think)
        val maxTok = params.maxTokens.coerceIn(16, 256)
        val queue = ConcurrentLinkedQueue<String>()
        val done = AtomicBoolean(false)
        val error = AtomicReference<String?>(null)

        // Status markers must never be appended to the answer.
        emit("${STATUS_PROGRESS}Evaluating…")

        val worker = thread(name = "afkllm-gen", isDaemon = true) {
            try {
                val status = NativeLlama.nativeComplete(
                    prompt,
                    params.temperature,
                    params.topP,
                    maxTok,
                    TokenCallback { piece -> queue.offer(piece) }
                )
                when {
                    status.startsWith("tokenize") ||
                        status.startsWith("decode") ||
                        status.startsWith("prompt") ||
                        status.startsWith("failed") ||
                        status.startsWith("empty") -> error.set(status)
                }
            } catch (t: Throwable) {
                error.set(t.message ?: "native crash")
            } finally {
                done.set(true)
            }
        }

        val started = System.currentTimeMillis()
        val timeoutMs = 180_000L
        var emittedTokens = false

        while (coroutineContext.isActive) {
            var piece = queue.poll()
            while (piece != null) {
                when {
                    piece.startsWith(STATUS_PROGRESS) ||
                        piece.startsWith(LEGACY_PROGRESS) -> {
                        val msg = piece
                            .removePrefix(STATUS_PROGRESS)
                            .removePrefix(LEGACY_PROGRESS)
                        emit("$STATUS_PROGRESS$msg")
                    }
                    piece.startsWith(STATUS_CLEAR) ||
                        piece.startsWith(LEGACY_CLEAR) ||
                        piece == "CLEAR:" ||
                        piece.endsWith("CLEAR:") && piece.length <= 8 -> {
                        emit(STATUS_CLEAR)
                    }
                    else -> {
                        if (!emittedTokens) {
                            emit(STATUS_CLEAR)
                            emittedTokens = true
                        }
                        emit(piece)
                    }
                }
                piece = queue.poll()
            }
            if (done.get() && queue.isEmpty()) break
            if (System.currentTimeMillis() - started > timeoutMs) {
                NativeLlama.nativeCancel()
                emit(STATUS_CLEAR)
                emit("\n\n[timeout — Stop and try a shorter message]")
                break
            }
            delay(40)
        }

        worker.join(3_000)
        if (worker.isAlive) {
            NativeLlama.nativeCancel()
        }
        error.get()?.let {
            emit(STATUS_CLEAR)
            emit("\n\n[$it]")
        }
        if (!emittedTokens && error.get() == null && coroutineContext.isActive) {
            emit(STATUS_CLEAR)
            emit("\n\n[no tokens — model may be incompatible or OOM]")
        }
    }.flowOn(Dispatchers.Default)

    companion object {
        const val STATUS_PROGRESS = "<<<PROGRESS>>>"
        const val STATUS_CLEAR = "<<<CLEAR>>>"
        private const val LEGACY_PROGRESS = "\u0001PROGRESS:"
        private const val LEGACY_CLEAR = "\u0001CLEAR:"
    }
}

class DemoLlamaEngine : LlamaEngine {
    @Volatile
    private var path: String? = null

    @Volatile
    private var cancelFlag = false

    override val isNativeBackend: Boolean = false
    override val hasRealLlama: Boolean = false
    override val isLoaded: Boolean get() = path != null
    override val modelPath: String? get() = path

    override suspend fun load(path: String): Result<Unit> {
        this.path = path
        return Result.success(Unit)
    }

    override suspend fun unload() {
        path = null
    }

    override fun cancel() {
        cancelFlag = true
    }

    override fun complete(messages: List<ChatTurn>, params: SamplingParams): Flow<String> = flow {
        cancelFlag = false
        val last = messages.lastOrNull { it.role == "user" }?.content ?: ""
        emit("Demo engine (no native llama). Last message:\n$last")
    }.flowOn(Dispatchers.Default)
}

fun createLlamaEngine(): LlamaEngine {
    return if (NativeLlama.isLibraryLoaded()) NativeLlamaEngine() else DemoLlamaEngine()
}

private fun buildPrompt(messages: List<ChatTurn>, think: Boolean): String {
    val sb = StringBuilder()
    // Minimal prompt — faster first token on phone CPU
    if (think) sb.append("Be brief.\n")
    val lastUser = messages.lastOrNull { it.role == "user" }?.content?.take(1500).orEmpty()
    sb.append("User: ").append(lastUser).append("\nAssistant:")
    return sb.toString()
}
