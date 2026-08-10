import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import type {
  ChatFileRef,
  ChatMessage,
  ChatMessageStats,
  ComposerFileAttachment,
  DocumentAttachment,
  EditorSelectionContext,
  FileAttachment,
  ImageAttachment
} from '../agent/runAgentTurn'
import {
  AGENT_CHECKLIST_MSG_ID,
  AGENT_PLAN_MSG_ID,
  FILES_CHANGED_TOOL,
  formatPlanExecutePrompt,
  getPlanStatus,
  parseThinkBlocks,
  promoteThinkOnlyAnswer,
  runAgentTurn,
  setPlanStatus,
  stripPlanStatus,
  type TurnFileChange
} from '../agent/runAgentTurn'
import type { QueueManager } from '../llm/queueManager'
import type { ChatSession, PersistedChatMessage } from '../../../shared/chats'
import { DEFAULT_WELCOME_MESSAGE } from '../../../shared/chats'
import { ComposerQueue, type QueuedFollowUp } from './ComposerQueue'
import { EditReviewDiff } from './EditReviewDiff'
import { MarkdownBody } from './MarkdownBody'
import {
  hasDisplayableStats,
  MessageStatsInfo
} from './MessageStatsInfo'
import { ContextUsageControl } from './ContextUsagePopover'
import {
  buildActivityFromTool,
  formatActivityParts,
  sanitizeActivity,
  type ComposerActivity
} from '../agent/composerActivity'
import {
  diffStatFromCodePreview,
  formatDiffStat
} from '../../../shared/diffStat'
import { useI18n } from '../i18n/I18nProvider'
import {
  registerAgentGenerationStop,
  setAgentGenerationBusy
} from '../agent/agentBusyGate'

interface ChatPanelProps {
  queue: QueueManager
  openFile?: { path: string; content: string }
  selection?: EditorSelectionContext | null
  llmReady: boolean
  ctxSize?: number | null
  editorTheme?: string
  fill?: boolean
  onOpenPath?: (relativePath: string) => void
  newAgentSignal?: number
  switchSessionSignal?: { id: string; nonce: number } | null
  hideSessionChrome?: boolean
  onSessionsChange?: (
    sessions: SessionMeta[],
    activeId: string | null
  ) => void
  planModeSignal?: number
  headerActions?: React.ReactNode
  workspaceKey?: string | null
  gitBranch?: string | null
  needsFolderToChat?: boolean
  onRequestFolderForSend?: (text: string) => void
  pendingSendSignal?: { text: string; nonce: number; restoreOnly?: boolean } | null
  onOpenFolder?: () => void
  /** Opens the app-level image lightbox (same as tree PNG click) */
  onOpenImagePreview?: (url: string, name?: string) => void
  /** Opens Settings → Agent when Image mode is off (master toggle lives there) */
  onOpenImageGenSettings?: () => void
}

type SessionMeta = Omit<ChatSession, 'messages'>

export type { SessionMeta }

export function ChatPanel({
  queue,
  openFile,
  selection = null,
  llmReady,
  ctxSize,
  editorTheme = 'afkllm-dark',
  fill = false,
  onOpenPath,
  newAgentSignal = 0,
  switchSessionSignal = null,
  hideSessionChrome = false,
  onSessionsChange,
  planModeSignal = 0,
  headerActions,
  workspaceKey = null,
  gitBranch = null,
  needsFolderToChat = false,
  onRequestFolderForSend,
  pendingSendSignal = null,
  onOpenFolder,
  onOpenImagePreview,
  onOpenImageGenSettings
}: ChatPanelProps): React.JSX.Element {
  const { t, lang } = useI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<SessionMeta[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: DEFAULT_WELCOME_MESSAGE.id,
      role: DEFAULT_WELCOME_MESSAGE.role,
      content: DEFAULT_WELCOME_MESSAGE.content
    }
  ])
  const [input, setInput] = useState('')
  const [composerFiles, setComposerFiles] = useState<ComposerFileAttachment[]>([])
  const [fileBusy, setFileBusy] = useState(false)
  const [slotBanner, setSlotBanner] = useState<string>('')
  const [busy, setBusy] = useState(false)
  /** Bumps on Stop so an in-flight turn's finally cannot re-lock the composer. */
  const turnGenRef = useRef(0)
  const [followQueue, setFollowQueue] = useState<QueuedFollowUp[]>([])
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const [reverbEdit, setReverbEdit] = useState<{ messageId: string; text: string } | null>(
    null
  )
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)

  const openChatImage = useCallback(async (path: string, name?: string) => {
    try {
      const url = await window.api.chatImages.readDataUrl(path)
      if (onOpenImagePreview) {
        onOpenImagePreview(url, name)
        return
      }
      console.error('onOpenImagePreview is not wired')
    } catch (err) {
      console.error('Failed to open image', err)
    }
  }, [onOpenImagePreview])

  const copyUserMessage = useCallback(
    async (id: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopiedMsgId(id)
        window.setTimeout(() => {
          setCopiedMsgId((cur) => (cur === id ? null : cur))
        }, 1600)
      } catch (err) {
        console.error('clipboard write failed', err)
      }
    },
    []
  )

  const fileToBase64 = useCallback(async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }, [])

  const ingestDroppedFile = useCallback(
    async (file: File) => {
      setFileBusy(true)
      try {
        const diskPath =
          window.api.getPathForFile?.(file)?.trim() ||
          (file as File & { path?: string }).path?.trim() ||
          ''
        const imported = diskPath
          ? await window.api.chatFiles.import({
              sessionId: sessionId ?? 'draft',
              sourcePath: diskPath
            })
          : await window.api.chatFiles.import({
              sessionId: sessionId ?? 'draft',
              dataBase64: await fileToBase64(file),
              mime: file.type || undefined,
              name: file.name || undefined
            })

        let previewUrl: string | undefined
        if (imported.kind === 'image') {
          try {
            previewUrl = await window.api.chatImages.readDataUrl(imported.path)
          } catch {
            /* ignore */
          }
        }

        const next: ComposerFileAttachment = {
          id: imported.id,
          path: imported.path,
          name: imported.name,
          mime: imported.mime,
          extLabel: imported.extLabel || 'FILE',
          kind: imported.kind,
          ...(previewUrl ? { previewUrl } : {}),
          ...(imported.text ? { text: imported.text } : {}),
          ...(imported.pageImages?.length
            ? {
                pageImages: imported.pageImages.map((p) => ({
                  id: p.id,
                  path: p.path,
                  mime: p.mime,
                  ...(p.name ? { name: p.name } : {})
                }))
              }
            : {}),
          ...(imported.note ? { note: imported.note } : {})
        }

        setComposerFiles((prev) => {
          if (prev.length >= 8) return prev
          if (prev.some((x) => x.id === next.id)) return prev
          const imageCount = prev.filter((x) => x.kind === 'image').length
          if (next.kind === 'image' && imageCount >= 4) return prev
          return [...prev, next]
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        window.alert(msg)
      } finally {
        setFileBusy(false)
      }
    },
    [fileToBase64, sessionId]
  )

  const ingestFiles = useCallback(
    async (list: FileList | File[]) => {
      for (const file of Array.from(list)) {
        await ingestDroppedFile(file)
      }
    },
    [ingestDroppedFile]
  )

  const splitComposerFiles = useCallback((files: ComposerFileAttachment[]) => {
    const images: ImageAttachment[] = []
    const documents: DocumentAttachment[] = []
    const attachments: FileAttachment[] = []
    const fileRefs: ChatFileRef[] = []
    for (const f of files) {
      fileRefs.push({
        id: f.id,
        path: f.path,
        name: f.name,
        mime: f.mime,
        extLabel: f.extLabel,
        kind: f.kind
      })
      if (f.kind === 'image') {
        images.push({
          id: f.id,
          path: f.path,
          mime: f.mime,
          name: f.name,
          ...(f.previewUrl ? { previewUrl: f.previewUrl } : {})
        })
      } else if (f.kind === 'pdf' || f.kind === 'docx') {
        documents.push({
          id: f.id,
          path: f.path,
          name: f.name,
          kind: f.kind,
          text: f.text || '',
          ...(f.pageImages?.length ? { pageImages: f.pageImages } : {}),
          ...(f.note ? { note: f.note } : {})
        })
      } else {
        const body = (f.text || f.note || '').trim()
        if (body) {
          attachments.push({
            path: `file/${f.name}`,
            content: body
          })
        }
      }
    }
    return { images, documents, attachments, fileRefs }
  }, [])
  const followQueueRef = useRef(followQueue)
  followQueueRef.current = followQueue
  const prioritySendRef = useRef<string | null>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  /** Serializes stop→send so cancelAll cannot abort the next turn. */
  const sendLockRef = useRef<Promise<void>>(Promise.resolve())
  const [lastStats, setLastStats] = useState<ChatMessageStats | null>(null)
  const [autoApprove, setAutoApprove] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [thinkThrough, setThinkThrough] = useState(true)
  const [imageMode, setImageMode] = useState(false)
  const [projectRulesText, setProjectRulesText] = useState('')
  const [mcpToolsJson, setMcpToolsJson] = useState('')
  const [systemPromptExtra, setSystemPromptExtra] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const codeEndRefs = useRef<Map<string, HTMLPreElement>>(new Map())
  const abortRef = useRef<AbortController | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId

  const applySnapshot = useCallback((snap: { activeId: string; sessions: ChatSession[] }) => {
    const list = snap.sessions
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    setSessionList(list)
    const active = snap.sessions.find((s) => s.id === snap.activeId) ?? snap.sessions[0]
    if (!active) {
      setSessionId(null)
      setMessages([])
      setInput('')
      setLastStats(null)
      setFollowQueue([])
      setEditingQueueId(null)
      setActiveUserMsgId(null)
      setReverbEdit(null)
      onSessionsChange?.(list, null)
      return
    }
    setSessionId(active.id)
    const nextMessages = active.messages.map(fromPersisted)
    setMessages(nextMessages)
    setFollowQueue([])
    setEditingQueueId(null)
    setActiveUserMsgId(null)
    setReverbEdit(null)
    let hydrated: ChatMessageStats | null = null
    for (let i = nextMessages.length - 1; i >= 0; i--) {
      const s = nextMessages[i]?.stats
      if (s?.promptTokens != null && s.promptTokens > 0) {
        hydrated = s
        break
      }
    }
    setLastStats(hydrated)
    onSessionsChange?.(list, active.id)
  }, [onSessionsChange])

  useEffect(() => {
    // Abort in-flight turn on repo switch; drop stale stats so a late onStats cannot paint the wrong gauge.
    turnGenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    busyRef.current = false
    setLastStats(null)
    setPickerOpen(false)
    setFollowQueue([])
    setEditingQueueId(null)
    setActiveUserMsgId(null)
    setReverbEdit(null)
    void window.api.chats.get().then(applySnapshot).catch(console.error)
  }, [applySnapshot, workspaceKey])

  useEffect(() => {
    void window.api.slots.status().then((s) => {
      if (s.detail && (s.phase === 'switching' || s.slot === 'imageGen')) {
        setSlotBanner(s.detail)
      } else if (s.phase === 'error' && (s.error || s.detail)) {
        setSlotBanner(s.error || s.detail)
      } else {
        setSlotBanner('')
      }
    })
    return window.api.slots.onStatus((s) => {
      if (s.detail && (s.phase === 'switching' || s.slot === 'imageGen')) {
        setSlotBanner(s.detail)
      } else if (s.phase === 'error' && (s.error || s.detail)) {
        setSlotBanner(s.error || s.detail)
      } else if (s.phase === 'ready' && s.slot !== 'imageGen') {
        setSlotBanner('')
      }
    })
  }, [])

  useEffect(() => {
    return window.api.chats.onChanged((snap) => {
      if (abortRef.current) {
        // Don't clobber an in-flight turn; apply after it ends via persist/get.
        return
      }
      setBusy(false)
      setPickerOpen(false)
      applySnapshot(snap)
    })
  }, [applySnapshot])

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setAutoApprove(Boolean(s.agentAutoApprove))
      setThinkThrough(s.agentThinkThrough !== false)
      setImageMode(s.agentImageGenEnabled === true)
      setSystemPromptExtra(s.systemPrompt?.trim() ?? '')
    })
    return window.api.settings.onChanged((s) => {
      setAutoApprove(Boolean(s.agentAutoApprove))
      setThinkThrough(s.agentThinkThrough !== false)
      setImageMode(s.agentImageGenEnabled === true)
      setSystemPromptExtra(s.systemPrompt?.trim() ?? '')
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const [rules, tools] = await Promise.all([
          window.api.context.projectRules().catch(() => ({ text: '' })),
          window.api.mcp.listTools().catch(() => [])
        ])
        if (cancelled) return
        setProjectRulesText(typeof rules?.text === 'string' ? rules.text : '')
        setMcpToolsJson(tools?.length ? JSON.stringify(tools) : '')
      } catch {
        /* ignore */
      }
    }
    void refresh()
    const unsub = window.api.mcp.onChanged(() => {
      void refresh()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [workspaceKey])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    for (const m of messages) {
      if (m.streaming && m.codePreview) {
        const el = codeEndRefs.current.get(m.id)
        if (el) el.scrollTop = el.scrollHeight
      }
    }
  }, [messages])

  useEffect(() => {
    if (!sessionId) return
    if (messages.some((m) => m.streaming || m.pending)) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const id = sessionIdRef.current
      if (!id) return
      void window.api.chats
        .updateMessages(id, messages.map(toPersisted))
        .then((snap) => {
          setSessionList(
            snap.sessions
              .map(({ id: sid, title, createdAt, updatedAt }) => ({
                id: sid,
                title,
                createdAt,
                updatedAt
              }))
              .sort((a, b) => b.updatedAt - a.updatedAt)
          )
        })
        .catch(console.error)
    }, 400)
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [messages, sessionId])

  const toggleAutoApprove = async (): Promise<void> => {
    const next = !autoApprove
    setAutoApprove(next)
    await window.api.settings.save({ agentAutoApprove: next })
    if (next) {
      try {
        await window.api.agent.acceptAllEdits()
      } catch {
        /* ignore */
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.editReview?.status === 'pending'
            ? { ...m, editReview: { ...m.editReview, status: 'accepted' as const } }
            : m
        )
      )
    }
  }

  const toggleThinkThrough = async (): Promise<void> => {
    const next = !thinkThrough
    setThinkThrough(next)
    await window.api.settings.save({ agentThinkThrough: next })
  }

  const toggleImageMode = async (): Promise<void> => {
    if (!imageMode) {
      onOpenImageGenSettings?.()
      return
    }
    setImageMode(false)
    await window.api.settings.save({ agentImageGenEnabled: false })
  }

  const stop = (opts?: { drain?: boolean }): void => {
    turnGenRef.current += 1
    abortRef.current?.abort('user_stop')
    abortRef.current = null
    setBusy(false)
    busyRef.current = false
    setActiveUserMsgId(null)
    setReverbEdit(null)
    setMessages((prev) => {
      const next = prev.map((m) =>
        m.streaming
          ? {
              ...m,
              streaming: false,
              content: m.content?.trim()
                ? m.content.replace(/\s*…\s*$/, '') || m.content
                : '⏹ Stopped'
            }
          : m
      )
      messagesRef.current = next
      return next
    })
    void window.api.terminal.interrupt()
    const drain = opts?.drain !== false
    const afterCancel = queue.cancelAll().catch(() => {
      /* ignore */
    })
    sendLockRef.current = afterCancel.then(() => {
      if (!drain) return
      const priority = prioritySendRef.current
      if (priority) {
        prioritySendRef.current = null
        void send(priority, { fromQueue: true })
        return
      }
      const next = followQueueRef.current[0]
      if (next) {
        setFollowQueue((q) => q.slice(1))
        void send(next.text, { fromQueue: true })
      }
    })
  }
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => {
    setAgentGenerationBusy(busy)
  }, [busy])

  useEffect(() => {
    return () => {
      // Panel teardown (e.g. old settings swap) — clear gate only if we own it.
      setAgentGenerationBusy(false)
    }
  }, [])

  useEffect(() => {
    return registerAgentGenerationStop(() => stopRef.current({ drain: false }))
  }, [])

  // Abort agent on window close/reload — otherwise tools keep writing.
  useEffect(() => {
    const onHide = (): void => {
      if (abortRef.current) stopRef.current({ drain: false })
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
    }
  }, [queue])

  const newAgent = async (): Promise<void> => {
    if (busy) stop({ drain: false })
    setPickerOpen(false)
    setFollowQueue([])
    setEditingQueueId(null)
    setReverbEdit(null)
    const snap = await window.api.chats.create()
    applySnapshot(snap)
    setInput('')
    setLastStats(null)
  }

  const switchSession = async (id: string): Promise<void> => {
    if (id === sessionId) {
      setPickerOpen(false)
      return
    }
    if (busy) stop({ drain: false })
    setPickerOpen(false)
    setFollowQueue([])
    setEditingQueueId(null)
    setReverbEdit(null)
    const snap = await window.api.chats.setActive(id)
    applySnapshot(snap)
    setInput('')
    setLastStats(null)
  }

  useEffect(() => {
    if (!newAgentSignal) return
    void newAgent()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signal edge only
  }, [newAgentSignal])

  useEffect(() => {
    if (!switchSessionSignal?.id) return
    void switchSession(switchSessionSignal.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signal edge only
  }, [switchSessionSignal?.nonce])

  useEffect(() => {
    if (!planModeSignal) return
    setPlanMode((v) => !v)
  }, [planModeSignal])

  const deleteSession = async (id: string, e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy && id === sessionId) stop({ drain: false })
    setFollowQueue([])
    setEditingQueueId(null)
    setReverbEdit(null)
    const snap = await window.api.chats.delete(id)
    applySnapshot(snap)
  }

  const ensureSession = async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current
    const snap = await window.api.chats.create()
    applySnapshot(snap)
    return snap.activeId || null
  }

  const applyTurnStats = useCallback(
    (stats: ChatMessageStats, turnId: number, forSession: string): void => {
      // Ignore late stats from aborted turns or a previous repo/session.
      if (turnGenRef.current !== turnId) return
      if (sessionIdRef.current !== forSession) return
      setLastStats((prev) => {
        // Rounds often report timings without prompt_tokens — never wipe a known measure.
        const promptTokens = stats.promptTokens ?? prev?.promptTokens
        const completionTokens = stats.completionTokens ?? prev?.completionTokens
        const totalTokens =
          stats.totalTokens ??
          (promptTokens != null || completionTokens != null
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : prev?.totalTokens)
        return {
          ...prev,
          ...stats,
          promptTokens,
          completionTokens,
          totalTokens
        }
      })
    },
    []
  )

  const send = async (
    textOverride?: string,
    opts?: { fromQueue?: boolean; reverb?: { messageId: string } }
  ): Promise<void> => {
    const text = (textOverride ?? input).trim()
    if ((!text && composerFiles.length === 0) || !llmReady) return
    const sendText =
      text ||
      (composerFiles.some((f) => f.kind === 'image')
        ? lang === 'ru'
          ? 'Что на этом изображении?'
          : 'What is in this image?'
        : composerFiles.length
          ? lang === 'ru'
            ? 'Что это за документ? Кратко по сути: для чего он и о чём (не пересказывай оглавление).'
            : 'What is this document? Briefly: what it is for and what it covers (do not recite the table of contents).'
          : '')
    if (!sendText) return
    if (needsFolderToChat) {
      setInput('')
      onRequestFolderForSend?.(sendText)
      return
    }
    if (busyRef.current && !opts?.fromQueue && !opts?.reverb) {
      setFollowQueue((q) => [...q, { id: crypto.randomUUID(), text: sendText }])
      setInput('')
      return
    }

    // Wait out any in-flight Stop/cancelAll so the new turn is not aborted.
    await sendLockRef.current.catch(() => {
      /* ignore */
    })

    let activeSession = sessionId
    if (!activeSession) {
      try {
        activeSession = await ensureSession()
      } catch (e) {
        console.error('Failed to create chat session', e)
        return
      }
      if (!activeSession) return
    }
    const usePlan = planMode && !opts?.reverb
    // Implicit-accept leftover edit reviews so they don't stale forever
    try {
      await window.api.agent.acceptAllEdits()
    } catch {
      /* ignore */
    }
    let history = messagesRef.current.map((m) => {
      let next = m
      if (m.editReview?.status === 'pending') {
        next = { ...next, editReview: { ...next.editReview!, status: 'accepted' as const } }
      }
      if (next.streaming) {
        next = {
          ...next,
          streaming: false,
          content: next.content?.trim()
            ? next.content.replace(/\s*…\s*$/, '') || next.content
            : '⏹ Stopped'
        }
      }
      return next
    })
    if (opts?.reverb) {
      const idx = history.findIndex((m) => m.id === opts.reverb!.messageId)
      if (idx >= 0) {
        history = history.slice(0, idx)
      }
    }
    setMessages((prev) => {
      const next = prev.map((m) =>
        m.editReview?.status === 'pending'
          ? { ...m, editReview: { ...m.editReview, status: 'accepted' as const } }
          : m
      )
      messagesRef.current = next
      return next
    })
    if (!opts?.fromQueue && !opts?.reverb) setInput('')
    const turnId = ++turnGenRef.current
    setBusy(true)
    busyRef.current = true
    const ac = new AbortController()
    abortRef.current = ac
    const split = splitComposerFiles(composerFiles)
    if (!opts?.fromQueue && !opts?.reverb) {
      setComposerFiles([])
    }
    try {
      await runAgentTurn({
        queue,
        history,
        userText: sendText,
        openFile,
        selection,
        attachments: split.attachments,
        images: split.images,
        documents: split.documents,
        files: split.fileRefs,
        onUpdate: (msgs) => {
          messagesRef.current = msgs
          setMessages(msgs)
        },
        onStats: (stats) => applyTurnStats(stats, turnId, activeSession),
        onOpenPath,
        signal: ac.signal,
        mode: usePlan ? 'plan' : 'agent',
        sessionId: activeSession,
        onUserMessageCreated: (id) => setActiveUserMsgId(id),
        reverbContinue: opts?.reverb,
        uiLanguage: lang
      })
      if (turnGenRef.current === turnId) {
        if (usePlan) setPlanMode(false)
      }
    } finally {
      if (turnGenRef.current === turnId) {
        abortRef.current = null
        setBusy(false)
        busyRef.current = false
        setActiveUserMsgId(null)
        const priority = prioritySendRef.current
        if (priority) {
          prioritySendRef.current = null
          void send(priority, { fromQueue: true })
        } else {
          const next = followQueueRef.current[0]
          if (next) {
            setFollowQueue((q) => q.slice(1))
            void send(next.text, { fromQueue: true })
          }
        }
      }
    }
  }

  const sendQueuedNow = (id: string): void => {
    const item = followQueueRef.current.find((q) => q.id === id)
    if (!item?.text.trim()) return
    setFollowQueue((q) => q.filter((x) => x.id !== id))
    setEditingQueueId(null)
    if (busyRef.current) {
      // Soft-stop current turn, then send this item as soon as cancel settles.
      prioritySendRef.current = item.text
      stop({ drain: true })
      return
    }
    void send(item.text, { fromQueue: true })
  }

  const saveReverb = (): void => {
    if (!reverbEdit) return
    const { messageId, text } = reverbEdit
    const trimmed = text.trim()
    if (!trimmed) return
    setReverbEdit(null)
    if (busyRef.current) {
      prioritySendRef.current = null
      stop({ drain: false })
    }
    void send(trimmed, { fromQueue: true, reverb: { messageId } })
  }

  const pendingSendHandled = useRef(0)
  const queuedSendRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pendingSendSignal || pendingSendSignal.nonce === pendingSendHandled.current) return
    pendingSendHandled.current = pendingSendSignal.nonce
    if (pendingSendSignal.restoreOnly) {
      setInput(pendingSendSignal.text)
      return
    }
    queuedSendRef.current = pendingSendSignal.text
  }, [pendingSendSignal?.nonce])

  useEffect(() => {
    if (needsFolderToChat || !llmReady) return
    const text = queuedSendRef.current
    if (!text) return
    queuedSendRef.current = null
    void send(text)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drain queue after folder bind
  }, [needsFolderToChat, workspaceKey, llmReady, sessionId])

  const approvePlan = async (): Promise<void> => {
    const plan = messages.find((m) => m.id === AGENT_PLAN_MSG_ID)
    if (!plan || getPlanStatus(plan.content) !== 'pending' || busy || !sessionId) return
    const approvedContent = setPlanStatus(plan.content, 'approved')
    const history = messages.map((m) =>
      m.id === AGENT_PLAN_MSG_ID ? { ...m, content: approvedContent } : m
    )
    setMessages(history)
    setBusy(true)
    const turnId = ++turnGenRef.current
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await runAgentTurn({
        queue,
        history,
        userText: formatPlanExecutePrompt(approvedContent),
        openFile,
        selection,
        attachments: [],
        onUpdate: setMessages,
        onStats: (stats) => applyTurnStats(stats, turnId, sessionId),
        onOpenPath,
        signal: ac.signal,
        mode: 'agent',
        sessionId,
        uiLanguage: lang
      })
    } finally {
      if (turnGenRef.current === turnId) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const rejectPlan = (): void => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === AGENT_PLAN_MSG_ID && getPlanStatus(m.content) === 'pending'
          ? { ...m, content: setPlanStatus(m.content, 'rejected') }
          : m
      )
    )
  }

  const editPlan = (): void => {
    const plan = messages.find((m) => m.id === AGENT_PLAN_MSG_ID)
    if (!plan) return
    setInput(stripPlanStatus(plan.content))
    setPlanMode(true)
  }

  const reviewEdit = async (
    messageId: string,
    path: string,
    action: 'accept' | 'reject'
  ): Promise<void> => {
    try {
      if (action === 'accept') {
        await window.api.agent.acceptEdit(path)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ||
            (m.editReview?.path === path && m.editReview.status === 'pending')
              ? {
                  ...m,
                  editReview: m.editReview
                    ? { ...m.editReview, status: 'accepted' as const }
                    : undefined
                }
              : m
          )
        )
      } else {
        const res = await window.api.agent.rejectEdit(path)
        if (!res.ok) {
          console.error('rejectEdit failed', res.error)
          return
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.editReview?.path === path && m.editReview.status === 'pending'
              ? { ...m, editReview: { ...m.editReview, status: 'rejected' as const } }
              : m
          )
        )
        onOpenPath?.(path)
      }
    } catch (err) {
      console.error(err)
    }
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!input.trim() && !busy && followQueue.length > 0) {
      const next = followQueue[0]!
      setFollowQueue((q) => q.slice(1))
      void send(next.text, { fromQueue: true })
      return
    }
    void send()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!input.trim() && !busy && followQueue.length > 0) {
        const next = followQueue[0]!
        setFollowQueue((q) => q.slice(1))
        void send(next.text, { fromQueue: true })
        return
      }
      void send()
    }
  }

  const ctxLimit = ctxSize && ctxSize > 0 ? ctxSize : null
  const measuredPromptTokens = useMemo(() => {
    if (lastStats?.promptTokens != null && lastStats.promptTokens > 0) {
      return lastStats.promptTokens
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const p = messages[i]?.stats?.promptTokens
      if (p != null && p > 0) return p
    }
    return null
  }, [lastStats?.promptTokens, messages])

  const contextEstimateInput = useMemo(
    () => ({
      messages,
      ctxLimit,
      promptTokens: measuredPromptTokens,
      agentAutoApprove: autoApprove,
      agentThinkThrough: thinkThrough,
      agentImageGenEnabled: imageMode,
      planMode,
      systemPromptExtra,
      projectRules: projectRulesText,
      mcpToolsJson
    }),
    [
      messages,
      ctxLimit,
      measuredPromptTokens,
      autoApprove,
      thinkThrough,
      imageMode,
      planMode,
      systemPromptExtra,
      projectRulesText,
      mcpToolsJson
    ]
  )

  const visibleMessages = messages.filter((m) => isVisibleChatMessage(m))
  const threadTitle =
    sessionList.find((s) => s.id === sessionId)?.title || deriveThreadTitle(messages)

  const feedItems = buildComposerFeed(visibleMessages)

  const displayContent = (m: ChatMessage): string => {
    if (m.id === 'welcome') {
      if (llmReady) {
        return imageMode ? t('chat.welcome.online') : t('chat.welcome.onlineNoImage')
      }
      return imageMode ? t('chat.welcome.loadModel') : t('chat.welcome.loadModelNoImage')
    }
    return m.content
  }

  return (
    <>
    <aside
      className={
        fill
          ? 'flex h-full min-w-0 flex-1 flex-col bg-ink-950'
          : 'flex h-full w-[380px] shrink-0 flex-col border-l border-ink-line bg-ink-950'
      }
    >
      <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-ink-line/80 px-3">
        {!hideSessionChrome && (
          <button
            type="button"
            title="New agent"
            onClick={() => void newAgent()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-mute hover:bg-ink-900 hover:text-ink-bright"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {hideSessionChrome ? (
          <div className="min-w-0 flex-1 truncate text-[14px] font-medium tracking-tight text-ink-bright">
            {sessionId ? threadTitle : t('chat.noChat')}
          </div>
        ) : (
          <button
            type="button"
            title="Switch session"
            onClick={() => setPickerOpen((v) => !v)}
            className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left hover:bg-ink-900/80"
          >
            <div className="truncate text-[14px] font-medium tracking-tight text-ink-bright">
              {threadTitle}
            </div>
          </button>
        )}
        <button
          type="button"
          onClick={() => setPlanMode((v) => !v)}
          title={
            planMode
              ? 'Plan Mode ON — next send drafts a plan (no tools)'
              : 'Plan Mode OFF — click to plan before execute'
          }
          className={
            'shrink-0 rounded-md px-2 py-0.5 text-[11px] ' +
            (planMode
              ? 'bg-signal/15 text-signal'
              : 'text-ink-mute hover:bg-ink-900 hover:text-ink-bright')
          }
        >
          {planMode ? t('chat.plan') : t('chat.agent')}
        </button>
        {headerActions}

        {!hideSessionChrome && pickerOpen && (
          <div className="absolute left-2 right-2 top-10 z-30 max-h-64 overflow-auto rounded-md border border-ink-line bg-ink-900 py-1 shadow-lg">
            {sessionList.map((s) => (
              <div
                key={s.id}
                className={
                  'group flex items-center gap-1 px-2 py-1.5 hover:bg-ink-800 ' +
                  (s.id === sessionId ? 'bg-ink-800/80' : '')
                }
              >
                <button
                  type="button"
                  onClick={() => void switchSession(s.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-[12px] text-ink-bright">{s.title}</div>
                  <div className="font-mono text-[9px] text-ink-mute">
                    {formatRelativeTime(s.updatedAt)}
                  </div>
                </button>
                <button
                  type="button"
                  title="Delete session"
                  onClick={(e) => void deleteSession(s.id, e)}
                  className="hidden px-1 font-mono text-[10px] text-ink-mute hover:text-rose-400 group-hover:inline"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-4 py-3">
        {!sessionId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            {needsFolderToChat || !workspaceKey ? (
              <>
                <div className="font-display text-base text-ink-bright">{t('chat.noRepoTitle')}</div>
                <p className="max-w-sm text-[13px] text-ink-mute">{t('chat.noRepoBody')}</p>
                {onOpenFolder && (
                  <button
                    type="button"
                    onClick={() => onOpenFolder()}
                    className="rounded-md border border-ink-line px-3 py-1.5 text-[12px] text-ink-soft hover:bg-ink-900 hover:text-ink-bright"
                  >
                    {t('chat.openFolder')}
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="font-display text-base text-ink-bright">{t('chat.noChatsTitle')}</div>
                <p className="max-w-sm text-[13px] text-ink-mute">{t('chat.noChatsBody')}</p>
              </>
            )}
          </div>
        ) : (
          feedItems.map((item) => {
            if (item.type === 'group') {
              const kids = item.messageIds
                .map((id) => visibleMessages.find((x) => x.id === id))
                .filter((x): x is ChatMessage => Boolean(x))
              return (
                <div key={item.messageIds.join('-')} className="py-0.5">
                  <ActivityGroupRow
                    summary={item.summary}
                    messages={kids}
                    onOpenPath={onOpenPath}
                    onOpenImage={(path, name) => void openChatImage(path, name)}
                  />
                </div>
              )
            }
            const m = item.message
            return (
          <div key={m.id} className={messageRowClass(m)}>
            {m.toolName === FILES_CHANGED_TOOL ? (
              <FilesChangedCard
                content={m.content}
                onOpenPath={onOpenPath}
              />
            ) : m.toolName ? (
              <ToolActivityRow
                message={m}
                onOpenPath={onOpenPath}
                onOpenImage={(path, name) => void openChatImage(path, name)}
              />
            ) : null}
            {!m.toolName && m.id === AGENT_PLAN_MSG_ID && m.content?.trim() ? (
              <div className="space-y-2">
                <div className="rounded-xl border border-ink-line/80 bg-ink-900/40 px-3 py-2.5 text-[13px] text-ink-soft">
                  <div className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-mute">
                    Plan
                  </div>
                  <div className="whitespace-pre-wrap break-words">
                    {stripPlanStatus(m.content)}
                    {m.streaming && !m.codePreview && (
                      <span className="stream-caret" aria-hidden />
                    )}
                  </div>
                </div>
                {!m.streaming && hasDisplayableStats(m.stats) ? (
                  <MessageStatsInfo stats={m.stats!} />
                ) : null}
              </div>
            ) : !m.toolName && (m.content?.trim() || (m.files && m.files.length > 0) || (m.images && m.images.length > 0)) ? (
              m.role === 'user' ? (
                <div className="flex w-full flex-col items-end">
                  {reverbEdit?.messageId === m.id ? (
                    <div className="w-full max-w-[85%] space-y-1.5">
                      <textarea
                        autoFocus
                        value={reverbEdit.text}
                        rows={3}
                        onChange={(e) =>
                          setReverbEdit({ messageId: m.id, text: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setReverbEdit(null)
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            saveReverb()
                          }
                        }}
                        className="w-full resize-none rounded-2xl border border-signal/50 bg-ink-900 px-3.5 py-2 text-[13px] leading-relaxed text-ink-bright outline-none"
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="mr-auto text-[10px] text-ink-mute">
                          {t('chat.reverb.hint')}
                        </span>
                        <button
                          type="button"
                          onClick={() => setReverbEdit(null)}
                          className="rounded-md px-2 py-1 text-[11px] text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                        >
                          {t('chat.reverb.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => saveReverb()}
                          disabled={!reverbEdit.text.trim()}
                          className="rounded-md bg-signal px-2.5 py-1 text-[11px] text-signal-on disabled:opacity-40"
                        >
                          {t('chat.reverb.save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="group/user flex max-w-[85%] flex-col items-end gap-1">
                      {m.images && m.images.length > 0 ? (
                        <div className="mb-0.5 flex flex-wrap justify-end gap-1.5">
                          {m.images.map((img) => (
                            <ChatImageThumb
                              key={img.id}
                              path={img.path}
                              name={img.name}
                              onOpen={() => void openChatImage(img.path, img.name)}
                            />
                          ))}
                        </div>
                      ) : null}
                      <div
                        role={busy && m.id === activeUserMsgId ? 'button' : undefined}
                        tabIndex={busy && m.id === activeUserMsgId ? 0 : undefined}
                        title={
                          busy && m.id === activeUserMsgId ? t('chat.reverb.edit') : undefined
                        }
                        onClick={() => {
                          if (!(busy && m.id === activeUserMsgId)) return
                          setReverbEdit({ messageId: m.id, text: m.content })
                        }}
                        onKeyDown={(e) => {
                          if (!(busy && m.id === activeUserMsgId)) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setReverbEdit({ messageId: m.id, text: m.content })
                          }
                        }}
                        className={
                          'w-full rounded-2xl border border-ink-line/70 bg-ink-900/90 px-3.5 py-2 text-left text-[13px] leading-relaxed text-ink-bright ' +
                          (busy && m.id === activeUserMsgId
                            ? 'cursor-pointer hover:border-signal/40'
                            : 'cursor-default')
                        }
                      >
                        <div className="break-words">
                          {m.content ? (
                            <span className="whitespace-pre-wrap">{m.content}</span>
                          ) : null}
                          {m.files && m.files.some((f) => f.kind !== 'image') ? (
                            <span className="inline">
                              {m.content?.trim() ? ' ' : null}
                              {m.files
                                .filter((f) => f.kind !== 'image')
                                .map((f) => (
                                  <FilePill
                                    key={f.id}
                                    file={f}
                                    onOpen={() => {
                                      void window.api.chatFiles.open(f.path).catch(() => undefined)
                                    }}
                                  />
                                ))}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        title={t('chat.copyMessage')}
                        onClick={() => void copyUserMessage(m.id, m.content)}
                        className={
                          'rounded px-1.5 py-0.5 font-mono text-[10px] text-ink-mute opacity-0 transition ' +
                          'hover:bg-ink-800 hover:text-ink-soft group-hover/user:opacity-100 focus:opacity-100'
                        }
                      >
                        {copiedMsgId === m.id ? t('chat.copied') : t('chat.copyMessage')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="rounded-xl border border-ink-line/70 bg-ink-950/40 px-3.5 py-2.5">
                    <ThinkThroughBody
                      content={displayContent(m)}
                      streaming={!!m.streaming}
                      durationLabel={
                        m.stats?.genMs != null || m.stats?.elapsedMs != null
                          ? formatDuration(m.stats.genMs ?? m.stats.elapsedMs ?? 0)
                          : undefined
                      }
                    />
                  </div>
                  {!m.streaming && hasDisplayableStats(m.stats) ? (
                    <MessageStatsInfo stats={m.stats!} />
                  ) : null}
                </div>
              )
            ) : null}
            {m.id === AGENT_PLAN_MSG_ID &&
              getPlanStatus(m.content) === 'pending' &&
              !m.streaming && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void approvePlan()}
                    className="rounded-md bg-signal/20 px-2 py-0.5 font-mono text-[10px] text-signal hover:bg-signal/30 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={rejectPlan}
                    className="rounded-md border border-rose-500/40 px-2 py-0.5 font-mono text-[10px] text-rose-300 hover:bg-rose-500/15 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={editPlan}
                    className="rounded-md border border-ink-line px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:bg-ink-800 disabled:opacity-40"
                  >
                    Edit
                  </button>
                  <span className="font-mono text-[9px] text-ink-mute">
                    approve runs tools
                  </span>
                </div>
              )}
            {m.id === AGENT_PLAN_MSG_ID && getPlanStatus(m.content) === 'approved' && (
              <div className="mt-1 font-mono text-[9px] text-ink-mute">Approved · executing</div>
            )}
            {m.id === AGENT_PLAN_MSG_ID && getPlanStatus(m.content) === 'rejected' && (
              <div className="mt-1 font-mono text-[9px] text-rose-300/80">Rejected</div>
            )}
            {m.codePreview != null &&
              m.codePreview.length > 0 &&
              !(m.editReview?.status === 'pending') && (
              <details
                open={!!m.streaming}
                className="group mt-1"
              >
                <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none py-0.5 text-[12px] text-ink-mute hover:text-ink-soft [&::-webkit-details-marker]:hidden">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="shrink-0 opacity-60 transition group-open:rotate-90"
                    aria-hidden
                  >
                    <path
                      d="M9 6l6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {m.streaming ? 'Writing…' : 'Show diff'}
                </summary>
                <pre
                  ref={(el) => {
                    if (el) codeEndRefs.current.set(m.id, el)
                    else codeEndRefs.current.delete(m.id)
                  }}
                  className="code-stream mt-1 max-h-48 overflow-auto rounded-lg border border-ink-line/50 bg-ink-950/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink-bright"
                >
                  {m.codePreview}
                  {m.streaming ? <span className="stream-caret" aria-hidden /> : null}
                </pre>
              </details>
            )}
            {m.editReview?.status === 'pending' &&
              m.editReview.path &&
              !m.streaming &&
              !autoApprove && (
              <div className="mt-2 space-y-2">
                <EditReviewDiff path={m.editReview.path} editorTheme={editorTheme} />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reviewEdit(m.id, m.editReview!.path, 'accept')}
                    className="rounded-md bg-signal/20 px-2 py-0.5 font-mono text-[10px] text-signal hover:bg-signal/30 disabled:opacity-40"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reviewEdit(m.id, m.editReview!.path, 'reject')}
                    className="rounded-md border border-rose-500/40 px-2 py-0.5 font-mono text-[10px] text-rose-300 hover:bg-rose-500/15 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <span className="font-mono text-[9px] text-ink-mute">
                    keeps / undoes disk write
                  </span>
                </div>
              </div>
            )}
            {m.editReview?.status === 'accepted' && !autoApprove && (
              <div className="mt-1 font-mono text-[9px] text-ink-mute">Accepted</div>
            )}
            {m.editReview?.status === 'rejected' && (
              <div className="mt-1 font-mono text-[9px] text-rose-300/80">Rejected · restored</div>
            )}
          </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 bg-ink-950 px-3 pb-2.5 pt-1">
        <ComposerQueue
          items={followQueue}
          editingId={editingQueueId}
          busy={busy}
          onEditStart={(id) => setEditingQueueId(id)}
          onEditChange={(id, text) =>
            setFollowQueue((q) => q.map((item) => (item.id === id ? { ...item, text } : item)))
          }
          onEditDone={() => setEditingQueueId(null)}
          onSendNow={sendQueuedNow}
          onDelete={(id) => {
            setFollowQueue((q) => q.filter((item) => item.id !== id))
            if (editingQueueId === id) setEditingQueueId(null)
          }}
          t={t}
        />
        <form onSubmit={onSubmit}>
          {slotBanner ? (
            <div className="mb-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
              {slotBanner}
            </div>
          ) : null}
          <div
            className="rounded-2xl border border-ink-line/90 bg-ink-900/90 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] focus-within:border-ink-mute/50"
            onDragOver={(e: DragEvent) => {
              if (!llmReady || busy) return
              const types = Array.from(e.dataTransfer?.types || [])
              if (!types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(e: DragEvent) => {
              if (!llmReady || busy) return
              const files = e.dataTransfer?.files
              if (!files?.length) return
              e.preventDefault()
              void ingestFiles(files)
            }}
          >
            {composerFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-ink-line/40 px-3 py-2">
                {composerFiles.map((f) =>
                  f.kind === 'image' ? (
                    <span
                      key={f.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-ink-800/90 px-1.5 py-0.5 text-[11px] text-ink-bright"
                    >
                      {f.previewUrl ? (
                        <img
                          src={f.previewUrl}
                          alt=""
                          className="h-8 w-8 rounded object-cover"
                        />
                      ) : (
                        <span className="opacity-70">🖼</span>
                      )}
                      <span className="truncate max-w-[7rem]">{f.name}</span>
                      <button
                        type="button"
                        title={t('chat.image.remove')}
                        onClick={() =>
                          setComposerFiles((prev) => prev.filter((x) => x.id !== f.id))
                        }
                        className="text-ink-mute hover:text-rose-300"
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <FilePill
                      key={f.id}
                      file={f}
                      onRemove={() =>
                        setComposerFiles((prev) => prev.filter((x) => x.id !== f.id))
                      }
                      onOpen={() => {
                        void window.api.chatFiles.open(f.path).catch(() => undefined)
                      }}
                    />
                  )
                )}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                if (!llmReady || busy) return
                const cd = e.clipboardData
                if (!cd) return
                const collected: File[] = []
                if (cd.files?.length) {
                  for (const f of Array.from(cd.files)) collected.push(f)
                }
                if (!collected.length && cd.items) {
                  for (const item of Array.from(cd.items)) {
                    if (item.kind !== 'file') continue
                    const f = item.getAsFile()
                    if (f) collected.push(f)
                  }
                }
                if (!collected.length) return
                e.preventDefault()
                void ingestFiles(collected)
              }}
              disabled={!llmReady}
              rows={2}
              placeholder={
                !llmReady
                  ? t('chat.placeholderWaiting')
                  : busy
                    ? t('chat.placeholderBusy')
                    : needsFolderToChat
                      ? t('chat.placeholderPickFolder')
                      : !sessionId
                        ? t('chat.placeholderNewAgent')
                        : t('chat.placeholderFollowUp')
              }
              className="w-full resize-none bg-transparent px-3.5 py-3 text-[13px] leading-relaxed text-ink-bright outline-none placeholder:text-ink-mute/80 disabled:opacity-50"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <button
                type="button"
                title={fileBusy ? t('chat.doc.working') : t('chat.file.attach')}
                disabled={busy || !llmReady || fileBusy || composerFiles.length >= 8}
                onClick={() => {
                  void (async () => {
                    const paths = await window.api.chatFiles.pick()
                    if (!paths?.length) return
                    setFileBusy(true)
                    try {
                      for (const sourcePath of paths) {
                        try {
                          const imported = await window.api.chatFiles.import({
                            sessionId: sessionId ?? 'draft',
                            sourcePath
                          })
                          let previewUrl: string | undefined
                          if (imported.kind === 'image') {
                            try {
                              previewUrl = await window.api.chatImages.readDataUrl(
                                imported.path
                              )
                            } catch {
                              /* ignore */
                            }
                          }
                          setComposerFiles((prev) => {
                            if (prev.length >= 8) return prev
                            if (prev.some((x) => x.id === imported.id)) return prev
                            if (
                              imported.kind === 'image' &&
                              prev.filter((x) => x.kind === 'image').length >= 4
                            ) {
                              return prev
                            }
                            return [
                              ...prev,
                              {
                                id: imported.id,
                                path: imported.path,
                                name: imported.name,
                                mime: imported.mime,
                                extLabel: imported.extLabel,
                                kind: imported.kind,
                                ...(previewUrl ? { previewUrl } : {}),
                                ...(imported.text ? { text: imported.text } : {}),
                                ...(imported.pageImages?.length
                                  ? {
                                      pageImages: imported.pageImages.map((p) => ({
                                        id: p.id,
                                        path: p.path,
                                        mime: p.mime,
                                        ...(p.name ? { name: p.name } : {})
                                      }))
                                    }
                                  : {}),
                                ...(imported.note ? { note: imported.note } : {})
                              }
                            ]
                          })
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err)
                          window.alert(msg)
                        }
                      }
                    } finally {
                      setFileBusy(false)
                    }
                  })()
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-mute hover:bg-ink-800 hover:text-ink-bright disabled:opacity-40"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                title={
                  autoApprove
                    ? 'Auto — tools run without asking'
                    : 'Ask — confirm shell/delete'
                }
                onClick={() => void toggleAutoApprove()}
                className={
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ' +
                  (autoApprove
                    ? 'bg-ink-800 text-ink-bright'
                    : 'text-ink-mute hover:bg-ink-800 hover:text-ink-bright')
                }
              >
                {autoApprove ? t('chat.auto') : t('chat.ask')}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                title={
                  thinkThrough
                    ? 'Think-through ON'
                    : 'Think-through OFF'
                }
                onClick={() => void toggleThinkThrough()}
                className={
                  'rounded-full px-2 py-1 text-[11px] ' +
                  (thinkThrough
                    ? 'text-signal'
                    : 'text-ink-mute hover:text-ink-soft')
                }
              >
                {t('chat.think')}
              </button>
              <button
                type="button"
                title={
                  imageMode ? t('chat.imageModeOn') : t('chat.imageModeDisabled')
                }
                aria-disabled={!imageMode}
                onClick={() => void toggleImageMode()}
                className={
                  'rounded-full px-2 py-1 text-[11px] ' +
                  (imageMode
                    ? 'text-signal'
                    : 'cursor-default text-ink-mute/50')
                }
              >
                {t('chat.imageMode')}
              </button>
              <span className="ml-auto" />
              {busy ? (
                <>
                  {input.trim() ? (
                    <button
                      type="submit"
                      title={t('chat.queue.add')}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-800 text-ink-bright hover:bg-ink-700"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="M12 19V5M12 5l-6 6M12 5l6 6"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => stop()}
                    title={t('chat.stop')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-bright hover:bg-ink-800"
                  >
                    <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={!llmReady || (!input.trim() && followQueue.length === 0)}
                  title={t('chat.send')}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-signal text-signal-on hover:bg-signal-dim disabled:opacity-35"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M12 19V5M12 5l-6 6M12 5l6 6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </form>
        <div className="mt-1.5 flex items-center gap-3 px-1 text-[11px] text-ink-mute">
          {gitBranch ? (
            <span className="inline-flex items-center gap-1 text-signal/90">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9c0 4-3 6-6 6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {gitBranch}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <span className="opacity-70">This PC</span>
          </span>
          <ContextUsageControl estimateInput={contextEstimateInput} />
        </div>
      </div>
    </aside>
    </>
  )
}

function deriveThreadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content?.trim())
  if (!firstUser?.content) return 'New agent'
  const line = firstUser.content.trim().split(/\n/)[0] ?? ''
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

function toPersisted(m: ChatMessage): PersistedChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content ?? '',
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(m.filePath ? { filePath: m.filePath } : {}),
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.files?.length ? { files: m.files } : {}),
    ...(m.stats ? { stats: m.stats } : {}),
    ...(m.activity ? { activity: m.activity } : {})
  }
}

function fromPersisted(m: PersistedChatMessage): ChatMessage {
  const activity = sanitizeActivity(m.activity)
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(m.filePath ? { filePath: m.filePath } : {}),
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.files?.length ? { files: m.files } : {}),
    ...(m.stats ? { stats: m.stats } : {}),
    ...(activity ? { activity } : {})
  }
}

function fileBadgeClass(extLabel: string, kind: ChatFileRef['kind']): string {
  const e = extLabel.toUpperCase()
  if (kind === 'pdf' || e === 'PDF') return 'bg-[#e25545]'
  if (kind === 'docx' || e === 'DOCX' || e === 'DOC') return 'bg-[#2b579a]'
  if (e === 'TS' || e === 'TSX') return 'bg-[#3178c6]'
  if (e === 'JS' || e === 'JSX') return 'bg-[#c4a000]'
  if (e === 'PY') return 'bg-[#3572A5]'
  if (e === 'MD' || e === 'TXT') return 'bg-[#6b7280]'
  if (e === 'JSON') return 'bg-[#cb8b00]'
  if (e === 'ZIP' || e === '7Z' || e === 'RAR') return 'bg-[#8b5cf6]'
  if (kind === 'image') return 'bg-[#0d9488]'
  if (kind === 'text') return 'bg-[#64748b]'
  return 'bg-[#52525b]'
}

function FilePill({
  file,
  onRemove,
  onOpen
}: {
  file: ChatFileRef
  onRemove?: () => void
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <span className="mx-0.5 inline-flex max-w-[min(100%,18rem)] items-center gap-1 align-middle">
      <span
        className={
          'inline-flex h-[15px] min-w-[26px] shrink-0 items-center justify-center rounded-[3px] px-1 text-[9px] font-bold leading-none tracking-wide text-white ' +
          fileBadgeClass(file.extLabel, file.kind)
        }
      >
        {file.extLabel}
      </span>
      <button
        type="button"
        title={file.path}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpen?.()
        }}
        className="truncate text-[13px] font-medium text-[#4da3ff] hover:underline"
      >
        {file.name}
      </button>
      {onRemove ? (
        <button
          type="button"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 text-[12px] text-ink-mute hover:text-rose-300"
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

function ChatImageThumb({
  path,
  name,
  onOpen
}: {
  path: string
  name?: string
  onOpen?: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [url, setUrl] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    void window.api.chatImages.readDataUrl(path).then(
      (u) => {
        if (!cancelled) setUrl(u)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [path])
  if (!url) {
    return (
      <span className="inline-flex h-14 w-14 items-center justify-center rounded bg-ink-800 text-[10px] text-ink-mute">
        {name?.slice(0, 6) || 'img'}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={t('chat.image.open')}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onOpen?.()
      }}
      className="block overflow-hidden rounded border border-ink-line/50 transition hover:border-signal/50 focus:outline-none focus:ring-1 focus:ring-signal/40"
    >
      <img
        src={url}
        alt={name || 'attachment'}
        className="h-14 w-14 object-cover"
      />
    </button>
  )
}

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function ThinkThroughBody({
  content,
  streaming,
  durationLabel
}: {
  content: string
  streaming?: boolean
  durationLabel?: string
}): React.JSX.Element {
  const parts = parseThinkBlocks(promoteThinkOnlyAnswer(content))
  const hasThink = parts.some((p) => p.kind === 'think')
  if (!hasThink) {
    return (
      <MarkdownBody content={promoteThinkOnlyAnswer(content)} streaming={streaming} />
    )
  }
  const thoughtLabel =
    durationLabel && !streaming
      ? `Thought for ${durationLabel}`
      : streaming
        ? 'Thinking'
        : 'Thought briefly'
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        p.kind === 'think' ? (
          <details
            key={i}
            open={streaming && i === parts.length - 1}
            className="group"
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none text-[12px] text-ink-mute hover:text-ink-soft [&::-webkit-details-marker]:hidden">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                className="shrink-0 opacity-70 transition group-open:rotate-90"
                aria-hidden
              >
                <path
                  d="M9 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {thoughtLabel}
            </summary>
            <div className="mt-1.5 border-l border-ink-line/50 pl-3 text-[12px] leading-relaxed text-ink-mute [&_.text-ink-soft]:text-ink-mute [&_.text-ink-bright]:text-ink-soft">
              <MarkdownBody content={p.text} />
            </div>
          </details>
        ) : (
          <MarkdownBody
            key={i}
            content={p.text}
            streaming={streaming && i === parts.length - 1}
          />
        )
      )}
    </div>
  )
}

function resolveActivity(m: ChatMessage): ComposerActivity {
  if (m.activity) return m.activity
  if (m.toolName === '__planning__') {
    return buildActivityFromTool({ name: '__planning__', streaming: !!m.streaming })
  }
  const args: Record<string, unknown> = {
    relative_path: m.filePath,
    command: m.codePreview
  }
  // content is the activity label for tools — only use as query for codebase search fallback
  if (m.toolName === 'search_codebase' || m.toolName === 'web_search') {
    // Prefer embedded activity; without it, leave query unset rather than mis-label
  } else {
    args.query = m.content
  }
  return buildActivityFromTool({
    name: m.toolName || 'tool',
    args,
    streaming: !!m.streaming,
    resultContent:
      m.toolName === 'web_search' || m.toolName === 'search_codebase'
        ? undefined
        : m.content
  })
}

function ToolActivityRow({
  message: m,
  onOpenPath,
  onOpenImage,
  activity: activityProp
}: {
  message: ChatMessage
  onOpenPath?: (path: string) => void
  onOpenImage?: (path: string, name?: string) => void
  activity?: ComposerActivity
}): React.JSX.Element {
  const { t } = useI18n()
  const activity = activityProp ?? resolveActivity(m)
  const parts = formatActivityParts(activity)
  const stat = diffStatFromCodePreview(m.toolName, m.codePreview, m.content)
  const add = stat?.added ?? 0
  const rem = stat?.removed ?? 0
  const showStat = Boolean(formatDiffStat(stat))
  const pathForOpen = activity.path || m.filePath

  if (activity.kind === 'web') {
    const q = (activity.query ?? '').trim() || '…'
    const label =
      activity.status === 'running'
        ? t('chat.activity.web.running', { query: q })
        : activity.status === 'skipped'
          ? t('chat.activity.web.skip', { query: q })
          : activity.status === 'error'
            ? t('chat.activity.web.error', { query: q })
            : t('chat.activity.web.ok', {
                n: activity.matchCount ?? 0,
                query: q
              })
    return (
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[12.5px] leading-snug text-ink-mute">
        <span className="text-ink-soft">{label}</span>
        {m.streaming && <span className="stream-caret" aria-hidden />}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[12.5px] leading-snug text-ink-mute">
        <span className="text-ink-mute/90">{parts.verb}</span>
        {pathForOpen &&
        (activity.kind === 'read' ||
          activity.kind === 'edit' ||
          activity.kind === 'delete' ||
          activity.kind === 'mkdir' ||
          m.toolName === 'generate_image') ? (
          <>
            <button
              type="button"
              title={`Open ${pathForOpen}`}
              onClick={() => onOpenPath?.(pathForOpen)}
              className={
                'truncate text-ink-soft hover:text-signal ' +
                (onOpenPath ? 'cursor-pointer' : 'cursor-default')
              }
            >
              {parts.pathLabel || fileBasename(pathForOpen)}
            </button>
            {parts.lineRange ? (
              <span className="font-mono text-[11px] text-ink-mute">{parts.lineRange}</span>
            ) : null}
          </>
        ) : parts.target ? (
          <span className="truncate text-ink-soft">{parts.target}</span>
        ) : null}
        {parts.suffix ? (
          <span className="text-ink-mute/70">({parts.suffix})</span>
        ) : null}
        {showStat && (
          <span className="font-mono text-[11px]">
            {add > 0 && <span className="text-emerald-400/90">+{add}</span>}
            {add > 0 && rem > 0 && ' '}
            {rem > 0 && <span className="text-rose-400/90">-{rem}</span>}
          </span>
        )}
        {m.streaming && <span className="stream-caret" aria-hidden />}
      </div>
      {m.toolName === 'generate_image' && m.images && m.images.length > 0 ? (
        <div className="flex flex-wrap gap-2 pl-0.5">
          {m.images.map((img) => (
            <ChatImageThumb
              key={img.id}
              path={img.path}
              name={img.name}
              onOpen={() => onOpenImage?.(img.path, img.name)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ActivityGroupRow({
  summary,
  messages: rows,
  onOpenPath,
  onOpenImage
}: {
  summary: string
  messages: ChatMessage[]
  onOpenPath?: (path: string) => void
  onOpenImage?: (path: string, name?: string) => void
}): React.JSX.Element {
  return (
    <details className="group py-0.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-ink-mute hover:text-ink-soft [&::-webkit-details-marker]:hidden">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          className="shrink-0 opacity-70 transition group-open:rotate-90"
          aria-hidden
        >
          <path
            d="M9 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {summary}
      </summary>
      <div className="mt-1 space-y-0.5 border-l border-ink-line/40 pl-3">
        {rows.map((m) => (
          <ToolActivityRow
            key={m.id}
            message={m}
            onOpenPath={onOpenPath}
            onOpenImage={onOpenImage}
          />
        ))}
      </div>
    </details>
  )
}

function fileBasename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

type ComposerFeedItem =
  | { type: 'message'; message: ChatMessage }
  | { type: 'group'; summary: string; messageIds: string[] }

function buildComposerFeed(messages: ChatMessage[]): ComposerFeedItem[] {
  const out: ComposerFeedItem[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]!
    if (!m.toolName || m.toolName === '__planning__' || m.toolName === FILES_CHANGED_TOOL) {
      out.push({ type: 'message', message: m })
      i++
      continue
    }
    const activity = resolveActivity(m)
    const kind = activity.kind
    if (
      (kind !== 'search' && kind !== 'read' && kind !== 'explore') ||
      m.streaming ||
      activity.status === 'running'
    ) {
      out.push({ type: 'message', message: m })
      i++
      continue
    }

    const batch: ChatMessage[] = [m]
    let j = i + 1
    while (j < messages.length) {
      const n = messages[j]!
      if (!n.toolName || n.streaming) break
      const na = resolveActivity(n)
      if (na.kind !== kind || na.status === 'running') break
      batch.push(n)
      j++
    }

    if (batch.length < 2) {
      out.push({ type: 'message', message: m })
      i++
      continue
    }

    let summary: string
    if (kind === 'search') summary = `${batch.length} searches`
    else if (kind === 'explore') {
      const files = batch.reduce((acc, x) => acc + (resolveActivity(x).fileCount ?? 1), 0)
      summary = `Explored ${files} files`
    } else summary = `Explored ${batch.length} files`

    out.push({
      type: 'group',
      summary,
      messageIds: batch.map((x) => x.id)
    })
    i = j
  }
  return out
}

function FilesChangedCard({
  content,
  onOpenPath
}: {
  content: string
  onOpenPath?: (path: string) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const files = parseFilesChanged(content)
  if (files.length === 0) return null
  const first = files[0]!.path
  const title =
    files.length === 1
      ? t('chat.filesChanged', { n: files.length })
      : t('chat.filesChangedPlural', { n: files.length })

  return (
    <div className="overflow-hidden rounded-xl border border-ink-line/80 bg-ink-900/50">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[12.5px] font-medium text-ink-soft">{title}</span>
        {onOpenPath ? (
          <button
            type="button"
            onClick={() => onOpenPath(first)}
            className="text-[12px] text-ink-mute hover:text-signal"
          >
            {t('chat.review')}
          </button>
        ) : (
          <span className="text-[12px] text-ink-mute">{t('chat.review')}</span>
        )}
      </div>
      <div className="border-t border-ink-line/60 px-2 py-1">
        {files.map((f) => {
          const name = fileBasename(f.path)
          const ext = fileExtLabel(name)
          return (
            <button
              key={f.path}
              type="button"
              title={f.path}
              disabled={!onOpenPath}
              onClick={() => onOpenPath?.(f.path)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ink-800/80 disabled:cursor-default"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] bg-sky-600/90 font-mono text-[8px] font-semibold uppercase tracking-tight text-white">
                {ext}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-soft">
                {name}
              </span>
              {f.deleted ? (
                <span className="shrink-0 font-mono text-[11px] text-rose-400/90">{t('chat.deleted')}</span>
              ) : (
                <span className="shrink-0 font-mono text-[11px]">
                  {f.added > 0 && (
                    <span className="text-emerald-400/90">+{f.added}</span>
                  )}
                  {f.added > 0 && f.removed > 0 && ' '}
                  {f.removed > 0 && (
                    <span className="text-rose-400/90">-{f.removed}</span>
                  )}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function parseFilesChanged(content: string): TurnFileChange[] {
  try {
    const raw = JSON.parse(content) as { files?: TurnFileChange[] }
    if (!Array.isArray(raw?.files)) return []
    return raw.files.filter(
      (f) => f && typeof f.path === 'string' && f.path.trim()
    )
  } catch {
    return []
  }
}

function fileExtLabel(name: string): string {
  const m = name.match(/\.([a-zA-Z0-9]+)$/)
  if (!m) return '·'
  const e = m[1]!.toLowerCase()
  if (e === 'tsx' || e === 'jsx') return 'RX'
  if (e === 'ts') return 'TS'
  if (e === 'js' || e === 'mjs' || e === 'cjs') return 'JS'
  if (e === 'json') return 'JS'
  if (e === 'css' || e === 'scss') return 'CSS'
  if (e === 'md' || e === 'mdx') return 'MD'
  if (e === 'py') return 'PY'
  if (e === 'rs') return 'RS'
  if (e === 'go') return 'GO'
  return e.slice(0, 3).toUpperCase()
}

function isVisibleChatMessage(m: ChatMessage): boolean {
  if (m.id === AGENT_CHECKLIST_MSG_ID) return false
  if (m.id === 'welcome') return true
  const hasText = Boolean(m.content?.trim())
  const hasCode = Boolean(m.codePreview && m.codePreview.length > 0)
  const hasFiles = Boolean(m.files?.length || m.images?.length)
  if (m.toolName === FILES_CHANGED_TOOL) return hasText
  if (m.toolName) return hasText || hasCode || Boolean(m.streaming && (m.filePath || hasCode))
  if (m.streaming) return hasText || hasCode
  return hasText || hasCode || hasFiles
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function messageRowClass(m: ChatMessage): string {
  if (m.id === AGENT_PLAN_MSG_ID) return 'py-1'
  if (m.toolName === FILES_CHANGED_TOOL) return 'py-1.5'
  if (m.toolName) return 'py-0.5'
  if (m.role === 'user') return 'flex justify-end py-1'
  return 'py-1.5 text-[13px] leading-relaxed text-ink-soft'
}

