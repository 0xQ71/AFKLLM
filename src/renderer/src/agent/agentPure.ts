/**
 * Pure agent helpers (no window / React) — safe for node smoke tests.
 */

import { looksLikeOpenHtmlCommand } from '../../../shared/localPreview'
import { cliStdoutLooksVacuous } from '../../../shared/shellNormalize'
import {
  contentLooksStructurallyComplete as contentLooksStructurallyCompleteV2,
  isLandingJsPath,
  isSourcePath,
  cssLooksLikeRealStylesheet
} from './loop/completeness'
import { advanceTodosOnEvidence } from './loop/plan'

export { looksLikeOpenHtmlCommand, isLandingJsPath, isSourcePath, cssLooksLikeRealStylesheet }
export {
  svgLooksLikeRealGraphic,
  contentLooksLikeSourceStub,
  formatStubOnDiskHint,
  looksLikeEmptyOrStubWriteContent,
  formatEmptyWriteError,
  formatWriteRedirectChip,
  isLandingWritePath
} from '../../../shared/completeness'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessageLite {
  id: string
  role: ChatRole
  content: string
  toolName?: string
  streaming?: boolean
  codePreview?: string
  filePath?: string
}

export type ApiMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ApiMessage = {
  role: string
  content: string | null | ApiMessageContentPart[]
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** Flatten multimodal content to plain text (ignores image parts). */
export function apiContentText(content: ApiMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export const AGENT_CHECKLIST_MSG_ID = 'agent-checklist'
/** Todo plan authored by the model via <plan>…</plan>. */
export const AGENT_TODO_MSG_ID = 'agent-todo'

/** Live plan card id, or an archived prior-turn plan (`agent-todo-<ts>`). */
export function isAgentTodoMessageId(id: string | undefined | null): boolean {
  if (!id) return false
  return id === AGENT_TODO_MSG_ID || id.startsWith(`${AGENT_TODO_MSG_ID}-`)
}

export type AgentTodoStatus = 'pending' | 'in_progress' | 'done'

export type AgentTodoStep = {
  id: string
  text: string
  status: AgentTodoStatus
}

export type AgentChecklist = {
  done: string[]
  incomplete: string[]
  failed: string[]
  shells: string[]
}

export function emptyChecklist(): AgentChecklist {
  return { done: [], incomplete: [], failed: [], shells: [] }
}

/** Parse @codebase / @file / @selection; returns cleaned text + flags. */
export function parseComposerMentions(text: string): {
  cleanText: string
  codebase: boolean
  file: boolean
  selection: boolean
} {
  const codebase = /@codebase\b/i.test(text)
  const file = /@file\b/i.test(text)
  const selection = /@selection\b/i.test(text)
  const cleanText = text
    .replace(/@codebase\b/gi, '')
    .replace(/@file\b/gi, '')
    .replace(/@selection\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return {
    cleanText: cleanText || text.replace(/@(?:codebase|file|selection)\b/gi, '').trim() || text,
    codebase,
    file,
    selection
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function pushUnique(list: string[], item: string, max = 80): void {
  const n = normPath(item)
  if (!n) return
  const i = list.findIndex((x) => normPath(x) === n)
  if (i !== -1) list.splice(i, 1)
  list.push(n)
  while (list.length > max) list.shift()
}

function removeFrom(list: string[], item: string): void {
  const n = normPath(item)
  for (let i = list.length - 1; i >= 0; i--) {
    if (normPath(list[i]!) === n) list.splice(i, 1)
  }
}

export function checklistHasItems(cl: AgentChecklist): boolean {
  return (
    cl.done.length + cl.incomplete.length + cl.failed.length + cl.shells.length >
    0
  )
}

/** JSON payload for the visible checklist bubble in chat. */
export function formatChecklistUiContent(cl: AgentChecklist): string {
  return JSON.stringify({
    kind: 'agent-checklist',
    done: cl.done,
    incomplete: cl.incomplete,
    failed: cl.failed,
    shells: cl.shells.slice(-8)
  })
}

export function parseChecklistUiContent(content: string): AgentChecklist | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (o.kind !== 'agent-checklist') return null
    return {
      done: Array.isArray(o.done) ? o.done.map(String) : [],
      incomplete: Array.isArray(o.incomplete) ? o.incomplete.map(String) : [],
      failed: Array.isArray(o.failed) ? o.failed.map(String) : [],
      shells: Array.isArray(o.shells) ? o.shells.map(String) : []
    }
  } catch {
    return null
  }
}

export function formatTodoUiContent(
  steps: AgentTodoStep[],
  opts?: { failed?: boolean }
): string {
  return JSON.stringify({
    kind: 'agent-todo',
    steps,
    ...(opts?.failed ? { failed: true } : {})
  })
}

/**
 * Plan card ✗ is not sticky: a later successful write/apply clears it.
 * Red header only when an edit failed and this turn never landed a write/apply.
 */
export function todoCardFailed(opts: {
  mutatingEditFailed: boolean
  mutatingEditOk: boolean
}): boolean {
  return opts.mutatingEditFailed && !opts.mutatingEditOk
}

/** Plan card header: edits failed even if every row is checked. */
export function parseTodoUiFailed(content: string): boolean {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    return o.kind === 'agent-todo' && o.failed === true
  } catch {
    return false
  }
}

export function parseTodoUiContent(content: string): AgentTodoStep[] | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (o.kind !== 'agent-todo' || !Array.isArray(o.steps)) return null
    return o.steps
      .map((s, i) => {
        const row = s as Record<string, unknown>
        const status =
          row.status === 'done' || row.status === 'in_progress' || row.status === 'pending'
            ? row.status
            : 'pending'
        const text = String(row.text ?? '').trim()
        if (!text) return null
        return {
          id: String(row.id ?? `s${i + 1}`),
          text,
          status
        } satisfies AgentTodoStep
      })
      .filter((x): x is AgentTodoStep => Boolean(x))
  } catch {
    return null
  }
}

/** True if assistant text opened a think/thinking block. */
export function hasThinkBlock(text: string | null | undefined): boolean {
  return /<\s*(?:think|thinking)\s*>/i.test(text ?? '')
}

/** Inner text of the first think/thinking block (unclosed counts). */
export function extractThinkInner(text: string | null | undefined): string {
  const raw = text ?? ''
  const closed = raw.match(
    /<\s*(?:think|thinking)\s*>([\s\S]*?)<\s*\/\s*(?:think|thinking)\s*>/i
  )
  if (closed) return (closed[1] ?? '').trim()
  const open = raw.match(/<\s*(?:think|thinking)\s*>([\s\S]*)$/i)
  return (open?.[1] ?? '').trim()
}

/** Think should be prose reasoning — not HTML / tool dumps. */
export function thinkBodyLooksLikeCodeDump(text: string | null | undefined): boolean {
  const inner = extractThinkInner(text) || (text ?? '')
  if (findCodeLeakIndex(inner) >= 0) return true
  if (/<write_file\b|call:write_file|<\/style>|bootstrap\.min|<link\s+rel=/i.test(inner)) {
    return true
  }
  // Long DeepThink prose is fine; only flag when markup/fences dominate.
  if (inner.length > 2400 && /<style[\s>]|<script[\s>]/i.test(inner)) return true
  return false
}

/** Index where generation / code starts leaking into think or plan prose. */
export function findCodeLeakIndex(text: string): number {
  const s = text ?? ''
  const patterns = [
    /```/,
    /<!DOCTYPE\s+html/i,
    /<html[\s>]/i,
    /<write_file\b/i,
    /call:write_file/i,
    /<\/?style\b/i,
    /<\/?script\b/i,
    /<\s*tool_call\b/i,
    /<\s*function\s*=/i,
    /<\s*parameter\s*=/i,
    /<\|tool_call\|/,
    /\[:tool\b/i,
    /\[:channel:/i
  ]
  let best = -1
  for (const re of patterns) {
    const m = s.search(re)
    if (m >= 0 && (best < 0 || m < best)) best = m
  }
  return best
}

/** Cut think prose before fenced code / HTML dumps. */
export function stripCodeLeakFromThink(text: string): string {
  let s = text ?? ''
  const at = findCodeLeakIndex(s)
  if (at >= 0) s = s.slice(0, at)
  return s
    .replace(/<\s*web_search\s*>[\s\S]*?(?:<\s*\/\s*web_search\s*>|$)/gi, '')
    .replace(/<\s*execute_terminal_command\s*>[\s\S]*?(?:<\s*\/\s*execute_terminal_command\s*>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/** Pull HTML the model dumped as plain assistant text (not a tool call). */
export function extractAssistantHtmlDump(text: string | null | undefined): string | null {
  const raw = text ?? ''
  const fence = raw.match(/```(?:html|htm)?\s*([\s\S]*?)(?:```|$)/i)
  if (fence?.[1] && /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]|<nav\b|<section\b|<div\b/i.test(fence[1])) {
    return fence[1].trim()
  }
  const doc = raw.search(/<!DOCTYPE\s+html|<html[\s>]/i)
  if (doc >= 0) {
    const body = raw.slice(doc).trim()
    if (body.length >= 40) return body
  }
  return null
}

export function looksLikeAssistantHtmlDump(text: string | null | undefined): boolean {
  const dump = extractAssistantHtmlDump(text)
  return Boolean(dump && dump.length >= 60)
}

/** True if text is mostly a numbered / checkbox plan, not prose reasoning. */
export function thinkLooksLikeChecklist(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  const checklistish = lines.filter((l) =>
    /^(\d+[.)]\s+|[-*•]\s+(\[[ xX]?\]\s+)?|\[\s*[xX ]?\]\s+)/.test(l)
  ).length
  return checklistish >= 2 && checklistish / lines.length >= 0.5
}

/** Think body for the UI fold. Keeps numbered lists; only drops code / tool dumps. */
export function sanitizeThinkProse(text: string | null | undefined): string {
  let inner = extractThinkInner(text)
  // Never fall back to the whole prelude (that pulled <plan> XML into «Думал»).
  if (!inner) return ''
  inner = stripPlanLeakFromThink(inner)
  inner = stripCodeLeakFromThink(inner)
  if (!inner) return ''
  if (thinkBodyLooksLikeCodeDump(`<think>${inner}</think>`)) {
    inner = inner
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.trim() &&
          !/^\s*</.test(l) &&
          !/write_file|```/.test(l)
      )
      .join('\n')
      .trim()
    if (!inner) return ''
  }
  if (/^(Планирую:|Planning:)/i.test(inner.trim())) return inner
  // Drop fenced code / obvious markup leftovers — keep 1) 2) 3) reasoning.
  inner = inner
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```[\s\S]*$/g, '')
    .replace(/<write_file[\s\S]*$/i, '')
    .trim()
  if (isEllipsisOnly(inner)) return ''
  // Allow DeepThink-length reasoning in the fold (was capped at 800).
  if (inner.length > 6000) inner = inner.slice(0, 6000).trim()
  return inner
}

export function isEllipsisOnly(text: string | null | undefined): boolean {
  return /^[.….\s·•…]+$/u.test((text ?? '').trim())
}

/**
 * Best-effort think prose for the UI. Never collapses a real stream to a lone "…".
 * Soft-keeps leftover sentences when sanitize would empty a checklist/code mix.
 */
export function displayThinkProse(text: string | null | undefined): string {
  const sanitized = sanitizeThinkProse(text)
  if (sanitized) return sanitized
  let inner =
    extractThinkInner(text) ||
    stripThinkTags(stripPlanBlock(text ?? '')).trim()
  inner = stripPlanLeakFromThink(inner)
  if (!inner || isEllipsisOnly(inner)) return ''
  if (/^<?\s*plan\b/i.test(inner) || inner === '<plan') return ''
  if (thinkBodyLooksLikeCodeDump(`<think>${inner}</think>`)) {
    inner = inner
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.trim() &&
          !/^\s*</.test(l) &&
          !/write_file|```/.test(l)
      )
      .join('\n')
      .trim()
  }
  if (!inner || isEllipsisOnly(inner)) return ''
  return inner.length > 6000 ? inner.slice(0, 6000).trim() : inner
}

export function stripThinkTags(text: string): string {
  return text
    .replace(/<\s*\/?\s*(?:think|thinking)\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Drop think blocks with their bodies (history context, not the UI fold). */
export function stripThinkBlocks(text: string): string {
  return (text ?? '')
    .replace(/<\s*(?:think|thinking)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking)\s*>/gi, '')
    .replace(/<\s*(?:think|thinking)\s*>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Live UI think body while tokens stream (do not wait for sanitize — show prose as it arrives). */
export function formatLiveThinkContent(rawAccum: string): string {
  let body = liveThinkProse(rawAccum)
  body = stripCodeLeakFromThink(body)
  if (thinkBodyLooksLikeCodeDump(`<think>${body}</think>`)) {
    body = body
      .split(/\r?\n/)
      .filter(
        (l) =>
          !/^\s*<(!DOCTYPE|html|head|body|style|script|link|meta|section|div|\/)/i.test(l) &&
          !/write_file|```/.test(l) &&
          !/^\s*<\s*\/?\s*plan\b/i.test(l)
      )
      .join('\n')
      .trim()
  }
  return `<think>\n${body}\n</think>`
}

/** Wrap clean prose so ThinkThroughBody can fold it. Never invent a lone ellipsis. */
export function wrapThinkForUi(prose: string): string {
  const clean = displayThinkProse(`<think>${prose}</think>`) || displayThinkProse(prose)
  return `<think>\n${clean}\n</think>`
}

/** Language-aware completeness (HTML `</html>`, braces, JSON, Python). */
export function contentLooksStructurallyComplete(
  content: string,
  relativePath = ''
): boolean {
  return contentLooksStructurallyCompleteV2(content, relativePath)
}

const CHARS_PER_TOKEN_READ = 3.2

/** Full-read budget from the model ctx — a whole file beats guessed line ranges. */
export function readFileCharBudget(ctxSize?: number): number {
  const ctx = Number.isFinite(ctxSize) && (ctxSize ?? 0) > 0 ? ctxSize! : 8192
  return Math.max(6_000, Math.min(24_000, Math.floor(ctx * CHARS_PER_TOKEN_READ * 0.25)))
}

/** Top-level anchors so a follow-up range request is exact, never guessed. */
export function buildFileStructureMap(raw: string, maxEntries = 60): string {
  const lines = raw.split(/\r?\n/)
  const anchors: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const t = line.trim()
    if (!t || t.length > 200) continue
    const isAnchor =
      /^<(?:style|script|head|body|nav|header|main|footer|section|article|aside|template)\b/i.test(t) ||
      /^<\/(?:style|script|head|body)\s*>/i.test(t) ||
      /^<[a-z][\w-]*[^>]*\b(?:id|class)\s*=/i.test(t) ||
      /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+[A-Za-z_$]/.test(t) ||
      /^(?:def|class)\s+[A-Za-z_]/.test(t) ||
      /^(?:public|private|protected|internal)\s+[\w<>[\]]+\s+\w+\s*\(/.test(t) ||
      /^@[A-Za-z-]+\s*[{(]?/.test(t) ||
      /^[.#]?[A-Za-z][\w -]*(?:,\s*[.#]?[A-Za-z][\w -]*)*\s*\{$/.test(t) ||
      /^#{1,6}\s+\S/.test(t) ||
      /^(?:[-\w"']+)\s*:\s*$/.test(t)
    if (!isAnchor) continue
    anchors.push(`${i + 1}| ${t.slice(0, 120)}`)
    if (anchors.length >= maxEntries) break
  }
  return anchors.join('\n')
}

/**
 * Pack read_file for the model. Whole file whenever it fits the ctx budget —
 * head+tail packing made the middle invisible and pushed the model into
 * guessing line ranges (read L1-10, L86-153 …) until the round cap.
 */
export function packReadFileForAgent(
  raw: string,
  opts?: {
    headLines?: number
    tailLines?: number
    maxChars?: number
    ctxSize?: number
    relativePath?: string
  }
): string {
  const maxChars = opts?.maxChars ?? readFileCharBudget(opts?.ctxSize)
  const lines = raw.split(/\r?\n/)
  const totalLines = lines.length
  const bytes = raw.length
  const complete = contentLooksStructurallyComplete(raw, opts?.relativePath ?? '')
  const status = complete ? 'FILE_COMPLETE' : 'FILE_MAYBE_INCOMPLETE'

  if (bytes <= maxChars) {
    return (
      `[read_file meta] total_lines=${totalLines} bytes=${bytes} truncated=false ${status}\n` +
      `--- full file ---\n` +
      raw
    )
  }

  // Too big for one shot: give a line-numbered map so the next range is exact.
  // Prefer map + fitted head/tail over a mid-body hard cut (which used to drop
  // the structure map and the closing lines the model needed).
  const headCap = opts?.headLines ?? 120
  const tailCap = opts?.tailLines ?? 60
  let headN = headCap
  let tailN = Math.min(tailCap, Math.max(0, totalLines - 1))
  const map = buildFileStructureMap(raw)
  const mapBlock = map ? `--- structure map (line| anchor) ---\n${map}\n` : ''
  const preface =
    `[read_file meta] total_lines=${totalLines} bytes=${bytes} truncated=true ${status}\n` +
    `NOTE: File is too large for one read (${bytes} > ${maxChars} chars). Middle omitted.\n` +
    `Use the STRUCTURE MAP below to request an EXACT range with read_file start_line/end_line — never guess line numbers. Do NOT rewrite the file.\n` +
    mapBlock

  const buildBody = (h: number, t: number): string => {
    const head = lines.slice(0, h).join('\n')
    const tailStart = Math.max(h, totalLines - t)
    const omitted = Math.max(0, tailStart - h)
    let body =
      preface.replace('Middle omitted.', `Middle omitted (${omitted} lines).`) +
      `--- lines 1-${Math.min(h, totalLines)} ---\n${head}`
    if (tailStart < totalLines) {
      body += `\n--- lines ${tailStart + 1}-${totalLines} (tail) ---\n${lines.slice(tailStart).join('\n')}`
    }
    return body
  }

  let body = buildBody(headN, tailN)
  while (body.length > maxChars + 800 && (headN > 24 || tailN > 12)) {
    if (headN >= tailN * 2) headN = Math.max(24, Math.floor(headN * 0.7))
    else tailN = Math.max(12, Math.floor(tailN * 0.7))
    body = buildBody(headN, tailN)
  }
  if (body.length > maxChars + 2000) {
    // Last resort: keep meta + structure map (the actionable part).
    const essential = preface.trimEnd() + '\n…[head/tail omitted — use structure map ranges]'
    return essential.length <= maxChars + 2000
      ? essential
      : essential.slice(0, maxChars) + '\n…[pack truncated for context]'
  }
  return body
}

/** Cache key so a later range never receives an earlier range's body. */
export function readFileRangeCacheKey(
  pathKey: string,
  startLine?: unknown,
  endLine?: unknown
): string {
  return `${pathKey}|${Number(startLine) || 0}-${Number(endLine) || 0}`
}

/**
 * When the re-read budget is spent: serve only an exact range hit.
 * Never invent an empty ok:true body — that lied to the model and caused loops.
 */
export function resolveExhaustedReadBudget(
  cached: string | undefined,
  filePath: string
): { ok: true; content: string } | { ok: false; content: string; error: string } {
  if (cached !== undefined) {
    return {
      ok: true,
      content: `${cached}\n[cached read_file: identical range already read this turn — use it, do not re-read]`
    }
  }
  return {
    ok: false,
    content: '',
    error:
      `READ_BUDGET: "${filePath}" was already read this turn and the re-read budget is spent. ` +
      'Use the content you already have. To locate something specific call search_codebase, ' +
      'then edit with apply_diff. Do NOT keep requesting line ranges.'
  }
}

/** Parse total_lines from packed read_file meta for UI activity labels. */
export function parseReadFileMeta(content: string): {
  totalLines?: number
  truncated?: boolean
} {
  const m = content.match(
    /\[read_file meta\]\s+total_lines=(\d+)\s+bytes=\d+\s+truncated=(true|false)/i
  )
  if (!m) return {}
  return {
    totalLines: Number(m[1]),
    truncated: m[2]!.toLowerCase() === 'true'
  }
}

type LandingSectionKey =
  | 'scaffold'
  | 'navbar'
  | 'hero'
  | 'features'
  | 'how'
  | 'social'
  | 'faq'
  | 'footer'
  | 'browser'
  | 'other'

const LANDING_SECTION_ORDER: Exclude<LandingSectionKey, 'browser' | 'other'>[] = [
  'scaffold',
  'navbar',
  'hero',
  'features',
  'how',
  'social',
  'faq',
  'footer'
]

/** Map a plan row to a landing section key for de-duplication. */
export function landingSectionKey(text: string): LandingSectionKey {
  const t = text.trim()
  if (!t) return 'other'
  if (isBrowserPlanStep(t)) return 'browser'
  if (/каркас|html\s*\+\s*css|^bootstrap\b/i.test(t) && t.length < 48) return 'scaffold'
  if (/^секц\w*\s*:\s*/i.test(t) || t.length < 28 || /^(navbar|hero|features?|faq|footer|how|social)/i.test(t)) {
    if (/каркас|html\s*\+|bootstrap/i.test(t)) return 'scaffold'
    if (/navbar|навиг|шапк/i.test(t)) return 'navbar'
    if (/\bhero\b|главн\w*\s+экран|jumbotron/i.test(t)) return 'hero'
    if (/feature|возможн|преимущ/i.test(t)) return 'features'
    if (/how\s*it\s*works|как\s*работа/i.test(t)) return 'how'
    if (/social|trust|отзыв|доказат/i.test(t)) return 'social'
    if (/\bfaq\b|вопрос/i.test(t)) return 'faq'
    if (/footer|подвал/i.test(t)) return 'footer'
  }
  // Long descriptive rows — still one section each
  if (/\bnavbar\b|навигац|логотип\s+northline|cta-?кнопк/i.test(t) && !/\bhero\b/i.test(t.slice(0, 40))) {
    return 'navbar'
  }
  if (/\bhero\b|hero-секц|крупн\w*\s+заголов/i.test(t)) return 'hero'
  if (/feature|возможн|преимущ|карточки/i.test(t)) return 'features'
  if (/how\s*it\s*works|как\s*работа/i.test(t)) return 'how'
  if (/social\s*proof|trust|отзыв|доказат/i.test(t)) return 'social'
  if (/\bfaq\b|вопрос/i.test(t)) return 'faq'
  if (/footer|подвал|копирайт/i.test(t)) return 'footer'
  if (/navbar|навиг|шапк|логотип/i.test(t)) return 'navbar'
  if (/каркас|html\s*\+|bootstrap|полный\s+лендинг|single[- ]?file/i.test(t)) return 'scaffold'
  return 'other'
}

/**
 * Drop duplicate landing rows (bare "Navbar" + long "Реализовать Navbar…").
 * Prefer the more specific (longer) description; keep canonical section order.
 */
export function dedupeLandingPlanSteps(steps: AgentTodoStep[]): AgentTodoStep[] {
  if (steps.length <= 1) return steps
  const best = new Map<LandingSectionKey, AgentTodoStep>()
  const others: AgentTodoStep[] = []
  for (const s of steps) {
    const key = landingSectionKey(s.text)
    if (key === 'other') {
      others.push(s)
      continue
    }
    const prev = best.get(key)
    if (!prev) {
      best.set(key, s)
      continue
    }
    // Prefer longer / more specific over bare labels like "Navbar".
    const prevBare = isBareLandingSectionStep(prev.text) || prev.text.trim().length < 24
    const nextBare = isBareLandingSectionStep(s.text) || s.text.trim().length < 24
    if (prevBare && !nextBare) best.set(key, s)
    else if (!prevBare && nextBare) {
      /* keep prev */
    } else if (s.text.trim().length > prev.text.trim().length) best.set(key, s)
  }

  const ordered: AgentTodoStep[] = []
  for (const k of LANDING_SECTION_ORDER) {
    const s = best.get(k)
    if (s) ordered.push(s)
  }
  ordered.push(...others)
  const browser = best.get('browser')
  if (browser) ordered.push(browser)

  return ordered.slice(0, 10).map((s, i) => ({
    ...s,
    id: `s${i + 1}`,
    status: (i === 0 ? 'in_progress' : 'pending') as AgentTodoStep['status']
  }))
}

/** Plan rows that escalate to rewriting the whole file — never keep these. */
export function isFullRewriteFallbackPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /если\s+(патч|patch)\s+не\s+сработ/i.test(t) ||
    /патч\s+не\s+сработал\s*[—\-–:].*перепис/i.test(t) ||
    /переписать\s+(файл\s+)?целик/i.test(t) ||
    /перепис(ать|ывать)\s+(весь\s+)?файл\s+(с\s+нуля|целиком|полностью)/i.test(t) ||
    /rewrite\s+(the\s+)?(whole|entire)\s+file/i.test(t) ||
    /full\s+rewrite\s+(if|when|fallback)/i.test(t) ||
    /overwrite\s+(the\s+)?(whole|entire)\s+file/i.test(t) ||
    /иначе\s+закрыть/i.test(t) && /перепис|rewrite|overwrite/i.test(t)
  )
}

/** Plan rows that name tools / shell / "close" — not product work from the user prompt. */
export function isToolOrientedPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (isFullRewriteFallbackPlanStep(t)) return true
  if (
    /\b(execute_terminal_command|write_file|read_file|apply_patch|apply_diff|generate_image|create_directory|list_directory|search_codebase|web_search|explore_subagent)\b/i.test(
      t
    )
  ) {
    return true
  }
  if (/\b(Start-Process|Get-Content|Invoke-Item|Select-String|Measure-Object)\b/i.test(t)) {
    return true
  }
  if (/проверк\w*\s+синтаксис|синтаксис\s+html|html\s+syntax|syntax\s+check/i.test(t)) {
    return true
  }
  if (/^(закрыть|close|стоп|stop|конец)\.?$/i.test(t)) return true
  return false
}

/** Finish remaining landing files (HTML/CSS) without touching JS. Not a surgical CSS tweak. */
export function looksLikeFinishMissingLandingFiles(userText: string): boolean {
  const t = (userText ?? '').trim()
  if (!t) return false
  const mentionsHtmlCss = /index\.html|styles\.css|\.css\b/i.test(t)
  const finish =
    /допиши|доделай|дописать|finish|remaining|missing|напиши\s+(index|styles)|не\s+трогай\s+js|don't\s+touch\s+(the\s+)?js|не\s+меняй\s+js/i.test(
      t
    )
  return mentionsHtmlCss && finish
}

/**
 * User already pasted product facts + GitHub URLs — do not crawl README / explore.
 */
export function landingBriefAlreadyHasFacts(userText: string): boolean {
  const t = userText ?? ''
  if (!t.trim()) return false
  if (!looksLikeLandingBuildTask(t) && !looksLikeFromScratchTask(t)) return false
  const github = /github\.com\/\S+/i.test(t)
  const product =
    /llama\.cpp|GGUF|Electron|Monaco|локальн\w*\s+GGUF|on-device|Windows x64/i.test(t)
  return github && product
}

/** Plan rows that stall a landing on GitHub scavenger hunts. */
export function isResearchScavengerPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/readme\.md/i.test(t) && /созда|напис|write|лендинг|landing/i.test(t)) return false
  if (isPreviewHealthCheckPlanStep(t)) return false
  return (
    /explore_subagent|web_search|curl(\.exe)?|Invoke-WebRequest|raw\.githubusercontent|api\.github/i.test(
      t
    ) ||
    /изучить\s+(репозитор|github|readme)|исследовать\s+(репозитор|github)/i.test(t) ||
    /собрать\s+(точн\w*\s+)?факт|fetch\s+(the\s+)?readme|scrape\s+github/i.test(t) ||
    /fetch\s+.{0,80}(github|readme|репозитор)/i.test(t) ||
    /github.{0,60}(readme|repo\s+content|source\s+code)/i.test(t) ||
    /extract.{0,80}(product\s+)?facts/i.test(t) ||
    /прочит(ать|ай).{0,40}(readme|github|репозитор)/i.test(t)
  )
}

/** True when the user is asking to build a full landing / new page from scratch. */
export function looksLikeLandingBuildTask(userText: string): boolean {
  const t = userText ?? ''
  if (!t.trim()) return false
  if (
    /исправ|поправ|убери|добавь|цвет|theme|тем[аы]|faq|перепиши\s+блок|только\s+(css|html|faq)|white|серый|gray|grey/i.test(
      t
    ) &&
    !/лендинг|landing|одностранич|bootstrap\s*5|с\s*нуля|новый\s+сайт/i.test(t)
  ) {
    // Targeted fix language without “build a landing” → not a build task.
    if (t.length < 900) return false
  }
  return (
    /лендинг|landing\s*page|одностранич|single[- ]?page|bootstrap\s*5|создай\s+(сайт|страниц|лендинг)|напиши\s+(лендинг|index\.html)|hero|navbar.*footer|все\s+секц/i.test(
      t
    ) ||
    (/index\.html/i.test(t) && /navbar|hero|features|faq|footer/i.test(t) && t.length > 400)
  )
}

/** User forbade a grid of AI feature cards. */
export function looksLikeNoCardDumpRequest(userText: string): boolean {
  const t = userText ?? ''
  return /карточного\s+мусора|ai-?карточного|без\s+['«"]?карто|card(?:-|\s)?(?:dump|clutter)|without\s+.*cards?/i.test(
    t
  )
}

/** Bare “Секция: Navbar” rows — junk on a surgical FAQ/CSS fix. */
export function isBareLandingSectionStep(text: string): boolean {
  const t = text
    .trim()
    .replace(/^секци[яюи]?\s*:\s*/i, '')
    .replace(/^section\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '')
  return /^(navbar|навигац\w*|hero|features?|возможн\w*|how\s*it\s*works|как\s*работа\w*|social\s*proof|trust|faq|footer|подвал|каркас(\s+html.*)?|html\s*\+\s*css)$/i.test(
    t
  )
}

/** CSS class / Bootstrap token — never a product plan row. */
export function isCssClassPlanStep(text: string): boolean {
  const raw = text.trim()
  // Model dumps selectors as: Секция: 'btn-primary' / Секция: "card"
  if (/^секци[яюи]?\s*:\s*['"`][\w.-]+['"`]\s*$/i.test(raw)) return true
  const t = raw
    .replace(/^секци[яюи]?\s*:\s*/i, '')
    .replace(/^section\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\./, '')
    .trim()
  if (!t || t.length > 48) return false
  if (/\s/.test(t)) return false
  return (
    /^(btn|badge|card|nav-|navbar-toggler|accordion|form-|col-|row|container|dropdown|list-group|spinner|alert|modal|offcanvas|pagination|progress|toast)[\w-]*/i.test(
      t
    ) ||
    /^(primary|secondary|success|danger|warning|info|light|dark)$/i.test(t) ||
    /^[a-z][\w-]*--[\w-]+$/i.test(t)
  )
}

export function isLandingSectionToken(text: string): boolean {
  const t = text
    .trim()
    .replace(/^секци[яюи]?\s*:\s*/i, '')
    .replace(/^section\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
  return /^(navbar|навигац\w*|hero|features?|возможн\w*|how(\s*it\s*works)?|как\s*работа\w*|social(\s*proof)?|trust|faq|footer|подвал|каркас)$/i.test(
    t
  )
}

/** True when ≥ half the steps are tool/shell fluff (bad PLAN_ONLY from the model). */
export function looksLikeToolOrientedPlan(steps: AgentTodoStep[]): boolean {
  if (!steps.length) return true
  const bad = steps.filter(
    (s) => isToolOrientedPlanStep(s.text) || isJunkPlanStep(s.text)
  ).length
  const hasSection = steps.some((s) =>
    /navbar|hero|feature|faq|footer|каркас|how\s*it|social|trust|навиг|секц/i.test(s.text)
  )
  // Short edit plans without section labels are OK — do NOT treat as tool fluff.
  if (!hasSection && steps.length <= 5) {
    return bad >= Math.ceil(steps.length / 2)
  }
  return bad >= Math.ceil(steps.length / 2)
}

export type CoercePlanOptions = {
  userText?: string
  /** When true, never inject the full landing checklist. */
  surgical?: boolean
}

/**
 * Landing file order the user asked for (CSS/JS/assets before index.html).
 * Reorders the plan card only — does not block the agent from calling tools in another order.
 */
export function landingPlanDependencyRank(text: string): number {
  const t = text.toLowerCase()
  if (isBrowserPlanStep(text)) return 60
  if (/readme/i.test(t)) return 50
  const mentionsHtml = /\.html?\b|index\.html|написать\s+.*html|write\s+.*html|собрать\s+все\s+секц|все\s+секции/i.test(
    t
  )
  const mentionsCss = /\.css\b|styles\.css|типографик|dark\s+theme|адаптив/i.test(t)
  const mentionsJs = /\.js\b|main\.js|javascript/i.test(t)
  if (mentionsHtml && !mentionsCss && !mentionsJs) return 40
  if (mentionsJs && !mentionsCss && !mentionsHtml) return 30
  if (mentionsCss && !mentionsHtml) return 20
  if (/svg|иконк|icon/i.test(t) && !/структур|папк|folder|mkdir|каталог/i.test(t)) return 15
  if (
    /структур|папк|folder|mkdir|каталог|директор|assets\/|css\/|js\//i.test(t) &&
    !mentionsHtml &&
    !mentionsCss &&
    !mentionsJs
  ) {
    return 10
  }
  return 45
}

export function sortPlanByUserDependencies(
  steps: AgentTodoStep[],
  userText: string
): AgentTodoStep[] {
  if (!steps.length) return steps
  const rankFn = looksLikeLandingBuildTask(userText)
    ? landingPlanDependencyRank
    : codingPlanDependencyRank
  return steps
    .map((s, i) => ({ s, i, rank: rankFn(s.text) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i))
    .map(({ s }) => s)
}

/** Edit before run, module before go run, summary last. */
export function codingPlanDependencyRank(text: string): number {
  const t = text.toLowerCase()
  if (isMetaOrSummaryPlanStep(text) || /оформить|сводк|итогов|заключен/i.test(t)) return 90
  if (isBrowserPlanStep(text)) return 80
  if (
    /(?:^|[^\p{L}])запустить|go\s+run|node\s+test|прогнать\s+(скрипт|тест)/iu.test(t) &&
    !/заменить|исправить|починить|написать|создать|прочитать/.test(t)
  ) {
    return 55
  }
  if (/go\.mod|инициализир\w*\s+модул/i.test(t)) return 28
  if (/прочитать|найти строку|read /i.test(t)) return 12
  if (/заменить|исправить|починить|поправ|написать|создать|write|fix |patch/i.test(t)) {
    return 22
  }
  if (/интернет|актуальн|версию/i.test(t)) return 16
  return 40
}

/**
 * Keep plan grounded in the model's own steps.
 * Empty / tool-name / status-noise rows are dropped; nothing is invented.
 */
export function coerceProductPlan(
  steps: AgentTodoStep[] | null | undefined,
  opts?: CoercePlanOptions
): AgentTodoStep[] {
  let cleaned = (steps ?? []).filter(
    (s) => !isJunkPlanStep(s.text) && !isToolOrientedPlanStep(s.text)
  )
  if (opts?.surgical) {
    cleaned = cleaned.filter((s) => !isScaffoldLandingPlanStep(s.text))
  }
  if (!cleaned.length) return []
  const cap = opts?.surgical ? 4 : 10
  let sliced = cleaned.slice(0, cap)
  sliced = sortPlanByUserDependencies(sliced, opts?.userText ?? '')
  return sliced.map((s, i) => ({
    ...s,
    id: `s${i + 1}`,
    status: (i === 0 ? 'in_progress' : 'pending') as AgentTodoStep['status']
  }))
}

/**
 * Drop plan rows that restate earlier chat work or expand far beyond THIS request
 * (e.g. navbar ask → weather / i18n / “fully rewrite landing”).
 */
/** From-scratch landing rows that must not reappear on a surgical follow-up. */
export function isScaffoldLandingPlanStep(text: string): boolean {
  const x = text.trim()
  if (!x) return false
  if (/исправ|поправ|fix\b|toggle|переключ|theme|тем[аые]/i.test(x)) return false
  return (
    /create\s+index\.html|созда(ть|й|ю)\s+index\.html|напис\S*\s+index\.html/i.test(x) ||
    /create\s+styles\.css|созда(ть|й|ю)\s+styles\.css/i.test(x) ||
    /create\s+js\/main\.js|созда(ть|й|ю)\s+js\/main/i.test(x) ||
    /explore.{0,60}(github|репозитор)|изучить\s+(репозитор|github|readme)|собрать\s+точн/i.test(
      x
    ) ||
    /полный\s+лендинг|full\s+(multi-?file\s+)?landing|создать\s+assets/i.test(x)
  )
}

export function filterPlanToCurrentRequest(
  steps: AgentTodoStep[],
  userText: string
): AgentTodoStep[] {
  const t = userText.trim()
  if (!steps.length || !t) return steps
  const surgical = looksLikeSurgicalFollowUp(t)
  const navbarOnly =
    /навбар|navbar|header/i.test(t) &&
    !/лендинг\s+с\s*нуля|landing\s+from\s+scratch|все\s+секц|bootstrap\s*5/i.test(t)
  const out = steps.filter((s) => {
    const x = s.text
    if (/погод|weather|одежд|печк|что\s+лучше\s+одеть/i.test(x)) return false
    if (surgical && isScaffoldLandingPlanStep(x)) return false
    if (
      /i18n|RU\s*\/\s*EN|EN\s*\/\s*RU|переключ\S*\s+язык|language\s+switch/i.test(x) &&
      !/язык|i18n|переключател|EN\s*\/\s*RU|RU\s*\/\s*EN|switcher/i.test(t)
    ) {
      return false
    }
    if (
      (looksLikeI18nFollowUp(t) || surgical) &&
      /git\s+clone|изучить\s+репозитор|создать\s+assets|полный\s+лендинг|все\s+секц|hero\.svg|bootstrap/i.test(
        x
      )
    ) {
      return false
    }
    if (
      navbarOnly &&
      /полностью\s+обнов|весь\s+лендинг|перепис\S*\s+(styles|css|лендинг)|hero\.js|open-?meteo|виджет\s+погод/i.test(
        x
      )
    ) {
      return false
    }
    return true
  })
  const capped = out.slice(0, navbarOnly || looksLikeI18nFollowUp(t) || surgical ? 4 : 10)
  return capped.map((s, i) => ({
    ...s,
    id: `s${i + 1}`,
    status: (i === 0 ? 'in_progress' : s.status === 'done' ? 'done' : 'pending') as AgentTodoStep['status']
  }))
}

/** Parse <plan>…</plan> or a markdown [Plan] / checklist body into todo steps. */
export function parsePlanBlock(text: string | null | undefined): AgentTodoStep[] | null {
  const raw = text ?? ''
  let body = ''
  const xml = raw.match(/<\s*plan\s*>([\s\S]*?)(?:<\s*\/\s*plan\s*>|$)/i)
  if (xml) {
    body = xml[1] ?? ''
  } else {
    const leak = findPlanLeakIndex(raw)
    if (leak >= 0) {
      body = raw.slice(leak).replace(/^[\s\S]*?(?:<\s*plan\b[^>]*>|\[\s*plan\s*\]|#{0,3}\s*plan\s*:?\s*)/i, '')
    } else if (/^[\s]*[-*•\d]/.test(raw.trim()) && (raw.match(/^\s*[-*•\d]/gm) ?? []).length >= 3) {
      body = raw
    } else {
      return null
    }
  }
  const steps: AgentTodoStep[] = []
  for (const line of body.split(/\r?\n/)) {
    let t = line.trim()
    if (!t) continue
    t = t
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^\[[ xX]?\]\s*/, '')
      .trim()
    if (t.length < 2) continue
    if (/^#{1,6}\s/.test(t)) continue
    if (/^<\/?\s*plan/i.test(t) || /^\[\s*plan\s*\]/i.test(t)) continue
    if (isJunkPlanStep(t)) continue
    for (const piece of splitCompoundPlanStep(t)) {
      if (isJunkPlanStep(piece)) continue
      steps.push({
        id: `s${steps.length + 1}`,
        text: piece.slice(0, 140),
        status: 'pending'
      })
    }
  }
  if (steps.length === 0) return null
  steps[0]!.status = 'in_progress'
  return dedupeLandingPlanSteps(steps.slice(0, 14))
}

/** Split “все секции (a, b, c)” / “полный лендинг” mega-steps into atomic todos. */
export function splitCompoundPlanStep(text: string): string[] {
  const t = text.trim()
  const mega =
    /полный\s+лендинг|весь\s+лендинг|все\s+секц|single[- ]?file|index\.html\s*[—–-].{30,}|write index\.html.*bootstrap|написать\s+.*index\.html|создать\s+.*index\.html/i.test(
      t
    )
  if (mega && /navbar|hero|feature|faq|footer|bootstrap|секц|лендинг|landing/i.test(t)) {
    return [t]
  }
  if (t.length < 60) return [t]
  const grouped = t.match(/\(([^)]{15,})\)/)
  if (grouped?.[1] && /navbar|hero|feature|faq|footer|how|social|навиг|секц/i.test(grouped[1])) {
    const parts = grouped[1]
      .split(/\s*[+,;/]\s*|\s+и\s+/i)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
    if (
      parts.length >= 3 &&
      parts.filter((p) => isLandingSectionToken(p)).length >= 3 &&
      !parts.some((p) => isCssClassPlanStep(p) && !isLandingSectionToken(p))
    ) {
      return parts.map((p) => (/^секц/i.test(p) ? p : `Секция: ${p}`))
    }
  }
  if (/[,;].*(?:navbar|hero|features|faq|footer)/i.test(t) && (t.match(/,/g) ?? []).length >= 2) {
    const afterColon = t.split(/:\s*/).slice(1).join(': ').trim() || t
    const parts = afterColon
      .split(/\s*,\s*/)
      .map((x) => x.replace(/\s+и\s+/gi, ' ').trim())
      .filter((x) => x.length >= 3 && x.length < 80)
    // "navbar, card, btn-primary…" → CSS junk; only split real landing section lists.
    if (
      parts.length >= 3 &&
      parts.filter((p) => isLandingSectionToken(p)).length >= Math.ceil(parts.length * 0.6) &&
      parts.every((p) => isLandingSectionToken(p) || !isCssClassPlanStep(p))
    ) {
      return parts
    }
  }
  return [t]
}

/** Index where a plan section starts (XML <plan> or markdown [Plan]). */
export function findPlanLeakIndex(text: string): number {
  const s = text ?? ''
  const patterns = [
    /<\s*plan\b/i,
    /\[\s*plan\s*\]/i,
    /\*{0,2}\[\s*plan\s*\]\*{0,2}/i
  ]
  let best = -1
  for (const re of patterns) {
    const m = s.search(re)
    if (m >= 0 && (best < 0 || m < best)) best = m
  }
  return best
}

/** Strip complete or partial plan markup from think prose. */
export function stripPlanLeakFromThink(text: string): string {
  let s = text ?? ''
  const planAt = findPlanLeakIndex(s)
  if (planAt >= 0) s = s.slice(0, planAt)
  s = s
    .replace(/<\s*\/?\s*plan\b[^>]*>?/gi, '')
    .replace(/\[\s*plan\s*\]/gi, '')
    .replace(/<[^>]*$/g, '')
    .replace(/^\s*>+\s*/g, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Live think text from a raw token buffer. Does not require <think> tags.
 * Cuts at <plan / [Plan], strips tag crumbs, keeps prose as it arrives.
 */
export function liveThinkProse(rawAccum: string): string {
  let s = rawAccum ?? ''
  const planAt = findPlanLeakIndex(s)
  if (planAt >= 0) s = s.slice(0, planAt)
  s = s.replace(/<\s*\/?\s*(?:think|thinking)\s*>/gi, '')
  s = stripPlanLeakFromThink(s)
  s = stripCodeLeakFromThink(s)
  if (isEllipsisOnly(s) || /^<?\s*plan\b/i.test(s) || /^\[\s*plan\s*\]/i.test(s)) return ''
  return s
}

export function stripPlanBlock(text: string): string {
  return stripPlanLeakFromThink(
    text
      .replace(/<\s*plan\s*>[\s\S]*?<\s*\/\s*plan\s*>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** Vague trailing plan lines the model likes to add — drop them. */
export function isFluffPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return (
    /при\s+необходимост|по\s+необходимости|если\s+нужно|при\s+нужде/i.test(t) ||
    /отредактировать\s+при|подправить\s+при|доработать\s+при/i.test(t) ||
    /edit\s+if\s+necessary|if\s+necessary|as\s+needed|optional\s+(edit|polish|tweak)/i.test(t) ||
    /polish\s+if|tweaks?\s+if\s+needed|adjust\s+if\s+needed/i.test(t) ||
    /если\s+есть\s+ошибк/i.test(t) ||
    /исправить\s+и\s+перезапустить/i.test(t) ||
    /ключев\p{L}*\s+ограничен/iu.test(t) ||
    /^ограничен/iu.test(t) ||
    /^план\s+действий/i.test(t) ||
    /каждый\s+шаг\s+созда[её]т\s+файлы/i.test(t) ||
    /^(edit|fix|polish|review|проверить|поправить)\.?$/i.test(t)
  )
}

/**
 * Verify/summary plan rows are NOT real tool work — they blocked Start-Process forever
 * ("Подтвердить отсутствие ошибок", "Дать краткую сводку…").
 */
export function isMetaOrSummaryPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (isBrowserPlanStep(t)) return false
  if (isToolOrientedPlanStep(t)) return true
  return (
    /сводк|summary|summarizing|суммируя|заключен|отчёт|отчет|report\s+completion/i.test(t) ||
    /подвест[\p{L}]*\s+итог|итог[ауе]?\s*:/iu.test(t) ||
    /подтвердить|валидац|отсутствие\s+ошибок|корректность\s+отображ/i.test(t) ||
    /провер[\p{L}]*\s+(отсутств|ошибок|корректн|отображ|вёрст|верст|html|синтаксис)/iu.test(t) ||
    /убедить?ся,?\s+что/iu.test(t) ||
    /give\s+(a\s+)?brief|краткую\s+сводк|пользователю\s+на\s+(русск|english)/i.test(t) ||
    /кратко\s+сообщ|сообщ\S*\s+пользовател|inform\s+the\s+user|tell\s+the\s+user|о\s+результатах/i.test(
      t
    ) ||
    /извлечь\s+информац|extract\s+(the\s+)?(info|information|data|temp|weather)|распарс/i.test(t) ||
    /получить\s+актуальн|fetch\s+(current|live)\s+(weather|data)/i.test(t) ||
    /уточнить\s*,?\s*если|clarify\s+if|дополнительн\S*\s+детал/i.test(t) ||
    /уже\s+(дан|даны|предоставлен|сообщен|выполнен)|already\s+(been\s+)?(given|provided|answered|done)/i.test(
      t
    ) ||
    /^(verify|validate|check|confirm|done|finish|summarize|report|закрыть|close)\b/i.test(t) ||
    /напиши\s+(кратк|итог|заключен)|write\s+(a\s+)?(short\s+)?(summary|closing)/i.test(t) ||
    /показать\s+(реальн\w+\s+)?вывод|show\s+(the\s+)?(real\s+)?(terminal\s+)?output|вывод\s+терминала/i.test(
      t
    ) ||
    /подготовить\s+(короткий\s+)?тестовый\s+текст|prepare\s+(a\s+)?(short\s+)?test(\s+text| input)?/i.test(
      t
    )
  )
}

/** Model repeating “plan already done in previous answer” — stop the nudge loop. */
export function isRedundantPlanCompleteProse(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return (
    /все\s+(три\s+)?шаг\S*\s+плана\s+уже\s+выполн/i.test(t) ||
    /уже\s+выполнен\S*\s+в\s+предыдущ/i.test(t) ||
    /отправлено\s+в\s+предыдущ\S*\s+ответ/i.test(t) ||
    /уже\s+предоставлен|already\s+provided|рекомендации\s+по\s+одежде\s+уже/i.test(t) ||
    /already\s+(been\s+)?(completed|done|finished)\s+in\s+the\s+previous/i.test(t) ||
    /all\s+(three\s+)?plan\s+steps?\s+(are\s+)?already\s+(done|complete)/i.test(t)
  )
}

/** «с NorthLine на AFKLLM» / «замени Foo на Bar» — literal global rename in a file. */
export function parseGlobalRenameIntent(
  text: string
): { from: string; to: string } | null {
  const t = text.trim()
  if (!t || t.length > 220) return null
  if (!/измени|замени|переимен|помен|rename|replace|везде/i.test(t)) return null
  const m =
    t.match(
      /(?:с|from)\s+([A-Za-z][\w.-]{1,48})\s+(?:на|to)\s+([A-Za-z][\w.-]{1,48})/i
    ) ||
    t.match(
      /(?:замени|заменить|поменяй|измени|rename|replace)\s+([A-Za-z][\w.-]{1,48})\s+(?:на|to|with)\s+([A-Za-z][\w.-]{1,48})/i
    )
  if (!m?.[1] || !m?.[2]) return null
  if (m[1].toLowerCase() === m[2].toLowerCase()) return null
  return { from: m[1], to: m[2] }
}

/** «…затем открой его» after an edit. */
export function wantsOpenAfterEdit(text: string): boolean {
  return /(?:затем|потом|после\s+этого|and\s+then|then).{0,24}(открой|open)|открой\s+(его|её|ее|файл|лендинг|index)|then\s+open|and\s+open\s+it/i.test(
    text
  )
}

export function replaceAllCi(content: string, from: string, to: string): string {
  if (!from) return content
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return content.replace(new RegExp(escaped, 'gi'), to)
}

export function countOccurrencesCi(content: string, needle: string): number {
  if (!needle) return 0
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return content.match(new RegExp(escaped, 'gi'))?.length ?? 0
}

/** Think/plan claiming the job is already done before any tools ran. */
export function isFalseSuccessProse(prose: string): boolean {
  const t = prose.trim()
  if (!t) return false
  if (/превью\s+открыто в приложении|preview is open in the app/i.test(t)) return false
  return (
    /^(готово|сделано|done)[!.,:\s]/i.test(t) ||
    /все\s+упоминания\s+\w+\s+заменен/i.test(t) ||
    /страница\s+открыта\s+в\s+браузер/i.test(t) ||
    /что\s+изменилось\s*:|как\s+проверить\s*:|what\s+changed\s*:/i.test(t) ||
    /заменен[ыао]\s+на\s+\w+.*(открыт|браузер|проверк)/i.test(t) ||
    // Hallucinated progress without tools — not a long post-tool closer.
    (t.length < 160 && /файлы?\s+создан|созданн\S*\s+файл/i.test(t)) ||
    /файлы?\s+создан(?:ы|о|а)?\s*:|созданн\S*\s+файл\s*:/i.test(t) ||
    /files?\s+(?:were\s+)?created|created\s+files?/i.test(t) ||
    /(?:создаю|пишу|writing|creating)\s+(?:компонент|component|styles\.css|js\/|index\.html|assets\/|navbar|навбар)/i.test(
      t
    ) ||
    /обновляю\s+index\.html|updating\s+index\.html|без\s+полной\s+перепис/i.test(t) ||
    /(?:^|\n)\s*(?:созданные\s+файлы|обновления|структура|язык)\s*:/i.test(t)
  )
}

function isCloserMetaBlock(block: string): boolean {
  const s = block.trim()
  if (!s) return true
  if (
    /^(perfect!?|now i need to write.{0,80}summary|let me write a concise.{0,60}summary|the task is complete|the user wants me to stop|let me compile what was done)/i.test(
      s
    )
  ) {
    return true
  }
  if (/пользователь просит дописать заключен/i.test(s)) return true
  if (/нужно просто добавить завершающий текст/i.test(s)) return true
  if (/без новых tool calls/i.test(s) && /заключен|closing|summary/i.test(s)) return true
  if (
    /the user .{0,100}(?:asks|wants|is asking|requested).{0,100}(?:closing|summary|заключен)/i.test(
      s
    )
  ) {
    return true
  }
  return false
}

/** Drop model-to-self chatter so the user sees the real closer (RU when the UI is RU). */
export function preferUserFacingCloser(text: string, uiLang: 'ru' | 'en'): string {
  let t = stripThinkBlocks(text ?? '').trim()
  if (!t) return t
  t = t
    .replace(/The task is complete\.?\s*/gi, '')
    .replace(
      /I should (?:provide|write|give) a (?:short )?summary in Russian[^.]*\.?\s*/gi,
      ''
    )
    .replace(/The user wants me to stop and write a closing summary in Russian[^.]*\.?\s*/gi, '')
    .replace(/Let me compile what was done:\s*/gi, '')
    .replace(/Let me summarize what was done:\s*/gi, '')
    .replace(/Perfect!\s*/gi, '')
    .replace(
      /Now I need to write (?:the |a )?(?:closing |concise )?(?:Russian )?summary[^.]*\.?\s*/gi,
      ''
    )
    .replace(
      /Let me write a concise (?:Russian )?summary[^.]*\.?\s*/gi,
      ''
    )
    .replace(/Пользователь просит дописать заключен[^.!?\n]*[.!?]\s*/gi, '')
    .replace(/Нужно просто добавить завершающий текст[^.!?\n]*[.!?]\s*/gi, '')
    .replace(/(?:^|\s)(?:но )?без новых tool calls\.?\s*/gi, ' ')
    .replace(
      /The user (?:asks|wants|is asking|requested)[^.!?\n]*(?:closing|summary|заключен)[^.!?\n]*[.!?]\s*/gi,
      ''
    )
    .replace(/(?:^|\s)(?:but )?without (?:any )?new tool calls\.?\s*/gi, ' ')
    .replace(/Need to (?:just )?add (?:a |the )?(?:closing|concluding) text[^.!?\n]*[.!?]\s*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  t = t
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !isCloserMetaBlock(b))
    .join('\n\n')
    .trim()
  if (uiLang !== 'ru') return t
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  const ru = blocks.filter((b) => /[а-яё]/i.test(b) && !/\bI should\b/i.test(b))
  if (ru.length > 0 && ru.join('\n\n').length >= 40) return ru.join('\n\n').trim()
  if (!/[а-яё]/i.test(t) && /summary in Russian|compile what was done|The user wants me to stop/i.test(text)) {
    return ''
  }
  return t
}

/** Closer cut mid-URL or mid-backtick — do not pin it as the final answer. */
export function looksTruncatedCloser(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (/https?:\/{0,2}$/i.test(t)) return true
  const ticks = t.match(/`/g)?.length ?? 0
  if (ticks % 2 === 1) {
    const lastTick = t.lastIndexOf('`')
    // Odd ticks in a long wrap-up are usually unclosed `command` mid-prose, not EOF truncation.
    return lastTick >= 0 && t.length - lastTick < 120
  }
  return false
}

/**
 * User wants a real file/landing edit — prose-only "done" is never enough.
 */
export function looksLikeFileEditRequest(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  if (looksLikeSurgicalFollowUp(t) || looksLikeLandingBuildTask(t)) return true
  return (
    /навбар|navbar|header|футер|footer|hero|секци|faq|index\.html|\.css|\.js\b|\.tsx?|\.jsx?|\.py\b|\.go\b|\.rs\b|\.java\b|\.cs\b|переключател|i18n|language\s+switch/i.test(
      t
    ) ||
    /добав|вставь|сделай|создай|поправ|исправ|убери|вынес|перенес|увели|больш|не\s+работает/i.test(
      t
    )
  ) &&
    !looksLikeChatQa(t)
}

/**
 * Model stuck repeating the same paragraph in one completion (no tools).
 * Used to abort the stream early instead of burning max_tokens.
 */
export function detectProseStutter(text: string): boolean {
  if (
    (text.match(
      /задача завершена|до новых встреч|готов к новым задачам|конечный ответ|конец сообщения/gi
    ) ?? []).length >= 3
  ) {
    return true
  }
  if ((text.match(/\n\s*---\s*\n/g) ?? []).length >= 5) return true
  if (text.length < 240) return false
  const maxUnit = Math.min(280, Math.floor(text.length / 3))
  for (let size = 48; size <= maxUnit; size++) {
    const a = text.slice(-size)
    if (a.trim().length < 36) continue
    const b = text.slice(-size * 2, -size)
    const c = text.slice(-size * 3, -size * 2)
    if (a === b && b === c) return true
  }
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 36)
  if (lines.length >= 3) {
    const last = lines[lines.length - 1]!
    let n = 0
    for (let i = lines.length - 1; i >= 0 && lines[i] === last; i--) n++
    if (n >= 3) return true
  }
  // Model glitch: same --- / blank-line blocks pasted many times.
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const dashChunks = text
    .split(/\n\s*---\s*\n/)
    .map(norm)
    .filter((c) => c.length >= 40)
  if (dashChunks.length >= 3) {
    const last = dashChunks[dashChunks.length - 1]!
    let n = 0
    for (let i = dashChunks.length - 1; i >= 0 && dashChunks[i] === last; i--) n++
    if (n >= 3) return true
  }
  const paras = text
    .split(/\n{2,}/)
    .map(norm)
    .filter((p) => p.length >= 50)
  const counts = new Map<string, number>()
  for (const p of paras) {
    const next = (counts.get(p) ?? 0) + 1
    counts.set(p, next)
    if (next >= 3) return true
  }
  if ((text.match(/Итого:\s*Рекомендации/gi) ?? []).length >= 3) return true
  if ((text.match(/Примечание:\s*данные основаны/gi) ?? []).length >= 3) return true
  if ((text.match(/If you need anything else|Если требуется что-то ещё/gi) ?? []).length >= 3) {
    return true
  }
  return false
}

/** Keep the first copy when the model pasted the same closing block repeatedly. */
export function dedupeStutteringProse(text: string): string {
  const raw = text ?? ''
  if (!raw.trim()) return raw
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const parts = raw.split(/(\n\s*---\s*\n)/)
  if (parts.length >= 5) {
    const seen = new Set<string>()
    let out = ''
    for (const p of parts) {
      if (/^\n\s*---\s*\n$/.test(p)) {
        out += p
        continue
      }
      const key = norm(p)
      if (key.length >= 40 && seen.has(key)) break
      if (key.length >= 40) seen.add(key)
      out += p
    }
    const trimmed = out.trim()
    if (trimmed.length >= 40) return trimmed
  }
  const paras = raw.split(/(\n{2,})/)
  const seen = new Set<string>()
  let out = ''
  for (const p of paras) {
    if (/^\n{2,}$/.test(p)) {
      out += p
      continue
    }
    const key = norm(p)
    if (key.length >= 50 && seen.has(key)) break
    if (key.length >= 50) seen.add(key)
    out += p
  }
  return out.trim() || raw.trim()
}

/**
 * Chat Q&A / advice — answer in prose is fine; do not force tools or plan-finish loops.
 * Coding / file-edit requests must return false.
 * Pass recent history so short follow-ups (“а если я как печка”) stay in the same chat thread.
 */
export function looksLikeChatQa(
  userText: string,
  history?: Array<{ role?: string; content?: string | null; toolName?: string }>
): boolean {
  const t = userText.trim()
  if (!t || t.length > 420) return false
  if (
    /write_file|apply_diff|apply_patch|index\.html|\.tsx?|\.jsx?|\.css|\.py\b|лендинг|landing|репозитор|codebase|компонент|рефактор|refactor|npm\s|git\s|pytest|javac|dockerfile/i.test(
      t
    )
  ) {
    return false
  }
  if (
    /исправ|поправ|создай\s+(сайт|файл|страниц|лендинг|проект|приложение|виджет)|перепиши|добавь\s+в\s+код|удали\s+из\s+файл|сделай\s+(сайт|страниц|лендинг|приложение)/i.test(
      t
    )
  ) {
    return false
  }
  if (
    /\?$|погод|weather|одеть|надеть|wear|что\s+лучше|как\s+(лучше|одеться)|посоветуй|recommend|сколько\s+градус|какая\s+погода|какой\s+прогноз|печк|жаркт|мерзн|замёрз|замерз|hot\s+person|i'?m\s+hot|i'?m\s+cold|что\s+на\s+.{0,16}(фото|картинк|изображен|скрин)|что\s+(это|тут|здесь)\s*\??$|опиши\s+(фото|картинк|изображен)|what('s|\s+is)\s+(on\s+|in\s+)?(this\s+)?(photo|image|picture)|describe\s+(the\s+)?(photo|image|picture)/i.test(
      t
    )
  ) {
    return true
  }
  if (
    t.length <= 100 &&
    !/[\\/][\w.-]+\.\w{1,8}\b/.test(t) &&
    /^(привет|спасибо|thanks|ок|ok|да|нет|хорошо|понял|подскаж|совет)/i.test(t)
  ) {
    return true
  }
  // Short personal follow-up in an ongoing weather / clothing advice thread.
  if (
    history &&
    t.length <= 160 &&
    !/[\\/][\w.-]+\.\w{1,8}\b/.test(t) &&
    /^(а\s+если|а\s+я|если\s+я|ну\s+а|what\s+if|and\s+if|а\s+как)/i.test(t)
  ) {
    const recent = history.slice(-12)
    const threadLooksLikeAdvice = recent.some((m) => {
      const c = (m.content ?? '').trim()
      if (!c || c.length < 8) return false
      if (m.role === 'user') {
        return /погод|weather|одеть|надеть|wear|градус|прогноз|что\s+лучше/i.test(c)
      }
      if (m.role === 'assistant' && !m.toolName) {
        return /°\s*c|температур|одежд|куртк|свитер|ветровк|шарф|погод|яндex|open-?meteo/i.test(
          c
        )
      }
      return false
    })
    if (threadLooksLikeAdvice) return true
  }
  return false
}

/**
 * Attached image + “what’s in this photo” — answer in prose, never a coding plan.
 * Screenshots that ask to fix/build a page stay on the agent loop.
 */
export function looksLikeImageQa(userText: string, hasImages: boolean): boolean {
  if (!hasImages) return false
  const t = userText.trim()
  if (!t) return true
  if (looksLikeChatQa(t)) return true
  if (looksLikeFileEditRequest(t) || looksLikeLandingBuildTask(t)) return false
  return (
    t.length <= 180 &&
    /фото|картинк|изображен|скрин|image|photo|picture/i.test(t)
  )
}

/** User asked to add a light/dark (or theme) control. */
export function looksLikeThemeToggleRequest(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  return /переключател\S*\s+тем|theme\s+toggle|light\s*\/\s*dark|dark\s*\/\s*light|светл\S*.{0,24}т[её]мн|т[её]мн\S*.{0,24}светл|data-theme/i.test(
    t
  )
}

/** Short follow-up: existing landing language switcher / i18n is broken. */
export function looksLikeI18nFollowUp(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  if (looksLikeLandingBuildTask(t) && t.length > 400) return false
  if (
    /EN\s*\/\s*RU|RU\s*\/\s*EN|language\s+switcher|data-i18n|\bi18n\b|\[object Object\]|переключател\S*\s+язык/i.test(
      t
    )
  ) {
    return true
  }
  return (
    t.length <= 400 &&
    /не\s+работает|doesn'?t\s+work|does\s+not\s+work|is\s+broken|\bbroken\b|сломан/i.test(t) &&
    /язык|lang|i18n|переключател|перевод|switcher/i.test(t)
  )
}

/** Explicit “rewrite the whole file” — surgical overwrite guards stand down. */
export function looksLikeExplicitRewrite(userText: string): boolean {
  return /перепиши\s+(весь|полностью|файл|лендинг|всё|все)|rewrite\s+(the\s+)?(whole|entire|full)|с\s*нуля|from\s+scratch|заново\s+весь|regenerate\s+(the\s+)?(page|file|landing)|создай\/перезапиши|создай\s+или\s+перезапиши|сначала\s+создай/i.test(
    userText
  )
}

/** Paths where follow-up edits go through apply_diff → Apply, not write_file overwrite. */
export function isComposerApplyPath(relativePath: string): boolean {
  return /\.(html?|css|jsx?|mjs|cjs)$/i.test((relativePath ?? '').replace(/\\/g, '/'))
}

/** Surgical follow-up must not overwrite an existing HTML/CSS/JS module. */
export function shouldBlockSurgicalOverwrite(opts: {
  userText: string
  relativePath: string
  overwrite: boolean
}): boolean {
  if (!opts.overwrite) return false
  if (looksLikeExplicitRewrite(opts.userText)) return false
  if (looksLikeFinishMissingLandingFiles(opts.userText)) return false
  if (!looksLikeSurgicalFollowUp(opts.userText)) return false
  return isComposerApplyPath(opts.relativePath)
}

/**
 * Full CSS rewrite is only blocked when a real stylesheet is already on disk
 * and the user asked for a surgical tweak — not “finish missing styles.css”.
 */
export function shouldBlockSurgicalCssRewrite(opts: {
  userText: string
  cssOnDisk?: string
}): boolean {
  const t = opts.userText ?? ''
  if (looksLikeExplicitRewrite(t) || looksLikeFinishMissingLandingFiles(t)) return false
  if (looksLikeFromScratchTask(t)) return false
  if (!cssLooksLikeRealStylesheet(opts.cssOnDisk ?? '')) return false
  return (
    looksLikeSurgicalFollowUp(t) ||
    (looksLikeFileEditRequest(t) && !looksLikeLandingBuildTask(t))
  )
}

/**
 * Completeness of THIS path only — never judge JS by last HTML write.
 */
export function priorCompleteForWritePath(opts: {
  relativePath: string
  lastHtml: string
  lastJs: string
  lastCss: string
}): boolean {
  const p = (opts.relativePath ?? '').replace(/\\/g, '/')
  if (/\.html?$/i.test(p)) return contentLooksStructurallyComplete(opts.lastHtml, p)
  if (/\.(jsx?|mjs|cjs)$/i.test(p)) return contentLooksStructurallyComplete(opts.lastJs, p)
  if (/\.css$/i.test(p)) return contentLooksStructurallyComplete(opts.lastCss, p)
  return false
}

/**
 * Chat write_file of an existing complete html/css/js should become apply_diff.
 * First-turn from-scratch and explicit rewrites stay write_file.
 */
export function shouldHandoffWriteToApply(opts: {
  userText: string
  relativePath: string
}): boolean {
  const p = opts.relativePath ?? ''
  if (!isComposerApplyPath(p)) return false
  const t = opts.userText ?? ''
  if (allowsComposerFullRewrite(t)) return false
  if (looksLikeFinishMissingLandingFiles(t)) return false
  if (looksLikeThemeToggleRequest(t)) return true
  if (looksLikeI18nFollowUp(t)) return true
  if (looksLikeSurgicalFollowUp(t)) return true
  if (t.trim().length <= 500 && looksLikeFileEditRequest(t)) return true
  return false
}

/** Rebuild / explicit rewrite — write_file overwrite, never Apply ping-pong. */
export function allowsComposerFullRewrite(userText: string): boolean {
  return looksLikeExplicitRewrite(userText) || looksLikeFromScratchTask(userText)
}

/** Persist truncated write_file only for new / incomplete files — never clobber a complete one. */
export function shouldPersistIncompleteWrite(opts: { knownComplete: boolean }): boolean {
  return !opts.knownComplete
}

const APPLY_HANDOFF_SNIPPET_MAX = 1_200

function snippetForApplyHandoff(content: string): string | undefined {
  const t = (content ?? '').trim()
  if (!t || t.length > APPLY_HANDOFF_SNIPPET_MAX) return undefined
  if (/^<!DOCTYPE|^<html[\s>]/i.test(t) && t.length > 400) return undefined
  if ((t.match(/\bfunction\b|\bconst\b|\blet\b/g) ?? []).length >= 8) return undefined
  return t
}

/** Short instruction for Apply — never dump a whole file into the prompt. */
export function formatApplyHandoffInstruction(opts: {
  userText: string
  relativePath: string
  snippet?: string
}): string {
  const user = (opts.userText ?? '').trim().slice(0, 400)
  const path = opts.relativePath || 'this file'
  const snip = snippetForApplyHandoff(opts.snippet ?? '')
  const parts = [
    user || `Edit ${path} as requested.`,
    `Edit this file only (${path}); do not rewrite the whole file.`
  ]
  if (snip) parts.push(`Suggested fragment:\n${snip}`)
  return parts.join('\n')
}

/** apply_diff arguments for a write_file → Apply handoff. */
export function buildApplyHandoffArgs(opts: {
  relativePath: string
  userText: string
  content?: string
}): Record<string, unknown> {
  return {
    relative_path: opts.relativePath,
    instruction: formatApplyHandoffInstruction({
      userText: opts.userText,
      relativePath: opts.relativePath,
      snippet: opts.content
    })
  }
}

/** search_block that is most of an already-complete file = full rewrite. */
export { isWholeFileSearchBlock } from '../../../shared/writeThresholds'

/** Long “build from scratch” briefs — never surgical. */
export function looksLikeFromScratchTask(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  if (looksLikeFinishMissingLandingFiles(t)) return true
  if (/с\s*нуля|from\s+scratch/i.test(t) && /\bvite\b/i.test(t) && /\breact\b/i.test(t)) {
    return true
  }
  if (looksLikeLandingBuildTask(t) && (t.length > 400 || /с\s*нуля|from\s+scratch/i.test(t))) {
    return true
  }
  if (
    t.length > 400 &&
    /создай\s+(приложение|проект|сервис|cli|бот|сайт)|scaffold|from\s+scratch|с\s*нуля|новый\s+(проект|репозитор|сервис)/i.test(
      t
    )
  ) {
    return true
  }
  return false
}

/** Follow-ups that must patch existing files, not invent a new landing or project. */
export function looksLikeSurgicalFollowUp(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  if (looksLikeFromScratchTask(t)) return false
  if (looksLikeFinishMissingLandingFiles(t)) return false
  if (looksLikeChatQa(t)) return false
  return (
    /без\s+полной\s+перепис|without\s+(a\s+)?full\s+rewrite|не\s+переписывай\s+цел/i.test(t) ||
    /вынеси|выделить|отдельн(ый|ую|ое)\s+(компонент|файл|css|js|модул)/i.test(t) ||
    /extract\s+(the\s+)?hero|split\s+(into|out)|move\s+hero\s+into/i.test(t) ||
    /поправь\s+cta|fix\s+the\s+cta|только\s+cta/i.test(t) ||
    /добав\S*\s+(больш\S*\s+)?(навбар|navbar|header|футер|footer|секци)/i.test(t) ||
    /как\s+насч[её]т\s+добав/i.test(t) ||
    /увели\S*\s+(навбар|navbar|header)|больш\S*\s+навбар/i.test(t) ||
    looksLikeI18nFollowUp(t) ||
    (t.length <= 400 &&
      /не\s+работает|doesn'?t\s+work|does\s+not\s+work|is\s+broken|\bbroken\b|сломан|почини|исправ\w*|fix\s+(the\s+)?|typeerror|compile|pytest|go\s+test|cargo\s+test|doesn't\s+compile|test\s+fail|упал\s+тест|\bbug\b|\bбаг\b|\berror\b|\bfails?\b|\bfailed\b|\bfailure\b/i.test(
        t
      ))
  )
}

/** Status / fake-success bubbles must not enter the model prompt. */
export function isAgentChatNoise(content: string | null | undefined): boolean {
  const t = (content ?? '').trim()
  if (!t) return true
  if (/^[↻⏹]/.test(t)) return true
  if (/^(Открыто|Opened)\.?\s*$/i.test(t)) return true
  if (isFalseSuccessProse(t)) return true
  if (/выдала план|не вызвала (ни одного )?инструмент|never called (a single )?tool/i.test(t)) {
    return true
  }
  if (t.length < 400 && /уже полный|точечная правка|FILE_COMPLETE/i.test(t)) return true
  return false
}

/** Ellipsis / code / HTML crumbs that must never become plan rows. */
export function isJunkPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t || isEllipsisOnly(t)) return true
  if (isFullRewriteFallbackPlanStep(t)) return true
  if (isToolOrientedPlanStep(t)) return true
  if (isCssClassPlanStep(t)) return true
  // Markdown / think leak into plan: "*План хирургического вмешательства:**"
  // Do not use \b after Cyrillic — JS treats letters as non-word without the unicode flag.
  if (/^\*+\s*план|^план\s+хирург|^#{1,6}\s*план|вмешательства\s*:\*+/i.test(t)) return true
  if (/^секци[яюи]?\s*:\s*['"`]?[\w.-]+['"`]?\s*$/i.test(t) && isCssClassPlanStep(t)) return true
  // PLAN_ONLY instruction echoed as a todo ("План из 3–6 шагов:")
  if (/^план\s+из\s+\d/i.test(t)) return true
  if (/^план\s+действий/i.test(t)) return true
  if (/^plan\s+steps?:?\s*$/i.test(t)) return true
  if (/^шаги\s+плана:?\s*$/i.test(t)) return true
  // Bare heading leaked as a row (T07d: «Шаги:» stayed in_progress → false incomplete closer)
  if (/^шаги:?\s*$/i.test(t)) return true
  if (/^steps?:?\s*$/i.test(t)) return true
  if (/^суммарно\s*:|^суммируя\s*:|^итого\s*:|^summary\s*:|^summarizing\s*:/i.test(t)) {
    return true
  }
  if (/каждый\s+шаг\s+созда[её]т\s+файлы/i.test(t)) return true
  if (/^plan\s+of\s+\d/i.test(t)) return true
  if (/^\d+\s*[–-]\s*\d+\s+(atomic\s+)?(product\s+)?steps?\b/i.test(t)) return true
  if (/^\d+\s*[–-]\s*\d+\s+шагов?:?\s*$/i.test(t)) return true
  if (/atomic\s+(product\s+)?steps?\s*:?\s*$/i.test(t) && t.length < 80) return true
  if (/^```/.test(t) || /```/.test(t)) return true
  if (/^</.test(t)) return true
  if (/<!DOCTYPE|<html[\s>]|<style[\s>]|<script[\s>]|<head[\s>]|<body[\s>]/i.test(t)) return true
  if (/^[{[]/.test(t) && t.length < 48) return true
  if (/^(write_file|call:|tool_call|function\s*call)/i.test(t)) return true
  if (/^(создаю|пишу|writing|creating)\s+index\.html/i.test(t) && t.length < 80) return true
  // Agent status / falseSuccess / recovery lines must never become plan rows.
  if (/^[↻⏹]/.test(t)) return true
  if (isFalseSuccessProse(t)) return true
  if (/^\*+\s*что\s+изменилось|^\*+\s*как\s+проверить|^что\s+изменилось\s*:|^как\s+проверить\s*:/i.test(t)) {
    return true
  }
  // Report crumbs like «Заголовок в секции …: NorthLine -> AFKLLM», not action steps.
  if (/заголовок\s+в\s+секции|подзаголовки\s+и\s+тексты|все\s+упоминания\s+заменен/i.test(t)) {
    return true
  }
  if (
    /незакрытые\s+шаги|не\s+рапортуем\s+успех|задача\s+не\s+выполнена|plan\s+still\s+has\s+open/i.test(
      t
    )
  ) {
    return true
  }
  if (
    /checking\s+for\s+missing|acceptance\s+incomplete|доделываю\s+план|finishing\s+the\s+plan|missing\s+files\s+before/i.test(
      t
    )
  ) {
    return true
  }
  if (/модель\s+не\s+вызвала|opened\s+the\s+complete\s+index|открыл\s+готов(ый|ое)\s+index/i.test(t)) {
    return true
  }
  if (/^готово[!.;]?\s*(лендинг|landing|northline|index|все)/i.test(t)) return true
  if (/что\s+реализовано\s*:/i.test(t)) return true
  if (/исправил\s+ширин|fixed\s+faq\s+width|faq\s+answers?\s+not\s+full/i.test(t)) return true
  return false
}

export type AdvanceTodoContext = {
  content?: string
  command?: string
  path?: string
}

/** Drop CSS/JS so class names / comments do not fake section completion. */
export function htmlSansAssets(content: string): string {
  return content
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
}

function sectionInnerLongEnough(inner: string, minChars: number): boolean {
  const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length >= minChars
}

/** True when a named landmark exists as a closed HTML block with real body text. */
export function htmlSectionComplete(
  content: string,
  opts: { tag?: RegExp; idOrClass: RegExp; minChars?: number }
): boolean {
  const html = htmlSansAssets(content)
  if (!html.trim()) return false
  const min = opts.minChars ?? 40
  const idRe = opts.idOrClass.source
  // <nav class="navbar">…</nav> or <section id="hero">…</section>
  const block = new RegExp(
    `<(${opts.tag?.source ?? 'section|div|header|footer|nav|aside'})\\b([^>]*)>` +
      `([\\s\\S]*?)<\\/\\1\\s*>`,
    'gi'
  )
  let m: RegExpExecArray | null
  const attrHit = new RegExp(idRe, 'i')
  while ((m = block.exec(html)) !== null) {
    const attrs = m[2] ?? ''
    const inner = m[3] ?? ''
    if (attrHit.test(attrs) && sectionInnerLongEnough(inner, min)) return true
  }
  // id= on any element with enough following siblings until a matching close is hard;
  // also accept <footer>…</footer> without id when tag is footer.
  if (opts.tag && /footer/i.test(opts.tag.source)) {
    const fm = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/i)
    if (fm && sectionInnerLongEnough(fm[1] ?? '', min)) return true
  }
  if (opts.tag && /nav/i.test(opts.tag.source)) {
    const nm = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav\s*>/i)
    if (nm && sectionInnerLongEnough(nm[1] ?? '', Math.min(min, 24))) return true
  }
  return false
}

type PlanContentRule = { step: RegExp; done: (html: string) => boolean }

const PLAN_CONTENT_RULES: PlanContentRule[] = [
  {
    step: /каркас|html\s*\+|bootstrap|\bcss\b/i,
    done: (h) =>
      /<!DOCTYPE\s+html|<html[\s>]/i.test(h) &&
      /<body[\s>]/i.test(htmlSansAssets(h)) &&
      (/<style\b|<link\b[^>]+stylesheet/i.test(h) || /class=["']/i.test(htmlSansAssets(h)))
  },
  {
    step: /navbar|навиг|шапк/i,
    done: (h) =>
      htmlSectionComplete(h, { tag: /nav/i, idOrClass: /navbar|nav-bar|site-nav/i, minChars: 10 }) ||
      htmlSectionComplete(h, { tag: /header/i, idOrClass: /navbar|nav/i, minChars: 16 }) ||
      (() => {
        const nm = htmlSansAssets(h).match(/<nav\b[^>]*>([\s\S]*?)<\/nav\s*>/i)
        return Boolean(nm && sectionInnerLongEnough(nm[1] ?? '', 10))
      })()
  },
  {
    step: /hero|главн\w*\s+экран|jumbotron/i,
    done: (h) => htmlSectionComplete(h, { idOrClass: /\bhero\b|jumbotron/i, minChars: 32 })
  },
  {
    step: /feature|возможн|преимущ/i,
    done: (h) => htmlSectionComplete(h, { idOrClass: /\bfeatures?\b/i, minChars: 36 })
  },
  {
    step: /how|как\s*работа/i,
    done: (h) =>
      htmlSectionComplete(h, { idOrClass: /how-it-works|howitworks|\bhow\b/i, minChars: 28 })
  },
  {
    step: /trust|social|отзыв|social\s*proof|доказат/i,
    done: (h) =>
      htmlSectionComplete(h, {
        idOrClass: /\btrust\b|testimonial|social-proof|reviews?/i,
        minChars: 28
      })
  },
  {
    step: /faq|вопрос/i,
    done: (h) =>
      htmlSectionComplete(h, { idOrClass: /\bfaq\b|accordion/i, minChars: 24 })
  },
  {
    step: /footer|подвал/i,
    done: (h) =>
      htmlSectionComplete(h, { tag: /footer/i, idOrClass: /footer|site-footer/i, minChars: 12 })
  },
  {
    step: /\bcta\b|призыв|кнопк\w*\s*(справа|справа\.|cta)|cta\s*справа/i,
    done: (h) => {
      const body = htmlSansAssets(h)
      return (
        /class=["'][^"']*\b(btn|cta|button)\b/i.test(body) ||
        /<(a|button)\b[^>]*(btn|cta)/i.test(body)
      ) && body.length > 200
    }
  }
]

/** Soft layout leftovers after a full landing write — do not force rewrite loops. */
export function isSoftLayoutPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t || isBrowserPlanStep(t)) return false
  return (
    /\bcta\b|справа|layout|сетк|grid|выравнив|отступ|spacing|кнопк/i.test(t) ||
    // "Найти FAQ в файле" is research fluff — must not block Start-Process forever.
    // Do NOT use \b after Cyrillic: JS treats Cyrillic as non-word, so /^найти\b/ never matches.
    /^найти[\s\u00a0]/i.test(t) ||
    /найти\s+.+\s+(файл|блок|faq|секц)/i.test(t) ||
    /find\s+.+\s+in\s+(the\s+)?existing|locate\s+(the\s+)?faq|search\s+for\s+faq/i.test(t) ||
    // Surgical leftover rows that stay yellow forever and trip PLAN_ORDER.
    /точечн|без\s+перепис|стили?\s*\/\s*размет|разметк\w*\s*\(|apply_diff|патч/i.test(t)
  )
}

/** curl -I localhost / «страница загрузилась» — preview health, not GitHub scrape. */
export function isPreviewHealthCheckPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\bcurl(\.exe)?\b|\bInvoke-WebRequest\b|\biwr\b/i.test(t) && /localhost|127\.0\.0\.1/i.test(t)) {
    return true
  }
  if (/curl\s+-I/i.test(t)) return true
  if (/страница\s+загрузил/i.test(t)) return true
  if (/без\s+ошибок\s+загруз/i.test(t)) return true
  return false
}

export function isBrowserPlanStep(text: string): boolean {
  if (isPreviewHealthCheckPlanStep(text)) return true
  return /браузер|browser|открыт\w*\s+index|open\s+in\s+browser|visual|визуальн|превью|preview|glassmorphism|glass-?morph|бургер|burger|desktop\s*\+|mobile|проверк\w*\s+в[её]рст|проверк\w*\s+на\s+(desktop|mobile)|Start-Process.*index\.html/i.test(
    text
  )
}

/** Close leftover visual / preview rows once the page was opened or files were written. */
export function settlePlanAfterWork(
  steps: AgentTodoStep[],
  opts: { previewOpened?: boolean; edited?: boolean }
): AgentTodoStep[] {
  if (!steps.length) return steps
  return steps.map((s) => {
    if (s.status === 'done') return s
    if (isFluffPlanStep(s.text)) {
      return { ...s, status: 'done' as const }
    }
    if (
      opts.previewOpened &&
      (isBrowserPlanStep(s.text) || isMetaOrSummaryPlanStep(s.text))
    ) {
      return { ...s, status: 'done' as const }
    }
    if (opts.edited && (isMetaOrSummaryPlanStep(s.text) || isSoftLayoutPlanStep(s.text))) {
      return { ...s, status: 'done' as const }
    }
    return s
  })
}

/** Plan ticked done but the named Vite+React file is still missing — reopen it. */
export function reopenTodosForMissingViteReact(
  steps: AgentTodoStep[],
  missing: Array<'package.json' | 'vite.config' | 'index.html' | 'entry' | 'app'>
): AgentTodoStep[] {
  if (!steps.length || !missing.length) return steps
  const testers: Record<string, RegExp> = {
    'package.json': /package\.json/i,
    'vite.config': /vite\.config/i,
    'index.html': /index\.html/i,
    entry: /main\.(jsx|tsx)|точка входа/i,
    app: /App\.(jsx|tsx)|игровая механик/i
  }
  return steps.map((s) => {
    const hit = missing.some((id) => testers[id]?.test(s.text))
    if (!hit || s.status !== 'done') return s
    return { ...s, status: 'in_progress' as const }
  })
}

/** "Write the whole landing / single-file index.html with all sections" mega-step. */
export function isLandingWritePlanStep(text: string): boolean {
  const t = text.trim()
  if (isBrowserPlanStep(t)) return false
  return (
    /single[- ]?file|index\.html|полный\s+лендинг|весь\s+лендинг|все\s+секц|написать\s+.*html|write\s+.*html|создать\s+.*html/i.test(
      t
    ) && /navbar|hero|feature|faq|footer|bootstrap|лендинг|landing|секц/i.test(t)
  )
}

/** Remaining plan steps that are real work — not browser open / verify / summary fluff. */
export function pendingPlanWork(steps: AgentTodoStep[]): AgentTodoStep[] {
  return steps.filter(
    (s) =>
      s.status !== 'done' &&
      !isJunkPlanStep(s.text) &&
      !isBrowserPlanStep(s.text) &&
      !isMetaOrSummaryPlanStep(s.text) &&
      !isFluffPlanStep(s.text) &&
      !isSoftLayoutPlanStep(s.text)
  )
}

/** Plan row that still needs a file write/patch (not search / weather fluff). */
export function isFileWorkPlanStep(text: string): boolean {
  const t = text ?? ''
  if (isMetaOrSummaryPlanStep(t) || isFluffPlanStep(t)) return false
  if (/web_search|поиск\s+в\s+интернет|искать\s+в\s+интернет|погод|weather/i.test(t)) {
    return false
  }
  return (
    /write_file|apply_diff|apply_patch|index\.html|\.css|\.js|\.md\b|readme|файл|созда|исправ|правк|edit|patch|html|секци/i.test(
      t
    ) || looksLikeLandingBuildTask(t)
  )
}

/**
 * Keep the tool loop going when CSS/JS already landed but index.html / README
 * (or other named files) are still open. Surgical follow-ups that already
 * patched must not be dragged back into a landing rewrite.
 */
export function shouldNudgeRemainingFileWork(opts: {
  fileWorkCount: number
  completedTools: number
  landingComplete: boolean
  missingNamedFiles: boolean
  surgicalFollowUp: boolean
  mutatingEditOk: boolean
  planFinishNudges: number
  maxNudges?: number
}): boolean {
  if (opts.fileWorkCount <= 0 || opts.completedTools <= 0) return false
  if (opts.planFinishNudges >= (opts.maxNudges ?? 3)) return false
  if (opts.surgicalFollowUp && opts.mutatingEditOk) return false
  if (opts.landingComplete && !opts.missingNamedFiles) return false
  return true
}

/** Mark plan steps done when HTML/content clearly contains that section. */
export function markTodosMatchingContent(
  _steps: AgentTodoStep[],
  _content: string
): number {
  // Content-shape matching (navbar/hero/faq) is not evidence of this turn's work.
  return 0
}

/**
 * After HTML write: mark only sections actually present in content.
 * Do NOT mass-check every plan row at once — progress is content-driven / live.
 */
export function markTodosAfterCompleteHtmlWrite(
  _steps: AgentTodoStep[],
  _content: string
): number {
  return 0
}

/** Live plan progress — evidence-gated in the tool loop; content shape is not proof. */
export function progressTodosFromContent(
  steps: AgentTodoStep[],
  _content: string
): { steps: AgentTodoStep[]; changed: boolean } {
  return { steps, changed: false }
}

export function rebalanceTodoStatuses(steps: AgentTodoStep[]): AgentTodoStep[] {
  if (!steps.some((s) => s.status === 'in_progress')) {
    const p = steps.find((s) => s.status === 'pending')
    if (p) p.status = 'in_progress'
  }
  // If current in_progress was marked done, promote next pending.
  const inProg = steps.find((s) => s.status === 'in_progress')
  if (!inProg) {
    const p = steps.find((s) => s.status === 'pending')
    if (p) p.status = 'in_progress'
  }
  return steps
}

export function reconcileTodosWithContent(
  steps: AgentTodoStep[],
  content: string
): AgentTodoStep[] {
  return progressTodosFromContent(steps, content).steps
}

/** Advance plan after a successful mutating / shell tool (content-aware for HTML writes). */
export function advanceTodosOnTool(
  steps: AgentTodoStep[],
  name: string,
  ok: boolean,
  ctx?: AdvanceTodoContext
): AgentTodoStep[] {
  const { steps: next } = advanceTodosOnEvidence(steps, [], {
    name,
    ok,
    path: ctx?.path,
    command: ctx?.command,
    content: ctx?.content
  })
  return next
}

export function todosAllDone(steps: AgentTodoStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === 'done')
}

/** Model-facing checklist block. */
export function formatChecklist(cl: AgentChecklist): string {
  if (!checklistHasItems(cl)) return ''
  const lines = [
    '[Agent checklist]',
    ...(cl.done.length ? [`✓ done: ${cl.done.join(', ')}`] : []),
    ...(cl.incomplete.length
      ? [`⚠ incomplete: ${cl.incomplete.join(', ')} (append next)`]
      : []),
    ...(cl.failed.length ? [`✗ failed: ${cl.failed.join(', ')}`] : []),
    ...(cl.shells.length ? [`shell: ${cl.shells.slice(-5).join(' | ')}`] : []),
    'Prefer apply_diff/apply_patch for edits. Do not invent duplicate filenames. Never claim done without a successful tool for that step.',
    '[/Agent checklist]'
  ]
  return '\n\n' + lines.join('\n')
}

export function stripChecklistBlock(text: string): string {
  return text
    .replace(/\n\n\[Agent checklist\][\s\S]*?\[\/Agent checklist\]/g, '')
    .replace(/\n\n\[Agent checklist\][\s\S]*$/g, '')
}

/** Remove prior compaction digests so each compact replaces, never stacks. */
export function stripCompactBlocks(text: string): string {
  return text
    .replace(
      /\n\n\[Context compacted due to context-window pressure\][\s\S]*?(?=\n\n\[Agent checklist\]|$)/g,
      ''
    )
}

/** Keep the compact memory blob so checklist refresh does not wipe it. */
export function extractCompactBlock(text: string): string {
  const m = text.match(
    /\n\n\[Context compacted due to context-window pressure\][\s\S]*?(?=\n\n\[Agent checklist\]|$)/
  )
  return m?.[0] ?? ''
}

export function mergeChecklistIntoSystem(
  systemText: string,
  checklistBlock: string
): string {
  const memory = extractCompactBlock(systemText)
  const base = stripCompactBlocks(stripChecklistBlock(systemText))
  return base + memory + (checklistBlock || '')
}

export function buildChecklistFromHistory(history: ChatMessageLite[]): AgentChecklist {
  const cl = emptyChecklist()
  for (const m of history) {
    if (m.id === AGENT_CHECKLIST_MSG_ID || m.id === 'welcome') continue
    if (!m.toolName || m.streaming) continue
    const c = m.content ?? ''

    if (m.toolName === 'execute_terminal_command') {
      const cmd = (m.codePreview || c.replace(/^.*?shell\s+/i, '')).trim().slice(0, 100)
      if (cmd && !/^⏹/.test(c)) pushUnique(cl.shells, cmd, 12)
      continue
    }

    const path = m.filePath
    if (!path) continue

    if (/incomplete|INCOMPLETE/i.test(c)) {
      removeFrom(cl.done, path)
      removeFrom(cl.failed, path)
      pushUnique(cl.incomplete, path)
    } else if (c.includes('✓')) {
      removeFrom(cl.incomplete, path)
      removeFrom(cl.failed, path)
      pushUnique(cl.done, path)
    } else if (/exists|✗|FILE_EXISTS|failed|ERROR/i.test(c)) {
      if (!cl.done.some((d) => normPath(d) === normPath(path))) {
        pushUnique(cl.failed, path)
      }
    }
  }
  return cl
}

export function applyToolToChecklist(
  cl: AgentChecklist,
  name: string,
  args: Record<string, unknown>,
  result: { ok: boolean; content: string; error?: string }
): void {
  if (name === 'execute_terminal_command') {
    const cmd = typeof args.command === 'string' ? args.command.trim() : ''
    if (cmd && !/USER_STOPPED|Interrupted by Stop/i.test(result.content)) {
      pushUnique(cl.shells, cmd.slice(0, 100), 12)
    }
    return
  }

  if (name === 'explore_subagent') {
    const goal = typeof args.goal === 'string' ? args.goal.trim().slice(0, 80) : ''
    if (goal) pushUnique(cl.shells, `explore: ${goal}`, 12)
    return
  }

  if (name === 'apply_patch') {
    const blob = `${result.error ?? ''}\n${result.content}`
    if (/USER_STOPPED|Interrupted by Stop/i.test(blob)) return
    const pathRe = /^\s+(add|update|delete)\s+(\S+)\s*$/gm
    let m: RegExpExecArray | null
    const paths: string[] = []
    while ((m = pathRe.exec(result.content)) !== null) {
      paths.push(m[2]!)
    }
    for (const path of paths) {
      if (result.ok || /PARTIAL/i.test(result.content)) {
        removeFrom(cl.incomplete, path)
        removeFrom(cl.failed, path)
        pushUnique(cl.done, path)
      } else {
        pushUnique(cl.failed, path)
      }
    }
    return
  }

  const path =
    typeof args.relative_path === 'string'
      ? args.relative_path
      : typeof args.dir_path === 'string'
        ? args.dir_path
        : ''
  if (!path) return

  const blob = `${result.error ?? ''}\n${result.content}`

  if (/USER_STOPPED|Interrupted by Stop/i.test(blob)) return

  if (/INCOMPLETE_WRITE/i.test(blob)) {
    removeFrom(cl.done, path)
    removeFrom(cl.failed, path)
    pushUnique(cl.incomplete, path)
    return
  }

  if (/FILE_EXISTS/i.test(blob)) {
    pushUnique(cl.failed, `${normPath(path)} (exists — append/diff)`)
    return
  }

  if (
    result.ok &&
    (name === 'write_file' ||
      name === 'apply_diff' ||
      name === 'apply_patch' ||
      name === 'create_directory')
  ) {
    removeFrom(cl.incomplete, path)
    removeFrom(cl.failed, path)
    cl.failed = cl.failed.filter((f) => !normPath(f).startsWith(normPath(path)))
    pushUnique(cl.done, path)
    return
  }

  if (
    !result.ok &&
    (name === 'write_file' ||
      name === 'apply_diff' ||
      name === 'apply_patch' ||
      name === 'create_directory' ||
      name === 'delete_file')
  ) {
    pushUnique(cl.failed, path)
  }

  if (result.ok && name === 'delete_file') {
    removeFrom(cl.done, path)
    removeFrom(cl.incomplete, path)
  }
}

/**
 * Devstral/Mistral Jinja: after system, alternate user/assistant;
 * tool results only after assistant tool_calls. Never user right after tool.
 */
export function normalizeApiMessages(msgs: ApiMessage[]): ApiMessage[] {
  if (msgs.length === 0) return msgs

  const systems = msgs.filter((m) => m.role === 'system')
  const rest = msgs.filter((m) => m.role !== 'system')
  const out: ApiMessage[] = []

  if (systems.length) {
    out.push({
      role: 'system',
      content: systems
        .map((s) => apiContentText(s.content))
        .filter(Boolean)
        .join('\n\n')
    })
  }

  const bridgeAfterTools = (): void => {
    const last = out[out.length - 1]
    if (last?.role === 'tool') {
      out.push({
        role: 'assistant',
        content: '(tool results received — continuing)'
      })
    }
  }

  const pushUser = (content: string): void => {
    bridgeAfterTools()
    const last = out[out.length - 1]
    if (last?.role === 'user') {
      last.content = `${apiContentText(last.content)}\n\n${content}`
    } else {
      out.push({ role: 'user', content })
    }
  }

  for (const m of rest) {
    const last = out[out.length - 1]

    if (m.role === 'tool') {
      if (last?.role === 'tool') {
        out.push({ ...m, content: apiContentText(m.content) })
        continue
      }
      if (last?.role === 'assistant' && last.tool_calls?.length) {
        out.push({ ...m, content: apiContentText(m.content) })
        continue
      }
      pushUser(`[tool ${m.tool_call_id ?? ''}]\n${apiContentText(m.content)}`)
      continue
    }

    if (m.role === 'user') {
      pushUser(apiContentText(m.content))
      continue
    }

    if (m.role === 'assistant') {
      if (!last || last.role === 'system') {
        pushUser('Continue the task using tools as needed.')
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'tool') {
        out.push({
          role: 'assistant',
          content: apiContentText(m.content),
          tool_calls: m.tool_calls
        })
        continue
      }
      if (
        prev?.role === 'assistant' &&
        !prev.tool_calls?.length &&
        !m.tool_calls?.length
      ) {
        prev.content = `${apiContentText(prev.content)}\n\n${apiContentText(m.content)}`
        continue
      }
      if (prev?.role === 'assistant' && prev.tool_calls?.length) {
        // Close open tool_calls without results
        prev.tool_calls = undefined
        if (!apiContentText(prev.content).trim()) prev.content = '(tool call interrupted)'
        pushUser('Previous tool call was interrupted. Continue.')
      }
      out.push({
        role: 'assistant',
        content: apiContentText(m.content),
        tool_calls: m.tool_calls
      })
    }
  }

  const end = out[out.length - 1]
  if (end?.role === 'assistant' && end.tool_calls?.length) {
    end.tool_calls = undefined
    if (!apiContentText(end.content).trim()) end.content = '(incomplete tool call removed)'
  }

  if (out[0]?.role === 'system' && out[1] && out[1].role !== 'user') {
    out.splice(1, 0, { role: 'user', content: 'Continue the unfinished task.' })
  }
  if (out[0]?.role === 'system' && out.length === 1) {
    out.push({ role: 'user', content: 'Continue the unfinished task.' })
  }

  return out
}

export type ThinkBlockPart =
  | { kind: 'think'; text: string }
  | { kind: 'text'; text: string }

/**
 * Split assistant content into text vs think blocks
 * (`<think>` / `<thinking>`, case-insensitive).
 */
export function parseThinkBlocks(content: string): ThinkBlockPart[] {
  if (!content) return []
  const re = /<\s*(think|thinking)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi
  const parts: ThinkBlockPart[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      const text = content.slice(last, m.index)
      if (text.trim()) parts.push({ kind: 'text', text })
    }
    const think = (m[2] ?? '').trim()
    parts.push({ kind: 'think', text: think })
    last = m.index + m[0].length
  }
  if (last < content.length) {
    const rest = content.slice(last)
    const open = rest.match(/^\s*<\s*(think|thinking)\s*>([\s\S]*)$/i)
    if (open) {
      const inner = open[2] ?? ''
      const leakAt = findCodeLeakIndex(inner)
      if (leakAt >= 0) {
        const think = inner.slice(0, leakAt).trim()
        if (think) parts.push({ kind: 'think', text: think })
        const tail = inner.slice(leakAt)
        if (tail.trim()) parts.push({ kind: 'text', text: tail })
      } else {
        const think = inner.trim()
        parts.push({ kind: 'think', text: think })
      }
    } else if (rest.trim() || parts.length === 0) {
      parts.push({ kind: 'text', text: rest })
    }
  }
  if (parts.length === 0) parts.push({ kind: 'text', text: content })
  return parts
}

/**
 * If the model put the entire reply inside `<think>` with no visible text,
 * unwrap it so API / final answer still gets text.
 * UI should call parseThinkBlocks on the raw content (do not promote first)
 * so the Think fold stays visible.
 */
export function promoteThinkOnlyAnswer(content: string): string {
  const raw = content ?? ''
  if (!raw.trim()) return raw
  const parts = parseThinkBlocks(raw)
  const hasText = parts.some((p) => p.kind === 'text' && p.text.trim())
  if (hasText) return raw
  const thinks = parts
    .filter((p): p is { kind: 'think'; text: string } => p.kind === 'think')
    .map((p) => p.text.trim())
    .filter(Boolean)
  if (thinks.length === 0) return raw
  return thinks.join('\n\n')
}

/** Visible text for UI: keep think tags so ThinkThroughBody can fold them. */
export function displayAssistantContent(content: string): string {
  return content ?? ''
}

/** Local clock for system prompt (recomputed each turn). */
export function formatNowForAgent(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const date = now.toLocaleDateString('en-CA') // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    `UTC${-now.getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-now.getTimezoneOffset() / 60}`
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const offH = String(Math.floor(abs / 60)).padStart(2, '0')
  const offM = String(abs % 60).padStart(2, '0')
  return (
    `Current local datetime: ${weekday}, ${date} ${time} (UTC${sign}${offH}:${offM}, ${tz}). ` +
    `Use this for “today”, deadlines, logs, and timestamps — do not invent another date.`
  )
}

/**
 * True only when the user asked for a product CLI smoke (cli.js / JSON-on-stdout).
 * Bare "stdin" / "argv" in a script description (Python wordfreq) must not trip this.
 */
export function userAskedForCliSmoke(text: string): boolean {
  const t = text ?? ''
  if (/\bcli\.js\b/i.test(t)) return true
  if (
    /\bCLI\b/.test(t) &&
    /json|stdout|one\s+line|prints?\s+one|command[-\s]?line/i.test(t)
  ) {
    return true
  }
  if (/command[-\s]?line\s+(tool|app|utility)/i.test(t)) return true
  return false
}

/** From-scratch CLI (wordfreq.go / .py): write the file, run it, show stdout — then stop. */
export function looksLikeFromScratchRunTask(text: string): boolean {
  const t = text ?? ''
  const write = /создай|create|напиши|write|сделай/i.test(t)
  const prog =
    /\.go\b|\.py\b|wordfreq|программ[ауеы]?|go-программ|python-скрипт/i.test(t)
  const run = /go\s+run|python3?|запусти|run it|покажи.{0,48}вывод|show.{0,40}(stdout|output|вывод)/i.test(
    t
  )
  return write && prog && run
}

/** Successful host verify for a from-scratch CLI — not a Vite preview server. */
export function isCliVerifyCommand(command: string): boolean {
  const c = command ?? ''
  if (/python\s+-m\s+http\.server|npm\s+run\s+dev|\bvite\b/i.test(c)) return false
  return /\bgo\s+run\b|\bpython3?\s+\S+\.py\b|\bpy\s+\S+\.py\b|\bdotnet\s+run\b|\bcargo\s+run\b/i.test(
    c
  )
}

/** True when go/python run exited 0 AND printed real output (not empty-wordfreq). */
export function cliVerifyLooksSuccessful(
  command: string,
  resultContent: string,
  ok: boolean
): boolean {
  if (!ok || !isCliVerifyCommand(command)) return false
  if (/TERMINAL_ERROR|exit_code=[1-9]/i.test(resultContent ?? '')) return false
  return !cliStdoutLooksVacuous(resultContent)
}

/** Gate premature "Task completed" / false test-pass claims. */
export function evaluateAcceptanceGate(input: {
  finalText: string
  userWantsNodeTest: boolean
  userWantsWebSearch: boolean
  userWantsCli: boolean
  lastNodeTestOk: boolean | null
  usedWebSearch: boolean
  ranCliSmoke: boolean
  incompleteCount: number
  failedCount: number
  completedTools: number
  /** Edit tools succeeded this turn (write/patch/diff). */
  mutatingEditOk?: boolean
  /** Edit tools failed this turn. */
  mutatingEditFailed?: boolean
}): {
  claimsDone: boolean
  hardMissing: string[]
  acceptanceDone: boolean
  looksPrematureDone: boolean
} {
  const claimsDone =
    /task completed|all (tests )?pass|tests?\s+pass|done\.|готово|сделано|исправлен/i.test(
      input.finalText
    )
  const hardMissing: string[] = []
  if (input.userWantsWebSearch && !input.usedWebSearch) {
    hardMissing.push(
      'Call web_search once (use the query the user gave if any) and put a real URL from the tool result under Refs — do not invent links.'
    )
  }
  if (input.userWantsNodeTest && input.lastNodeTestOk !== true) {
    hardMissing.push(
      input.lastNodeTestOk === false
        ? 'The latest node --test / npm test FAILED (exit ≠ 0). Read TERMINAL_ERROR, fix with apply_patch/apply_diff, re-run until green. Do not claim pass yet.'
        : 'Run the test command via execute_terminal_command (node --test / npm test) and fix until green (exit 0). Do not claim pass until then.'
    )
  }
  if (input.userWantsCli && !input.ranCliSmoke) {
    hardMissing.push(
      'Smoke-test the CLI with execute_terminal_command (argv JSON and/or stdin pipe) and confirm it prints one JSON result line.'
    )
  }
  if (input.mutatingEditFailed && !input.mutatingEditOk && claimsDone) {
    hardMissing.push(
      'A file edit failed this turn. Do not claim done — fix with apply_diff/apply_patch, or honestly report the failure. Never rewrite a finished HTML file from scratch.'
    )
  }
  if (input.mutatingEditFailed && input.mutatingEditOk && claimsDone) {
    hardMissing.push(
      'An edit also failed this turn. Do not claim the whole task is done — verify remaining work or report what failed.'
    )
  }
  const acceptanceDone =
    /task completed/i.test(input.finalText) &&
    (!input.userWantsNodeTest || input.lastNodeTestOk === true) &&
    input.incompleteCount === 0 &&
    hardMissing.length === 0 &&
    !input.mutatingEditFailed
  const looksPrematureDone =
    !acceptanceDone &&
    claimsDone &&
    (input.incompleteCount > 0 ||
      input.failedCount > 0 ||
      input.completedTools < 2 ||
      hardMissing.length > 0 ||
      input.mutatingEditFailed === true)
  return { claimsDone, hardMissing, acceptanceDone, looksPrematureDone }
}

/**
 * Model sometimes leaks native/channel tool syntax into write_file content
 * or assistant text instead of emitting structured tool_calls.
 */
export function looksLikeToolMarkupLeak(text: string): boolean {
  if (!text) return false
  return /<\/?tool_call\b|<\|tool_call\||\[:tool\b|\[:channel:|<\|channel\|>|call:write_file\b|call:create_directory\b|call:apply_(?:diff|patch)\b|<\s*function\s*=\s*[a-z_]+|<\s*web_search\s*>/i.test(
    text
  )
}

const SALVAGEABLE_TOOLS = new Set([
  'write_file',
  'create_directory',
  'apply_diff',
  'apply_patch',
  'execute_terminal_command',
  'verify_project',
  'read_file',
  'web_search',
  'list_directory',
  'search_codebase',
  'delete_file'
])

function parseXmlParameters(body: string): Record<string, string> {
  const args: Record<string, string> = {}
  const paramRe =
    /<\s*parameter\s*=\s*([a-z0-9_]+)\s*>\s*([\s\S]*?)(?:<\s*\/\s*parameter\s*>|$)/gi
  let p: RegExpExecArray | null
  while ((p = paramRe.exec(body)) !== null) {
    const key = (p[1] ?? '').trim()
    if (key) args[key] = (p[2] ?? '').replace(/^\n/, '').replace(/\n$/, '')
  }
  return args
}

function pushSalvagedCall(
  out: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>,
  name: string,
  args: Record<string, unknown>
): void {
  if (name === 'write_file' && !args.content && !args.relative_path && !args.path) return
  if (name === 'create_directory' && !args.relative_path && !args.path && !args.dir_path) return
  if (name === 'verify_project' && !args.mode && !args.command) return
  if (name === 'read_file' && !args.relative_path && !args.path) return
  if (name === 'web_search' && !args.query && !args.q) return
  if (name === 'execute_terminal_command' && !args.command) return
  out.push({
    id: `salvage-${out.length + 1}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  })
}

/**
 * Ornith/Qwen dump `<tool_call><function=write_file><parameter=…>` as assistant
 * text instead of OpenAI tool_calls. Recover those into real calls.
 * Rehearsals inside `<think>` are skipped (same idea as Unsloth auto-heal).
 */
export function salvageLeakedToolCalls(
  text: string
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  const raw = text ?? ''
  if (!raw.trim()) return []
  const actionable = parseThinkBlocks(raw)
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
  if (!actionable.trim()) return []
  const out: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []

  const jsonRe = /<\s*tool_call\s*>\s*(\{[\s\S]*?\})\s*<\s*\/\s*tool_call\s*>/gi
  let jm: RegExpExecArray | null
  while ((jm = jsonRe.exec(actionable)) !== null) {
    try {
      const obj = JSON.parse(jm[1] ?? '') as {
        name?: string
        arguments?: unknown
        parameters?: unknown
      }
      const name = String(obj.name ?? '').trim().toLowerCase()
      if (!SALVAGEABLE_TOOLS.has(name)) continue
      let args = obj.arguments ?? obj.parameters ?? {}
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args) as Record<string, unknown>
        } catch {
          args = { value: args }
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue
      pushSalvagedCall(out, name, args as Record<string, unknown>)
    } catch {
      /* not JSON — fall through to function= XML */
    }
  }

  const fnRe =
    /<\s*function\s*=\s*([a-z0-9_-]+)\s*>([\s\S]*?)(?:<\s*\/\s*function\s*>|$)/gi
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(actionable)) !== null) {
    const name = (m[1] ?? '').trim().toLowerCase()
    if (!SALVAGEABLE_TOOLS.has(name)) continue
    const args = parseXmlParameters(m[2] ?? '')
    if (Object.keys(args).length === 0) continue
    pushSalvagedCall(out, name, args)
  }
  return out
}

/** Strip leaked XML tool dumps from assistant text, keep think/prose. */
export function stripLeakedToolMarkup(text: string): string {
  return (text ?? '')
    .replace(/<\s*tool_call\b[\s\S]*?<\/\s*tool_call\s*>/gi, '')
    .replace(/<\s*function\s*=\s*[a-z_]+\s*>[\s\S]*?<\/\s*function\s*>/gi, '')
    .replace(/<\s*tool_call\b[\s\S]*$/gi, '')
    .replace(/<\s*function\s*=\s*[a-z_]+\s*>[\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Stable-ish fingerprint to detect identical repeated tool calls. */
export function fingerprintToolCall(
  name: string,
  args: Record<string, unknown>
): string {
  const path = coerceToolRelativePath(args) ?? ''
  const content =
    typeof args.content === 'string'
      ? args.content
      : typeof args.patch === 'string'
        ? args.patch
        : typeof args.replace_block === 'string'
          ? args.replace_block
          : typeof args.command === 'string'
            ? args.command
            : typeof args.goal === 'string'
              ? args.goal
              : ''
  const normPath = path.replace(/\\/g, '/')
  if (name === 'create_directory') return `${name}|${normPath}`
  // Any Start-Process / open index.html variant is the same action (cwd/path must not bypass dedupe).
  if (
    name === 'execute_terminal_command' &&
    (looksLikeOpenHtmlCommand(content) ||
      (/\.html?\b/i.test(content) &&
        /Start-Process|Invoke-Item|\bii\b|explorer\.exe/i.test(content)))
  ) {
    return `${name}|open_html_preview`
  }
  if (content.length > 0) {
    return `${name}|${normPath}|${content.length}|${content.slice(0, 48)}|${content.slice(-48)}`
  }
  try {
    return `${name}|${normPath}|${JSON.stringify(args).slice(0, 160)}`
  } catch {
    return `${name}|${normPath}`
  }
}

/**
 * Models often emit path / file / file_path instead of relative_path.
 * Returns a cleaned workspace-relative path, or null if missing.
 */
export function coerceToolRelativePath(
  args: Record<string, unknown> | null | undefined
): string | null {
  if (!args) return null
  const keys = [
    'relative_path',
    'path',
    'file',
    'filename',
    'file_path',
    'filepath',
    'dir_path',
    'target'
  ] as const
  for (const key of keys) {
    const v = args[key]
    if (typeof v !== 'string') continue
    const t = v.trim().replace(/\\/g, '/')
    if (!t || t === '.' || t === './') continue
    // Keep Windows/UNC absolutes — main-process safeResolve rebases into the project.
    if (/^[a-zA-Z]:\//.test(t) || t.startsWith('//')) return t
    const cleaned = t.replace(/^\/+/, '')
    if (cleaned) return cleaned
  }
  return null
}

/**
 * When the model streams write_file content without a path, guess only when the
 * body is clearly a full HTML document. Never invent styles.css / app.js / etc.
 */
export function inferWritePathFromContent(content: string): string | null {
  const t = (content ?? '').trimStart()
  if (!t || t.length < 8) return null
  if (/^<!DOCTYPE\s+html\b/i.test(t) || /^<html[\s>]/i.test(t)) return 'index.html'
  return null
}

/** Resolve write path from args, or infer from content when the model omitted it. */
export function resolveWriteFilePath(
  args: Record<string, unknown> | null | undefined
): string | null {
  const fromArgs = coerceToolRelativePath(args)
  if (fromArgs) return fromArgs
  const content = typeof args?.content === 'string' ? args.content : ''
  return inferWritePathFromContent(content)
}
