/**
 * Pure agent helpers (no window / React) — safe for node smoke tests.
 */

import { looksLikeOpenHtmlCommand } from '../../../shared/localPreview'

export { looksLikeOpenHtmlCommand }

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
/** Cursor-style todo plan authored by the model via <plan>…</plan>. */
export const AGENT_TODO_MSG_ID = 'agent-todo'

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

export function formatTodoUiContent(steps: AgentTodoStep[]): string {
  return JSON.stringify({ kind: 'agent-todo', steps })
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
    /<\/?script\b/i
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

/** Prose-only think body for the UI fold. Empty if code dump or a plan checklist. */
export function sanitizeThinkProse(text: string | null | undefined): string {
  let inner = extractThinkInner(text)
  // Never fall back to the whole prelude (that pulled <plan> / 1. 2. 3. into «Думал»).
  if (!inner) return ''
  inner = stripPlanLeakFromThink(inner)
  inner = stripCodeLeakFromThink(inner)
  if (!inner || thinkBodyLooksLikeCodeDump(`<think>${inner}</think>`)) return ''
  if (thinkLooksLikeChecklist(inner)) return ''
  // Drop fenced code / obvious markup leftovers.
  inner = inner
    .replace(/```[\s\S]*?```/g, '')
    .replace(/```[\s\S]*$/g, '')
    .replace(/<write_file[\s\S]*$/i, '')
    .trim()
  if (thinkLooksLikeChecklist(inner)) return ''
  if (isEllipsisOnly(inner)) return ''
  // Allow DeepThink / Cursor-length reasoning in the fold (was capped at 800).
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
          !/write_file|```/.test(l) &&
          !/^(\d+[.)]\s+|[-*•]\s+)/.test(l.trim())
      )
      .join('\n')
      .trim()
  }
  if (thinkLooksLikeChecklist(inner)) {
    const kept = inner
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^(\d+[.)]\s+|[-*•]\s+(\[[ xX]?\]\s+)?|\[\s*[xX ]?\]\s+)/.test(l)
      )
      .join(' ')
      .trim()
    if (kept.length >= 12 && !isEllipsisOnly(kept)) return kept.slice(0, 6000)
    return ''
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

/** HTML/markup that already closes — do not treat as truncated mid-write. */
export function contentLooksStructurallyComplete(content: string): boolean {
  const t = content.trim()
  if (!t) return false
  if (/<\/html\s*>/i.test(t)) return true
  if (/<\/body\s*>/i.test(t) && /<\/html\s*>/i.test(t)) return true
  // Non-HTML: balanced enough closing brace / no open string — leave to other checks
  return false
}

/**
 * Pack read_file for the model: head + tail + metadata.
 * Never present a head-only slice as if it were EOF (false "file truncated at ~250 lines").
 */
export function packReadFileForAgent(
  raw: string,
  opts?: { headLines?: number; tailLines?: number; maxChars?: number }
): string {
  const headN = opts?.headLines ?? 80
  const tailN = opts?.tailLines ?? 40
  const maxChars = opts?.maxChars ?? 10_000
  const lines = raw.split(/\r?\n/)
  const totalLines = lines.length
  const bytes = raw.length
  const complete = contentLooksStructurallyComplete(raw)
  const status = complete ? 'FILE_COMPLETE' : 'FILE_MAYBE_INCOMPLETE'

  if (bytes <= maxChars && totalLines <= headN + tailN) {
    return (
      `[read_file meta] total_lines=${totalLines} bytes=${bytes} truncated=false ${status}\n` +
      `--- full file ---\n` +
      raw
    )
  }

  const head = lines.slice(0, headN).join('\n')
  const tailStart = Math.max(headN, totalLines - tailN)
  const tail = lines.slice(tailStart).join('\n')
  const omitted = Math.max(0, tailStart - headN)
  let body =
    `[read_file meta] total_lines=${totalLines} bytes=${bytes} truncated=true ${status}\n` +
    `NOTE: Middle omitted (${omitted} lines). Tail is shown — closing tags may be here. Do NOT rewrite the file just because the head ends mid-section.\n` +
    `--- lines 1-${Math.min(headN, totalLines)} ---\n` +
    head
  if (tailStart < totalLines) {
    body +=
      `\n--- lines ${tailStart + 1}-${totalLines} (tail) ---\n` + tail
  }
  if (body.length > maxChars + 2000) {
    return body.slice(0, maxChars) + '\n…[pack truncated for context]'
  }
  return body
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

const LANDING_SECTION_STEPS = [
  'Каркас HTML + CSS',
  'Navbar',
  'Hero',
  'Features',
  'How it works',
  'Social proof',
  'FAQ',
  'Footer'
]

/** Parse <plan>…</plan> or a markdown [Plan] / checklist body into Cursor-style todo steps. */
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
  return steps.slice(0, 10)
}

/** Fallback plan when the model skips <plan> — still show the UI card. */
export function defaultLandingPlanSteps(): AgentTodoStep[] {
  const steps: AgentTodoStep[] = [
    ...LANDING_SECTION_STEPS,
    'Открыть index.html в браузере'
  ].map((text, i) => ({
    id: `s${i + 1}`,
    text,
    status: 'pending' as const
  }))
  steps[0]!.status = 'in_progress'
  return steps
}

/** Split “все секции (a, b, c)” / “полный лендинг” mega-steps into atomic todos. */
export function splitCompoundPlanStep(text: string): string[] {
  const t = text.trim()
  const mega =
    /полный\s+лендинг|весь\s+лендинг|все\s+секц|single[- ]?file|index\.html\s*[—–-].{30,}|write index\.html.*bootstrap|написать\s+.*index\.html|создать\s+.*index\.html/i.test(
      t
    )
  if (mega && /navbar|hero|feature|faq|footer|bootstrap|секц|лендинг|landing/i.test(t)) {
    return [...LANDING_SECTION_STEPS]
  }
  if (t.length < 60) return [t]
  const grouped = t.match(/\(([^)]{15,})\)/)
  if (grouped?.[1] && /navbar|hero|feature|faq|footer|how|social|навиг|секц/i.test(grouped[1])) {
    const parts = grouped[1]
      .split(/\s*[+,;/]\s*|\s+и\s+/i)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
    if (parts.length >= 3) {
      return parts.map((p) => (/^секц/i.test(p) ? p : `Секция: ${p}`))
    }
  }
  if (/[,;].*(?:navbar|hero|features|faq|footer)/i.test(t) && (t.match(/,/g) ?? []).length >= 2) {
    const afterColon = t.split(/:\s*/).slice(1).join(': ').trim() || t
    const parts = afterColon
      .split(/\s*,\s*/)
      .map((x) => x.replace(/\s+и\s+/gi, ' ').trim())
      .filter((x) => x.length >= 3 && x.length < 80)
    if (parts.length >= 3) return parts
  }
  return [t]
}

/** Index where a plan section starts (XML <plan> or markdown [Plan] / Plan:). */
export function findPlanLeakIndex(text: string): number {
  const s = text ?? ''
  const patterns = [
    /<\s*plan\b/i,
    /\[\s*plan\s*\]/i,
    /\*{0,2}\[\s*plan\s*\]\*{0,2}/i,
    /(?:^|\n)\s*#{0,3}\s*plan\s*:?\s*(?:\n|$)/i
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
  return (
    /сводк|summary|заключен|отчёт|отчет|report\s+completion/i.test(t) ||
    /подтвердить|валидац|отсутствие\s+ошибок|корректность\s+отображ/i.test(t) ||
    /проверк\w*\s+(отсутств|ошибок|корректн|отображ|вёрст|верст|html)/i.test(t) ||
    /give\s+(a\s+)?brief|краткую\s+сводк|пользователю\s+на\s+(русск|english)/i.test(t) ||
    /^(verify|validate|check|done|finish|summarize|report)\b/i.test(t) ||
    /напиши\s+(кратк|итог|заключен)|write\s+(a\s+)?(short\s+)?(summary|closing)/i.test(t)
  )
}

/** Ellipsis / code / HTML crumbs that must never become plan rows. */
export function isJunkPlanStep(text: string): boolean {
  const t = text.trim()
  if (!t || isEllipsisOnly(t)) return true
  if (isFluffPlanStep(t)) return true
  if (isMetaOrSummaryPlanStep(t)) return true
  if (/^```/.test(t) || /```/.test(t)) return true
  if (/^</.test(t)) return true
  if (/<!DOCTYPE|<html[\s>]|<style[\s>]|<script[\s>]|<head[\s>]|<body[\s>]/i.test(t)) return true
  if (/^[{[]/.test(t) && t.length < 48) return true
  if (/^(write_file|call:|tool_call|function\s*call)/i.test(t)) return true
  if (/^(создаю|пишу|writing|creating)\s+index\.html/i.test(t) && t.length < 80) return true
  return false
}

export type AdvanceTodoContext = {
  content?: string
  command?: string
  path?: string
}

const PLAN_CONTENT_RULES: { step: RegExp; hay: RegExp }[] = [
  { step: /каркас|html\s*\+|bootstrap|\bcss\b/i, hay: /<!DOCTYPE\s+html|<html[\s>]/i },
  { step: /navbar|навиг|шапк/i, hay: /<nav\b|id=["']navbar|class=["'][^"']*navbar/i },
  { step: /hero|главн\w*\s+экран|jumbotron/i, hay: /id=["']hero\b|class=["'][^"']*hero|#hero\b/i },
  { step: /feature|возможн|преимущ/i, hay: /id=["']features?\b|feature-card|features/i },
  { step: /how|как\s*работа/i, hay: /how-it-works|howitworks|id=["']how/i },
  { step: /trust|social|отзыв|social\s*proof|доказат/i, hay: /id=["']trust|testimonial|social-proof|\btrust\b/i },
  { step: /faq|вопрос/i, hay: /id=["']faq\b|accordion|\bfaq\b/i },
  { step: /footer|подвал/i, hay: /<footer\b|id=["']footer/i }
]

export function isBrowserPlanStep(text: string): boolean {
  return /браузер|browser|открыть\s+index|open\s+in\s+browser|visual|проверк\w*\s+в[её]рст/i.test(
    text
  )
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
      !isBrowserPlanStep(s.text) &&
      !isMetaOrSummaryPlanStep(s.text)
  )
}

/** Mark plan steps done when HTML/content clearly contains that section. */
export function markTodosMatchingContent(
  steps: AgentTodoStep[],
  content: string
): number {
  if (!content || steps.length === 0) return 0
  let n = 0
  for (const s of steps) {
    if (s.status === 'done') continue
    if (isBrowserPlanStep(s.text) && !/navbar|hero|faq|footer|feature/i.test(s.text)) {
      continue
    }
    let hit = false
    for (const r of PLAN_CONTENT_RULES) {
      if (r.step.test(s.text) && r.hay.test(content)) {
        hit = true
        break
      }
    }
    if (!hit) {
      const sec = s.text.match(/секц\w*\s*:\s*(.+)/i)
      const key = (sec?.[1] ?? '').trim().toLowerCase().replace(/\s+/g, '-')
      if (key.length >= 3) {
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(esc, 'i').test(content)) hit = true
      }
    }
    if (hit) {
      s.status = 'done'
      n++
    }
  }
  return n
}

/**
 * After a structurally complete HTML write: close every non-browser work step
 * that this file already satisfies (sections + mega "write whole landing" todos).
 * Incomplete HTML must NOT close the whole plan (that unlocked Start-Process too early).
 */
export function markTodosAfterCompleteHtmlWrite(
  steps: AgentTodoStep[],
  content: string
): number {
  if (!content || steps.length === 0) return 0
  // Partial writes may contain <html> + a few section ids — only soft-match sections.
  if (!contentLooksStructurallyComplete(content)) {
    return markTodosMatchingContent(steps, content)
  }
  let n = markTodosMatchingContent(steps, content)
  for (const s of steps) {
    if (s.status === 'done') continue
    if (isBrowserPlanStep(s.text)) continue
    if (isMetaOrSummaryPlanStep(s.text)) {
      s.status = 'done'
      n++
      continue
    }
    if (isLandingWritePlanStep(s.text)) {
      s.status = 'done'
      n++
      continue
    }
    // Any remaining section-ish / каркас step once the page exists.
    if (
      /каркас|html\s*\+|bootstrap|секц|navbar|hero|feature|how|trust|social|faq|footer|тёмн|dark\s*theme|svg|иллюстрац/i.test(
        s.text
      )
    ) {
      s.status = 'done'
      n++
    }
  }
  return n
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
  const next = steps.map((s) => ({ ...s }))
  markTodosAfterCompleteHtmlWrite(next, content)
  return rebalanceTodoStatuses(next)
}

/** Advance plan after a successful mutating / shell tool (content-aware for HTML writes). */
export function advanceTodosOnTool(
  steps: AgentTodoStep[],
  name: string,
  ok: boolean,
  ctx?: AdvanceTodoContext
): AgentTodoStep[] {
  if (!ok || steps.length === 0) return steps
  if (
    !/^(write_file|apply_patch|apply_diff|create_directory|delete_file|execute_terminal_command|generate_image|rename_file)$/.test(
      name
    )
  ) {
    return steps
  }
  const next = steps.map((s) => ({ ...s }))

  if (
    (name === 'write_file' || name === 'apply_patch' || name === 'apply_diff') &&
    (ctx?.content?.length ?? 0) > 80
  ) {
    const body = ctx!.content!
    const marked = contentLooksStructurallyComplete(body)
      ? markTodosAfterCompleteHtmlWrite(next, body)
      : markTodosMatchingContent(next, body)
    if (marked > 0) return rebalanceTodoStatuses(next)
  }

  if (name === 'execute_terminal_command') {
    const cmd = ctx?.command || ctx?.content || ''
    if (looksLikeOpenHtmlCommand(cmd)) {
      let marked = 0
      for (const s of next) {
        if (s.status === 'done') continue
        if (isBrowserPlanStep(s.text)) {
          s.status = 'done'
          marked++
        }
      }
      if (marked > 0) return rebalanceTodoStatuses(next)
    }
  }

  let cur = next.find((s) => s.status === 'in_progress')
  if (!cur) {
    cur = next.find((s) => s.status === 'pending')
    if (cur) cur.status = 'in_progress'
  }
  if (!cur) return next
  cur.status = 'done'
  const nxt = next.find((s) => s.status === 'pending')
  if (nxt) nxt.status = 'in_progress'
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
    'Use overwrite=true for small HTML/CSS; apply_patch for large existing files. Do not invent duplicate filenames.',
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
      const think = (open[2] ?? '').trim()
      parts.push({ kind: 'think', text: think })
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
}): {
  claimsDone: boolean
  hardMissing: string[]
  acceptanceDone: boolean
  looksPrematureDone: boolean
} {
  const claimsDone =
    /task completed|all (tests )?pass|tests?\s+pass|done\.|готово/i.test(
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
  const acceptanceDone =
    /task completed/i.test(input.finalText) &&
    (!input.userWantsNodeTest || input.lastNodeTestOk === true) &&
    input.incompleteCount === 0 &&
    hardMissing.length === 0
  const looksPrematureDone =
    !acceptanceDone &&
    claimsDone &&
    (input.incompleteCount > 0 ||
      input.failedCount > 0 ||
      input.completedTools < 2 ||
      hardMissing.length > 0)
  return { claimsDone, hardMissing, acceptanceDone, looksPrematureDone }
}

/**
 * Model sometimes leaks native/channel tool syntax into write_file content
 * or assistant text instead of emitting structured tool_calls.
 */
export function looksLikeToolMarkupLeak(text: string): boolean {
  if (!text) return false
  return /<\/?tool_call\b|<\|tool_call\||\[:tool\b|\[:channel:|<\|channel\|>|call:write_file\b|call:create_directory\b|call:apply_(?:diff|patch)\b/i.test(
    text
  )
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
    looksLikeOpenHtmlCommand(content)
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
 * When the model streams write_file content without a path, guess a sensible
 * filename from the body (landing-page trio and common source types).
 */
export function inferWritePathFromContent(content: string): string | null {
  const t = (content ?? '').trimStart()
  if (!t || t.length < 8) return null
  if (/^<!DOCTYPE\s+html\b/i.test(t) || /^<html[\s>]/i.test(t)) return 'index.html'
  // CSS: rules / at-rules, little/no HTML tags
  const htmlTagHits = (t.match(/<\/?[a-zA-Z][\w:-]*/g) ?? []).length
  if (
    htmlTagHits < 2 &&
    (/@(media|font-face|keyframes|import)\b/i.test(t) ||
      /[.#]?[a-zA-Z][\w-]*\s*\{[^}]*:[^}]+\}/.test(t) ||
      /:(root|hover|focus|active)\b/.test(t))
  ) {
    return 'styles.css'
  }
  if (
    /\b(document\.|window\.|addEventListener|querySelector|getElementById|IntersectionObserver)\b/.test(
      t
    ) ||
    /^(?:['"]use strict['"];?\s*)?(?:const|let|var|function|class)\b/m.test(t)
  ) {
    return 'app.js'
  }
  if (/^\{[\s\S]*"[\w.-]+"\s*:/.test(t)) return 'data.json'
  if (/^#{1,3}\s+\w+/m.test(t) && !/<html/i.test(t)) return 'README.md'
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
