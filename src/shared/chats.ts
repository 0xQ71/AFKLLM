/** Persisted agent chats (userData/chats.json), scoped per workspace root. */

export type PersistedChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface PersistedChatImage {
  id: string
  /** Absolute path under userData/chat-images */
  path: string
  mime: string
  name?: string
}

/** File chip on a user message (any dropped/attached file). */
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
  /** Shell stdout / write preview — capped on sanitize. */
  codePreview?: string
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

const WELCOME_MESSAGE_RU_CONTENT =
  'Агент AFKLLM онлайн. Просите править файлы, искать по репозиторию или объяснить код. Инструменты работают локально.'

export function welcomeMessageForLang(lang: 'en' | 'ru'): PersistedChatMessage {
  return {
    id: 'welcome',
    role: 'assistant',
    content: lang === 'ru' ? WELCOME_MESSAGE_RU_CONTENT : DEFAULT_WELCOME_MESSAGE.content
  }
}

export function defaultChatTitleForLang(lang: 'en' | 'ru'): string {
  return lang === 'ru' ? 'Новый агент' : 'New agent'
}

/** Stored welcome may be EN or RU; UI remaps via i18n when id is welcome. */
export function isWelcomeChatMessage(m: { id?: string; content?: string }): boolean {
  if (m.id === 'welcome') return true
  const c = (m.content ?? '').trim()
  return (
    c === DEFAULT_WELCOME_MESSAGE.content.trim() || c === WELCOME_MESSAGE_RU_CONTENT
  )
}

export const CHAT_MAX_MESSAGES = 200
export const CHAT_MAX_CONTENT_CHARS = 12_000

/** LLM/heuristic digest of earlier turns; survives sanitize. */
export const THREAD_SUMMARY_MSG_ID = 'thread-summary'

/**
 * Thread memory stays in persisted history (and the agent system prompt) but
 * must not render in the chat list — sanitizePersistedMessages pins it after
 * "welcome", which would otherwise dump a debug block at the top.
 */
export function isVisibleChatMessageId(id: string): boolean {
  return id !== THREAD_SUMMARY_MSG_ID
}

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
      ...(m.filePath ? { filePath: String(m.filePath) } : {}),
      ...(typeof m.codePreview === 'string' && m.codePreview.trim()
        ? { codePreview: m.codePreview.slice(0, 4000) }
        : {})
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

export function createEmptySession(lang: 'en' | 'ru' = 'en'): ChatSession {
  const now = Date.now()
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  return {
    id,
    title: defaultChatTitleForLang(lang),
    createdAt: now,
    updatedAt: now,
    messages: [welcomeMessageForLang(lang)]
  }
}

/** Default / unset chat titles that may still be auto-named. */
export function isDefaultChatTitle(title: string | undefined | null): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  return /^(new agent|новый агент|new chat|новый чат)$/i.test(t)
}

/** Unused composer thread — New Agent should reuse this instead of stacking blanks. */
export function isReusableEmptySession(s: {
  title?: string
  messages?: Array<{ role?: string }>
}): boolean {
  if (!isDefaultChatTitle(s.title)) return false
  return !(s.messages ?? []).some((m) => m.role === 'user')
}

const TITLE_STOP =
  /^(сделай|сделать|создай|создать|собери|собрать|напиши|написать|добавь|добавить|исправь|исправить|простой|простую|простое|пожалуйста|please|make|create|build|write|add|fix|update|implement|a|an|the|для|на|по|и|или|с|от|из|в|к|о|об|with|from|this|that|into|about|одностраничный|одностраничную|page|сайт|сайта|файл|файлы|папк[аеиу]|корне|нуля|этой|именно|code|код|русском|english|продукта|product|без|не|запрет|запрещено)$/iu

const TITLE_BRAND_STOP =
  /^(HTML|CSS|FAQ|CTA|CDN|API|IDE|LLM|HTTP|JSON|TODO|URL|SVG|PNG|JPG|Icon|Icons|Feature|Features|Hero|Navbar|Footer|Button|Buttons|Section|Sections|Mobile|Desktop|Editor|Bootstrap|Windows|JavaScript|TypeScript|React|Vite|GitHub|Github|North|South|East|West|How|Works|Social|Proof|Trust)$/i

function extractPromptTheme(text: string): string | null {
  const m = text.match(/тема\s*[—–:\-]\s*[«"']?([\p{L}][\p{L}\s-]{1,24})/u)
  const raw = m?.[1]?.trim()
  if (!raw) return null
  const first = raw.split(/[\s,.;:]+/)[0] ?? ''
  if (!first || TITLE_STOP.test(first) || TITLE_BRAND_STOP.test(first)) return null
  return first
}

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

function matchTaskNounSkipLanding(text: string): string | null {
  const m = text.match(
    /(?:^|[^\p{L}\p{N}_])(dashboard|дашборд|refactor|рефактор|баг|bug|игр[ауеы]?|game)(?=$|[^\p{L}\p{N}_])/iu
  )
  const raw = m?.[1]
  if (!raw) return null
  if (/^игр/i.test(raw)) return 'игра'
  return raw
}

function brandLooksNegated(full: string, index: number): boolean {
  const before = full.slice(Math.max(0, index - 40), index)
  if (/(?:^|[\s,;:(«"'/])(?:не|без|not|no|don't|dont)\s+$/i.test(before)) return true
  // «не ходи на GitHub» / «don't go to GitHub»
  if (
    /(?:^|[\s,;:(«"'/])(?:не|don't|dont|do\s+not)\s+\S+(?:\s+\S+){0,3}\s+(?:на|to|at|in)\s+$/i.test(
      before
    )
  ) {
    return true
  }
  return false
}

function scoreBrandCandidate(word: string, full: string, index: number): number {
  let score = 10
  if (TITLE_BRAND_STOP.test(word)) return -100
  if (brandLooksNegated(full, index)) return -100
  if (/^[A-Z][a-z]+[A-Z]/.test(word)) score += 40 // Northline-style
  if (/^[A-Z][a-z]{3,}$/.test(word)) score += 15
  if (/^[A-Z]{2,}$/.test(word)) score -= 20 // FAQ, CTA
  const before = full.slice(Math.max(0, index - 40), index).toLowerCase()
  if (/логотип|название|бренд|продукт|лендинг|landing|сайт|for\s+|called\s+|«|"/.test(before)) {
    score += 50
  }
  if (/градиент|иконк|icon|без\s|запрет/i.test(before + word)) score -= 40
  return score
}

/** Quoted studio/product name — Latin or Cyrillic («Северная заводь»). */
function extractQuotedBrand(text: string): string | null {
  const quoted = text.match(/[«"\u201C]([^\n»"\u201D]{2,40})[»"\u201D]/)?.[1]?.trim()
  if (!quoted) return null
  if (/градиент|icon/i.test(quoted)) return null
  if (/^(не|без|not|no)\s+/i.test(quoted)) return null
  const first = quoted.split(/\s+/)[0] ?? ''
  if (TITLE_BRAND_STOP.test(first)) return null
  if (!/[\p{L}]/u.test(quoted)) return null
  if (quoted.length <= 22) return quoted
  const parts = quoted
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(и|или|для|the|a|an|of)$/iu.test(w))
  if (parts.length >= 2) return parts.slice(0, 2).join(' ')
  return parts[0] || quoted.slice(0, 22)
}

/** Brand token from the prompt — quoted name wins; skip “не Northline”. */
export function extractBrandFromPrompt(raw: string): string | null {
  const text = String(raw ?? '')
  const quoted = extractQuotedBrand(text)
  if (quoted) return quoted

  let best: { word: string; score: number } | null = null
  const re = /\b([A-Z][a-zA-Z0-9]{2,24})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const word = m[1]!
    const score = scoreBrandCandidate(word, text, m.index)
    if (score < 5) continue
    if (!best || score > best.score) best = { word, score }
  }
  return best?.word ?? null
}

/** Awkward / nonsense titles (genitive, constraints, UI junk as brand). */
export function isAwkwardChatTitle(title: string): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  if (/\b(без|запрет|не\s+используй|don't|constraint)\b/i.test(t)) return true
  if (/\bдля\s+\S+$/i.test(t)) return true
  if (/^(thinking(\s+process)?|думаю|думал|планирую|planning)\b/i.test(t)) return true
  if (/^(пользователь|user)\s+(просит|хочет|asked|wants)/i.test(t)) return true
  if (/^(react|vite|javascript|typescript)$/i.test(t)) return true
  if (/собери|нуля|корне/i.test(t) && !/игр|game|лендинг|landing/i.test(t)) return true
  const parts = t.split(/[\s–—•·\-]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  if (/[а-яё]/i.test(last) && /(ов|ев|ей|ах|ях|ого|ому|ами)$/iu.test(last)) return true
  if (parts.length >= 2 && TITLE_BRAND_STOP.test(parts[parts.length - 1]!)) return true
  return false
}

/** True when the user asked for a landing — not “не делай лендинг”. */
export function userAskedForLanding(text: string): boolean {
  const t = String(text ?? '')
  if (!/лендинг|landing/i.test(t)) return false
  if (
    /не\s+делай[^\n.]{0,80}(лендинг|landing)|не\s+html\s*[-/]?\s*(лендинг|landing)|не\s+делай\s+html\s*\/?\s*лендинг|без\s+(html\/)?лендинг|html\s*[-/]?\s*лендинг\s+запрещ|don't\s+(make|create|build)[^\n.]{0,40}landing|not\s+an?\s+html\s*[-/]?\s*landing|not\s+a\s+landing|no\s+landing/i.test(
      t
    )
  ) {
    return false
  }
  return true
}

/**
 * Prefer heuristic when it has a real brand; reject model junk like «Лендинг Icons».
 */
export function pickChatTitle(userPrompt: string, modelTitle: string): string {
  const heuristic = deriveChatTitle(userPrompt)
  const model = sanitizeModelChatTitle(modelTitle)
  if (!model || isAwkwardChatTitle(model)) return heuristic
  if (!userAskedForLanding(userPrompt) && /^(лендинг|landing)(?=$|[^\p{L}\p{N}_])/iu.test(model)) {
    return heuristic
  }
  const brand = extractBrandFromPrompt(userPrompt)
  if (brand && heuristic && new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(heuristic)) {
    if (!new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(model)) return heuristic
  }
  return model || heuristic
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

  const brand = extractBrandFromPrompt(text)
  const theme = extractPromptTheme(text)
  const askedLanding = userAskedForLanding(text)
  const fileHit = text.match(
    /\b([\w.-]+\.(py|go|js|mjs|cjs|ts|tsx|jsx|java|cs|cpp|c|rs|rb))\b/i
  )
  if (fileHit && !askedLanding) {
    const name = fileHit[1]!
    const stem = name.replace(/\.[^.]+$/, '')
    const lang =
      /\.py$/i.test(name)
        ? 'Python'
        : /\.go$/i.test(name)
          ? 'Go'
          : /\.java$/i.test(name)
            ? 'Java'
            : /\.cs$/i.test(name)
              ? 'C#'
              : /\.(js|mjs|cjs)$/i.test(name)
                ? 'JS'
                : ''
    if (/баг|исправ|почин|fix\b|bug\b/i.test(text)) return clipTitle(`Fix ${name}`)
    return clipTitle(lang ? `${lang} ${stem}` : name)
  }

  const task =
    (askedLanding ? matchTaskNoun(cleaned) : matchTaskNounSkipLanding(cleaned)) ||
    matchTaskNounSkipLanding(cleaned) ||
    matchTaskNounSkipLanding(text)
  if (task) {
    const titled = capitalizeWord(task.toLowerCase())
    if (brand) return clipTitle(`${titled} ${brand}`)
    if (theme) return clipTitle(`${titled} ${capitalizeWord(theme)}`)
    return titled
  }

  if (brand) return clipTitle(brand)

  const quoted = text.match(/[«"\u201C]([^\n»"\u201D]{2,64})[»"\u201D]/)?.[1]?.trim()
  if (quoted && !isAwkwardChatTitle(quoted)) {
    if (quoted.length <= 22) return quoted
    const parts = quoted
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/^(и|или|для|the|a|an|of)$/iu.test(w))
    if (parts.length >= 2) return clipTitle(parts.slice(0, 2).join(' '))
    return clipTitle(parts[0] || quoted)
  }

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.replace(/^[,.:;!?—–-]+|[,.:;!?—–-]+$/g, ''))
    .filter((w) => w.length > 1 && !TITLE_STOP.test(w) && !TITLE_BRAND_STOP.test(w))

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

/** Clean a model-generated chat title (one line, no think/markup). */
export function sanitizeModelChatTitle(raw: string): string {
  let t = (raw ?? '')
    .replace(/<\s*think\s*>[\s\S]*?(?:<\s*\/\s*think\s*>|$)/gi, '')
    .replace(/<\s*\/?\s*think\s*>/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
  // Prefer a non-empty content line (skip blank / "Title:" labels).
  const lines = t
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  t = ''
  for (const line of lines) {
    const cand = line
      .replace(/^(title|название|chat\s*name|имя\s*чата)\s*[:：\-–—]\s*/i, '')
      .replace(/^["'`«“]+|["'`»”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cand && !isDefaultChatTitle(cand) && !/^(ok|done|yes|нет|да)\.?$/i.test(cand)) {
      t = cand
      break
    }
  }
  if (!t || isDefaultChatTitle(t)) return ''
  if (t.length < 2) return ''
  if (isAwkwardChatTitle(t)) return ''
  return clipTitle(t)
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
