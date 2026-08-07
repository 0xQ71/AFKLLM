package com.afkllm.android

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.afkllm.core.chat.ChatMessage
import com.afkllm.core.chat.ChatRepository
import com.afkllm.core.chat.ChatRole
import com.afkllm.core.chat.ChatSession
import com.afkllm.core.settings.AppSettings
import com.afkllm.core.settings.McpServerConfig
import com.afkllm.core.settings.SettingsPageId
import com.afkllm.core.settings.SettingsStore
import com.afkllm.core.settings.WorkspaceId
import com.afkllm.llama.ChatTurn
import com.afkllm.llama.LlamaEngine
import com.afkllm.llama.NativeLlamaEngine
import com.afkllm.llama.SamplingParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID

data class TreeNode(val name: String, val uri: String, val isDirectory: Boolean)

data class UiState(
    val sessions: List<ChatSession> = emptyList(),
    val activeSessionId: String? = null,
    val draft: String = "",
    val streamingText: String = "",
    val generating: Boolean = false,
    val modelLoaded: Boolean = false,
    val modelPath: String? = null,
    val engineNative: Boolean = false,
    val workspace: WorkspaceId = WorkspaceId.AGENT,
    val settingsPage: SettingsPageId = SettingsPageId.GENERAL,
    val sidePanelOpen: Boolean = false,
    val error: String? = null,
    val treeNodes: List<TreeNode> = emptyList(),
    val openFileUri: String? = null,
    val openFileName: String = "",
    val editorText: String = "",
    val editorDirty: Boolean = false,
    val terminalInput: String = "",
    val terminalOutput: String = "",
    val browserUrl: String = "https://huggingface.co",
    val browserNavigate: String = "https://huggingface.co",
    val gitOutput: String = "",
    val consoleLines: List<String> = emptyList(),
    val showModelStore: Boolean = false,
    val storeQuery: String = "",
    val storeItems: List<com.afkllm.core.hf.HfListItem> = emptyList(),
    val storeLoading: Boolean = false,
    val storeError: String? = null,
    val storeSelectedId: String? = null,
    val storeFiles: List<com.afkllm.core.hf.HfRepoFile> = emptyList(),
    val storeFilePath: String = "",
    val storeDownloading: Boolean = false,
    val storeProgress: Float = 0f,
    val storeProgressLabel: String = ""
)

class MainViewModel(
    private val appContext: Context,
    private val settingsStore: SettingsStore,
    private val chats: ChatRepository,
    private val engine: LlamaEngine
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsStore.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    private val _ui = MutableStateFlow(
        UiState(
            modelLoaded = engine.isLoaded,
            modelPath = engine.modelPath,
            engineNative = engine.isNativeBackend
        )
    )
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var genJob: Job? = null
    private val loadMutex = Mutex()

    init {
        viewModelScope.launch {
            refreshSessions(selectFirst = true)
            Log.i("afkllm", "engine native=${engine.isNativeBackend} realLlama=${engine.hasRealLlama} libErr=${com.afkllm.llama.NativeLlama.libraryError}")
            log("engine: native=${engine.isNativeBackend} llama.cpp=${engine.hasRealLlama}")
            val path = settings.value.modelPath
            if (path.isNotBlank() && File(path).exists()) {
                ensureModelLoaded(path, statusIntoStreaming = false)
            }
        }
    }

    /** Single-flight load with optional UI status. */
    private suspend fun ensureModelLoaded(path: String, statusIntoStreaming: Boolean): Boolean {
        if (engine.isLoaded && engine.modelPath == path) return true
        return loadMutex.withLock {
            if (engine.isLoaded && engine.modelPath == path) return@withLock true
            if (statusIntoStreaming) {
                _ui.update { it.copy(streamingText = "Loading model into RAM…\n(first time can take 1–3 min)") }
            }
            log("Loading model…")
            Log.i("afkllm", "load start $path")
            val result = engine.load(path)
            Log.i("afkllm", "load done success=${result.isSuccess} msg=${result.exceptionOrNull()?.message}")
            _ui.update {
                it.copy(
                    modelLoaded = result.isSuccess && engine.isLoaded,
                    modelPath = engine.modelPath,
                    engineNative = engine.isNativeBackend,
                    error = result.exceptionOrNull()?.message
                )
            }
            if (result.isSuccess) log("Model loaded") else log("Model load failed: ${result.exceptionOrNull()?.message}")
            result.isSuccess
        }
    }

    fun log(line: String) {
        _ui.update { it.copy(consoleLines = (it.consoleLines + line).takeLast(500)) }
    }

    private suspend fun refreshSessions(selectFirst: Boolean) {
        var list = chats.listSessions()
        if (list.isEmpty()) {
            chats.createSession()
            list = chats.listSessions()
        }
        val active = when {
            !selectFirst && _ui.value.activeSessionId != null &&
                list.any { it.id == _ui.value.activeSessionId } -> _ui.value.activeSessionId
            else -> list.firstOrNull()?.id
        }
        _ui.update {
            it.copy(
                sessions = list,
                activeSessionId = active,
                modelLoaded = engine.isLoaded,
                modelPath = engine.modelPath,
                engineNative = engine.isNativeBackend
            )
        }
    }

    fun activeSession(): ChatSession? =
        _ui.value.sessions.find { it.id == _ui.value.activeSessionId }

    fun setWorkspace(id: WorkspaceId) {
        _ui.update { it.copy(workspace = id) }
        if (id == WorkspaceId.GIT) refreshGit()
        if (id == WorkspaceId.EXPLORER) {
            val root = settings.value.workspaceRootUri
            if (root.isNotBlank()) loadTree(root)
        }
    }

    fun setSidePanelOpen(open: Boolean) {
        _ui.update { it.copy(sidePanelOpen = open) }
    }

    fun setSettingsPage(page: SettingsPageId) {
        _ui.update { it.copy(settingsPage = page) }
    }

    fun toggleSidePanel() {
        _ui.update { it.copy(sidePanelOpen = !it.sidePanelOpen) }
    }

    fun selectSession(id: String) {
        _ui.update { it.copy(activeSessionId = id, draft = "", streamingText = "", error = null) }
    }

    fun newChat() {
        viewModelScope.launch {
            val s = chats.createSession()
            refreshSessions(selectFirst = false)
            _ui.update { it.copy(activeSessionId = s.id, draft = "", streamingText = "") }
            log("New chat ${s.id.take(8)}")
        }
    }

    fun setDraft(text: String) {
        _ui.update { it.copy(draft = text) }
    }

    fun updateSettings(block: (AppSettings) -> AppSettings) {
        viewModelScope.launch { settingsStore.update(block) }
    }

    fun setModelPath(path: String) {
        viewModelScope.launch {
            settingsStore.update { it.copy(modelPath = path) }
            log("Model path set")
        }
    }

    fun setWorkspaceRoot(uri: String) {
        viewModelScope.launch {
            settingsStore.update { s ->
                val roots = (listOf(uri) + s.recentRoots).distinct().take(12)
                s.copy(workspaceRootUri = uri, recentRoots = roots)
            }
            loadTree(uri)
            log("Workspace opened")
        }
    }

    fun loadTree(uriString: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val doc = DocumentFile.fromTreeUri(appContext, Uri.parse(uriString))
            val nodes = doc?.listFiles()?.map {
                TreeNode(it.name ?: "?", it.uri.toString(), it.isDirectory)
            }?.sortedWith(compareByDescending<TreeNode> { it.isDirectory }.thenBy { it.name.lowercase() })
                ?: emptyList()
            _ui.update { it.copy(treeNodes = nodes) }
        }
    }

    fun openTreeChild(node: TreeNode) {
        if (node.isDirectory) {
            viewModelScope.launch(Dispatchers.IO) {
                val doc = DocumentFile.fromSingleUri(appContext, Uri.parse(node.uri))
                val nodes = doc?.listFiles()?.map {
                    TreeNode(it.name ?: "?", it.uri.toString(), it.isDirectory)
                }?.sortedWith(compareByDescending<TreeNode> { it.isDirectory }.thenBy { it.name.lowercase() })
                    ?: emptyList()
                _ui.update { it.copy(treeNodes = nodes) }
            }
        } else {
            openEditor(node.uri, node.name)
            setWorkspace(WorkspaceId.CODE)
        }
    }

    fun openEditor(uri: String, name: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val text = runCatching {
                appContext.contentResolver.openInputStream(Uri.parse(uri))?.bufferedReader()?.use { it.readText() }
                    ?: ""
            }.getOrDefault("")
            _ui.update {
                it.copy(
                    openFileUri = uri,
                    openFileName = name,
                    editorText = text,
                    editorDirty = false,
                    workspace = WorkspaceId.CODE
                )
            }
            log("Opened $name")
        }
    }

    fun setEditorText(text: String) {
        _ui.update { it.copy(editorText = text, editorDirty = true) }
    }

    fun saveEditor() {
        val uri = _ui.value.openFileUri ?: return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                appContext.contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { out ->
                    out.write(_ui.value.editorText.toByteArray())
                }
            }
            _ui.update { it.copy(editorDirty = false) }
            log("Saved ${_ui.value.openFileName}")
        }
    }

    fun setTerminalInput(text: String) {
        _ui.update { it.copy(terminalInput = text) }
    }

    fun runTerminal() {
        val cmd = _ui.value.terminalInput.trim()
        if (cmd.isEmpty()) return
        viewModelScope.launch {
            _ui.update {
                it.copy(
                    terminalOutput = it.terminalOutput + "\n$ $cmd\n",
                    terminalInput = ""
                )
            }
            val out = withContext(Dispatchers.IO) { execShell(cmd) }
            _ui.update { it.copy(terminalOutput = it.terminalOutput + out + "\n") }
            log("terminal: $cmd")
        }
    }

    fun setBrowserUrl(url: String) {
        _ui.update { it.copy(browserUrl = url) }
    }

    fun navigateBrowser() {
        var url = _ui.value.browserUrl.trim()
        if (url.isEmpty()) return
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://$url"
        }
        _ui.update { it.copy(browserUrl = url, browserNavigate = url) }
        log("browser → $url")
    }

    fun refreshGit() {
        viewModelScope.launch {
            val out = withContext(Dispatchers.IO) {
                val root = settings.value.workspaceRootUri
                if (root.isBlank()) return@withContext "(no workspace root)"
                // Best-effort: try app filesDir git if user cloned there; otherwise show status hint
                val cwd = File(appContext.filesDir, "workspace")
                if (!cwd.exists()) cwd.mkdirs()
                val status = execShell("sh -c 'cd \"${cwd.absolutePath}\" && git status 2>&1 || echo NO_GIT'")
                "Workspace SAF: $root\nLocal sandbox: ${cwd.absolutePath}\n\n$status"
            }
            _ui.update { it.copy(gitOutput = out) }
        }
    }

    fun clearConsole() {
        _ui.update { it.copy(consoleLines = emptyList()) }
    }

    fun addMcpServer() {
        updateSettings { s ->
            s.copy(
                mcpServers = s.mcpServers + McpServerConfig(
                    id = UUID.randomUUID().toString(),
                    name = "mcp-server",
                    command = "npx",
                    args = "-y @modelcontextprotocol/server-filesystem ."
                )
            )
        }
    }

    fun removeMcpServer(id: String) {
        updateSettings { s -> s.copy(mcpServers = s.mcpServers.filterNot { it.id == id }) }
    }

    fun updateMcpServer(id: String, transform: (McpServerConfig) -> McpServerConfig) {
        updateSettings { s ->
            s.copy(mcpServers = s.mcpServers.map { if (it.id == id) transform(it) else it })
        }
    }

    private fun execShell(cmd: String): String = try {
        val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", cmd))
        val stdout = BufferedReader(InputStreamReader(p.inputStream)).readText()
        val stderr = BufferedReader(InputStreamReader(p.errorStream)).readText()
        p.waitFor()
        (stdout + stderr).ifBlank { "(exit ${p.exitValue()})" }
    } catch (t: Throwable) {
        t.message ?: "error"
    }

    fun loadModel() {
        viewModelScope.launch {
            val path = settings.value.modelPath
            if (path.isBlank()) {
                _ui.update { it.copy(error = "No model path") }
                return@launch
            }
            ensureModelLoaded(path, statusIntoStreaming = false)
        }
    }

    fun unloadModel() {
        viewModelScope.launch {
            engine.unload()
            _ui.update { it.copy(modelLoaded = false, modelPath = null, error = null) }
            log("Model unloaded")
        }
    }

    fun stop() {
        engine.cancel()
        genJob?.cancel()
        _ui.update { it.copy(generating = false) }
    }

    fun send() {
        val text = _ui.value.draft.trim()
        if (text.isEmpty() || _ui.value.generating) return
        val sessionId = _ui.value.activeSessionId ?: return
        val s = settings.value

        viewModelScope.launch {
            var session = chats.getSession(sessionId) ?: return@launch
            val userContent = if (s.agentPlanMode) {
                "[PLAN MODE — draft a plan only, do not execute tools]\n\n$text"
            } else text
            val userMsg = ChatMessage(role = ChatRole.USER, content = userContent)
            session = session.copy(
                messages = session.messages + userMsg,
                title = if (session.messages.isEmpty()) text.take(42) else session.title
            )
            chats.upsertSession(session)
            _ui.update {
                it.copy(
                    draft = "",
                    generating = true,
                    streamingText = "Starting…",
                    error = null,
                    sessions = chats.listSessions()
                )
            }

            if (!engine.isLoaded && s.modelPath.isNotBlank()) {
                val ok = ensureModelLoaded(s.modelPath, statusIntoStreaming = true)
                if (!ok) {
                    _ui.update {
                        it.copy(generating = false, error = "model", streamingText = "")
                    }
                    return@launch
                }
            }
            if (!engine.isLoaded) {
                _ui.update {
                    it.copy(
                        generating = false,
                        error = "model",
                        streamingText = "",
                        sessions = chats.listSessions()
                    )
                }
                return@launch
            }

            // Keep turns tiny on mobile — only last user (+ optional short system)
            val turns = buildList {
                if (s.systemPrompt.isNotBlank()) {
                    add(ChatTurn("system", s.systemPrompt.take(500)))
                }
                add(ChatTurn("user", userContent.take(1500)))
            }
            val maxTok = when {
                s.limitResponseLength -> s.maxTokens.coerceIn(16, 256)
                else -> 96
            }
            val params = SamplingParams(
                temperature = s.temperature,
                topP = if (s.topPEnabled) s.topP else 0.95f,
                maxTokens = maxTok,
                think = s.agentThinkThrough
            )

            genJob = viewModelScope.launch {
                val acc = StringBuilder()
                try {
                    engine.complete(turns, params).collect { piece ->
                        when {
                            piece.startsWith(NativeLlamaEngine.STATUS_PROGRESS) -> {
                                val status = piece.removePrefix(NativeLlamaEngine.STATUS_PROGRESS)
                                // Status replaces bubble text; never enters the saved answer.
                                _ui.update { it.copy(streamingText = status) }
                            }
                            piece.startsWith(NativeLlamaEngine.STATUS_CLEAR) ||
                                piece.startsWith("\u0001CLEAR:") ||
                                piece == "CLEAR:" -> {
                                acc.clear()
                                _ui.update { it.copy(streamingText = "") }
                            }
                            else -> {
                                acc.append(piece)
                                _ui.update { it.copy(streamingText = acc.toString()) }
                            }
                        }
                    }
                    val finalText = acc.toString().ifBlank { "(no output)" }
                    val assistant = ChatMessage(role = ChatRole.ASSISTANT, content = finalText)
                    val latest = chats.getSession(sessionId) ?: session
                    chats.upsertSession(latest.copy(messages = latest.messages + assistant))
                    _ui.update {
                        it.copy(
                            generating = false,
                            streamingText = "",
                            sessions = chats.listSessions()
                        )
                    }
                } catch (t: Throwable) {
                    _ui.update {
                        it.copy(generating = false, error = t.message, streamingText = "")
                    }
                    log("gen error: ${t.message}")
                }
            }
        }
    }

    fun openModelStore(open: Boolean) {
        _ui.update { it.copy(showModelStore = open) }
        if (open) refreshStoreHome()
    }

    fun setStoreQuery(q: String) {
        _ui.update { it.copy(storeQuery = q) }
    }

    fun refreshStoreHome() {
        viewModelScope.launch {
            _ui.update { it.copy(storeLoading = true, storeError = null) }
            try {
                val ru = settings.value.uiLanguage.id == "ru"
                val q = _ui.value.storeQuery.trim()
                val local = com.afkllm.core.hf.LocalModels.listGgufs(
                    File(appContext.filesDir, "models")
                )
                val raw = if (q.isEmpty()) {
                    com.afkllm.core.hf.HfHubClient.staffHome(ru)
                } else {
                    com.afkllm.core.hf.HfHubClient.search(q)
                }
                val items = raw.map { com.afkllm.core.hf.LocalModels.annotate(it, local) }
                _ui.update {
                    it.copy(
                        storeItems = items,
                        storeLoading = false,
                        storeSelectedId = it.storeSelectedId ?: items.firstOrNull()?.id
                    )
                }
                val sel = _ui.value.storeSelectedId
                if (sel != null) selectStoreModel(sel)
            } catch (t: Throwable) {
                _ui.update { it.copy(storeLoading = false, storeError = t.message) }
            }
        }
    }

    fun clearStoreSelection() {
        _ui.update {
            it.copy(storeSelectedId = null, storeFiles = emptyList(), storeFilePath = "", storeError = null)
        }
    }

    fun selectStoreModel(id: String) {
        if (id.isBlank()) {
            clearStoreSelection()
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(storeSelectedId = id, storeLoading = true, storeError = null) }
            val local = com.afkllm.core.hf.LocalModels.listGgufs(File(appContext.filesDir, "models"))
            val installed = com.afkllm.core.hf.LocalModels.findInstalled(local, null, id)
            try {
                val files = com.afkllm.core.hf.HfHubClient.listGgufFiles(id)
                val rec = com.afkllm.core.model.HF_RECOMMENDED_MODELS.find { it.repoId == id }
                val preferred = when {
                    installed != null && files.any { it.path.substringAfterLast('/') == installed.name } ->
                        files.first { it.path.substringAfterLast('/') == installed.name }.path
                    installed != null -> installed.name
                    rec?.preferredFile != null && files.any { it.path == rec.preferredFile } -> rec.preferredFile
                    else -> files.firstOrNull()?.path.orEmpty()
                }
                // refresh installed flag on selected card
                _ui.update { state ->
                    state.copy(
                        storeFiles = files,
                        storeFilePath = preferred,
                        storeLoading = false,
                        storeItems = state.storeItems.map {
                            if (it.id == id) com.afkllm.core.hf.LocalModels.annotate(it, local) else it
                        }
                    )
                }
            } catch (t: Throwable) {
                val rec = com.afkllm.core.model.HF_RECOMMENDED_MODELS.find { it.repoId == id }
                _ui.update { state ->
                    state.copy(
                        storeFiles = emptyList(),
                        storeFilePath = installed?.name ?: rec?.preferredFile.orEmpty(),
                        storeLoading = false,
                        storeError = t.message,
                        storeItems = state.storeItems.map {
                            if (it.id == id) com.afkllm.core.hf.LocalModels.annotate(it, local) else it
                        }
                    )
                }
            }
        }
    }

    fun setStoreFilePath(path: String) {
        _ui.update { it.copy(storeFilePath = path) }
    }

    fun downloadStoreModel() {
        val id = _ui.value.storeSelectedId ?: return
        val file = _ui.value.storeFilePath.trim()
        if (file.isEmpty()) return
        viewModelScope.launch {
            _ui.update { it.copy(storeDownloading = true, storeProgress = 0f, storeProgressLabel = "…") }
            try {
                val destDir = File(appContext.filesDir, "models").also { it.mkdirs() }
                val leaf = file.substringAfterLast('/').replace(Regex("[\\\\/]+"), "_")
                val dest = File(destDir, leaf)
                com.afkllm.core.hf.HfHubClient.download(id, file, dest) { frac, recv, total ->
                    _ui.update {
                        it.copy(
                            storeProgress = frac,
                            storeProgressLabel = "${com.afkllm.core.hf.formatBytes(recv)} / ${com.afkllm.core.hf.formatBytes(total)}"
                        )
                    }
                }
                setModelPath(dest.absolutePath)
                _ui.update {
                    it.copy(
                        storeDownloading = false,
                        storeProgress = 1f,
                        storeProgressLabel = "done"
                    )
                }
                log("Downloaded $leaf")
                refreshStoreHome()
                loadModel()
            } catch (t: Throwable) {
                _ui.update {
                    it.copy(storeDownloading = false, storeError = t.message, storeProgressLabel = t.message ?: "error")
                }
                log("download failed: ${t.message}")
            }
        }
    }

    companion object {
        fun factory(app: AfkApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return MainViewModel(
                        app.applicationContext,
                        app.settingsStore,
                        app.chatRepository,
                        app.llamaEngine
                    ) as T
                }
            }
    }
}
