import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type * as Monaco from 'monaco-editor'
import { setupMonaco, AFK_SCROLLBAR, applyMonacoTheme } from './editor/monacoSetup'
import { registerMonacoFimProvider } from './editor/monacoFimProvider'
import { registerMonacoLspProviders } from './editor/monacoLspProviders'
import { applyRepoMarkers } from './editor/applyRepoMarkers'
import {
  applyCurrentLineDecoration,
  breakpointsToArray,
  wireBreakpointGutter
} from './editor/debugBreakpoints'
import { InlineEditModal } from './editor/InlineEditModal'
import { createTab, type EditorTab } from './editor/tabs'
import { SettingsView } from './components/SettingsView'
import { OnboardingWizard } from './components/OnboardingWizard'
import type { SettingsPageId } from './components/settings/nav'
import { RuntimeProgressOverlay } from './components/RuntimeProgressOverlay'
import {
  ChangelogModal,
  usePostUpdateChangelog
} from './components/ChangelogModal'
import { AboutDeveloperDialog } from './components/AboutDeveloperDialog'
import { UpdateAvailableBanner } from './components/UpdateAvailableBanner'
import { FileTree } from './components/FileTree'
import { AgentSidebar } from './components/AgentSidebar'
import { ConfirmDialog } from './components/ConfirmDialog'
import { TextNoticeDialog } from './components/TextNoticeDialog'
import thirdPartyNoticesMd from './legal/THIRD_PARTY_NOTICES.md?raw'
import noticeTxt from './legal/NOTICE.txt?raw'
import { HSplitHandle } from './hooks/HSplitHandle'
import { LAYOUT, useLayoutWidth } from './hooks/useLayoutWidth'
import { AgentRail, type AgentSessionMeta } from './components/AgentRail'
import { OutlinePanel } from './components/OutlinePanel'
import { TerminalPanel } from './components/TerminalPanel'
import { GitSidebar } from './components/GitSidebar'
import { BrowserPanel } from './components/BrowserPanel'
import { ProblemsPanel, countProblems, setRepoDiagnostics } from './components/ProblemsPanel'
import { DebugPanel, isDebuggablePath } from './components/DebugPanel'
import { WorkspacePlusMenu } from './components/WorkspacePlusMenu'
import { TitleBar, listMenuShortcuts, type TitleBarAction } from './components/TitleBar'
import { useI18n } from './i18n/I18nProvider'
import {
  localizeLlmState,
  localizeStatusDetail
} from './i18n/localizeStatusDetail'
import {
  CommandPalette,
  type PaletteCommand,
  type PaletteMode
} from './components/CommandPalette'
import { getQueueManager } from './llm/queueManager'
import type { EditorSelectionContext } from './agent/runAgentTurn'
import {
  isAgentGenerationBusy,
  stopAgentGeneration
} from './agent/agentBusyGate'
import type { LlmRuntimeStatus } from '../../shared/settings'
import type { GitStatus } from '../../shared/git'
import type { DebugSessionStatus } from '../../shared/debug'
import type { DiagnosticsSnapshot } from '../../shared/diagnostics'
import { changeLetter, isStagedChange, isUnstagedChange } from '../../shared/git'
import {
  applyDocumentTheme,
  migrateUiTheme,
  monacoThemeId,
  UI_THEME_LABELS,
  UI_THEMES,
  type UiTheme
} from '../../shared/theme'

setupMonaco()

const thirdPartyNoticesBody = `${noticeTxt.trim()}\n\n──\n\n${thirdPartyNoticesMd.trim()}`

type WorkspaceTab = 'code' | 'browser' | 'terminal'

export default function App(): React.JSX.Element {
  const { t } = useI18n()
  const changelog = usePostUpdateChangelog()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const fimDisposable = useRef<Monaco.IDisposable | null>(null)
  const lspDisposable = useRef<Monaco.IDisposable | null>(null)
  const bpDisposable = useRef<Monaco.IDisposable | null>(null)
  const saveRef = useRef<() => void>(() => undefined)
  const openSettingsRef = useRef<(page?: SettingsPageId) => void>(() => undefined)
  const breakpointsRef = useRef<Map<string, Set<number>>>(new Map())
  const currentLineDecoRef = useRef<string[]>([])
  const [inlineOpen, setInlineOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busyBlockHint, setBusyBlockHint] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [thirdPartyOpen, setThirdPartyOpen] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [developerOpen, setDeveloperOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [statusBarVisible, setStatusBarVisible] = useState(true)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPageId>('general')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [ideOpen, setIdeOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserNav, setBrowserNav] = useState<{ url: string; key: number } | null>(null)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugStatus, setDebugStatus] = useState<DebugSessionStatus>({ state: 'idle' })
  const [debugOutput, setDebugOutput] = useState('')
  const [diagSnap, setDiagSnap] = useState<DiagnosticsSnapshot | null>(null)
  const [problemCounts, setProblemCounts] = useState({ errors: 0, warnings: 0, total: 0 })
  const [scmOpen, setScmOpen] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('code')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('files')
  const [switchSessionSignal, setSwitchSessionSignal] = useState<{
    id: string
    nonce: number
  } | null>(null)
  const [sessionsByRoot, setSessionsByRoot] = useState<
    Record<string, AgentSessionMeta[]>
  >({})
  const [railActiveSessionId, setRailActiveSessionId] = useState<string | null>(null)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [recentRoots, setRecentRoots] = useState<string[]>([])
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [removeRootTarget, setRemoveRootTarget] = useState<string | null>(null)
  const [deleteChatTarget, setDeleteChatTarget] = useState<{
    root: string
    id: string
    title: string
  } | null>(null)
  const [closeConfirmIntent, setCloseConfirmIntent] = useState<'close' | 'quit' | null>(
    null
  )
  const [pickFolderForSend, setPickFolderForSend] = useState<{ text: string } | null>(null)
  const [pendingSendSignal, setPendingSendSignal] = useState<{
    text: string
    nonce: number
    restoreOnly?: boolean
  } | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitRefreshKey, setGitRefreshKey] = useState(0)
  const [gitFocusCommit, setGitFocusCommit] = useState(0)
  const [imagePreview, setImagePreview] = useState<{ url: string; name?: string } | null>(
    null
  )
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [status, setStatus] = useState<LlmRuntimeStatus | null>(null)
  const [uiTheme, setUiTheme] = useState<UiTheme>('classic')
  const [localApiEnabled, setLocalApiEnabled] = useState(false)
  const [railWidth, setRailWidth] = useLayoutWidth(
    LAYOUT.rail.key,
    LAYOUT.rail.fallback,
    LAYOUT.rail.min,
    LAYOUT.rail.max
  )
  const [workspaceWidth, setWorkspaceWidth] = useLayoutWidth(
    LAYOUT.workspace.key,
    LAYOUT.workspace.fallback,
    LAYOUT.workspace.min,
    LAYOUT.workspace.max
  )
  const [treeWidth, setTreeWidth] = useLayoutWidth(
    LAYOUT.tree.key,
    LAYOUT.tree.fallback,
    LAYOUT.tree.min,
    LAYOUT.tree.max
  )
  const [monacoReady, setMonacoReady] = useState(false)
  const [selection, setSelection] = useState<EditorSelectionContext | null>(null)
  const queue = getQueueManager()
  const activePathRef = useRef<string | null>(null)
  activePathRef.current = activePath

  const activeTab = activePath ? tabs.find((t) => t.path === activePath) : undefined
  const editorTheme = monacoThemeId(uiTheme)
  const workspaceVisible = ideOpen || browserOpen || terminalOpen

  useEffect(() => {
    void window.api.getVersion().then((v) => setAppVersion(String(v || '').trim()))
  }, [])

  useEffect(() => {
    if (workspaceTab === 'code' && !ideOpen) {
      if (terminalOpen) setWorkspaceTab('terminal')
      else if (browserOpen) setWorkspaceTab('browser')
    } else if (workspaceTab === 'browser' && !browserOpen) {
      if (ideOpen) setWorkspaceTab('code')
      else if (terminalOpen) setWorkspaceTab('terminal')
    } else if (workspaceTab === 'terminal' && !terminalOpen) {
      if (ideOpen) setWorkspaceTab('code')
      else if (browserOpen) setWorkspaceTab('browser')
    }
  }, [ideOpen, browserOpen, terminalOpen, workspaceTab])


  const rememberRoot = useCallback(async (root: string, base?: string[]): Promise<void> => {
    const from = base ?? recentRoots
    const next = [root, ...from.filter((r) => r !== root)].slice(0, 12)
    setRecentRoots(next)
    await window.api.settings.save({ recentRoots: next })
  }, [recentRoots])

  const setTheme = useCallback(async (theme: UiTheme): Promise<void> => {
    setUiTheme(theme)
    applyDocumentTheme(theme)
    applyMonacoTheme(theme)
    await window.api.settings.save({ uiTheme: theme })
  }, [])

  const refreshStatus = useCallback((): void => {
    void window.api.llm.status().then(setStatus)
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await window.api.settings.get()
      const theme = migrateUiTheme(s.uiTheme)
      setUiTheme(theme)
      setLocalApiEnabled(s.localApiEnabled === true)
      applyDocumentTheme(theme)
      applyMonacoTheme(theme)
      if (!s.setupComplete) setWizardOpen(true)
      const roots = s.recentRoots ?? []
      setRecentRoots(roots)
      // Main starts with no workspace — never auto-open cwd / AFKLLM.
      const root = await window.api.workspace.getRoot()
      if (root) setProjectRoot(root)
    })()
    return window.api.settings.onChanged((s) => {
      const theme = migrateUiTheme(s.uiTheme)
      setUiTheme(theme)
      setLocalApiEnabled(s.localApiEnabled === true)
      applyDocumentTheme(theme)
      applyMonacoTheme(theme)
      if (Array.isArray(s.recentRoots)) setRecentRoots(s.recentRoots)
      if (s.setupComplete) setWizardOpen(false)
    })
  }, [])

  // Re-apply when OS light/dark changes and theme preference is Auto
  useEffect(() => {
    if (uiTheme !== 'auto' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => {
      applyDocumentTheme('auto')
      applyMonacoTheme('auto')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [uiTheme])

  useEffect(() => {
    refreshStatus()
    // Idle: slow poll. Starting: faster so UI tracks load.
    const ms = status?.state === 'starting' ? 1_000 : 4_000
    const id = setInterval(refreshStatus, ms)
    return () => clearInterval(id)
  }, [refreshStatus, status?.state])

  const showBusyBlockHint = useCallback(
    (message: string): void => {
      setBusyBlockHint(message)
      window.setTimeout(() => {
        setBusyBlockHint((cur) => (cur === message ? null : cur))
      }, 3200)
    },
    []
  )

  const openSettings = useCallback(
    (page?: SettingsPageId): void => {
      if (isAgentGenerationBusy()) {
        showBusyBlockHint(t('confirm.busyBlockSettings'))
        return
      }
      setSettingsInitialPage(page ?? 'general')
      setSettingsOpen(true)
    },
    [showBusyBlockHint, t]
  )
  openSettingsRef.current = openSettings

  const unloadModel = async (): Promise<void> => {
    if (isAgentGenerationBusy()) {
      showBusyBlockHint(t('confirm.busyBlockUnload'))
      return
    }
    await queue.cancelAll()
    const next = await window.api.llm.unload()
    setStatus(next)
  }

  const reloadModel = async (): Promise<void> => {
    if (isAgentGenerationBusy()) {
      showBusyBlockHint(t('confirm.busyBlockUnload'))
      return
    }
    const next = await window.api.llm.restart()
    setStatus(next)
  }

  useEffect(() => {
    return window.api.terminal.onEnsureOpen(() => {
      setTerminalOpen(true)
      setWorkspaceTab('terminal')
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onOpenUrl((url) => {
      setBrowserOpen(true)
      setWorkspaceTab('browser')
      setBrowserNav({ url, key: Date.now() })
    })
  }, [])

  useEffect(() => {
    return window.api.app.onCloseAttempt(({ intent }) => {
      if (isAgentGenerationBusy()) {
        setCloseConfirmIntent(intent)
        return
      }
      if (intent === 'quit') {
        void window.api.app.quit()
        return
      }
      void window.api.window.hideToTray()
    })
  }, [])

  const confirmQuitDespiteGeneration = (): void => {
    setCloseConfirmIntent(null)
    stopAgentGeneration()
    window.setTimeout(() => {
      void window.api.app.quit()
    }, 150)
  }

  useEffect(() => {
    if (!monacoReady) return
    const tick = (): void => setProblemCounts(countProblems())
    tick()
    const sub = monaco.editor.onDidChangeMarkers(() => tick())
    return () => sub.dispose()
  }, [monacoReady, tabs, activePath])

  useEffect(() => {
    void window.api.diagnostics.get().then((snap) => {
      setRepoDiagnostics(snap)
      setDiagSnap(snap)
      setProblemCounts(countProblems())
    })
    return window.api.diagnostics.onChanged((snap) => {
      setRepoDiagnostics(snap)
      setDiagSnap(snap)
      setProblemCounts(countProblems())
    })
  }, [])

  useEffect(() => {
    if (!monacoReady) return
    applyRepoMarkers(diagSnap)
  }, [monacoReady, diagSnap, tabs, activePath])

  useEffect(() => {
    return window.api.debug.onEvent((ev) => {
      setDebugStatus(ev.status)
      if (ev.type === 'output' && ev.output) {
        setDebugOutput((prev) => (prev + ev.output).slice(-12_000))
      }
      if (ev.type === 'error' && ev.error) {
        setDebugOutput((prev) => (prev + `\n[error] ${ev.error}\n`).slice(-12_000))
      }
      if (ev.type === 'paused' && ev.status.stack?.[0]) {
        const top = ev.status.stack[0]
        if (top.path && top.line) {
          void openFileAtRef.current?.(top.path, top.line, top.column ?? 1)
          const ed = editorRef.current
          const monaco = monacoRef.current
          currentLineDecoRef.current = applyCurrentLineDecoration(
            ed,
            monaco,
            top.line,
            currentLineDecoRef.current
          )
        }
      }
      if (ev.type === 'resumed' || ev.type === 'exited') {
        currentLineDecoRef.current = applyCurrentLineDecoration(
          editorRef.current,
          monacoRef.current,
          null,
          currentLineDecoRef.current
        )
      }
    })
  }, [])

  const openFileAtRef = useRef<
    ((path: string, line?: number, column?: number) => Promise<void>) | null
  >(null)

  useEffect(() => {
    return () => {
      fimDisposable.current?.dispose()
      lspDisposable.current?.dispose()
      bpDisposable.current?.dispose()
    }
  }, [])

  const saveActive = useCallback(async () => {
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    const content = editorRef.current?.getValue() ?? tab.content
    const res = await window.api.workspace.writeFile(tab.path, content)
    if (res.ok) {
      setTabs((prev) =>
        prev.map((t) => (t.path === tab.path ? { ...t, content, dirty: false } : t))
      )
      setGitRefreshKey((n) => n + 1)
      return
    }
    showBusyBlockHint(res.error || t('editor.saveFailed'))
  }, [tabs, activePath, showBusyBlockHint, t])

  saveRef.current = () => {
    void saveActive()
  }

  const refreshGit = useCallback(async () => {
    if (!projectRoot) {
      setGitStatus(null)
      return
    }
    try {
      const st = await window.api.git.status()
      setGitStatus(st)
    } catch {
      setGitStatus(null)
    }
  }, [projectRoot])

  useEffect(() => {
    void refreshGit()
    const id = setInterval(() => void refreshGit(), 8_000)
    return () => clearInterval(id)
  }, [refreshGit, projectRoot, gitRefreshKey])

  useEffect(() => {
    return window.api.workspace.onChanged(() => {
      setGitRefreshKey((n) => n + 1)
    })
  }, [])

  const gitMarks = useMemo(() => {
    const marks: Record<string, string> = {}
    if (!gitStatus?.available) return marks
    for (const f of gitStatus.files) {
      const letter = isUnstagedChange(f)
        ? changeLetter(f, 'worktree')
        : isStagedChange(f)
          ? changeLetter(f, 'index')
          : 'M'
      marks[f.path] = letter
    }
    return marks
  }, [gitStatus])

  const openScm = useCallback(() => {
    setScmOpen(true)
  }, [])

  const closeTab = useCallback(
    (path: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      const key = path.replace(/\\/g, '/')
      setTabs((prev) => {
        const next = prev.filter((t) => t.path.replace(/\\/g, '/') !== key)
        const activeKey = activePath?.replace(/\\/g, '/')
        if (activeKey === key) {
          const idx = prev.findIndex((t) => t.path.replace(/\\/g, '/') === key)
          const fallback = next[Math.max(0, idx - 1)] ?? next[0]
          setActivePath(fallback?.path ?? null)
        }
        return next
      })
    },
    [activePath]
  )

  useEffect(() => {
    return window.api.workspace.onFileDeleted(({ path }) => {
      closeTab(path)
    })
  }, [closeTab])

  const renameTab = useCallback((from: string, to: string) => {
    const tab = createTab(to, '')
    setTabs((prev) =>
      prev.map((t) =>
        t.path === from
          ? { ...t, path: tab.path, name: tab.name, language: tab.language }
          : t
      )
    )
    setActivePath((cur) => (cur === from ? tab.path : cur))
  }, [])

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setMonacoReady(true)

    const syncSelection = (): void => {
      const path = activePathRef.current
      if (!path) {
        setSelection(null)
        return
      }
      const sel = editor.getSelection()
      if (!sel || sel.isEmpty()) {
        setSelection(null)
        return
      }
      const model = editor.getModel()
      if (!model) {
        setSelection(null)
        return
      }
      const text = model.getValueInRange(sel)
      if (!text.trim()) {
        setSelection(null)
        return
      }
      setSelection({
        path,
        text: text.slice(0, 4000),
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber
      })
    }

    editor.onDidChangeCursorSelection(() => syncSelection())
    syncSelection()

    fimDisposable.current?.dispose()
    fimDisposable.current = registerMonacoFimProvider(monaco, {
      queue,
      getFilePath: () => activePathRef.current ?? '',
      getEditor: () => editorRef.current
    })

    lspDisposable.current?.dispose()
    lspDisposable.current = registerMonacoLspProviders(monaco, {
      openAt: (path, line, column) => {
        void openFileAtRef.current?.(path, line, column)
      }
    })

    bpDisposable.current?.dispose()
    editor.updateOptions({ glyphMargin: true })
    bpDisposable.current = wireBreakpointGutter(editor, monaco, {
      getPath: () => activePathRef.current,
      getBreakpoints: () => breakpointsRef.current,
      setBreakpoints: (next) => {
        breakpointsRef.current = next
      },
      onChanged: () => {
        void window.api.debug.setBreakpoints(
          breakpointsToArray(breakpointsRef.current)
        )
      }
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => setInlineOpen(true))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Comma, () =>
      openSettingsRef.current()
    )
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, () => {
      setTerminalOpen((v) => !v)
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
      if (activePath) closeTab(activePath)
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
      setPaletteMode('files')
      setPaletteOpen(true)
    })
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      () => {
        setPaletteMode('commands')
        setPaletteOpen(true)
      }
    )
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => {
        setPaletteMode('search')
        setPaletteOpen(true)
      }
    )
    editor.addCommand(monaco.KeyCode.F9, () => {
      const path = activePathRef.current
      const line = editor.getPosition()?.lineNumber
      if (!path || !line) return
      const next = new Map(breakpointsRef.current)
      const set = new Set(next.get(path) ?? [])
      if (set.has(line)) set.delete(line)
      else set.add(line)
      if (set.size === 0) next.delete(path)
      else next.set(path, set)
      breakpointsRef.current = next
      void window.api.debug.setBreakpoints(breakpointsToArray(next))
      bpDisposable.current?.dispose()
      bpDisposable.current = wireBreakpointGutter(editor, monaco, {
        getPath: () => activePathRef.current,
        getBreakpoints: () => breakpointsRef.current,
        setBreakpoints: (n) => {
          breakpointsRef.current = n
        },
        onChanged: () => {
          void window.api.debug.setBreakpoints(
            breakpointsToArray(breakpointsRef.current)
          )
        }
      })
    })

    editor.updateOptions({
      inlineSuggest: { enabled: true },
      glyphMargin: true,
      fontFamily: '"IBM Plex Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      padding: { top: 10 },
      automaticLayout: true,
      tabCompletion: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      cursorBlinking: 'smooth',
      scrollbar: AFK_SCROLLBAR,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false
    })
    monaco.editor.setTheme(monacoThemeId(uiTheme))
  }

  const switchRoot = useCallback(
    async (root: string) => {
      setProjectRoot(root)
      setIdeOpen(true)
      setWorkspaceTab('code')
      await window.api.workspace.setRoot(root)
      setTabs([])
      setActivePath(null)
      setGitRefreshKey((n) => n + 1)
      await rememberRoot(root)
    },
    [rememberRoot]
  )

  const refreshSessionsByRoot = useCallback(async (roots: string[]): Promise<void> => {
    if (roots.length === 0) {
      setSessionsByRoot({})
      return
    }
    try {
      const map = await window.api.chats.listByRoots(roots)
      setSessionsByRoot(map)
    } catch (e) {
      console.error('Failed to list chats by roots', e)
    }
  }, [])

  useEffect(() => {
    void refreshSessionsByRoot(recentRoots)
    return window.api.chats.onChanged(() => {
      void refreshSessionsByRoot(recentRoots)
    })
  }, [recentRoots, refreshSessionsByRoot])

  useEffect(() => {
    if (projectRoot) {
      setIdeOpen(true)
      setWorkspaceTab('code')
    }
  }, [projectRoot])

  const onSessionsChange = useCallback(
    (sessions: AgentSessionMeta[], activeId: string | null) => {
      setRailActiveSessionId(activeId)
      if (projectRoot) {
        setSessionsByRoot((prev) => ({ ...prev, [projectRoot]: sessions }))
      }
    },
    [projectRoot]
  )

  const newAgentInRoot = useCallback(
    (root: string) => {
      void (async () => {
        const same =
          projectRoot != null &&
          projectRoot.replace(/\\/g, '/').toLowerCase() ===
            root.replace(/\\/g, '/').toLowerCase()
        if (!same) await switchRoot(root)
        // Create after workspace switch so the session lands in this repo.
        await window.api.chats.create()
        void refreshSessionsByRoot(recentRoots)
      })()
    },
    [projectRoot, switchRoot, recentRoots, refreshSessionsByRoot]
  )

  const selectSessionInRoot = useCallback(
    (root: string, id: string) => {
      void (async () => {
        const same =
          projectRoot != null &&
          projectRoot.replace(/\\/g, '/').toLowerCase() ===
            root.replace(/\\/g, '/').toLowerCase()
        if (!same) {
          await switchRoot(root)
          await window.api.chats.setActive(id)
          return
        }
        setSwitchSessionSignal({ id, nonce: Date.now() })
      })()
    },
    [projectRoot, switchRoot]
  )

  const deleteSessionInRoot = useCallback((root: string, id: string) => {
    const sessions = sessionsByRoot[root] ?? []
    const title = sessions.find((s) => s.id === id)?.title || t('chat.newAgent')
    setDeleteChatTarget({ root, id, title })
  }, [sessionsByRoot, t])

  const confirmDeleteChat = useCallback(async () => {
    const target = deleteChatTarget
    if (!target) return
    setDeleteChatTarget(null)
    const { root, id } = target
    const same =
      projectRoot != null &&
      projectRoot.replace(/\\/g, '/').toLowerCase() ===
        root.replace(/\\/g, '/').toLowerCase()
    if (!same) await switchRoot(root)
    await window.api.chats.delete(id)
    void refreshSessionsByRoot(recentRoots)
  }, [deleteChatTarget, projectRoot, switchRoot, recentRoots, refreshSessionsByRoot])

  const openFolder = useCallback(async () => {
    const root = await window.api.workspace.pickFolder()
    if (!root) return
    await switchRoot(root)
  }, [switchRoot])

  /** Remove from recentRoots + wipe that repo's chats — never deletes disk files. */
  const confirmRemoveRoot = useCallback(async () => {
    const root = removeRootTarget
    if (!root) return
    setRemoveRootTarget(null)

    const norm = (p: string): string =>
      p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const key = norm(root)
    const next = recentRoots.filter((r) => norm(r) !== key)
    const wasActive = projectRoot != null && norm(projectRoot) === key

    setRecentRoots(next)
    if (wasActive && !next[0]) {
      setProjectRoot(null)
      setTabs([])
      setActivePath(null)
      setIdeOpen(false)
      setBrowserOpen(false)
      setTerminalOpen(false)
      setScmOpen(false)
      try {
        await window.api.workspace.clearRoot()
      } catch (e) {
        console.error('Failed to clear workspace root', e)
      }
    }

    try {
      await window.api.settings.save({ recentRoots: next })
    } catch (e) {
      console.error('Failed to save recentRoots', e)
    }
    try {
      await window.api.chats.forgetRoot(root)
    } catch (e) {
      console.error('Failed to forget chat root', e)
    }

    if (wasActive && next[0]) {
      await switchRoot(next[0])
    }
  }, [removeRootTarget, recentRoots, projectRoot, switchRoot])

  const needsFolderToChat = !projectRoot

  const requestFolderForSend = useCallback((text: string) => {
    setPickFolderForSend({ text })
  }, [])

  const confirmPickFolderForSend = useCallback(async () => {
    const pending = pickFolderForSend
    if (!pending) return
    setPickFolderForSend(null)
    const root = await window.api.workspace.pickFolder()
    if (!root) {
      setPendingSendSignal({ text: pending.text, nonce: Date.now(), restoreOnly: true })
      return
    }
    await switchRoot(root)
    setPendingSendSignal({ text: pending.text, nonce: Date.now() })
  }, [pickFolderForSend, switchRoot])

  const openFile = useCallback(async (relativePath: string) => {
    const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(rel)) {
      try {
        const root = await window.api.workspace.getRoot()
        if (!root) {
          console.error('No workspace root to open image')
          return
        }
        const abs = `${root.replace(/[\\/]+$/, '')}/${rel}`
        const url = await window.api.chatImages.readDataUrl(abs)
        setImagePreview({ url, name: rel.split('/').pop() || rel })
      } catch (err) {
        console.error('Failed to open image from tree', err)
      }
      return
    }
    const res = await window.api.workspace.readFile(rel)
    if (!res.ok) {
      console.error(res.error)
      return
    }
    setIdeOpen(true)
    setWorkspaceTab('code')
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === rel)
      if (existing) {
        if (existing.dirty) return prev
        return prev.map((t) =>
          t.path === rel ? { ...t, content: res.content, dirty: false } : t
        )
      }
      return [...prev, createTab(rel, res.content)]
    })
    setActivePath(rel)
  }, [])

  const openFileAt = useCallback(
    async (rawPath: string, line?: number, column?: number) => {
      const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
      const match =
        tabs.find(
          (t) =>
            t.path === normalized ||
            normalized.endsWith('/' + t.path) ||
            normalized.endsWith(t.path) ||
            t.path.endsWith(normalized)
        )?.path ?? normalized.replace(/^.*?:/, '')
      const rel = match.includes('/') || !match.includes(':') ? match : normalized
      await openFile(rel)
      if (line && line > 0) {
        setTimeout(() => {
          const ed = editorRef.current
          if (!ed) return
          ed.revealLineInCenter(line)
          ed.setPosition({ lineNumber: line, column: column && column > 0 ? column : 1 })
          ed.focus()
        }, 120)
      }
    },
    [openFile, tabs]
  )
  openFileAtRef.current = openFileAt

  const startDebug = useCallback(async () => {
    if (!isDebuggablePath(activePath)) {
      setDebugOpen(true)
      setDebugStatus({
        state: 'error',
        message: 'Open a .js / .ts file to debug'
      })
      return
    }
    setDebugOpen(true)
    setDebugOutput('')
    setIdeOpen(true)
    setWorkspaceTab('code')
    const res = await window.api.debug.start({
      entry: activePath!,
      breakpoints: breakpointsToArray(breakpointsRef.current)
    })
    setDebugStatus(res.status)
    if (!res.ok && res.error) {
      setDebugOutput(`[error] ${res.error}\n`)
    }
  }, [activePath])

  const handleChange = (value: string | undefined): void => {
    if (value === undefined || !activePath) return
    setTabs((prev) =>
      prev.map((t) => (t.path === activePath ? { ...t, content: value, dirty: true } : t))
    )
  }

  const openPalette = useCallback((mode: PaletteMode): void => {
    setPaletteMode(mode)
    setPaletteOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === '`') {
        e.preventDefault()
        setTerminalOpen((v) => {
          const next = !v
          if (next) setWorkspaceTab('terminal')
          return next
        })
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openPalette('search')
        return
      }
      if (!mod || e.key.toLowerCase() !== 'p') return
      e.preventDefault()
      openPalette(e.shiftKey ? 'commands' : 'files')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPalette])

  const paletteCommands: PaletteCommand[] = useMemo(
    () => [
      {
        id: 'ide.toggle',
        label: 'Toggle IDE',
        run: () => {
          setIdeOpen((v) => {
            if (!v) setWorkspaceTab('code')
            return !v
          })
        }
      },
      {
        id: 'browser.toggle',
        label: 'Toggle Browser',
        run: () => {
          setBrowserOpen((v) => {
            if (!v) setWorkspaceTab('browser')
            return !v
          })
        }
      },
      {
        id: 'terminal.toggle',
        label: 'Toggle Terminal',
        hint: 'Ctrl+`',
        run: () => {
          setTerminalOpen((v) => {
            const next = !v
            if (next) setWorkspaceTab('terminal')
            return next
          })
        }
      },
      {
        id: 'sidebar.scm',
        label: 'Show Source Control',
        run: () => openScm()
      },
      {
        id: 'git.refresh',
        label: 'Refresh Git Status',
        run: () => setGitRefreshKey((n) => n + 1)
      },
      {
        id: 'git.stageAll',
        label: 'Git: Stage All',
        run: () => {
          openScm()
          void window.api.git.stageAll().then(() => setGitRefreshKey((n) => n + 1))
        }
      },
      {
        id: 'git.commit',
        label: 'Git: Commit…',
        run: () => {
          openScm()
          setGitFocusCommit((n) => n + 1)
        }
      },
      {
        id: 'git.fetch',
        label: 'Git: Fetch',
        run: () => {
          openScm()
          void window.api.git.fetch().then(() => setGitRefreshKey((n) => n + 1))
        }
      },
      {
        id: 'git.pull',
        label: 'Git: Pull',
        run: () => {
          openScm()
          void window.api.git.pull().then(() => setGitRefreshKey((n) => n + 1))
        }
      },
      {
        id: 'git.push',
        label: 'Git: Push',
        run: () => {
          openScm()
          void window.api.git.push().then(() => setGitRefreshKey((n) => n + 1))
        }
      },
      {
        id: 'search.findInFiles',
        label: 'Find in Files',
        hint: 'Ctrl+Shift+F',
        run: () => openPalette('search')
      },
      {
        id: 'problems.toggle',
        label: 'Toggle Problems',
        run: () => {
          setIdeOpen(true)
          setWorkspaceTab('code')
          setProblemsOpen((v) => !v)
        }
      },
      {
        id: 'debug.toggle',
        label: 'Toggle Debug Panel',
        run: () => {
          setIdeOpen(true)
          setWorkspaceTab('code')
          setDebugOpen((v) => !v)
        }
      },
      {
        id: 'debug.start',
        label: 'Debug: Start',
        run: () => void startDebug()
      },
      {
        id: 'debug.stop',
        label: 'Debug: Stop',
        run: () => void window.api.debug.stop().then(setDebugStatus)
      },
      {
        id: 'editor.goToDefinition',
        label: 'Go to Definition',
        hint: 'F12',
        run: () => {
          editorRef.current?.trigger('afkllm', 'editor.action.revealDefinition', null)
        }
      },
      {
        id: 'editor.findReferences',
        label: 'Find References',
        hint: 'Shift+F12',
        run: () => {
          editorRef.current?.trigger(
            'afkllm',
            'editor.action.goToReferences',
            null
          )
        }
      },
      {
        id: 'editor.goToSymbol',
        label: 'Go to Symbol in File…',
        hint: 'Ctrl+Shift+O',
        run: () => {
          editorRef.current?.trigger(
            'afkllm',
            'editor.action.quickOutline',
            null
          )
        }
      },
      {
        id: 'outline.toggle',
        label: 'Toggle Outline',
        run: () => {
          setIdeOpen(true)
          setWorkspaceTab('code')
          setOutlineOpen((v) => !v)
        }
      },
      {
        id: 'agent.new',
        label: 'New Agent',
        run: () => {
          if (projectRoot) newAgentInRoot(projectRoot)
          else void openFolder()
        }
      },
      {
        id: 'folder.open',
        label: 'Open Folder…',
        run: () => void openFolder()
      },
      {
        id: 'settings.open',
        label: 'Open Settings',
        hint: 'Ctrl+,',
        run: () => openSettings()
      },
      ...UI_THEMES.map(
        (t): PaletteCommand => ({
          id: `theme.${t}`,
          label: `Theme: ${UI_THEME_LABELS[t]}`,
          run: () => void setTheme(t)
        })
      ),
      {
        id: 'model.load',
        label: 'Load Model',
        run: () => void reloadModel()
      },
      {
        id: 'model.unload',
        label: 'Unload Model',
        run: () => void unloadModel()
      }
    ],
    [openFolder, openScm, setTheme, startDebug, projectRoot, newAgentInRoot, openSettings, reloadModel, unloadModel]
  )

  const stateColor =
    status?.state === 'ready'
      ? 'text-emerald-400'
      : status?.state === 'error' || status?.state === 'stopped'
        ? 'text-rose-400'
        : 'text-amber-400'

  const plusMenu = (
    <WorkspacePlusMenu
      ideOpen={ideOpen}
      browserOpen={browserOpen}
      terminalOpen={terminalOpen}
      scmOpen={scmOpen}
      debugOpen={debugOpen}
      onToggleIde={() => {
        setIdeOpen((v) => {
          const next = !v
          if (next) setWorkspaceTab('code')
          return next
        })
      }}
      onToggleBrowser={() => {
        setBrowserOpen((v) => {
          const next = !v
          if (next) setWorkspaceTab('browser')
          return next
        })
      }}
      onToggleTerminal={() => {
        setTerminalOpen((v) => {
          const next = !v
          if (next) setWorkspaceTab('terminal')
          return next
        })
      }}
      onToggleScm={() => setScmOpen((v) => !v)}
      onToggleDebug={() => {
        setIdeOpen(true)
        setWorkspaceTab('code')
        setDebugOpen((v) => !v)
      }}
    />
  )

  const onTitleBarAction = useCallback(
    (action: TitleBarAction) => {
      switch (action) {
        case 'newAgent':
          if (projectRoot) newAgentInRoot(projectRoot)
          else void openFolder()
          break
        case 'openFolder':
          void openFolder()
          break
        case 'newTerminal':
          setTerminalOpen(true)
          setWorkspaceTab('terminal')
          break
        case 'newBrowser':
          setBrowserOpen(true)
          setWorkspaceTab('browser')
          setBrowserNav({ url: 'about:blank', key: Date.now() })
          break
        case 'openIde':
          setIdeOpen(true)
          setWorkspaceTab('code')
          break
        case 'exit':
          void window.api.app.requestQuit()
          break
        case 'undo':
          document.execCommand('undo')
          break
        case 'redo':
          document.execCommand('redo')
          break
        case 'cut':
          document.execCommand('cut')
          break
        case 'copy':
          document.execCommand('copy')
          break
        case 'paste':
          document.execCommand('paste')
          break
        case 'selectAll':
          document.execCommand('selectAll')
          break
        case 'changes':
          setScmOpen(true)
          break
        case 'browser':
          setBrowserOpen(true)
          setWorkspaceTab('browser')
          break
        case 'files':
          setIdeOpen(true)
          setWorkspaceTab('code')
          break
        case 'terminal':
          setTerminalOpen(true)
          setWorkspaceTab('terminal')
          break
        case 'toggleStatusBar':
          setStatusBarVisible((v) => !v)
          break
        case 'zoomIn':
          void window.api.window.zoom(0.1)
          break
        case 'zoomOut':
          void window.api.window.zoom(-0.1)
          break
        case 'zoomReset':
          void window.api.window.zoomReset()
          break
        case 'settings':
          openSettings()
          break
        case 'commandPalette':
          openPalette('commands')
          break
        case 'keyboardShortcuts':
          setShortcutsOpen(true)
          break
        case 'viewVersion':
          setVersionOpen(true)
          break
        case 'viewDeveloper':
          setDeveloperOpen(true)
          break
        case 'viewLicense':
          setLicenseOpen(true)
          break
        case 'viewThirdParty':
          setThirdPartyOpen(true)
          break
        default:
          break
      }
    },
    [openFolder, projectRoot, newAgentInRoot, openPalette, openSettings]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target
      const typing =
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)

      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (mod && e.shiftKey && (key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        onTitleBarAction('newTerminal')
        return
      }
      if (mod && e.shiftKey && key === 'n') {
        e.preventDefault()
        onTitleBarAction('openIde')
        return
      }
      if (mod && e.shiftKey && key === 'b') {
        e.preventDefault()
        onTitleBarAction('browser')
        return
      }
      if (mod && e.shiftKey && (key === '/' || key === '?')) {
        e.preventDefault()
        onTitleBarAction('keyboardShortcuts')
        return
      }
      if (mod && key === 'n' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('newAgent')
        return
      }
      if (mod && key === 'o' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('openFolder')
        return
      }
      if (mod && key === 'e' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('changes')
        return
      }
      if (mod && key === 'g' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('files')
        return
      }
      if (mod && key === 'j' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('terminal')
        return
      }
      if (mod && key === 'k' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('commandPalette')
        return
      }
      if (mod && key === ',') {
        e.preventDefault()
        onTitleBarAction('settings')
        return
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault()
        onTitleBarAction('zoomIn')
        return
      }
      if (mod && key === '-') {
        e.preventDefault()
        onTitleBarAction('zoomOut')
        return
      }
      if (mod && key === '0') {
        e.preventDefault()
        onTitleBarAction('zoomReset')
        return
      }

      // Edit shortcuts — let the focused field handle them unless we need Monaco
      if (typing) return
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        onTitleBarAction('undo')
      } else if (mod && key === 'y') {
        e.preventDefault()
        onTitleBarAction('redo')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onTitleBarAction])

  return (
    <div className="relative flex h-full flex-col bg-ink-950 text-ink-bright">
      <TitleBar
        onAction={onTitleBarAction}
        statusBarVisible={statusBarVisible}
        appVersion={appVersion}
      />
      <UpdateAvailableBanner />
      <div className="flex min-h-0 flex-1">
        <AgentRail
          width={railWidth}
          sessionsByRoot={sessionsByRoot}
          activeSessionId={railActiveSessionId}
          roots={recentRoots}
          activeRoot={projectRoot}
          onNewAgentInRoot={newAgentInRoot}
          onSelectSession={selectSessionInRoot}
          onDeleteSession={deleteSessionInRoot}
          onSelectRoot={(root) => void switchRoot(root)}
          onRemoveRoot={(root) => setRemoveRootTarget(root)}
          onSearch={() => openPalette('search')}
          onOpenFolder={() => void openFolder()}
          onSettings={() => openSettings()}
          llmState={status?.state}
        />
        <HSplitHandle
          title="Resize repositories"
          onDrag={(dx) => setRailWidth((w) => w + dx)}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="flex h-full min-w-0 flex-1 flex-col" style={{ minWidth: LAYOUT.chatMin }}>
              <AgentSidebar
                queue={queue}
                llmReady={status?.state === 'ready'}
                ctxSize={status?.ctxSize}
                editorTheme={editorTheme}
                openFile={
                  activeTab
                    ? { path: activeTab.path, content: activeTab.content }
                    : undefined
                }
                selection={selection}
                onOpenPath={(p) => void openFile(p)}
                switchSessionSignal={switchSessionSignal}
                hideSessionChrome
                onSessionsChange={onSessionsChange}
                headerActions={plusMenu}
                workspaceKey={projectRoot}
                gitBranch={gitStatus?.available ? gitStatus.branch ?? null : null}
                needsFolderToChat={needsFolderToChat}
                onRequestFolderForSend={requestFolderForSend}
                pendingSendSignal={pendingSendSignal}
                onOpenFolder={() => void openFolder()}
                onOpenImagePreview={(url, name) => setImagePreview({ url, name })}
                onOpenImageGenSettings={() => openSettings('agent')}
              />
            </div>

            {workspaceVisible && (
              <>
                <HSplitHandle
                  title="Resize IDE"
                  onDrag={(dx) => {
                    const maxWs = Math.max(
                      LAYOUT.workspace.min,
                      window.innerWidth - railWidth - LAYOUT.chatMin - 24
                    )
                    setWorkspaceWidth((w) => Math.min(maxWs, w - dx))
                  }}
                />
                <div
                  className="flex min-w-0 shrink-0 flex-col"
                  style={{ width: workspaceWidth }}
                >
                <div className="flex h-8 shrink-0 items-center gap-1 border-b border-ink-line bg-ink-950 px-2">
                  {ideOpen && (
                    <button
                      type="button"
                      onClick={() => setWorkspaceTab('code')}
                      className={
                        'rounded px-2 py-0.5 font-mono text-[10px] ' +
                        (workspaceTab === 'code'
                          ? 'bg-ink-800 text-ink-bright'
                          : 'text-ink-mute hover:text-ink-soft')
                      }
                    >
                      Code
                    </button>
                  )}
                  {browserOpen && (
                    <button
                      type="button"
                      onClick={() => setWorkspaceTab('browser')}
                      className={
                        'rounded px-2 py-0.5 font-mono text-[10px] ' +
                        (workspaceTab === 'browser'
                          ? 'bg-ink-800 text-ink-bright'
                          : 'text-ink-mute hover:text-ink-soft')
                      }
                    >
                      Browser
                    </button>
                  )}
                  {terminalOpen && (
                    <button
                      type="button"
                      onClick={() => setWorkspaceTab('terminal')}
                      className={
                        'rounded px-2 py-0.5 font-mono text-[10px] ' +
                        (workspaceTab === 'terminal'
                          ? 'bg-ink-800 text-ink-bright'
                          : 'text-ink-mute hover:text-ink-soft')
                      }
                    >
                      Terminal
                    </button>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-ink-mute">
                    {projectRoot
                      ? projectRoot.replace(/\\/g, '/').split('/').pop()
                      : 'no folder'}
                  </span>
                </div>

                <div className="flex min-h-0 flex-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {workspaceTab === 'terminal' && terminalOpen ? (
                      <TerminalPanel
                        fill
                        open
                        cwd={projectRoot}
                        uiTheme={uiTheme}
                        onClose={() => {
                          setTerminalOpen(false)
                          setWorkspaceTab(ideOpen ? 'code' : browserOpen ? 'browser' : 'code')
                        }}
                      />
                    ) : workspaceTab === 'browser' && browserOpen ? (
                      <BrowserPanel
                        open
                        navigateUrl={browserNav?.url ?? null}
                        navigateKey={browserNav?.key ?? 0}
                      />
                    ) : (
                      <main className="relative flex min-h-0 flex-1 flex-col bg-ink-900">
                        <div className="afk-scroll-hidden flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-ink-line bg-ink-950 px-1 pt-1">
                          {tabs.length === 0 ? (
                            <span className="px-2 py-1.5 font-mono text-[11px] text-ink-mute">
                              Open a file from the tree
                            </span>
                          ) : (
                            tabs.map((tab) => (
                              <div
                                key={tab.path}
                                className={`group flex max-w-[200px] items-center rounded-t ${
                                  tab.path === activePath
                                    ? 'bg-ink-900 text-ink-bright'
                                    : 'text-ink-mute hover:bg-ink-900/60 hover:text-ink-soft'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => setActivePath(tab.path)}
                                  className="truncate px-2 py-1.5 font-mono text-[11px]"
                                  title={tab.path}
                                >
                                  {tab.dirty ? '● ' : ''}
                                  {tab.name}
                                </button>
                                <button
                                  type="button"
                                  title="Close"
                                  onClick={(e) => closeTab(tab.path, e)}
                                  className="mr-1 px-1 font-mono text-[10px] text-ink-mute opacity-60 hover:text-rose-400 group-hover:opacity-100"
                                >
                                  ×
                                </button>
                              </div>
                            ))
                          )}
                        </div>

                        <div className="relative min-h-0 flex-1">
                          {!activeTab ? (
                            <div className="flex h-full items-center justify-center font-mono text-xs text-ink-mute">
                              No file open — pick one in the explorer
                            </div>
                          ) : (
                            <>
                              {!monacoReady && (
                                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink-900 font-mono text-xs text-ink-mute">
                                  Booting editor…
                                </div>
                              )}
                              <Editor
                                key={activeTab.path}
                                path={activeTab.path}
                                language={activeTab.language}
                                value={activeTab.content}
                                theme={editorTheme}
                                loading={
                                  <span className="font-mono text-xs text-ink-mute">
                                    Booting editor…
                                  </span>
                                }
                                onMount={onMount}
                                onChange={handleChange}
                                options={{
                                  inlineSuggest: { enabled: true },
                                  glyphMargin: true,
                                  hover: { enabled: true, delay: 250 },
                                  scrollbar: AFK_SCROLLBAR,
                                  overviewRulerLanes: 3,
                                  hideCursorInOverviewRuler: false,
                                  overviewRulerBorder: false
                                }}
                              />
                              <InlineEditModal
                                open={inlineOpen}
                                onClose={() => setInlineOpen(false)}
                                editor={editorRef.current}
                                filePath={activeTab.path}
                                queue={queue}
                                editorTheme={editorTheme}
                                applyReady={status?.applyState === 'ready'}
                                onAccept={({ content }) => {
                                  setTabs((prev) =>
                                    prev.map((t) =>
                                      t.path === activeTab.path
                                        ? { ...t, content, dirty: true }
                                        : t
                                    )
                                  )
                                }}
                              />
                            </>
                          )}
                        </div>
                      </main>
                    )}
                  </div>

                  {ideOpen && workspaceTab === 'code' && (
                    <>
                      <HSplitHandle
                        title="Resize file tree"
                        onDrag={(dx) => {
                          const maxTree = Math.max(
                            LAYOUT.tree.min,
                            workspaceWidth - 160
                          )
                          setTreeWidth((w) => Math.min(maxTree, w - dx))
                        }}
                      />
                      <div
                        className="flex h-full shrink-0 flex-col"
                        style={{ width: treeWidth }}
                      >
                        <div className="flex min-h-0 flex-1 flex-col">
                          <div className="min-h-0 flex-1 overflow-hidden">
                            <FileTree
                              fill
                              root={projectRoot}
                              activePath={activePath}
                              onOpenFile={(p) => void openFile(p)}
                              onOpenFolder={() => void openFolder()}
                              onFileDeleted={(path) => closeTab(path)}
                              onFileRenamed={renameTab}
                              gitMarks={gitMarks}
                            />
                          </div>
                          {outlineOpen && (
                            <OutlinePanel
                              path={activePath}
                              onOpenAt={(path, line, column) =>
                                void openFileAt(path, line, column)
                              }
                            />
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {ideOpen && workspaceTab === 'code' && (
                  <>
                    <ProblemsPanel
                      open={problemsOpen}
                      onClose={() => setProblemsOpen(false)}
                      onOpenAt={(path, line, column) => void openFileAt(path, line, column)}
                    />
                    <DebugPanel
                      open={debugOpen}
                      onClose={() => setDebugOpen(false)}
                      status={debugStatus}
                      output={debugOutput}
                      activePath={activePath}
                      canStart={isDebuggablePath(activePath)}
                      onStart={() => void startDebug()}
                      onStop={() => void window.api.debug.stop().then(setDebugStatus)}
                      onContinue={() => void window.api.debug.continue().then(setDebugStatus)}
                      onStepOver={() => void window.api.debug.stepOver().then(setDebugStatus)}
                      onStepInto={() => void window.api.debug.stepInto().then(setDebugStatus)}
                      onOpenFrame={(f) => {
                        if (f.path && f.line) {
                          void openFileAt(f.path, f.line, f.column ?? 1)
                        }
                      }}
                    />
                  </>
                )}
              </div>
              </>
            )}
          </div>

          {scmOpen && (
            <div className="absolute inset-y-0 left-0 z-30 flex w-[min(380px,90vw)] flex-col border-r border-ink-line bg-ink-950 shadow-2xl">
              <div className="flex h-8 items-center justify-between border-b border-ink-line px-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  Source Control
                </span>
                <button
                  type="button"
                  onClick={() => setScmOpen(false)}
                  className="font-mono text-[10px] text-ink-mute hover:text-ink-bright"
                >
                  Close
                </button>
              </div>
              <GitSidebar
                root={projectRoot}
                refreshKey={gitRefreshKey}
                focusCommit={gitFocusCommit}
                editorTheme={editorTheme}
                onOpenFile={(p) => void openFile(p)}
                onStatus={setGitStatus}
              />
            </div>
          )}
        </div>
      </div>

      {statusBarVisible && (
      <footer className="relative z-40 flex h-7 shrink-0 items-center gap-3 border-t border-ink-line px-3 font-mono text-[10px] text-ink-mute">
        <button
          type="button"
          onClick={openScm}
          title={
            gitStatus?.available
              ? t('status.git.title', {
                  branch: `${gitStatus.branch ?? 'git'}${
                    gitStatus.ahead != null || gitStatus.behind != null
                      ? ` · ↑${gitStatus.ahead ?? 0} ↓${gitStatus.behind ?? 0}`
                      : ''
                  }`,
                  staged: gitStatus.stagedCount,
                  changes: gitStatus.unstagedCount
                })
              : t('status.git.sourceControl')
          }
          className="max-w-[240px] truncate text-left hover:text-ink-bright"
        >
          {gitStatus?.available
            ? `⎇ ${gitStatus.branch ?? '?'}${
                gitStatus.ahead != null || gitStatus.behind != null
                  ? ` ↑${gitStatus.ahead ?? 0} ↓${gitStatus.behind ?? 0}`
                  : ''
              } · ${gitStatus.stagedCount + gitStatus.unstagedCount}`
            : t('status.git.none')}
        </button>
        <span className="text-ink-line">|</span>
        <button
          type="button"
          title={t('status.problemsTitle')}
          onClick={() => {
            setIdeOpen(true)
            setWorkspaceTab('code')
            setProblemsOpen((v) => !v)
          }}
          className={
            'hover:text-ink-bright ' +
            (problemCounts.errors > 0
              ? 'text-rose-400'
              : problemCounts.warnings > 0
                ? 'text-amber-400'
                : '')
          }
        >
          {problemCounts.errors}↑ {problemCounts.warnings}⚠
        </button>
        <span className="text-ink-line">|</span>
        <button
          type="button"
          title={t('status.debugTitle')}
          onClick={() => {
            setIdeOpen(true)
            setWorkspaceTab('code')
            setDebugOpen((v) => !v)
          }}
          className={
            'hover:text-ink-bright ' +
            (debugStatus.state === 'paused'
              ? 'text-amber-400'
              : debugStatus.state === 'running' || debugStatus.state === 'starting'
                ? 'text-signal'
                : '')
          }
        >
          dbg:{debugStatus.state}
        </button>
        <span className="text-ink-line">|</span>
        <span
          className={`max-w-[280px] truncate ${stateColor}`}
          title={
            status?.error
              ? localizeStatusDetail(status.error, t)
              : status?.detail
                ? localizeStatusDetail(status.detail, t)
                : undefined
          }
        >
          {localizeLlmState(status?.state, t)}
          {status?.detail && status.detail !== status.state
            ? ` · ${localizeStatusDetail(status.detail, t)}`
            : ''}
        </span>
        {status?.state === 'ready' ? (
          <button
            type="button"
            onClick={() => void unloadModel()}
            title={t('status.action.unloadTitle')}
            className="text-rose-400 hover:text-rose-300"
          >
            {t('status.action.unload')}
          </button>
        ) : status?.state === 'starting' ? (
          <button
            type="button"
            onClick={() => void unloadModel()}
            title={t('status.action.cancelLoadTitle')}
            className="text-amber-400 hover:text-ink-bright"
          >
            {t('status.action.loading')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void reloadModel()}
            title={t('status.action.loadTitle')}
            className="text-blue-400 hover:text-blue-300"
          >
            {t('status.action.load')}
          </button>
        )}
        <span className="text-ink-line">|</span>
        <span>{t('status.termHint')}</span>
        <span>{t('status.settingsHint')}</span>
        {status?.ctxSize != null && (
          <span title={t('status.ctxTitle')}>
            {t('status.ctx', { n: status.ctxSize })}
          </span>
        )}
        {appVersion ? (
          <button
            type="button"
            title={t('menu.help.versionTitle', { version: appVersion })}
            onClick={() => setVersionOpen(true)}
            className="hover:text-ink-bright"
          >
            v{appVersion}
          </button>
        ) : null}
        <span
          className={
            'ml-auto truncate font-mono ' +
            (localApiEnabled && status?.state === 'ready'
              ? 'text-emerald-400'
              : localApiEnabled
                ? 'text-amber-400'
                : 'text-rose-400')
          }
          title={
            !localApiEnabled
              ? t('status.api.off')
              : status?.state === 'ready'
                ? t('status.api.onReady', { url: status.baseUrl ?? '' })
                : t('status.api.onWaiting')
          }
        >
          {(status?.baseUrl ?? 'http://127.0.0.1:8080').replace(/^https?:\/\//, '')}
        </span>
      </footer>
      )}

      {settingsOpen ? (
        <div className="absolute inset-0 z-[85] flex flex-col bg-ink-950">
          <SettingsView
            open
            onClose={() => {
              setSettingsOpen(false)
              setSettingsInitialPage('general')
            }}
            llmStatus={status}
            onLoadModel={reloadModel}
            onUnloadModel={unloadModel}
            initialPage={settingsInitialPage}
          />
        </div>
      ) : null}

      {busyBlockHint ? (
        <div className="pointer-events-none absolute bottom-10 left-1/2 z-[95] max-w-md -translate-x-1/2 rounded-md border border-ink-line bg-ink-900 px-3 py-2 text-center text-xs text-ink-bright shadow-lg">
          {busyBlockHint}
        </div>
      ) : null}

      <CommandPalette
        open={paletteOpen}
        mode={paletteMode}
        onClose={() => setPaletteOpen(false)}
        onOpenFile={(p) => void openFile(p)}
        commands={paletteCommands}
      />
      <OnboardingWizard
        open={wizardOpen}
        onComplete={() => setWizardOpen(false)}
        onOpenSettings={(page) => openSettings(page ?? 'model')}
      />
      <ChangelogModal
        open={changelog.open}
        version={changelog.version}
        body={changelog.body}
        onClose={changelog.dismiss}
      />
      <RuntimeProgressOverlay />
      <ConfirmDialog
        open={closeConfirmIntent != null}
        title={t('confirm.closeWhileGeneratingTitle')}
        message={t('confirm.closeWhileGeneratingBody')}
        confirmLabel={t('confirm.closeWhileGeneratingQuit')}
        cancelLabel={t('confirm.closeWhileGeneratingStay')}
        danger
        onConfirm={confirmQuitDespiteGeneration}
        onCancel={() => setCloseConfirmIntent(null)}
      />
      <ConfirmDialog
        open={removeRootTarget != null}
        title={t('confirm.removeRepoTitle')}
        message={
          removeRootTarget
            ? t('confirm.removeRepoBody', {
                name:
                  removeRootTarget.replace(/\\/g, '/').split('/').filter(Boolean).pop() ??
                  removeRootTarget
              })
            : ''
        }
        confirmLabel={t('confirm.removeRepoConfirm')}
        cancelLabel={t('chat.cancel')}
        danger
        onConfirm={() => void confirmRemoveRoot()}
        onCancel={() => setRemoveRootTarget(null)}
      />
      <ConfirmDialog
        open={pickFolderForSend != null}
        title={t('chat.pickFolderTitle')}
        message={t('chat.pickFolderBody')}
        confirmLabel={t('chat.pickFolderConfirm')}
        cancelLabel={t('chat.cancel')}
        onConfirm={() => void confirmPickFolderForSend()}
        onCancel={() => {
          const text = pickFolderForSend?.text
          setPickFolderForSend(null)
          if (text) {
            setPendingSendSignal({ text, nonce: Date.now(), restoreOnly: true })
          }
        }}
      />
      <ConfirmDialog
        open={deleteChatTarget != null}
        title={t('confirm.deleteChatTitle')}
        message={
          deleteChatTarget
            ? t('confirm.deleteChatBody', { name: deleteChatTarget.title })
            : ''
        }
        confirmLabel={t('confirm.deleteChatConfirm')}
        cancelLabel={t('chat.cancel')}
        danger
        onConfirm={() => void confirmDeleteChat()}
        onCancel={() => setDeleteChatTarget(null)}
      />
      <TextNoticeDialog
        open={versionOpen}
        title={t('menu.help.versionTitle', { version: appVersion || '…' })}
        body={t('menu.help.versionBody', { version: appVersion || '…' })}
        closeLabel={t('menu.help.ok')}
        onClose={() => setVersionOpen(false)}
      />
      <AboutDeveloperDialog
        open={developerOpen}
        onClose={() => setDeveloperOpen(false)}
        appVersion={appVersion}
      />
      <TextNoticeDialog
        open={licenseOpen}
        title={t('menu.help.licenseTitle')}
        body={t('menu.help.licenseBody')}
        closeLabel={t('menu.help.ok')}
        onClose={() => setLicenseOpen(false)}
      />
      <TextNoticeDialog
        open={thirdPartyOpen}
        title={t('menu.help.thirdPartyTitle')}
        body={`${t('menu.help.thirdPartyNote')}\n\n──\n\n${thirdPartyNoticesBody}`}
        closeLabel={t('menu.help.ok')}
        onClose={() => setThirdPartyOpen(false)}
      />
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShortcutsOpen(false)
          }}
        >
          <div className="max-h-[80vh] w-full max-w-md overflow-hidden rounded-lg border border-ink-line bg-ink-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-line px-4 py-3">
              <h2 className="font-display text-sm font-semibold text-ink-bright">
                {t('menu.help.shortcutsTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="rounded px-2 py-1 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
              >
                {t('chat.cancel')}
              </button>
            </div>
            <div className="max-h-[60vh] space-y-1 overflow-y-auto px-4 py-3">
              {listMenuShortcuts().map((row) => (
                <div
                  key={row.labelKey + row.accel}
                  className="flex items-center justify-between gap-4 py-1 text-[12px]"
                >
                  <span className="text-ink-soft">{t(row.labelKey)}</span>
                  <span className="font-mono text-[11px] text-ink-mute">{row.accel}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {imagePreview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={imagePreview.name || t('chat.image.open')}
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImagePreview(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setImagePreview(null)
          }}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-md border border-white/20 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-white hover:bg-black/70"
            onClick={() => setImagePreview(null)}
          >
            {t('chat.image.close')}
          </button>
          <img
            src={imagePreview.url}
            alt={imagePreview.name || 'preview'}
            className="max-h-[90vh] max-w-[min(96vw,1200px)] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  )
}
