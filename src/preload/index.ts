import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentToolCall,
  AgentToolResult,
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMStreamChunk
} from '../shared/types'
import type { AppSettings, DiscoveredModel, LlmRuntimeStatus } from '../shared/settings'
import type {
  GpuInfo,
  HfDownloadProgress,
  HfModelDetail,
  HfModelListItem,
  HfStoreHomeResult,
  StoreDownloadTarget
} from '../shared/hfStore'
import type {
  ChatSession,
  ChatStoreSnapshot,
  PersistedChatMessage
} from '../shared/chats'
import type {
  AgentCheckpoint,
  CheckpointListItem,
  CheckpointRewindResult
} from '../shared/checkpoints'
import type { McpOpenAiTool, McpServerStatus } from '../shared/mcp'
import type {
  CodebaseQueryResult,
  ContextIndexStatus,
  ProjectRulesSnapshot,
  ProjectStackSnapshot,
  RepoMapSnapshot
} from '../shared/context'
import type {
  GitCommitDetail,
  GitCommitNode,
  GitDiff,
  GitOkResult,
  GitStatus
} from '../shared/git'
import type { WorkspaceSearchResult } from '../shared/workspace'
import type { DiagnosticsSnapshot } from '../shared/diagnostics'
import type { UpdaterCheckResult } from '../shared/updater'
import type {
  LspDefinitionResult,
  LspDocumentSymbolsResult,
  LspHoverResult,
  LspReferencesResult,
  LspStatus
} from '../shared/lsp'
import type {
  DebugBreakpoint,
  DebugEvent,
  DebugSessionStatus,
  DebugStartRequest,
  DebugStartResult
} from '../shared/debug'
import type {
  LlamaRuntimeEnsureOptions,
  LlamaRuntimeProgress,
  LlamaRuntimeStatus
} from '../shared/llamaRuntime'
import type { TelemetryEvent, TelemetryReportResult } from '../shared/telemetry'
import type { ModelSlot, ModelSlotStatus } from '../shared/modelSlots'
import type { SdRuntimeEnsureOptions, SdRuntimeProgress, SdRuntimeStatus } from '../shared/sdRuntime'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),

  updater: {
    check: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke('updater:install'),
    getStatus: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke('updater:status'),
    releaseNotes: (version?: string): Promise<{ version: string; body: string }> =>
      ipcRenderer.invoke('updater:release-notes', version),
    onStatus: (cb: (status: UpdaterCheckResult) => void): (() => void) => {
      const listener = (_: unknown, status: UpdaterCheckResult): void => cb(status)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    }
  },

  telemetry: {
    report: (event: TelemetryEvent): Promise<TelemetryReportResult> =>
      ipcRenderer.invoke('telemetry:report', event),
    openLogDir: (): Promise<{ ok: boolean; path: string; error?: string }> =>
      ipcRenderer.invoke('telemetry:open-log-dir'),
    readLog: (): Promise<{ ok: boolean; path: string; text: string; error?: string }> =>
      ipcRenderer.invoke('telemetry:read-log'),
    clearLog: (): Promise<{ ok: boolean; path: string; error?: string }> =>
      ipcRenderer.invoke('telemetry:clear-log')
  },

  diagnostics: {
    run: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke('diagnostics:run'),
    get: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke('diagnostics:get'),
    onChanged: (cb: (snap: DiagnosticsSnapshot) => void): (() => void) => {
      const listener = (_: unknown, snap: DiagnosticsSnapshot): void => cb(snap)
      ipcRenderer.on('diagnostics:changed', listener)
      return () => ipcRenderer.removeListener('diagnostics:changed', listener)
    }
  },

  lsp: {
    definition: (
      path: string,
      line: number,
      column: number
    ): Promise<LspDefinitionResult> =>
      ipcRenderer.invoke('lsp:definition', path, line, column),
    hover: (
      path: string,
      line: number,
      column: number,
      content?: string
    ): Promise<LspHoverResult> =>
      ipcRenderer.invoke('lsp:hover', path, line, column, content),
    references: (
      path: string,
      line: number,
      column: number
    ): Promise<LspReferencesResult> =>
      ipcRenderer.invoke('lsp:references', path, line, column),
    documentSymbols: (path: string): Promise<LspDocumentSymbolsResult> =>
      ipcRenderer.invoke('lsp:documentSymbols', path),
    status: (): Promise<LspStatus> => ipcRenderer.invoke('lsp:status')
  },

  debug: {
    start: (req: DebugStartRequest): Promise<DebugStartResult> =>
      ipcRenderer.invoke('debug:start', req),
    stop: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:stop'),
    continue: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:continue'),
    stepOver: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:stepOver'),
    stepInto: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:stepInto'),
    stepOut: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:stepOut'),
    status: (): Promise<DebugSessionStatus> => ipcRenderer.invoke('debug:status'),
    setBreakpoints: (bps: DebugBreakpoint[]): Promise<DebugSessionStatus> =>
      ipcRenderer.invoke('debug:setBreakpoints', bps),
    onEvent: (cb: (event: DebugEvent) => void): (() => void) => {
      const listener = (_: unknown, event: DebugEvent): void => cb(event)
      ipcRenderer.on('debug:event', listener)
      return () => ipcRenderer.removeListener('debug:event', listener)
    }
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:save', patch),
    onChanged: (cb: (settings: AppSettings) => void): (() => void) => {
      const listener = (_: unknown, settings: AppSettings): void => cb(settings)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
  },

  chats: {
    get: (): Promise<ChatStoreSnapshot> => ipcRenderer.invoke('chats:get'),
    list: (): Promise<Array<Omit<ChatSession, 'messages'>>> =>
      ipcRenderer.invoke('chats:list'),
    listByRoots: (
      roots: string[]
    ): Promise<Record<string, Array<Omit<ChatSession, 'messages'>>>> =>
      ipcRenderer.invoke('chats:list-by-roots', roots),
    create: (): Promise<ChatStoreSnapshot> => ipcRenderer.invoke('chats:create'),
    setActive: (id: string): Promise<ChatStoreSnapshot> =>
      ipcRenderer.invoke('chats:set-active', id),
    delete: (id: string): Promise<ChatStoreSnapshot> =>
      ipcRenderer.invoke('chats:delete', id),
    /** Wipe chats for removed repo; re-open path = fresh chat. */
    forgetRoot: (root: string): Promise<ChatStoreSnapshot> =>
      ipcRenderer.invoke('chats:forget-root', root),
    updateMessages: (
      id: string,
      messages: PersistedChatMessage[],
      title?: string
    ): Promise<ChatStoreSnapshot> =>
      ipcRenderer.invoke('chats:update-messages', { id, messages, title }),
    onChanged: (cb: (snap: ChatStoreSnapshot) => void): (() => void) => {
      const listener = (_: unknown, snap: ChatStoreSnapshot): void => cb(snap)
      ipcRenderer.on('chats:changed', listener)
      return () => ipcRenderer.removeListener('chats:changed', listener)
    }
  },

  workspace: {
    setRoot: (root: string): Promise<{ ok: boolean; root: string }> =>
      ipcRenderer.invoke('workspace:set-root', root),
    clearRoot: (): Promise<{ ok: boolean; root: null }> =>
      ipcRenderer.invoke('workspace:clear-root'),
    getRoot: (): Promise<string | null> => ipcRenderer.invoke('workspace:get-root'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-folder'),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-file'),
    pickModel: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-model'),
    pickMmproj: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-mmproj'),
    pickImageGenModel: (): Promise<string | null> =>
      ipcRenderer.invoke('workspace:pick-image-gen-model'),
    pickSdCli: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-sd-cli'),
    pickModelsDir: (): Promise<string | null> =>
      ipcRenderer.invoke('workspace:pick-models-dir'),
    list: (dirPath?: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:list', dirPath),
    readFile: (relativePath: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:read-file', relativePath),
    writeFile: (relativePath: string, content: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:write-file', relativePath, content),
    deleteFile: (relativePath: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:delete-file', relativePath),
    createFile: (relativePath: string, content?: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:create-file', relativePath, content),
    createDir: (relativePath: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:create-dir', relativePath),
    rename: (from: string, to: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('workspace:rename', from, to),
    search: (
      query: string,
      opts?: { glob?: string; limit?: number }
    ): Promise<WorkspaceSearchResult> =>
      ipcRenderer.invoke('workspace:search', { query, ...opts }),
    onChanged: (cb: (payload: { paths: string[] }) => void): (() => void) => {
      const listener = (_: unknown, payload: { paths: string[] }): void => cb(payload)
      ipcRenderer.on('workspace:changed', listener)
      return () => ipcRenderer.removeListener('workspace:changed', listener)
    },
    onFileDeleted: (cb: (payload: { path: string }) => void): (() => void) => {
      const listener = (_: unknown, payload: { path: string }): void => cb(payload)
      ipcRenderer.on('workspace:file-deleted', listener)
      return () => ipcRenderer.removeListener('workspace:file-deleted', listener)
    }
  },

  context: {
    repoMap: (): Promise<RepoMapSnapshot> => ipcRenderer.invoke('context:repo-map'),
    codebaseQuery: (query: string): Promise<CodebaseQueryResult> =>
      ipcRenderer.invoke('context:codebase-query', query),
    indexStatus: (): Promise<ContextIndexStatus> =>
      ipcRenderer.invoke('context:index-status'),
    projectRules: (): Promise<ProjectRulesSnapshot> =>
      ipcRenderer.invoke('context:project-rules'),
    stack: (): Promise<ProjectStackSnapshot> =>
      ipcRenderer.invoke('context:stack')
  },

  terminal: {
    create: (cwd?: string): Promise<{ id: string; cwd: string }> =>
      ipcRenderer.invoke('terminal:create', cwd),
    scrollback: (id: string): Promise<{ id: string; data: string }> =>
      ipcRenderer.invoke('terminal:scrollback', id),
    write: (id: string, data: string): void => {
      ipcRenderer.send('terminal:write', { id, data })
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send('terminal:resize', { id, cols, rows })
    },
    kill: (id: string): Promise<{ ok: boolean; kept?: boolean }> =>
      ipcRenderer.invoke('terminal:kill', id),
    /** Stop in-flight agent shell (Ctrl+C + unblock). */
    interrupt: (): Promise<{ ok: boolean; interrupted: boolean }> =>
      ipcRenderer.invoke('terminal:interrupt'),
    onData: (cb: (payload: { id: string; data: string }) => void): (() => void) => {
      const listener = (_: unknown, payload: { id: string; data: string }): void => cb(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    onExit: (cb: (payload: { id: string; exitCode: number }) => void): (() => void) => {
      const listener = (_: unknown, payload: { id: string; exitCode: number }): void =>
        cb(payload)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.removeListener('terminal:exit', listener)
    },
    onEnsureOpen: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('terminal:ensure-open', listener)
      return () => ipcRenderer.removeListener('terminal:ensure-open', listener)
    }
  },

  browser: {
    onOpenUrl: (cb: (url: string) => void): (() => void) => {
      const listener = (_: unknown, payload: { url: string }): void => {
        if (payload?.url) cb(payload.url)
      }
      ipcRenderer.on('browser:open-url', listener)
      return () => ipcRenderer.removeListener('browser:open-url', listener)
    }
  },

  llm: {
    enqueue: (
      request: Omit<LLMCompletionRequest, 'id'> & { id?: string; stream?: boolean }
    ): Promise<LLMCompletionResult> => ipcRenderer.invoke('llm:enqueue', request),
    onStream: (cb: (chunk: LLMStreamChunk) => void): (() => void) => {
      const listener = (_: unknown, chunk: LLMStreamChunk): void => cb(chunk)
      ipcRenderer.on('llm:stream', listener)
      return () => ipcRenderer.removeListener('llm:stream', listener)
    },
    cancelAll: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('llm:cancel-all'),
    status: (): Promise<LlmRuntimeStatus> => ipcRenderer.invoke('llm:status'),
    restart: (): Promise<LlmRuntimeStatus> => ipcRenderer.invoke('llm:restart'),
    unload: (): Promise<LlmRuntimeStatus> => ipcRenderer.invoke('llm:unload'),
    listModels: (): Promise<DiscoveredModel[]> => ipcRenderer.invoke('llm:list-models'),
    listMmproj: (): Promise<DiscoveredModel[]> => ipcRenderer.invoke('llm:list-mmproj')
  },

  slots: {
    status: (): Promise<ModelSlotStatus> => ipcRenderer.invoke('slots:status'),
    ensure: (slot: ModelSlot): Promise<ModelSlotStatus> =>
      ipcRenderer.invoke('slots:ensure', slot),
    onStatus: (cb: (status: ModelSlotStatus) => void): (() => void) => {
      const listener = (_: unknown, status: ModelSlotStatus): void => cb(status)
      ipcRenderer.on('slots:status', listener)
      return () => ipcRenderer.removeListener('slots:status', listener)
    }
  },

  chatImages: {
    import: (payload: {
      sessionId?: string
      sourcePath?: string
      dataBase64?: string
      mime?: string
      name?: string
    }): Promise<{ id: string; path: string; mime: string; name?: string }> =>
      ipcRenderer.invoke('chat-images:import', payload),
    readDataUrl: (absPath: string): Promise<string> =>
      ipcRenderer.invoke('chat-images:read-data-url', absPath),
    pick: (): Promise<string[]> => ipcRenderer.invoke('chat-images:pick')
  },

  chatDocs: {
    import: (payload: {
      sessionId?: string
      sourcePath?: string
      dataBase64?: string
      mime?: string
      name?: string
    }): Promise<{
      id: string
      path: string
      mime: string
      name: string
      kind: 'pdf' | 'docx' | 'doc'
      text: string
      pageCount?: number
      pageImages?: Array<{ id: string; path: string; mime: string; name?: string }>
      note?: string
    }> => ipcRenderer.invoke('chat-docs:import', payload),
    pick: (): Promise<string[]> => ipcRenderer.invoke('chat-docs:pick')
  },

  chatFiles: {
    import: (payload: {
      sessionId?: string
      sourcePath?: string
      dataBase64?: string
      mime?: string
      name?: string
    }): Promise<{
      id: string
      path: string
      mime: string
      name: string
      extLabel: string
      kind: 'image' | 'pdf' | 'docx' | 'text' | 'binary'
      text?: string
      pageImages?: Array<{ id: string; path: string; mime: string; name?: string }>
      note?: string
      image?: { id: string; path: string; mime: string; name?: string }
    }> => ipcRenderer.invoke('chat-files:import', payload),
    pick: (): Promise<string[]> => ipcRenderer.invoke('chat-files:pick'),
    open: (absPath: string): Promise<boolean> => ipcRenderer.invoke('chat-files:open', absPath)
  },

  /** Electron 32+: File.path removed — use this for drag/drop & paste paths */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  sdRuntime: {
    status: (): Promise<SdRuntimeStatus> => ipcRenderer.invoke('sd-runtime:status'),
    check: (): Promise<SdRuntimeStatus> => ipcRenderer.invoke('sd-runtime:check'),
    ensure: (opts?: SdRuntimeEnsureOptions): Promise<SdRuntimeStatus> =>
      ipcRenderer.invoke('sd-runtime:ensure', opts ?? {}),
    progress: (): Promise<SdRuntimeProgress> => ipcRenderer.invoke('sd-runtime:progress'),
    onProgress: (cb: (p: SdRuntimeProgress) => void): (() => void) => {
      const listener = (_: unknown, p: SdRuntimeProgress): void => cb(p)
      ipcRenderer.on('sd-runtime:progress', listener)
      return () => ipcRenderer.removeListener('sd-runtime:progress', listener)
    }
  },

  llamaRuntime: {
    status: (): Promise<LlamaRuntimeStatus> => ipcRenderer.invoke('llama-runtime:status'),
    ensure: (opts?: LlamaRuntimeEnsureOptions): Promise<LlamaRuntimeStatus> =>
      ipcRenderer.invoke('llama-runtime:ensure', opts ?? {}),
    progress: (): Promise<LlamaRuntimeProgress> =>
      ipcRenderer.invoke('llama-runtime:progress'),
    openDir: (): Promise<{ ok: boolean; path: string; error?: string }> =>
      ipcRenderer.invoke('llama-runtime:open-dir'),
    onProgress: (cb: (p: LlamaRuntimeProgress) => void): (() => void) => {
      const listener = (_: unknown, p: LlamaRuntimeProgress): void => cb(p)
      ipcRenderer.on('llama-runtime:progress', listener)
      return () => ipcRenderer.removeListener('llama-runtime:progress', listener)
    }
  },

  hf: {
    search: (params?: {
      query?: string
      limit?: number
      target?: StoreDownloadTarget
    }): Promise<HfModelListItem[]> => ipcRenderer.invoke('hf:search', params ?? {}),
    home: (target?: StoreDownloadTarget): Promise<HfStoreHomeResult> =>
      ipcRenderer.invoke('hf:home', target),
    gpu: (): Promise<GpuInfo | null> => ipcRenderer.invoke('hf:gpu'),
    model: (
      repoId: string,
      preferredFile?: string,
      target?: StoreDownloadTarget
    ): Promise<HfModelDetail> =>
      ipcRenderer.invoke('hf:model', repoId, preferredFile, target),
    download: (input: {
      repoId: string
      filename: string
    }): Promise<HfDownloadProgress> => ipcRenderer.invoke('hf:download', input),
    cancelDownload: (id?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('hf:download-cancel', id),
    pauseDownload: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('hf:download-pause', id),
    resumeDownload: (id: string): Promise<HfDownloadProgress> =>
      ipcRenderer.invoke('hf:download-resume', id),
    listDownloads: (): Promise<HfDownloadProgress[]> =>
      ipcRenderer.invoke('hf:downloads'),
    clearCompletedDownloads: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('hf:downloads-clear'),
    openModelsDir: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('hf:open-models-dir'),
    showInFolder: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('hf:show-in-folder', filePath),
    onDownloadProgress: (cb: (p: HfDownloadProgress) => void): (() => void) => {
      const listener = (_: unknown, p: HfDownloadProgress): void => cb(p)
      ipcRenderer.on('hf:download-progress', listener)
      return () => ipcRenderer.removeListener('hf:download-progress', listener)
    },
    onReadmeLocalized: (
      cb: (payload: {
        id: string
        readmeMarkdown?: string
        done?: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        payload: { id: string; readmeMarkdown?: string; done?: boolean }
      ): void => cb(payload)
      ipcRenderer.on('hf:readme-localized', listener)
      return () => ipcRenderer.removeListener('hf:readme-localized', listener)
    }
  },

  agent: {
    listTools: (): Promise<unknown[]> => ipcRenderer.invoke('agent:list-tools'),
    invoke: (call: AgentToolCall): Promise<AgentToolResult> =>
      ipcRenderer.invoke('agent:invoke', call),
    acceptEdit: (relativePath: string): Promise<{ ok: boolean; path: string }> =>
      ipcRenderer.invoke('agent:accept-edit', relativePath),
    rejectEdit: (relativePath: string): Promise<AgentToolResult> =>
      ipcRenderer.invoke('agent:reject-edit', relativePath),
    acceptAllEdits: (): Promise<{ ok: boolean; cleared: number }> =>
      ipcRenderer.invoke('agent:accept-all-edits'),
    pendingDiff: (
      relativePath: string
    ): Promise<{
      ok: boolean
      path: string
      previous: string
      current: string
      existed: boolean
      error?: string
    }> => ipcRenderer.invoke('agent:pending-diff', relativePath)
  },

  checkpoints: {
    list: (sessionId?: string): Promise<CheckpointListItem[]> =>
      ipcRenderer.invoke('checkpoints:list', sessionId),
    commit: (input: {
      sessionId: string
      messageId: string
      label: string
    }): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke('checkpoints:commit', input),
    rewind: (id: string): Promise<CheckpointRewindResult> =>
      ipcRenderer.invoke('checkpoints:rewind', id),
    onChanged: (cb: (payload: { sessionId?: string }) => void): (() => void) => {
      const listener = (_: unknown, payload: { sessionId?: string }): void =>
        cb(payload ?? {})
      ipcRenderer.on('checkpoints:changed', listener)
      return () => ipcRenderer.removeListener('checkpoints:changed', listener)
    }
  },

  mcp: {
    status: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:status'),
    listTools: (): Promise<McpOpenAiTool[]> => ipcRenderer.invoke('mcp:list-tools'),
    onChanged: (cb: (status: McpServerStatus[]) => void): (() => void) => {
      const listener = (_: unknown, status: McpServerStatus[]): void => cb(status ?? [])
      ipcRenderer.on('mcp:changed', listener)
      return () => ipcRenderer.removeListener('mcp:changed', listener)
    }
  },

  window: {
    minimize: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<{ ok: boolean; maximized?: boolean }> =>
      ipcRenderer.invoke('window:maximize'),
    close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:close'),
    hideToTray: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:hide-to-tray'),
    showFromTray: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('window:show-from-tray'),
    toggleFullscreen: (): Promise<{ ok: boolean; fullscreen?: boolean }> =>
      ipcRenderer.invoke('window:toggle-fullscreen'),
    toggleDevTools: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('window:toggle-devtools'),
    zoom: (delta: number): Promise<{ ok: boolean; zoom?: number }> =>
      ipcRenderer.invoke('window:zoom', delta),
    zoomReset: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:zoom-reset')
  },

  app: {
    quit: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:quit'),
    requestQuit: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:request-quit'),
    openExternal: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('app:open-external', url),
    onCloseAttempt: (
      cb: (payload: { intent: 'close' | 'quit' }) => void
    ): (() => void) => {
      const listener = (_: unknown, payload: { intent: 'close' | 'quit' }): void =>
        cb(payload ?? { intent: 'close' })
      ipcRenderer.on('app:close-attempt', listener)
      return () => ipcRenderer.removeListener('app:close-attempt', listener)
    }
  },

  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke('git:status'),
    diff: (path: string, staged?: boolean): Promise<GitDiff> =>
      ipcRenderer.invoke('git:diff', { path, staged }),
    stage: (paths: string[]): Promise<GitOkResult> =>
      ipcRenderer.invoke('git:stage', paths),
    unstage: (paths: string[]): Promise<GitOkResult> =>
      ipcRenderer.invoke('git:unstage', paths),
    stageAll: (): Promise<GitOkResult> => ipcRenderer.invoke('git:stage-all'),
    unstageAll: (): Promise<GitOkResult> => ipcRenderer.invoke('git:unstage-all'),
    commit: (message: string): Promise<GitOkResult> =>
      ipcRenderer.invoke('git:commit', message),
    fetch: (): Promise<GitOkResult> => ipcRenderer.invoke('git:fetch'),
    pull: (): Promise<GitOkResult> => ipcRenderer.invoke('git:pull'),
    push: (): Promise<GitOkResult> => ipcRenderer.invoke('git:push'),
    log: (limit?: number): Promise<GitCommitNode[]> =>
      ipcRenderer.invoke('git:log', limit),
    show: (hash: string): Promise<GitCommitDetail> =>
      ipcRenderer.invoke('git:show', hash)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type AfkApi = typeof api
