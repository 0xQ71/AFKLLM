/** Persisted agent chats (userData/chats.json), scoped per workspace root. */

export type PersistedChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface PersistedChatImage {
  id: string
  /** Absolute path under userData/chat-images */
  path: string
  mime: string
  name?: string
}

/** Cursor-style file chip on a user message (any dropped/attached file). */
export interface PersistedChatFile {
  id: string
  path: string
  name: string
  mime: string
  /** Badge label, e.g. PDF / TS / ZIP */
  extLabel: string
  kind: 'image' | 'pdf' | 'docx' | 'text' | 'binary'
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
  files?: PersistedChatFile[]
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
    // agent-checklist / agent-todo / agent-plan are kept (live plan stages)
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
    if (Array.isArray(m.files) && m.files.length > 0) {
      const kinds = new Set(['image', 'pdf', 'docx', 'text', 'binary'])
      cleaned.files = m.files
        .filter(
          (f) =>
            f &&
            typeof f === 'object' &&
            typeof f.id === 'string' &&
            typeof f.path === 'string' &&
            typeof f.name === 'string' &&
            typeof f.mime === 'string' &&
            typeof f.extLabel === 'string' &&
            kinds.has(String(f.kind))
        )
        .slice(0, 8)
        .map((f) => ({
          id: String(f.id),
          path: String(f.path),
          name: String(f.name),
          mime: String(f.mime),
          extLabel: String(f.extLabel).slice(0, 8).toUpperCase(),
          kind: f.kind as PersistedChatFile['kind']
        }))
      if (!cleaned.files.length) delete cleaned.files
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

/** Default / unset chat titles that may still be auto-named. */
export function isDefaultChatTitle(title: string | undefined | null): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  return /^(new agent|новый агент|new chat|новый чат)$/i.test(t)
}

const TITLE_STOP =
  /^(сделай|сделать|создай|создать|напиши|написать|добавь|добавить|исправь|исправить|простой|простую|простое|пожалуйста|please|make|create|build|write|add|fix|update|implement|a|an|the|для|на|по|и|или|с|от|из|в|к|о|об|with|from|this|that|into|about|одностраничный|одностраничную|page|сайт|сайта|файл|файлы|code|код|русском|english|продукта|product)$/iu

function capitalizeWord(w: string): string {
  if (!w) return w
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** JS \\b is ASCII-only — use Unicode-aware boundaries for RU/EN tokens. */
function matchTaskNoun(text: string): string | null {
  const m = text.match(
    /(?:^|[^\p{L}\p{N}_])(лендинг|landing|dashboard|дашборд|refactor|рефактор|баг|bug)(?=$|[^\p{L}\p{N}_])/iu
  )
  return m?.[1] ?? null
}

/**
 * Short stable chat name from the first user prompt (keyword-ish, not the full sentence).
 */
export function deriveChatTitle(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return ''

  const firstLine = (text.split(/\n/).find((l) => l.trim()) ?? '').trim()
  const cleaned = firstLine
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[*_#>[\](){}|\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const quoted = text.match(/[«"\u201C]([^\n»"\u201D]{2,64})[»"\u201D]/)?.[1]?.trim()

  // 1) Task noun first — "Лендинг", not a genitive fragment from the product name.
  const task = matchTaskNoun(cleaned)
  if (task) {
    const titled = capitalizeWord(task.toLowerCase())
    if (quoted && quoted.length <= 20) {
      return clipTitle(`${titled} · ${quoted}`)
    }
    return titled
  }

  // 2) Short quoted product / topic
  if (quoted) {
    if (quoted.length <= 22) return quoted
    const parts = quoted
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/^(и|или|для|the|a|an|of)$/iu.test(w))
    // Prefer the START of the name, not the awkward genitive tail.
    if (parts.length >= 2) return clipTitle(parts.slice(0, 2).join(' '))
    return clipTitle(parts[0] || quoted)
  }

  // 3) First few content words
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.replace(/^[,.:;!?—–-]+|[,.:;!?—–-]+$/g, ''))
    .filter((w) => w.length > 1 && !TITLE_STOP.test(w))

  if (words.length === 0) {
    return clipTitle(cleaned || firstLine)
  }
  return clipTitle(words.slice(0, 3).join(' '))
}

function clipTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t.length <= 28) return t
  return `${t.slice(0, 27).trimEnd()}…`
}

/** Title from the first user message in a thread; empty if none yet. */
export function deriveChatTitleFromMessages(
  messages: Array<{ role?: string; content?: string }>
): string {
  const firstUser = messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim()
  )
  return firstUser ? deriveChatTitle(firstUser.content!) : ''
}
