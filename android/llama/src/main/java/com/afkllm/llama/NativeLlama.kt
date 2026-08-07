package com.afkllm.llama

fun interface TokenCallback {
    fun onToken(piece: String)
}

/**
 * JNI bridge to libafkllm_llama.so.
 * Default native build is a stub; enable real llama.cpp via CMake AFKLLM_WITH_LLAMA.
 */
object NativeLlama {
    @Volatile
    private var loadedLibrary = false

    @Volatile
    var libraryError: String? = null
        private set

    init {
        try {
            System.loadLibrary("afkllm_llama")
            loadedLibrary = true
        } catch (t: Throwable) {
            libraryError = t.message
            loadedLibrary = false
        }
    }

    fun isLibraryLoaded(): Boolean = loadedLibrary

    external fun nativeAvailable(): Boolean
    external fun nativeLoad(path: String): String
    external fun nativeUnload()
    external fun nativeIsLoaded(): Boolean
    external fun nativeCancel()
    external fun nativeComplete(
        prompt: String,
        temperature: Float,
        topP: Float,
        maxTokens: Int,
        callback: TokenCallback
    ): String
}
