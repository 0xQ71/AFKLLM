import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getLLMQueue } from './llama/LLMQueueManager'
import { LlamaProcessManager } from './llama/LlamaProcessManager'
import type { LlamaProcessOptions } from './llama/LlamaProcessManager'
import { llamaRuntime } from './llama/LlamaRuntimeManager'
import { ModelSlotOrchestrator } from './llama/ModelSlotOrchestrator'
import { findMmprojForModel, scanGgufModels, scanMmprojFiles, scanWeightFiles } from './llama/ModelScanner'
import type { StoreDownloadTarget } from '../shared/hfStore'
import { isImageGenStoreTarget, isStoreDownloadTarget } from '../shared/hfStore'
import { sdRuntime } from './imagegen/SdRuntimeManager'
import { isNearlyBlankImage, killActiveSdCli, runSdCli } from './imagegen/SdCliRunner'
import { imageGenPathsNeedAutofill } from './imagegen/ImageGenAutofill'
import {
  CHAT_IMAGE_MAX_COUNT,
  importChatImage,
  readChatImageDataUrl
} from './chats/ChatImages'
import {
  CHAT_DOC_MAX_COUNT,
  importChatDocument
} from './chats/ChatDocuments'
import { CHAT_FILE_MAX_COUNT, importChatFile } from './chats/ChatFiles'
import type { LlamaRuntimeEnsureOptions } from '../shared/llamaRuntime'
import { isLlamaRuntimeSelection } from '../shared/llamaRuntime'
import type { ModelSlot } from '../shared/modelSlots'
import { isModelSlot } from '../shared/modelSlots'
import {
  getHfModelDetail,
  listStoreHome,
  searchHfGgufModels
} from './hf/HfHubClient'
import {
  localizeHfDetail,
  localizeHfHome,
  localizeHfListItems,
  localizeHfReadme
} from './hf/localizeStore'
import { setTranslateCacheDir } from './hf/translateRu'
import { detectGpuInfo } from './hardware/GpuInfo'
import { hfDownloads } from './hf/HfDownloadManager'
import { AgentToolRegistry } from './agent/AgentToolRegistry'
import { fastApplyEdit } from './llama/ApplyEditClient'
import { SettingsStore } from './settings/SettingsStore'
import { ChatStore } from './chats/ChatStore'
import { CheckpointStore, pendingMapToSnaps } from './checkpoints/CheckpointStore'
import { McpManager } from './mcp/McpManager'
import { TerminalManager } from './terminal/TerminalManager'
import { GitService } from './git/GitService'
import { buildRepoMap, queryCodebase } from './context/ContextEngine'
import { ContextIndex } from './context/ContextIndex'
import { loadProjectRules } from './context/ProjectRules'
import { probeProjectStack } from './context/StackProbe'
import { setWebSearchCacheDir } from './agent/WebSearch'
import { isUiLanguage } from '../shared/i18n'
import { TsLanguageService } from './lsp/TsLanguageService'
import { NodeDebugSession } from './debug/NodeDebugSession'
import type { DebugBreakpoint, DebugStartRequest } from '../shared/debug'
import { AppUpdater } from './updater/AppUpdater'
import { isSafeExternalUrl } from '../shared/safeExternalUrl'
import { DiagnosticsService } from './diagnostics/DiagnosticsService'
import {
  initCrashReporter,
  openLogDir,
  clearErrorLog,
  readErrorLog,
  reportEvent,
  setCollectLogsToFile
} from './telemetry/CrashReporter'
import {
  createAppTray,
  destroyAppTray,
  hideMainWindowToTray,
  setTrayLanguage,
  showMainWindow
} from './tray/AppTray'
import { resolveAppIconPath } from './appIcon'
import type { AgentToolCall, LLMCompletionRequest } from '../shared/types'
import type { PersistedChatMessage } from '../shared/chats'
import type { AppSettings, LlmRuntimeStatus } from '../shared/settings'
import type { CheckpointCommitInput } from '../shared/checkpoints'
import { decodeMcpToolName } from '../shared/mcp'
import { AGENT_TOOL_SCHEMAS } from '../shared/types'

let mainWindow: BrowserWindow | null = null
/** When true, close events are allowed to destroy the window (real quit). */
let isQuitting = false
let llama: LlamaProcessManager | null = null
/** Coresident apply llama-server (port+1); only while chat slot is active. */
let applyLlama: LlamaProcessManager | null = null
let slotOrch: ModelSlotOrchestrator | null = null
let tools: AgentToolRegistry | null = null
let settingsStore: SettingsStore | null = null
let chatStore: ChatStore | null = null
let checkpointStore: CheckpointStore | null = null
let mcpManager: McpManager | null = null
let gitService: GitService | null = null
let projectRoot = ''
let bootError: string | undefined
const terminals = new TerminalManager()
const appUpdater = new AppUpdater()
const diagnostics = new DiagnosticsService()
const contextIndex = new ContextIndex()
const tsLsp = new TsLanguageService()
const debugSession = new NodeDebugSession()
let folderWatcher: FSWatcher | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null
/** When true, agent turn requested a slot switch — allow through busy gate. */
let slotSwitchFromAgent = false

/** Prefer a real project folder over a drive root (mkdir D:\\ → EPERM). */
function pickSafeProjectRoot(candidate: string): string {
  if (!candidate || /^[a-zA-Z]:[\\/]?$/.test(candidate)) {
    return ''
  }
  return candidate
}

function noWorkspaceDir(): string {
  return join(app.getPath('userData'), 'no-workspace')
}

async function applyProjectRoot(root: string): Promise<void> {
  const safe = pickSafeProjectRoot(root)
  projectRoot = safe
  const toolRoot = safe || noWorkspaceDir()
  try {
    mkdirSync(toolRoot, { recursive: true })
  } catch {
    /* ignore */
  }
  tools?.setProjectRoot(toolRoot)
  gitService?.setRoot(safe)
  diagnostics.setRoot(safe)
  if (safe) {
    syncIdeRoot(safe)
    watchProject(safe)
  } else {
    folderWatcher?.close()
    folderWatcher = null
    contextIndex.setRoot('')
    tsLsp.setRoot('')
    debugSession.setRoot('')
  }
  if (checkpointStore) {
    checkpointStore.setWorkspaceRoot(safe || '__none__')
    await checkpointStore.load()
  }
  mcpManager?.setCwd(toolRoot)
  const snap = await chatStore?.setWorkspaceRoot(safe || '')
  if (snap) mainWindow?.webContents.send('chats:changed', snap)
  if (safe) void diagnostics.run()
}

function emitWorkspaceChanged(paths: string[] = []): void {
  mainWindow?.webContents.send('workspace:changed', { paths })
  diagnostics.schedule(1_500)
  contextIndex.invalidate(paths)
  tsLsp.invalidate(paths)
}

function syncContextIndexRoot(root: string): void {
  contextIndex.setRoot(root)
  void contextIndex.ensureReady()
}

function syncIdeRoot(root: string): void {
  syncContextIndexRoot(root)
  tsLsp.setRoot(root)
  debugSession.setRoot(root)
}

function watchProject(root: string): void {
  folderWatcher?.close()
  folderWatcher = null
  const pending = new Set<string>()
  const skipSeg = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    'release',
    '.next',
    'coverage',
    '.cache'
  ])
  try {
    folderWatcher = watch(root, { recursive: true }, (_event, filename) => {
      if (typeof filename === 'string' && filename) {
        const norm = filename.split(/[/\\]/).join('/')
        const top = norm.split('/')[0]
        if (top && skipSeg.has(top)) return
        if (norm.split('/').some((s) => skipSeg.has(s))) return
        pending.add(norm)
      }
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        const paths = [...pending]
        pending.clear()
        emitWorkspaceChanged(paths)
      }, 300)
    })
  } catch {
    // recursive watch unsupported on some volumes — FileTree still refreshes on demand
  }
}

function createWindow(): void {
  const icon = resolveAppIconPath()
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#181818',
    title: `AFKLLM ${app.getVersion()}`,
    autoHideMenuBar: true,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#181818',
            symbolColor: '#c8c8c8',
            height: 36
          }
        }),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  terminals.setWindow(mainWindow)
  appUpdater.setWindow(mainWindow)
  hfDownloads.setWindow(mainWindow)
  llamaRuntime.setWindow(mainWindow)
  sdRuntime.setWindow(mainWindow)
  const reveal = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  mainWindow.on('ready-to-show', reveal)
  mainWindow.webContents.on('did-finish-load', reveal)
  // Windows + custom titleBarOverlay can skip ready-to-show; don't leave a hidden window.
  setTimeout(reveal, 2500)
  // X / Alt+F4: ask renderer (tray hide or generation warning) instead of quitting.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:close-attempt', { intent: 'close' as const })
  })
  mainWindow.on('closed', () => {
    terminals.setWindow(null)
    appUpdater.setWindow(null)
    hfDownloads.setWindow(null)
    llamaRuntime.setWindow(null)
  sdRuntime.setWindow(null)
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function runtimeStatus(): LlmRuntimeStatus {
  const queue = getLLMQueue()
  const settings = settingsStore?.peek()
  const slot = slotOrch?.getStatus()
  const activePath =
    slot?.slot === 'vision'
      ? settings?.visionModelPath ?? null
      : settings?.modelPath ?? null
  const applyPath = settings?.applyModelPath?.trim() || ''
  const applyErr = slotOrch?.getApplyError() ?? applyLlama?.error
  let applyState: LlmRuntimeStatus['applyState'] = 'stopped'
  if (!applyPath) {
    applyState = 'stopped'
  } else if (applyLlama?.currentState === 'ready') {
    applyState = 'ready'
  } else if (applyLlama?.currentState === 'starting') {
    applyState = 'starting'
  } else if (applyErr || applyLlama?.currentState === 'error') {
    applyState = 'error'
  } else if (slot?.slot === 'chat' && slot.phase === 'switching') {
    applyState = 'starting'
  }

  const applyPort = (Number(settings?.port) || 8080) + 1
  const applyHost = settings?.host || '127.0.0.1'

  return {
    state: llama?.currentState ?? 'stopped',
    baseUrl: llama?.baseUrl ?? settings?.baseUrl ?? null,
    modelPath: activePath,
    ctxSize: settings?.ctxSize ?? null,
    pending: queue.pendingCount,
    error: bootError ?? llama?.error ?? slot?.error,
    detail: slot?.phase === 'switching' ? slot.detail : llama?.detail || slot?.detail,
    applyState,
    applyModelPath: applyPath || null,
    applyBaseUrl: applyLlama?.baseUrl ?? (applyPath ? `http://${applyHost}:${applyPort}` : null),
    applyError: applyErr
  }
}

function applyQueueSettings(settings: AppSettings): void {
  getLLMQueue(settings.baseUrl, 'local')
  const port = Number(settings.port) || 8080
  terminals.setDenyPreviewPorts(
    [port, port + 1, 8080].filter((p, i, a) => a.indexOf(p) === i)
  )
}

function settingsToLlamaOpts(
  settings: AppSettings,
  slot: 'chat' | 'vision' | 'apply' = 'chat',
  mmprojPath?: string | null
): LlamaProcessOptions {
  const custom = settings.llamaServerPath?.trim()
  const resolved = custom
    ? custom
    : llamaRuntime.resolveStatus(undefined, settings.llamaRuntimeVariant).binaryPath ||
      undefined
  const port = Number(settings.port) || 8080
  let modelPath = settings.modelPath
  let portOut = port
  let ctxSize = settings.ctxSize
  if (slot === 'vision') {
    modelPath = settings.visionModelPath
  } else if (slot === 'apply') {
    modelPath = settings.applyModelPath
    portOut = port + 1
    ctxSize = applyCtxSizeFor(settings)
  }
  return {
    binaryPath: resolved,
    modelPath,
    ...(slot === 'vision' && mmprojPath ? { mmprojPath } : {}),
    host: settings.host,
    port: portOut,
    nGpuLayers: settings.nGpuLayers,
    ctxSize,
    cacheTypeK: settings.cacheTypeK,
    cacheTypeV: settings.cacheTypeV,
    parallel: Math.max(1, settings.parallel),
    flashAttn: settings.flashAttn,
    threads: settings.threads,
    batchSize: settings.batchSize,
    ubatchSize: settings.ubatchSize,
    fitHardware: settings.fitHardware,
    kvOffload: settings.kvOffload,
    kvUnified: settings.kvUnified,
    ctxCheckpoints: settings.ctxCheckpoints,
    loadMode: settings.loadMode,
    contextShift: settings.contextOverflow === 'context_shift',
    ...(slot === 'apply' ? { disableReasoning: true } : {})
  }
}

/** Apply slot ctx: explicit setting, else follow chat ctx within safe bounds. */
function applyCtxSizeFor(settings?: AppSettings | null): number {
  const explicit = Number(settings?.applyCtxSize)
  if (Number.isFinite(explicit) && explicit >= 4096) {
    return Math.min(131_072, Math.floor(explicit))
  }
  return Math.min(Math.max(Number(settings?.ctxSize) || 8192, 8192), 32_768)
}

function emitSlotStatus(): void {
  if (!slotOrch || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('slots:status', slotOrch.getStatus())
}

function initSlotOrchestrator(): void {
  slotOrch = new ModelSlotOrchestrator({
    getLlama: () => llama,
    setLlama: (mgr) => {
      llama = mgr
    },
    getApplyLlama: () => applyLlama,
    setApplyLlama: (mgr) => {
      applyLlama = mgr
    },
    createLlama: (opts) => new LlamaProcessManager(opts),
    optsFor: async (slot) => {
      const settings = settingsStore!.get()
      if (slot === 'vision') {
        const mm = await findMmprojForModel(
          settings.visionModelPath,
          settings.visionMmprojPath
        )
        return settingsToLlamaOpts(settings, 'vision', mm)
      }
      if (slot === 'apply') {
        return settingsToLlamaOpts(settings, 'apply')
      }
      return settingsToLlamaOpts(settings, 'chat')
    },
    ensureRuntime: async () => {
      const settings = settingsStore!.get()
      if (!settings.llamaServerPath?.trim()) {
        const rt = await llamaRuntime.ensure(
          { variant: settings.llamaRuntimeVariant },
          settings.llamaServerPath,
          settings.llamaRuntimeVariant
        )
        if (!rt.ready || !rt.binaryPath) {
          throw new Error('llama.cpp runtime is not installed')
        }
      }
    }
  })
  slotOrch.on('status', () => emitSlotStatus())
}

function registerIpc(): void {
  const queue = getLLMQueue()

  ipcMain.handle('app:get-version', () => app.getVersion())

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return { ok: false }
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return { ok: true, maximized: mainWindow.isMaximized() }
  })
  ipcMain.handle('window:close', () => {
    // Goes through BrowserWindow 'close' → renderer close-attempt
    mainWindow?.close()
    return { ok: true }
  })
  ipcMain.handle('window:hide-to-tray', () => {
    hideMainWindowToTray(mainWindow)
    return { ok: true }
  })
  ipcMain.handle('window:show-from-tray', () => {
    showMainWindow(mainWindow)
    return { ok: true }
  })
  ipcMain.handle('window:toggle-fullscreen', () => {
    if (!mainWindow) return { ok: false }
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return { ok: true, fullscreen: mainWindow.isFullScreen() }
  })
  ipcMain.handle('window:toggle-devtools', () => {
    mainWindow?.webContents.toggleDevTools()
    return { ok: true }
  })
  ipcMain.handle('window:zoom', (_e, delta: number) => {
    if (!mainWindow) return { ok: false }
    const next = Math.min(3, Math.max(0.5, mainWindow.webContents.getZoomFactor() + delta))
    mainWindow.webContents.setZoomFactor(next)
    return { ok: true, zoom: next }
  })
  ipcMain.handle('window:zoom-reset', () => {
    mainWindow?.webContents.setZoomFactor(1)
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => {
    isQuitting = true
    destroyAppTray()
    app.quit()
    return { ok: true }
  })
  ipcMain.handle('app:request-quit', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      isQuitting = true
      destroyAppTray()
      app.quit()
      return { ok: true }
    }
    showMainWindow(mainWindow)
    mainWindow.webContents.send('app:close-attempt', { intent: 'quit' as const })
    return { ok: true }
  })
  ipcMain.handle('app:open-external', async (_e, url: string) => {
    const target = String(url ?? '')
    if (!isSafeExternalUrl(target)) {
      return { ok: false }
    }
    await shell.openExternal(target)
    return { ok: true }
  })
  ipcMain.handle('workspace:pick-file', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      defaultPath: projectRoot || undefined
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('updater:check', () => appUpdater.check())
  ipcMain.handle('updater:status', () => appUpdater.getLast())
  ipcMain.handle('updater:download', () => appUpdater.download())
  ipcMain.handle('updater:install', () => appUpdater.install())
  ipcMain.handle('updater:release-notes', (_e, version?: string) =>
    appUpdater.fetchReleaseNotes(
      typeof version === 'string' && version.trim()
        ? version.trim()
        : app.getVersion()
    )
  )

  ipcMain.handle('telemetry:report', (_e, event: unknown) => reportEvent(event))
  ipcMain.handle('telemetry:open-log-dir', () => openLogDir())
  ipcMain.handle('telemetry:read-log', () => readErrorLog())
  ipcMain.handle('telemetry:clear-log', () => clearErrorLog())

  ipcMain.handle('diagnostics:run', () => diagnostics.run())
  ipcMain.handle('diagnostics:get', () => diagnostics.getLast())

  ipcMain.handle('settings:get', () => settingsStore?.get())

  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    if (!settingsStore) throw new Error('Settings not ready')
    const cur = settingsStore.peek()
    const next = await settingsStore.save({
      ...patch,
      baseUrl: `http://${patch.host ?? cur.host}:${patch.port ?? cur.port}`
    })
    const slot = slotOrch?.getStatus().slot
    if (slot === 'vision') {
      const mm = await findMmprojForModel(next.visionModelPath, next.visionMmprojPath)
      llama?.updateOptions(settingsToLlamaOpts(next, 'vision', mm))
    } else {
      llama?.updateOptions(settingsToLlamaOpts(next, 'chat'))
      applyLlama?.updateOptions(settingsToLlamaOpts(next, 'apply'))
    }
    applyQueueSettings(next)
    if (mcpManager) {
      mcpManager.setCwd(projectRoot)
      void mcpManager.applyConfig(next.mcpServers)
    }
    if (isUiLanguage(next.uiLanguage)) setTrayLanguage(next.uiLanguage)
    mainWindow?.webContents.send('settings:changed', next)
    return next
  })

  ipcMain.handle('chats:get', () => {
    if (!chatStore) throw new Error('Chats not ready')
    return chatStore.get()
  })

  ipcMain.handle('chats:list', () => {
    if (!chatStore) throw new Error('Chats not ready')
    return chatStore.list()
  })

  ipcMain.handle('chats:list-by-roots', (_e, roots: string[]) => {
    if (!chatStore) throw new Error('Chats not ready')
    return chatStore.listByRoots(Array.isArray(roots) ? roots.map(String) : [])
  })

  ipcMain.handle('chats:create', async () => {
    if (!chatStore) throw new Error('Chats not ready')
    const snap = await chatStore.create()
    mainWindow?.webContents.send('chats:changed', snap)
    return snap
  })

  ipcMain.handle('chats:set-active', async (_e, id: string) => {
    if (!chatStore) throw new Error('Chats not ready')
    const snap = await chatStore.setActive(id)
    mainWindow?.webContents.send('chats:changed', snap)
    return snap
  })

  ipcMain.handle('chats:delete', async (_e, id: string) => {
    if (!chatStore) throw new Error('Chats not ready')
    void checkpointStore?.forgetSession(String(id ?? ''))
    const snap = await chatStore.delete(id)
    mainWindow?.webContents.send('chats:changed', snap)
    return snap
  })

  ipcMain.handle('chats:forget-root', async (_e, root: string) => {
    if (!chatStore) throw new Error('Chats not ready')
    const snap = await chatStore.forgetRoot(root)
    mainWindow?.webContents.send('chats:changed', snap)
    return snap
  })

  ipcMain.handle(
    'chats:update-messages',
    async (
      _e,
      payload: { id: string; messages: PersistedChatMessage[]; title?: string }
    ) => {
      if (!chatStore) throw new Error('Chats not ready')
      const snap = await chatStore.updateMessages(
        payload.id,
        payload.messages,
        payload.title
      )
      mainWindow?.webContents.send('chats:changed', snap)
      return snap
    }
  )

  ipcMain.handle('workspace:set-root', async (_e, root: string) => {
    await applyProjectRoot(String(root ?? ''))
    return { ok: true, root: projectRoot }
  })

  ipcMain.handle('workspace:clear-root', async () => {
    await applyProjectRoot('')
    return { ok: true, root: null }
  })

  ipcMain.handle('workspace:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    await applyProjectRoot(result.filePaths[0])
    return projectRoot || null
  })

  ipcMain.handle('workspace:pick-model', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('workspace:pick-mmproj', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select vision mmproj (.gguf)',
      properties: ['openFile'],
      filters: [{ name: 'mmproj GGUF', extensions: ['gguf'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('workspace:pick-image-gen-model', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select image generation model',
      properties: ['openFile'],
      filters: [
        {
          name: 'Diffusion weights',
          extensions: ['safetensors', 'gguf', 'ckpt', 'pt']
        },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('workspace:pick-sd-cli', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select sd-cli binary',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('workspace:pick-models-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select models folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('workspace:get-root', () => projectRoot || null)

  ipcMain.handle('context:repo-map', async () => {
    try {
      return await buildRepoMap(projectRoot)
    } catch (e) {
      return {
        text: '',
        fileCount: 0,
        dirCount: 0,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('context:codebase-query', async (_e, query: string) => {
    try {
      if (!contextIndex.isReady()) void contextIndex.ensureReady()
      return await queryCodebase(
        projectRoot,
        typeof query === 'string' ? query : '',
        contextIndex
      )
    } catch (e) {
      return {
        text: '',
        hits: 0,
        files: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('context:index-status', () => contextIndex.getStatus())

  ipcMain.handle('lsp:definition', (_e, path: string, line: number, column: number) => {
    return tsLsp.getDefinitionAt(
      typeof path === 'string' ? path : '',
      Number(line) || 1,
      Number(column) || 1
    )
  })

  ipcMain.handle(
    'lsp:hover',
    (_e, path: string, line: number, column: number, content?: string) => {
      return tsLsp.getHoverAt(
        typeof path === 'string' ? path : '',
        Number(line) || 1,
        Number(column) || 1,
        typeof content === 'string' ? content : undefined
      )
    }
  )

  ipcMain.handle('lsp:references', (_e, path: string, line: number, column: number) => {
    return tsLsp.getReferencesAt(
      typeof path === 'string' ? path : '',
      Number(line) || 1,
      Number(column) || 1
    )
  })

  ipcMain.handle('lsp:documentSymbols', (_e, path: string) => {
    return tsLsp.getDocumentSymbols(typeof path === 'string' ? path : '')
  })

  ipcMain.handle('lsp:status', () => tsLsp.getStatus())

  ipcMain.handle('debug:start', async (_e, req: DebugStartRequest) => {
    return debugSession.start(req ?? { entry: '' })
  })
  ipcMain.handle('debug:stop', () => debugSession.stop())
  ipcMain.handle('debug:continue', () => debugSession.continue())
  ipcMain.handle('debug:stepOver', () => debugSession.stepOver())
  ipcMain.handle('debug:stepInto', () => debugSession.stepInto())
  ipcMain.handle('debug:stepOut', () => debugSession.stepOut())
  ipcMain.handle('debug:status', () => debugSession.getStatus())
  ipcMain.handle('debug:setBreakpoints', (_e, bps: DebugBreakpoint[]) =>
    debugSession.setBreakpoints(Array.isArray(bps) ? bps : [])
  )

  ipcMain.handle('context:project-rules', async () => {
    try {
      return await loadProjectRules(projectRoot)
    } catch (e) {
      return {
        text: '',
        files: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('context:stack', async () => {
    try {
      return await probeProjectStack(projectRoot)
    } catch (e) {
      return {
        stacks: [],
        markers: [],
        text: '',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('workspace:list', async (_e, dirPath = '.') => {
    if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
    return tools.invoke({
      id: 'ws-list',
      name: 'list_directory',
      arguments: { dir_path: dirPath }
    })
  })

  ipcMain.handle('workspace:read-file', async (_e, relativePath: string) => {
    if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
    return tools.invoke({
      id: 'ws-read',
      name: 'read_file',
      arguments: { relative_path: relativePath }
    })
  })

  ipcMain.handle(
    'workspace:write-file',
    async (_e, relativePath: string, content: string) => {
      if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
      return tools.invoke({
        id: 'ws-write',
        name: 'write_file',
        arguments: { relative_path: relativePath, content, overwrite: true }
      })
    }
  )

  ipcMain.handle('workspace:delete-file', async (_e, relativePath: string) => {
    if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
    if (!mainWindow) return { ok: false, content: '', error: 'No window' }
    if (!settingsStore?.get().agentAutoApprove) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Delete file',
        message: `Delete ${relativePath}?`,
        detail: 'This cannot be undone.'
      })
      if (response !== 0) {
        return { ok: false, content: '', error: 'User cancelled', needsConfirmation: true }
      }
    }
    try {
      return await tools.deleteFile(relativePath)
    } catch (err) {
      return {
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(
    'workspace:create-file',
    async (_e, relativePath: string, content?: string) => {
      if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
      return tools.createFile(String(relativePath ?? ''), typeof content === 'string' ? content : '')
    }
  )

  ipcMain.handle('workspace:create-dir', async (_e, relativePath: string) => {
    if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
    return tools.createDir(String(relativePath ?? ''))
  })

  ipcMain.handle(
    'workspace:rename',
    async (_e, from: string, to: string) => {
      if (!tools) return { ok: false, content: '', error: 'Tools not ready' }
      return tools.renamePath(String(from ?? ''), String(to ?? ''))
    }
  )

  ipcMain.handle(
    'workspace:search',
    async (
      _e,
      payload: { query: string; glob?: string; limit?: number }
    ) => {
      if (!tools) {
        return { ok: false, matches: [], error: 'Tools not ready' }
      }
      return tools.searchFiles(payload?.query ?? '', {
        glob: payload?.glob,
        limit: payload?.limit
      })
    }
  )

  ipcMain.handle('terminal:create', (_e, cwd?: string) => {
    // Agent + panel share one visible PTY
    return terminals.ensure(cwd || projectRoot)
  })

  ipcMain.handle('terminal:scrollback', (_e, id: string) => {
    return { id, data: terminals.getScrollback(id) }
  })

  ipcMain.on('terminal:write', (_e, payload: { id: string; data: string }) => {
    terminals.writeFromUi(payload.id, payload.data)
  })

  ipcMain.on('terminal:resize', (_e, payload: { id: string; cols: number; rows: number }) => {
    terminals.resize(payload.id, payload.cols, payload.rows)
  })

  ipcMain.handle('terminal:kill', (_e, id: string) => {
    // Hide-only for primary — agent may still need it
    if (id === terminals.getPrimaryId()) {
      return { ok: true, kept: true }
    }
    terminals.kill(id)
    return { ok: true }
  })

  ipcMain.handle('terminal:interrupt', () => {
    const interrupted = terminals.interruptActiveCommand()
    return { ok: true, interrupted }
  })

  ipcMain.handle(
    'llm:enqueue',
    async (
      e,
      request: Omit<LLMCompletionRequest, 'id'> & { id?: string; stream?: boolean }
    ) => {
      const id = request.id ?? cryptoRandomId()
      return queue.enqueue({
        ...request,
        id,
        stream: request.stream,
        onChunk: request.stream
          ? (chunk) => {
              e.sender.send('llm:stream', chunk)
            }
          : undefined
      })
    }
  )

  ipcMain.handle('llm:cancel-all', () => {
    queue.cancelAll('user_stop')
    killActiveSdCli()
    return { ok: true }
  })

  ipcMain.handle('llm:status', async () => {
    // Only reconcile while loading — avoid /health spam when stopped
    if (llama && llama.currentState === 'starting') {
      const ok = await llama.reconcile()
      if (ok) bootError = undefined
    }
    return runtimeStatus()
  })

  /** Kill llama-server and free VRAM; does not auto-restart. */
  ipcMain.handle('llm:unload', async () => {
    bootError = undefined
    try {
      if (slotOrch) {
        await slotOrch.ensureSlot('idle')
      } else {
        getLLMQueue().cancelAll('model_unloaded')
        await llama?.stop()
        await applyLlama?.stop()
        applyLlama = null
      }
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err)
    }
    return runtimeStatus()
  })

  ipcMain.handle('llm:restart', async () => {
    bootError = undefined
    try {
      await bootInference(true)
      return runtimeStatus()
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err)
      return runtimeStatus()
    }
  })

  ipcMain.handle('slots:status', () => slotOrch?.getStatus() ?? { slot: 'idle', phase: 'ready', detail: '' })

  ipcMain.handle('slots:ensure', async (_e, target: unknown) => {
    if (!isModelSlot(target)) throw new Error(`Invalid slot: ${String(target)}`)
    if (!slotOrch) throw new Error('Slot orchestrator not ready')
    slotSwitchFromAgent = true
    try {
      bootError = undefined
      const status = await slotOrch.ensureSlot(target as ModelSlot)
      applyQueueSettings(settingsStore!.get())
      return status
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      slotSwitchFromAgent = false
    }
  })

  ipcMain.handle(
    'chat-images:import',
    async (
      _e,
      payload: {
        sessionId?: string
        sourcePath?: string
        dataBase64?: string
        mime?: string
        name?: string
      }
    ) => {
      const sessionId = String(payload?.sessionId || 'draft')
      return importChatImage({
        sessionId,
        sourcePath: payload?.sourcePath,
        dataBase64: payload?.dataBase64,
        mime: payload?.mime,
        name: payload?.name
      })
    }
  )

  ipcMain.handle('chat-images:read-data-url', async (_e, absPath: unknown) => {
    const p = String(absPath ?? '')
    if (!p) throw new Error('path required')
    return readChatImageDataUrl(p)
  })

  ipcMain.handle('chat-images:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return []
    return result.filePaths.slice(0, CHAT_IMAGE_MAX_COUNT)
  })

  ipcMain.handle(
    'chat-docs:import',
    async (
      _e,
      payload: {
        sessionId?: string
        sourcePath?: string
        dataBase64?: string
        mime?: string
        name?: string
      }
    ) => {
      const sessionId = String(payload?.sessionId || 'draft')
      return importChatDocument({
        sessionId,
        sourcePath: payload?.sourcePath,
        dataBase64: payload?.dataBase64,
        mime: payload?.mime,
        name: payload?.name
      })
    }
  )

  ipcMain.handle(
    'chat-files:import',
    async (
      _e,
      payload: {
        sessionId?: string
        sourcePath?: string
        dataBase64?: string
        mime?: string
        name?: string
      }
    ) => {
      const sessionId = String(payload?.sessionId || 'draft')
      return importChatFile({
        sessionId,
        sourcePath: payload?.sourcePath,
        dataBase64: payload?.dataBase64,
        mime: payload?.mime,
        name: payload?.name
      })
    }
  )

  ipcMain.handle('chat-files:open', async (_e, absPath: string) => {
    const p = String(absPath || '').trim()
    if (!p || !existsSync(p)) throw new Error('File not found')
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return true
  })

  ipcMain.handle('chat-files:pick', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || !result.filePaths.length) return []
    return result.filePaths.slice(0, CHAT_FILE_MAX_COUNT)
  })

  ipcMain.handle('chat-docs:pick', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word', extensions: ['docx', 'doc'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return []
    return result.filePaths.slice(0, CHAT_DOC_MAX_COUNT)
  })

  ipcMain.handle('llm:list-mmproj', async () => {
    const dir = settingsStore?.get().modelsDir
    if (!dir) return []
    return scanMmprojFiles(dir)
  })

  ipcMain.handle('sd-runtime:status', () => {
    const settings = settingsStore?.get()
    return sdRuntime.getStatus(settings?.sdCppPath)
  })

  ipcMain.handle('sd-runtime:check', async () => {
    const settings = settingsStore?.get()
    return sdRuntime.check(settings?.sdCppPath)
  })

  ipcMain.handle(
    'sd-runtime:ensure',
    async (_e, opts?: { force?: boolean }) => {
      const settings = settingsStore?.get()
      return sdRuntime.ensure(settings?.sdCppPath, opts?.force === true)
    }
  )

  ipcMain.handle('sd-runtime:progress', () => sdRuntime.getProgress())

  ipcMain.handle('llama-runtime:status', () => {
    const settings = settingsStore?.get()
    return llamaRuntime.getStatus(
      settings?.llamaServerPath,
      settings?.llamaRuntimeVariant ?? 'auto'
    )
  })

  ipcMain.handle(
    'llama-runtime:ensure',
    async (_e, opts?: LlamaRuntimeEnsureOptions) => {
      const settings = settingsStore?.get()
      const selection = settings?.llamaRuntimeVariant ?? 'auto'
      const ensureOpts: LlamaRuntimeEnsureOptions = {
        force: opts?.force,
        preferCuda: opts?.preferCuda,
        variant:
          opts?.variant && isLlamaRuntimeSelection(opts.variant)
            ? opts.variant
            : selection
      }
      try {
        await llamaRuntime.ensure(ensureOpts, settings?.llamaServerPath, selection)
        return llamaRuntime.getStatus(settings?.llamaServerPath, selection)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        bootError = msg
        throw err
      }
    }
  )

  ipcMain.handle('llama-runtime:progress', () => llamaRuntime.getProgress())

  ipcMain.handle('llama-runtime:open-dir', async () => {
    const dir = llamaRuntime.runtimeDir()
    try {
      mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
      return { ok: true as const, path: dir }
    } catch (err) {
      return {
        ok: false as const,
        path: dir,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('llm:list-models', async () => {
    const dir = settingsStore?.get().modelsDir
    if (!dir) return []
    return scanGgufModels(dir)
  })

  const storeLang = (): 'en' | 'ru' => {
    const v = settingsStore?.get().uiLanguage
    return isUiLanguage(v) ? v : 'en'
  }

  ipcMain.handle(
    'hf:search',
    async (_e, params: { query?: string; limit?: number; target?: string }) => {
      const q = (params?.query ?? '').trim()
      const target: StoreDownloadTarget = isStoreDownloadTarget(params?.target)
        ? params.target
        : 'chat'
      const modelsDir = settingsStore?.get().modelsDir
      const local =
        isImageGenStoreTarget(target)
          ? modelsDir
            ? await scanWeightFiles(modelsDir)
            : []
          : modelsDir
            ? await scanGgufModels(modelsDir)
            : []
      const lang = storeLang()
      if (!q) {
        const home = await listStoreHome(local, target)
        return (await localizeHfHome(home, lang)).items
      }
      const items = await searchHfGgufModels(
        { query: q, limit: params?.limit ?? 30 },
        local,
        target
      )
      return localizeHfListItems(items, lang)
    }
  )

  ipcMain.handle('hf:home', async (_e, targetRaw?: unknown) => {
    const target: StoreDownloadTarget = isStoreDownloadTarget(targetRaw)
      ? targetRaw
      : 'chat'
    const modelsDir = settingsStore?.get().modelsDir
    const local =
      isImageGenStoreTarget(target)
        ? modelsDir
          ? await scanWeightFiles(modelsDir)
          : []
        : modelsDir
          ? await scanGgufModels(modelsDir)
          : []
    const home = await listStoreHome(local, target)
    return localizeHfHome(home, storeLang())
  })

  ipcMain.handle('hf:gpu', async () => detectGpuInfo())

  ipcMain.handle(
    'hf:model',
    async (_e, repoId: string, preferredFile?: string, targetRaw?: unknown) => {
      const target: StoreDownloadTarget = isStoreDownloadTarget(targetRaw)
        ? targetRaw
        : 'chat'
      const modelsDir = settingsStore?.get().modelsDir
      const local =
        isImageGenStoreTarget(target)
          ? modelsDir
            ? await scanWeightFiles(modelsDir)
            : []
          : modelsDir
            ? await scanGgufModels(modelsDir)
            : []
      const detail = await getHfModelDetail(
        String(repoId ?? ''),
        preferredFile || undefined,
        local,
        target
      )
      const lang = storeLang()
      const localized = await localizeHfDetail(detail, lang)
      // README translation is slow (many MyMemory chunks) — never block model open.
      if (lang === 'ru' && localized.readmeMarkdown?.trim()) {
        const id = localized.id
        void localizeHfReadme(localized, lang)
          .then((readmeMarkdown) => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            mainWindow.webContents.send('hf:readme-localized', {
              id,
              readmeMarkdown: readmeMarkdown ?? undefined,
              done: true as const
            })
          })
          .catch(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            mainWindow.webContents.send('hf:readme-localized', {
              id,
              done: true as const
            })
          })
      }
      return localized
    }
  )

  ipcMain.handle(
    'hf:download',
    async (_e, input: { repoId: string; filename: string }) => {
      const modelsDir = settingsStore?.get().modelsDir
      if (!modelsDir) throw new Error('modelsDir is not configured')
      return hfDownloads.download({
        repoId: String(input.repoId),
        filename: String(input.filename),
        modelsDir
      })
    }
  )

  ipcMain.handle('hf:download-cancel', (_e, id?: string) => hfDownloads.cancel(id))
  ipcMain.handle('hf:download-pause', (_e, id: string) => hfDownloads.pause(String(id)))
  ipcMain.handle('hf:download-resume', async (_e, id: string) =>
    hfDownloads.resume(String(id))
  )
  ipcMain.handle('hf:downloads', () => hfDownloads.list())
  ipcMain.handle('hf:downloads-clear', () => hfDownloads.clearCompleted())

  ipcMain.handle('hf:open-models-dir', async () => {
    const dir = settingsStore?.get().modelsDir
    if (!dir) return { ok: false, error: 'modelsDir is not configured' }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('hf:show-in-folder', async (_e, filePath: string) => {
    const p = String(filePath ?? '')
    if (!p || !existsSync(p)) return { ok: false, error: 'File not found' }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  ipcMain.handle('agent:list-tools', () => {
    const builtin = tools?.schemas ?? AGENT_TOOL_SCHEMAS
    const mcp = mcpManager?.listOpenAiTools() ?? []
    return [...builtin, ...mcp]
  })

  ipcMain.handle('agent:invoke', async (_e, call: AgentToolCall) => {
    if (decodeMcpToolName(call.name)) {
      if (!mcpManager) {
        return {
          id: call.id,
          name: call.name,
          ok: false,
          content: '',
          error: 'MCP manager not initialized'
        }
      }
      return mcpManager.callTool(call.name, call.arguments ?? {}, call.id)
    }
    if (!tools) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        content: '',
        error: 'Tool registry not initialized'
      }
    }
    return tools.invoke(call)
  })

  ipcMain.handle('mcp:status', () => mcpManager?.getStatus() ?? [])
  ipcMain.handle('mcp:list-tools', () => mcpManager?.listOpenAiTools() ?? [])

  ipcMain.handle('agent:accept-edit', (_e, relativePath: string) => {
    if (!tools) return { ok: false, path: relativePath }
    return tools.acceptEdit(String(relativePath ?? ''))
  })

  ipcMain.handle('agent:reject-edit', async (_e, relativePath: string) => {
    if (!tools) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: 'Tool registry not initialized'
      }
    }
    return tools.rejectEdit(String(relativePath ?? ''))
  })

  ipcMain.handle('agent:accept-all-edits', () => {
    if (!tools) return { ok: false, cleared: 0 }
    return tools.acceptAllEdits()
  })

  ipcMain.handle('agent:pending-diff', async (_e, relativePath: string) => {
    if (!tools) {
      return {
        ok: false,
        path: String(relativePath ?? ''),
        previous: '',
        current: '',
        existed: false,
        error: 'Tool registry not initialized'
      }
    }
    return tools.getPendingDiff(String(relativePath ?? ''))
  })

  // Ctrl+K inline edit: run on the fast apply slot, not the chat queue.
  ipcMain.handle(
    'agent:apply-edit',
    async (
      _e,
      params: {
        instruction?: string
        filePath?: string
        content?: string
        region?: { startLine: number; endLine: number }
      }
    ) => {
      const baseUrl =
        applyLlama?.currentState === 'ready' ? applyLlama.baseUrl : ''
      if (!baseUrl) {
        return {
          ok: false,
          code: 'APPLY_UNAVAILABLE',
          error: 'Apply model is not loaded (Settings → Apply model → Load).'
        }
      }
      const filePath = String(params?.filePath ?? '')
      const result = await fastApplyEdit({
        baseUrl,
        instruction: String(params?.instruction ?? ''),
        filePath,
        content: String(params?.content ?? ''),
        region: params?.region,
        ctxSize: applyCtxSizeFor(settingsStore?.get()),
        onToken: (token) => {
          mainWindow?.webContents.send('agent:apply-token', { path: filePath, token })
        }
      })
      return result.ok
        ? { ok: true, content: result.content, applied: result.applied }
        : { ok: false, error: result.error, code: result.code }
    }
  )

  ipcMain.handle('checkpoints:list', (_e, sessionId?: string) => {
    return checkpointStore?.list(sessionId ? String(sessionId) : undefined) ?? []
  })

  ipcMain.handle('checkpoints:commit', async (_e, input: CheckpointCommitInput) => {
    if (!checkpointStore || !tools) return null
    const pending = tools.exportPendingEdits()
    const files =
      input.files && input.files.length > 0
        ? input.files
        : pendingMapToSnaps(
            pending.map((p) => [
              p.path,
              { existed: p.existed, previous: p.previous }
            ] as [string, { existed: boolean; previous: string }])
          )
    const cp = await checkpointStore.commit({
      sessionId: String(input.sessionId ?? ''),
      messageId: String(input.messageId ?? ''),
      label: String(input.label ?? 'turn'),
      files
    })
    if (cp) {
      mainWindow?.webContents.send('checkpoints:changed', {
        sessionId: cp.sessionId
      })
    }
    return cp
  })

  ipcMain.handle('checkpoints:rewind', async (_e, id: string) => {
    if (!checkpointStore || !tools) {
      return {
        ok: false,
        checkpointId: String(id ?? ''),
        restoredPaths: [],
        truncatedAfterMessageId: '',
        error: 'Checkpoint store not initialized'
      }
    }
    const result = await checkpointStore.rewind(String(id ?? ''), (snap) =>
      tools!.restoreCheckpointFile(snap)
    )
    if (result.ok) {
      emitWorkspaceChanged(result.restoredPaths)
      mainWindow?.webContents.send('checkpoints:changed', {})
    }
    return result
  })

  ipcMain.handle('git:status', () => {
    if (!gitService) {
      return {
        available: false,
        branch: null,
        ahead: null,
        behind: null,
        files: [],
        stagedCount: 0,
        unstagedCount: 0
      }
    }
    return gitService.status()
  })

  ipcMain.handle(
    'git:diff',
    (_e, payload: { path: string; staged?: boolean }) => {
      if (!gitService) {
        return {
          path: payload?.path ?? '',
          staged: Boolean(payload?.staged),
          oldText: '',
          newText: '',
          error: 'Git not ready'
        }
      }
      return gitService.diff(payload.path, Boolean(payload.staged))
    }
  )

  ipcMain.handle('git:stage', (_e, paths: string[]) => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.stage(Array.isArray(paths) ? paths : [])
  })

  ipcMain.handle('git:unstage', (_e, paths: string[]) => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.unstage(Array.isArray(paths) ? paths : [])
  })

  ipcMain.handle('git:stage-all', () => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.stageAll()
  })

  ipcMain.handle('git:unstage-all', () => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.unstageAll()
  })

  ipcMain.handle('git:commit', (_e, message: string) => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.commit(typeof message === 'string' ? message : '')
  })

  ipcMain.handle('git:log', (_e, limit?: number) => {
    if (!gitService) return []
    return gitService.log(typeof limit === 'number' ? limit : 40)
  })

  ipcMain.handle('git:show', (_e, hash: string) => {
    if (!gitService) {
      return {
        hash: '',
        shortHash: '',
        subject: '',
        body: '',
        author: '',
        date: '',
        patch: '',
        error: 'Git not ready'
      }
    }
    return gitService.show(typeof hash === 'string' ? hash : '')
  })

  ipcMain.handle('git:fetch', () => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.fetch()
  })

  ipcMain.handle('git:pull', () => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.pull()
  })

  ipcMain.handle('git:push', () => {
    if (!gitService) return { ok: false, error: 'Git not ready' }
    return gitService.push()
  })
}

async function bootInference(forceRestart = false): Promise<void> {
  if (!settingsStore) throw new Error('SettingsStore missing')
  const settings = settingsStore.get()
  applyQueueSettings(settings)

  tools?.setProjectRoot(projectRoot)

  // Status-bar Load starts the server; this path only refreshes options
  if (!forceRestart) {
    if (!llama) {
      llama = new LlamaProcessManager(settingsToLlamaOpts(settings))
    } else {
      llama.updateOptions(settingsToLlamaOpts(settings))
    }
    return
  }

  if (!slotOrch) initSlotOrchestrator()
  await slotOrch!.ensureSlot('chat')
  applyQueueSettings(settingsStore.get())
}

app.whenReady().then(async () => {
  initCrashReporter()
  // Empty workspace on launch (cwd is often this repo)
  projectRoot = ''
  settingsStore = new SettingsStore()
  await settingsStore.load()
  initSlotOrchestrator()
  setCollectLogsToFile(() => settingsStore?.get().collectLogsToFile !== false)
  void reportEvent({
    kind: 'info',
    message: 'Log recording active',
    source: 'main:startup',
    extra: {
      collectLogsToFile: settingsStore.get().collectLogsToFile !== false
    }
  })
  terminals.setAutoConfirm(() => settingsStore?.get().agentAutoApprove === true)
  applyQueueSettings(settingsStore.get())

  chatStore = new ChatStore()
  await chatStore.load()
  await chatStore.setWorkspaceRoot('')

  checkpointStore = new CheckpointStore()
  checkpointStore.setWorkspaceRoot('__none__')
  await checkpointStore.load()

  const placeholder = noWorkspaceDir()
  try {
    mkdirSync(placeholder, { recursive: true })
  } catch {
    /* ignore */
  }

  mcpManager = new McpManager()
  mcpManager.setCwd(placeholder)
  mcpManager.setOnChanged(() => {
    mainWindow?.webContents.send('mcp:changed', mcpManager?.getStatus() ?? [])
  })
  void mcpManager.applyConfig(settingsStore.get().mcpServers)

  gitService = new GitService()
  gitService.setRoot('')

  diagnostics.setRoot('')
  diagnostics.setOnChange((snap) => {
    mainWindow?.webContents.send('diagnostics:changed', snap)
  })

  setWebSearchCacheDir(join(app.getPath('userData'), 'web-search-cache'))
  setTranslateCacheDir(join(app.getPath('userData'), 'translate-cache'))

  debugSession.setEmit((event) => {
    mainWindow?.webContents.send('debug:event', event)
  })

  tools = new AgentToolRegistry({
    projectRoot: placeholder,
    contextIndex,
    getApplyBaseUrl: () =>
      applyLlama?.currentState === 'ready' ? applyLlama.baseUrl : null,
    getApplyCtxSize: () => applyCtxSizeFor(settingsStore?.get()),
    onApplyToken: (relativePath, token) => {
      mainWindow?.webContents.send('agent:apply-token', { path: relativePath, token })
    },
    getDiagnostics: () => diagnostics.getLast(),
    runVisibleCommand: (command, cwd) => terminals.runVisibleCommand(command, cwd),
    readTerminalScrollback: (maxChars) => terminals.getPrimaryScrollback(maxChars),
    confirmTerminal: async (command, cwd) => {
      if (settingsStore?.get().agentAutoApprove === true) return true
      if (!mainWindow) return false
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Allow', 'Allow all (auto)', 'Deny'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: 'Terminal command',
        message: 'Agent wants to run a shell command',
        detail: `cwd: ${cwd}\n\n${command}`
      })
      if (response === 1) {
        await settingsStore?.save({ agentAutoApprove: true })
        mainWindow.webContents.send('settings:changed', settingsStore?.get())
        return true
      }
      return response === 0
    },
    confirmDelete: async (relativePath) => {
      if (settingsStore?.get().agentAutoApprove === true) return true
      if (!mainWindow) return false
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Allow all (auto)', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: 'Delete file',
        message: `Agent wants to delete ${relativePath}`,
        detail: 'This cannot be undone.'
      })
      if (response === 1) {
        await settingsStore?.save({ agentAutoApprove: true })
        mainWindow.webContents.send('settings:changed', settingsStore?.get())
        return true
      }
      return response === 0
    },
    onFilesystemChange: (paths) => emitWorkspaceChanged(paths),
    onFileDeleted: (relativePath) => {
      mainWindow?.webContents.send('workspace:file-deleted', {
        path: relativePath.replace(/\\/g, '/')
      })
    },
    onOpenPreview: (url) => {
      mainWindow?.webContents.send('browser:open-url', { url })
    },
    getDenyPreviewPorts: () => {
      const port = Number(settingsStore?.get().port) || 8080
      return [port, 8080].filter((p, i, a) => a.indexOf(p) === i)
    },
    generateImage: async (args) => {
      let settings = settingsStore?.get()
      if (!settings?.agentImageGenEnabled) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error:
            'Image mode is off. Turn on Image in the composer to allow generate_image.'
        }
      }
      if (settingsStore && imageGenPathsNeedAutofill(settings ?? settingsStore.get())) {
        settings = await settingsStore.autofillImageGenIfNeeded()
        // Push updated paths to renderer so Settings UI stays in sync.
        mainWindow?.webContents.send('settings:changed', settings)
      }
      if (!settings?.imageGenModelPath?.trim()) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error:
            'imageGenModelPath is not set. Put FLUX/SDXL weights in Models dir or set Settings → Multimodal.'
        }
      }
      if (!slotOrch) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error: 'Slot orchestrator not ready'
        }
      }
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error: 'prompt is required'
        }
      }
      const relRaw =
        String(args.relative_path ?? '').trim() || 'generated/hero.png'
      const rel = relRaw.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel || rel.includes('..')) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error: 'relative_path must be inside the project (no ..)'
        }
      }
      const root = projectRoot || noWorkspaceDir()
      const abs = join(root, rel)
      if (/favicon\.(ico|png)$/i.test(rel)) {
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error:
            'FAVICON: do not generate favicon via generate_image. Skip it or use a tiny inline SVG in HTML.'
        }
      }
      const restoreChat = async (): Promise<void> => {
        if (!slotOrch) return
        try {
          // Brief pause so the OS can reclaim RAM after sd-cli exits before
          // llama-server maps the chat GGUF (avoids peak-RAM OOM → auto-stop).
          await new Promise((r) => setTimeout(r, 750))
          slotOrch.setDetail('Restoring chat model…', 'switching')
          // Do not cancelPending — this tool IPC is still part of the agent turn.
          await slotOrch.ensureSlot('chat', { cancelPending: false })
        } catch (restoreErr) {
          console.error('[generate_image] chat restore failed', restoreErr)
        }
      }
      try {
        slotSwitchFromAgent = true
        killActiveSdCli()
        await slotOrch.ensureSlot('imageGen')
        const rt = await sdRuntime.ensure(settings.sdCppPath)
        if (!rt.ready || !rt.binaryPath) {
          throw new Error('sd-cli runtime is not installed')
        }
        const reqW =
          typeof args.width === 'number' ? args.width : settings.imageGenWidth
        const reqH =
          typeof args.height === 'number' ? args.height : settings.imageGenHeight
        // Absolute ceiling — anything above 1536 is rejected/clamped.
        const width = Math.max(64, Math.min(1536, Number(reqW) || 1024))
        const height = Math.max(64, Math.min(1536, Number(reqH) || 1024))
        const steps = Math.max(
          1,
          Math.min(
            40,
            typeof args.steps === 'number' ? args.steps : settings.imageGenSteps
          )
        )
        const runOnce = (
          hires: boolean,
          outputPath: string,
          overrides?: {
            width?: number
            height?: number
            vaeOnCpu?: boolean
            weightStorage?: 'disk' | 'ram' | 'vram'
          }
        ) =>
          runSdCli({
            binaryPath: rt.binaryPath!,
            modelPath: settings!.imageGenModelPath,
            vaePath: settings!.imageGenVaePath,
            clipLPath: settings!.imageGenClipLPath,
            clipGPath: settings!.imageGenClipGPath,
            t5Path: settings!.imageGenT5Path,
            llmPath: settings!.imageGenLlmPath,
            prompt,
            outputPath,
            negativePrompt: (() => {
              const fromAgent = String(args.negative_prompt ?? '').trim()
              const fromSettings = String(settings!.imageGenNegativePrompt ?? '').trim()
              if (fromAgent && fromSettings) return `${fromSettings}, ${fromAgent}`
              return fromAgent || fromSettings || undefined
            })(),
            width: overrides?.width ?? width,
            height: overrides?.height ?? height,
            steps,
            cfgScale: settings!.imageGenCfg,
            weightStorage: overrides?.weightStorage ?? settings!.imageGenWeightStorage,
            vaeOnCpu: overrides?.vaeOnCpu,
            hires,
            hiresScale: settings!.imageGenHiresScale,
            hiresDenoising: settings!.imageGenHiresDenoising,
            onProgress: (p) => {
              slotOrch?.setDetail(p.detail, 'switching')
            }
          })

        const stageDir = join(
          tmpdir(),
          'afkllm-img-stage',
          `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        )
        mkdirSync(stageDir, { recursive: true })
        const baseName = basename(abs) || 'image.png'
        const baseTmp = join(stageDir, `base-${baseName}`)
        const hiresTmp = join(stageDir, `hires-${baseName}`)
        const safeTmp = join(stageDir, `safe-${baseName}`)
        const cleanupStage = (): void => {
          for (const p of [baseTmp, hiresTmp, safeTmp]) {
            try {
              if (existsSync(p)) unlinkSync(p)
            } catch {
              /* ignore */
            }
          }
          try {
            rmSync(stageDir, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }

        // One sampling job only:
        // - hires ON → single run with --hires (pass1+pass2 inside sd-cli ≈ 2×steps)
        // - hires OFF → single base run
        // Old "base-first then full hires redo" did base + (base+hires) = 3×steps — waste.
        const wantHires = settings.imageGenHires === true
        let outTmp = wantHires ? hiresTmp : baseTmp
        slotOrch?.setDetail(
          wantHires ? 'Image gen: pass 1–2 (hires)…' : 'Image gen: base pass…',
          'switching'
        )
        let primaryResult = await runOnce(wantHires, outTmp)
        let primaryExists = existsSync(outTmp)
        let primaryBlank = primaryExists && isNearlyBlankImage(outTmp)
        let primaryOk =
          primaryResult.ok && primaryExists && !primaryBlank

        // If hires produced blank/hard-fail, fall back to one base-only pass (keep usable image).
        let note = ''
        if (!primaryOk && wantHires) {
          console.warn(
            '[generate_image] hires blank/failed — falling back to base-only',
            primaryResult.error
          )
          slotOrch?.setDetail('Image gen: hires failed — base fallback…', 'switching')
          try {
            if (existsSync(outTmp)) unlinkSync(outTmp)
          } catch {
            /* ignore */
          }
          outTmp = baseTmp
          primaryResult = await runOnce(false, outTmp)
          primaryExists = existsSync(outTmp)
          primaryBlank = primaryExists && isNearlyBlankImage(outTmp)
          primaryOk = primaryResult.ok && primaryExists && !primaryBlank
          if (primaryOk) note = ' (hires failed — kept base)'
        }

        // Hard fail (crash / no file): one safe retry @768 RAM offload.
        // Blank-but-saved = model/runtime NaN — do not burn another full pass.
        const hardFail = !primaryResult.ok || !primaryExists
        if (!primaryOk && hardFail) {
          console.warn(
            '[generate_image] hard-failed — safe retry @768 RAM offload',
            primaryResult.error
          )
          slotOrch?.setDetail(
            'Image gen: safe retry (768, RAM offload, VAE CPU)…',
            'switching'
          )
          primaryResult = await runOnce(false, safeTmp, {
            width: Math.min(width, 768),
            height: Math.min(height, 768),
            vaeOnCpu: true,
            weightStorage: 'ram'
          })
          if (
            primaryResult.ok &&
            existsSync(safeTmp) &&
            !isNearlyBlankImage(safeTmp)
          ) {
            try {
              copyFileSync(safeTmp, baseTmp)
              outTmp = baseTmp
            } catch {
              outTmp = safeTmp
            }
            primaryExists = existsSync(outTmp)
            primaryBlank = primaryExists && isNearlyBlankImage(outTmp)
            primaryOk = primaryExists && !primaryBlank
            if (primaryOk) note = ' (safe retry)'
          }
        }

        if (!primaryOk) {
          cleanupStage()
          await restoreChat()
          return {
            id: '',
            name: 'generate_image',
            ok: false,
            content: '',
            error: primaryBlank
              ? 'IMAGE_BLANK: the image model returned a blank/white frame (NaN decode) — this is a model/runtime issue, not the prompt. Do NOT retry generate_image this turn; use a CSS gradient/placeholder and continue.'
              : primaryResult.error ||
                'Image gen failed to produce an image. Try weightStorage=ram or lower resolution.',
            filePath: rel.replace(/\\/g, '/')
          }
        }

        mkdirSync(dirname(abs), { recursive: true })
        try {
          if (existsSync(abs)) unlinkSync(abs)
        } catch {
          /* ignore */
        }
        copyFileSync(outTmp, abs)

        cleanupStage()
        const posix = rel.replace(/\\/g, '/')
        if (existsSync(abs) && !isNearlyBlankImage(abs)) {
          emitWorkspaceChanged([posix])
          await restoreChat()
          return {
            id: '',
            name: 'generate_image',
            ok: true,
            content:
              `OK: image saved to ${posix}${note}. ` +
              `HTML: use exactly one tag <img src="${posix}"> (relative to the page). ` +
              `Do not duplicate <img> tags, do not read_file this PNG. IMAGE_DONE: continue other requested work if any; if the request was image-only, one short confirmation is enough.`,
            filePath: posix
          }
        }
        try {
          if (existsSync(abs)) unlinkSync(abs)
        } catch {
          /* ignore */
        }
        await restoreChat()
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error: 'Final image was blank — not saved',
          filePath: posix
        }
      } catch (err) {
        await restoreChat()
        return {
          id: '',
          name: 'generate_image',
          ok: false,
          content: '',
          error: err instanceof Error ? err.message : String(err)
        }
      } finally {
        slotSwitchFromAgent = false
      }
    }
  })

  registerIpc()
  // Native menu unused — File/Edit/View live in the in-app title bar
  Menu.setApplicationMenu(null)
  createWindow()
  createAppTray(
    {
      show: () => showMainWindow(mainWindow),
      requestQuit: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          isQuitting = true
          destroyAppTray()
          app.quit()
          return
        }
        showMainWindow(mainWindow)
        mainWindow.webContents.send('app:close-attempt', { intent: 'quit' as const })
      }
    },
    settingsStore?.get().uiLanguage ?? 'en'
  )
  // Quiet update checks once UI is up
  setTimeout(() => appUpdater.checkQuiet(), 4_000)
  setTimeout(() => {
    const path = settingsStore?.get().sdCppPath
    sdRuntime.checkQuiet(path)
  }, 5_000)

  try {
    await bootInference()
  } catch (err) {
    bootError = err instanceof Error ? err.message : String(err)
    console.error('[inference] boot failed', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow(mainWindow)
  })
})

app.on('window-all-closed', () => {
  // Tray keeps the app alive on Windows/Linux when the window is hidden.
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  destroyAppTray()
  terminals.killAll()
  folderWatcher?.close()
  void mcpManager?.dispose()
  void llama?.stop()
  void applyLlama?.stop()
  getLLMQueue().cancelAll('app_quit')
})

function cryptoRandomId(): string {
  return randomUUID()
}
