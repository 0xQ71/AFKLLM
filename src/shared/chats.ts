/** Persisted agent chats (userData/chats.json), scoped per workspace root. */

export type PersistedChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface PersistedChatImage {
  id: string
  /** Absolute path under userData/chat-images */
  path: string
  mime: string
  name?: string
}

export interface PersistedChatMessageStats {
  tps?: number
  promptTps?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  elapsedMs?: number
  genMs?: number
  turnElapsedMs?: number
}

export interface PersistedChatMessage {
  id: string
  role: PersistedChatRole
  content: string
  toolName?: string
  filePath?: string
  images?: PersistedChatImage[]
  stats?: PersistedChatMessageStats
  activity?: {
    kind: string
    verb: string
    path?: string
    query?: string
    command?: string
    lineStart?: number
    lineEnd?: number
    matchCount?: number
    fileCount?: number
    detail?: string
    status: 'running' | 'done' | 'error' | 'skipped' | 'partial'
  }
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: PersistedChatMessage[]
}

export interface ChatStoreSnapshot {
  activeId: string
  sessions: ChatSession[]
}

export const DEFAULT_WELCOME_MESSAGE: PersistedChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'AFKLLM agent online. Ask me to edit files, search the repo, or explain code. Tools run locally.'
}

export const CHAT_MAX_MESSAGES = 200
export const CHAT_MAX_CONTENT_CHARS = 12_000

/** LLM/heuristic digest of earlier turns; survives sanitize. */
export const THREAD_SUMMARY_MSG_ID = 'thread-summary'

/** Also used by smoke tests. */
export function sanitizePersistedMessages(
  msgs: PersistedChatMessage[]
): PersistedChatMessage[] {
  const out: PersistedChatMessage[] = []
  let summary: PersistedChatMessage | null = null
  for (const m of msgs.slice(-CHAT_MAX_MESSAGES)) {
    if (!m || typeof m !== 'object') continue
    if (!m.id || !m.role || typeof m.content !== 'string') continue
    if (m.id === 'agent-checklist') continue
    // agent-plan is kept (persisted plan bubble with _Status: …_)
    const cleaned: PersistedChatMessage = {
      id: String(m.id),
      role: m.role,
      content: m.content.slice(0, CHAT_MAX_CONTENT_CHARS),
      ...(m.toolName ? { toolName: String(m.toolName) } : {}),
      ...(m.filePath ? { filePath: String(m.filePath) } : {})
    }
    if (Array.isArray(m.images) && m.images.length > 0) {
      cleaned.images = m.images
        .filter(
          (img) =>
            img &&
            typeof img === 'object' &&
            typeof img.id === 'string' &&
            typeof img.path === 'string' &&
            typeof img.mime === 'string'
        )
        .slice(0, 4)
        .map((img) => ({
          id: String(img.id),
          path: String(img.path),
          mime: String(img.mime),
          ...(typeof img.name === 'string' ? { name: img.name } : {})
        }))
      if (!cleaned.images.length) delete cleaned.images
    }
    const stats = sanitizeStats(m.stats)
    if (stats) cleaned.stats = stats
    if (m.activity && typeof m.activity === 'object') {
      const a = m.activity as PersistedChatMessage['activity']
      if (
        a &&
        typeof a.kind === 'string' &&
        typeof a.verb === 'string' &&
        (a.status === 'running' ||
          a.status === 'done' ||
          a.status === 'error' ||
          a.status === 'skipped' ||
          a.status === 'partial')
      ) {
        cleaned.activity = {
          kind: a.kind,
          verb: a.verb,
          status: a.status,
          ...(typeof a.path === 'string' ? { path: a.path } : {}),
          ...(typeof a.query === 'string' ? { query: a.query } : {}),
          ...(typeof a.command === 'string' ? { command: a.command } : {}),
          ...(typeof a.detail === 'string' ? { detail: a.detail } : {}),
          ...(typeof a.lineStart === 'number' ? { lineStart: a.lineStart } : {}),
          ...(typeof a.lineEnd === 'number' ? { lineEnd: a.lineEnd } : {}),
          ...(typeof a.matchCount === 'number' ? { matchCount: a.matchCount } : {}),
          ...(typeof a.fileCount === 'number' ? { fileCount: a.fileCount } : {})
        }
      }
    }
    if (cleaned.id === THREAD_SUMMARY_MSG_ID) {
      summary = cleaned
      continue
    }
    out.push(cleaned)
  }
  // Single thread-summary near the front (after welcome if present)
  if (summary) {
    const w = out.findIndex((m) => m.id === 'welcome')
    out.splice(w >= 0 ? w + 1 : 0, 0, summary)
  }
  if (out.length === 0) out.push({ ...DEFAULT_WELCOME_MESSAGE })
  return out
}

function sanitizeStats(
  raw: PersistedChatMessage['stats'] | unknown
): PersistedChatMessageStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Record<string, unknown>
  const pick = (k: keyof PersistedChatMessageStats): number | undefined => {
    const v = s[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const out: PersistedChatMessageStats = {
    ...(pick('tps') != null ? { tps: pick('tps') } : {}),
    ...(pick('promptTps') != null ? { promptTps: pick('promptTps') } : {}),
    ...(pick('promptTokens') != null ? { promptTokens: pick('promptTokens') } : {}),
    ...(pick('completionTokens') != null
      ? { completionTokens: pick('completionTokens') }
      : {}),
    ...(pick('totalTokens') != null ? { totalTokens: pick('totalTokens') } : {}),
    ...(pick('elapsedMs') != null ? { elapsedMs: pick('elapsedMs') } : {}),
    ...(pick('genMs') != null ? { genMs: pick('genMs') } : {}),
    ...(pick('turnElapsedMs') != null ? { turnElapsedMs: pick('turnElapsedMs') } : {})
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function createEmptySession(): ChatSession {
  const now = Date.now()
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  return {
    id,
    title: 'New agent',
    createdAt: now,
    updatedAt: now,
    messages: [{ ...DEFAULT_WELCOME_MESSAGE }]
  }
}
