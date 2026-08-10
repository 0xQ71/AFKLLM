/**
 * Pure agent helpers (no window / React) — safe for node smoke tests.
 */

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

/** Model-facing checklist block. */
export function formatChecklist(cl: AgentChecklist): string {
  if (
    cl.done.length + cl.incomplete.length + cl.failed.length + cl.shells.length ===
    0
  ) {
    return ''
  }
  const lines = [
    '[Agent checklist]',
    ...(cl.done.length ? [`✓ done: ${cl.done.join(', ')}`] : []),
    ...(cl.incomplete.length
      ? [`⚠ incomplete: ${cl.incomplete.join(', ')} (append next)`]
      : []),
    ...(cl.failed.length ? [`✗ failed: ${cl.failed.join(', ')}`] : []),
    ...(cl.shells.length ? [`shell: ${cl.shells.slice(-5).join(' | ')}`] : []),
    'Use append/apply_patch for existing paths. Do not recreate done files.',
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
    .replace(/\n\n\[Context compacted due to context-window pressure\][\s\S]*$/g, '')
    .replace(/\n\n\[Context compacted due to context-window pressure\][\s\S]*?(?=\n\n\[Context compacted|\n\n\[Agent checklist\]|$)/g, '')
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
    if (think) parts.push({ kind: 'think', text: think })
    last = m.index + m[0].length
  }
  if (last < content.length) {
    const text = content.slice(last)
    if (text.trim() || parts.length === 0) parts.push({ kind: 'text', text })
  }
  if (parts.length === 0) parts.push({ kind: 'text', text: content })
  return parts
}

/**
 * If the model put the entire reply inside `<think>` with no visible text,
 * unwrap it so the user still gets an answer.
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
    // Strip absolute drive prefix leftovers for Windows-style leaks
    const cleaned = t.replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '')
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
