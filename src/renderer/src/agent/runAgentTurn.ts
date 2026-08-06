import { AGENT_TOOL_SCHEMAS, type AgentToolName, type AgentToolResult } from '../../../shared/types'
import { THREAD_SUMMARY_MSG_ID } from '../../../shared/chats'
import {
  DEFAULT_UI_LANGUAGE,
  isUiLanguage,
  type UiLanguage
} from '../../../shared/i18n'
import type { QueueManager } from '../llm/queueManager'
import { translate } from '../i18n/messages'
import {
  AGENT_CHECKLIST_MSG_ID,
  applyToolToChecklist,
  buildChecklistFromHistory,
  emptyChecklist,
  formatChecklist,
  normalizeApiMessages,
  parseComposerMentions,
  parseThinkBlocks,
  formatNowForAgent,
  stripChecklistBlock,
  evaluateAcceptanceGate,
  fingerprintToolCall,
  looksLikeToolMarkupLeak,
  coerceToolRelativePath,
  resolveWriteFilePath,
  inferWritePathFromContent,
  type AgentChecklist,
  type ApiMessage
} from './agentPure'
import { runExploreSubagent } from './runExploreSubagent'
import {
  buildActivityFromTool,
  formatActivityLabel,
  type ComposerActivity
} from './composerActivity'
import { diffStatFromCodePreview } from '../../../shared/diffStat'

const RECENT_TURNS_WITH_SUMMARY = 12

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function clearPlanningRows(messages: ChatMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.toolName === '__planning__') messages.splice(i, 1)
  }
}

function upsertPlanningNextMoves(messages: ChatMessage[]): void {
  clearPlanningRows(messages)
  messages.push({
    id: uid(),
    role: 'assistant',
    content: 'Planning next moves',
    toolName: '__planning__',
    streaming: true,
    activity: buildActivityFromTool({ name: '__planning__', streaming: true })
  })
}

function activityForTool(
  name: string,
  args: Record<string, unknown>,
  opts?: {
    streaming?: boolean
    ok?: boolean
    partial?: boolean
    resultContent?: string
    fileCount?: number
  }
): ComposerActivity {
  return buildActivityFromTool({
    name,
    args,
    streaming: opts?.streaming,
    ok: opts?.ok,
    partial: opts?.partial,
    resultContent: opts?.resultContent,
    fileCount: opts?.fileCount
  })
}

function pushUnique(list: string[], item: string, max = 80): void {
  const n = normPath(item)
  if (!n) return
  const i = list.findIndex((x) => normPath(x) === n)
  if (i !== -1) list.splice(i, 1)
  list.push(n)
  while (list.length > max) list.shift()
}

export type { AgentChecklist }
export {
  AGENT_CHECKLIST_MSG_ID,
  applyToolToChecklist,
  buildChecklistFromHistory,
  formatChecklist,
  normalizeApiMessages,
  parseComposerMentions,
  parseThinkBlocks
}

export const AGENT_PLAN_MSG_ID = 'agent-plan'

export type AgentTurnMode = 'agent' | 'plan'
export type PlanStatus = 'pending' | 'approved' | 'rejected'

export function stripPlanStatus(content: string): string {
  return content.replace(/\n*_Status:\s*(pending|approved|rejected)_\s*$/i, '').trimEnd()
}

export function getPlanStatus(content: string): PlanStatus | null {
  const m = content.match(/_Status:\s*(pending|approved|rejected)_/i)
  if (!m?.[1]) return null
  return m[1].toLowerCase() as PlanStatus
}

export function setPlanStatus(content: string, status: PlanStatus): string {
  const body = stripPlanStatus(content).trimEnd()
  return `${body}\n\n_Status: ${status}_`
}

export function formatPlanExecutePrompt(planMarkdown: string): string {
  const body = stripPlanStatus(planMarkdown).trim()
  return (
    'Execute this approved plan. Follow the steps in order. Use tools as needed; ' +
    'do not re-ask for a plan unless blocked.\n\n' +
    `## Approved plan\n${body}`
  )
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessageStats {
  tps?: number
  promptTps?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Wall-clock for this LLM call (ms) */
  elapsedMs?: number
  /** Server predicted_ms when available */
  genMs?: number
  /** Wall-clock for the whole agent turn (ms) */
  turnElapsedMs?: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  toolName?: string
  pending?: boolean
  streaming?: boolean
  codePreview?: string
  filePath?: string
  stats?: ChatMessageStats
  editReview?: { path: string; status: 'pending' | 'accepted' | 'rejected' }
  activity?: ComposerActivity
}

export interface EditorSelectionContext {
  path: string
  text: string
  startLine: number
  endLine: number
}

export interface FileAttachment {
  path: string
  content: string
}

const AGENT_RULES = `
Rules for multi-file work (critical):
- Paths MUST be relative to the project root (e.g. engineering_calc/main.py). Never use absolute paths like D:\\...
- Finish ONE file completely before starting another. If a write returns INCOMPLETE_WRITE or FILE_EXISTS, fix THAT path first (append=true) — never invent a sibling filename.
- write_file on an existing non-empty file is REJECTED unless append=true (or rare overwrite=true). Prefer apply_patch for edits (multi-hunk / multi-file); apply_diff for a single unique replace.
- Corrections / bugfixes / "это не так" / pointing out mistakes (critical):
  1) read_file (or search_codebase) the existing file first — do NOT guess from memory.
  2) Change ONLY the broken part with apply_patch (Codex *** Begin Patch hunks) or apply_diff (small unique search_block → replace_block).
  3) Or append missing pieces with write_file append=true.
  FORBIDDEN on corrections: recreating the whole file/page/app from scratch, write_file overwrite=true, new duplicate filenames, "let me rewrite the landing".
  Full overwrite is allowed ONLY if the user explicitly asks to rewrite/regenerate the entire file.
- If apply_patch / apply_diff fails: read_file again, use a tighter unique hunk / shorter search_block, retry. Do NOT fall back to rewriting the whole file unless the user asked for a full rewrite.
- Unclear repo layout or “where is X?”: call explore_subagent with a clear goal before large edits (read-only research report).
- NEVER invent duplicate modules (thermodynamic.py vs thermodynamics.py). list_directory / read_file first.
- Keep each write_file chunk modest (~1200–1500 chars of code). Large files = stub + several append=true calls until the file is syntactically complete.
- Do not say the task is done while required files from the user's structure are still missing — create the next missing file.
- Terminal (Windows): shell is PowerShell. NEVER use bash && or ||. Prefer ONE command + cwd="subdir" (e.g. command="javac Calculator.java", cwd="Calculator/src"). Chain only with "; " if needed. Do NOT pass unquoted globs like *.java to javac/java — PowerShell does not expand them for native exes; list files explicitly or use Get-ChildItem. Never run interactive stdin programs (Scanner/input()) via execute_terminal_command — they hang with no TTY; for CLI demos pass argv, or build a Swing/JavaFX UI when the user wants to type interactively.
- Terminal errors (critical): when execute_terminal_command fails with TERMINAL_ERROR / ERROR_FOCUS, READ that focus, fix the exact file/line with read_file + apply_patch (or apply_diff), then re-run the SAME command. Never claim "environment forbids &&" — use cwd/; instead. Never drop JavaFX/GUI mid-task without explaining; for simple Java GUI prefer javax.swing (no modules) first, get javac/java working, then discuss .exe (jpackage) as a later step.
- PROCESS_ENDED (critical): if the tool result says PROCESS_ENDED, the user closed the window or the program finished — this is NOT a bug. Do NOT rewrite code, do NOT relaunch, do NOT "fix" anything. Briefly acknowledge and wait for the next user message.
- Tests / shell honesty (critical): NEVER say "tests pass", "Task completed" for a test task, or claim green unless the latest execute_terminal_command for that test returned ok (exit 0). If you see TERMINAL_ERROR / fail ✖ / exit_code≠0 with an error traceback, fix and re-run first — do not summarize success from an earlier run.
- When running Python packages: use "python -m" from the project root.
- When the user says "continue" / "продолжи", inspect what already exists and only create missing pieces.
- When the user includes @codebase, relevant repo snippets are already attached — use them; still call tools if you need more.
- Prefer @codebase for “where is X / which file?” before spamming search_codebase.
- When the user includes @file or @selection, that file/snippet is already attached — use it before re-reading unless you suspect it is stale.
- Web / docs (critical):
  1) If the user asks you to search the web, cite docs, add a Refs/link from search, or names a query for web_search — you MUST call the web_search tool at least once before finishing. Do NOT invent URLs from memory.
  2) Otherwise call web_search for up-to-date docs, package APIs, stack-overflow-style fixes, or facts not in the repo. Prefer search_codebase for local code. Use a precise query (library + error text + language).
- Node.js tests (when the user asks for node:test / npm test):
  1) Use import { describe, it } from 'node:test' and assert from 'node:assert' (or node:assert/strict).
  2) Wrap cases in describe/it — do NOT rely on bare top-level assert calls as the only tests.
  3) Import and assert every exported helper the user named (e.g. normalize), not only indirect coverage via another function.
  4) After writing/fixing tests, run the exact test command the user gave (usually node --test …) via execute_terminal_command and fix until green.
- CLI / scripts verification (when you create a CLI):
  1) Implement BOTH stdin and argv/first-arg paths if the user required them — argv must actually print the result, not only parse-and-return.
  2) Before claiming done, run at least one execute_terminal_command smoke for the CLI (e.g. node src/cli.js "[10,90]" and/or echo pipe) and confirm JSON output looks right.
- Acceptance / "Task completed":
  1) Only claim Task completed after required tools ran (tests green, web_search if required, tree verified).
  2) If the user gave an exact acceptance format, follow it; cite a web_ref URL that came from a web_search tool result, not a guessed link.
- Local web preview: when you start a landing/dev server (vite, npm run dev, python -m http.server, etc.), AFKLLM auto-opens the in-app Browser on the Local/localhost URL from the terminal — do not ask the user to open an external browser.
- Do NOT ask for permission in chat — call tools.`

/** Exported for Context Usage estimates (without embedding in SYSTEM twice). */
export { AGENT_RULES }

const SYSTEM_CORE = `You are AFKLLM, a local coding agent inside a desktop IDE.
You can read/write/delete files, create directories, search code, search the web (web_search: DuckDuckGo + Bing + Brave + Wikipedia + SO + HN), run shell commands, and call connected MCP tools (names starting with mcp__). Prefer built-in filesystem/shell tools over MCP equivalents.
Prefer apply_patch for edits (apply_diff for one small replace). Be concise. When done, summarize what changed.
IMPORTANT: Do NOT ask the user for permission to use tools. Call tools immediately when needed.`

const SYSTEM_CONFIRM_CORE = `You are AFKLLM, a local coding agent inside a desktop IDE.
You can read/write/delete files, create folders, search code, search the web (web_search: DuckDuckGo + Bing + Brave + Wikipedia + SO + HN), run shell commands, and call connected MCP tools (names starting with mcp__). Prefer built-in filesystem/shell tools over MCP equivalents.
Shell commands open the IDE Terminal panel (visible). They may need a one-click confirm unless auto-approve is ON.
Prefer apply_patch for edits (apply_diff for one small replace). Be concise. When done, summarize what changed.
Do not ask in chat for permission to read or edit files — use tools directly.`

const SYSTEM = `${SYSTEM_CORE}
${AGENT_RULES}`

const SYSTEM_CONFIRM = `${SYSTEM_CONFIRM_CORE}
${AGENT_RULES}`

const SYSTEM_PLAN = `You are AFKLLM in Plan Mode inside a desktop IDE.
The user wants a concrete execution plan BEFORE any edits or shell commands.

Rules:
- Do NOT call tools. Do NOT write or apply code. Do NOT run shell commands.
- Output a clear numbered plan (1, 2, 3, …) with short steps.
- Name likely files/paths to create or edit (relative paths).
- Call out risks, assumptions, and what you will verify when done.
- Be concise. No preamble about being in plan mode.
- End with the plan only — the UI will ask the user to Approve or Reject.
`

const THINK_THROUGH = `
Think-through protocol (mandatory while enabled):
1) Before the first tool call (and after any failure), write a short reasoning block:
   <think>
   - Goal / what changed
   - Hypothesis or next step
   - If an error: root cause, options, chosen fix
   </think>
2) Keep each <think> under ~120 words. Prefer concrete paths and commands.
3) Then call tools or give the final user-facing answer (outside <think>).
4) Do not ask the user for permission inside <think> — decide and act.
5) Intermediate conclusions are good: "build failed because X → try Y".
`

export {
  SYSTEM_CORE,
  SYSTEM_CONFIRM_CORE,
  SYSTEM_PLAN,
  THINK_THROUGH
}

/** Bug/inaccuracy phrasing → surgical edits only. */
function looksLikeCorrection(text: string): boolean {
  const t = text.trim()
  if (t.length > 2500) return false
  return /исправ|неточн|ошибк|баг|fix\b|wrong|bug\b|broken|instead|а не\b|не так|поправ|сломан|не работает|doesn't work|does not work|почему|зачем перепис|лишн|убери|удали\b|добавь|дополни|дописать|подправ|измени только|только.*(css|js|html|файл)|too much|перебор|не то\b|неправильн|криво|багфикс/i.test(
    t
  )
}

/** Explicit full-rewrite request → overwrite allowed. */
function looksLikeExplicitRewrite(text: string): boolean {
  return /перепиши\s+(весь|полностью|файл|лендинг|всё|все)|rewrite\s+(the\s+)?(whole|entire|full)|с\s*нуля|from\s+scratch|заново\s+весь|regenerate\s+(the\s+)?(page|file|landing)/i.test(
    text
  )
}

const SURGICAL_EDIT_HINT = `
[SURGICAL_EDIT — mandatory]
The user is correcting existing work, not requesting a new project.
1) read_file / search_codebase the relevant existing file(s) first.
2) Fix ONLY the inaccurate part with apply_diff (small exact search_block).
3) Missing pieces → write_file append=true on the SAME path.
FORBIDDEN: write_file overwrite=true, regenerating the whole page/app, new duplicate filenames.
`

const DEFAULT_MAX_ROUNDS = 64
const TOOL_RESULT_CHARS = 10_000
/** 4096 often truncates mid-tool-JSON. */
const AGENT_MAX_TOKENS = 8192
/** Cyrillic/code runs denser than English. */
const CHARS_PER_TOKEN = 3.2
/** Headroom for tools schema + next completion. */
const CTX_RESERVE_TOKENS = 2_800
/** Cap forced append loops on the same path when stream was truncated. */
const MAX_INCOMPLETE_APPENDS_PER_PATH = 6
/** Identical tool+args repeats before TOOL_LOOP. */
const MAX_IDENTICAL_TOOL_CALLS = 2
const MAX_TOOL_LOOP_HITS = 2
const MAX_MARKUP_REPAIR_ATTEMPTS = 2
/** Absolute safety cap for a single tool-arguments JSON blob. */
const MAX_TOOL_ARG_CHARS = 48_000
const MAX_MISSING_PATH_HITS = 3

async function fetchProjectRules(): Promise<string> {
  try {
    const snap = await window.api.context.projectRules()
    return snap.text?.trim() ?? ''
  } catch {
    return ''
  }
}

function upsertThreadSummary(messages: ChatMessage[], summary: string): void {
  const body = summary.trim().slice(0, 8_000)
  if (!body) return
  const content =
    '## Thread memory\n' +
    body +
    '\n\n_(earlier turns compressed to fit context)_'
  const msg: ChatMessage = {
    id: THREAD_SUMMARY_MSG_ID,
    role: 'assistant',
    content
  }
  const idx = messages.findIndex((m) => m.id === THREAD_SUMMARY_MSG_ID)
  if (idx >= 0) {
    messages[idx] = msg
    return
  }
  const w = messages.findIndex((m) => m.id === 'welcome')
  messages.splice(w >= 0 ? w + 1 : 0, 0, msg)
}

async function fetchProjectTreeDigest(): Promise<string> {
  try {
    const map = await window.api.context.repoMap()
    if (!map.text?.trim()) return ''
    return `\n${map.text}\n`
  } catch {
    try {
      const res = await window.api.workspace.list('.')
      if (!res.ok) return ''
      const files = res.content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 80)
      if (files.length === 0) return ''
      return (
        '\n[Current project files — reuse these paths, do not invent duplicates]\n' +
        files.map((f) => `- ${f}`).join('\n')
      )
    } catch {
      return ''
    }
  }
}

/** @deprecated use parseComposerMentions */
export function parseCodebaseMention(text: string): {
  cleanText: string
  query: string | null
} {
  const m = parseComposerMentions(text)
  return {
    cleanText: m.cleanText,
    query: m.codebase ? m.cleanText || text.replace(/@codebase\b/gi, '').trim() : null
  }
}

const FILE_ATTACH_MAX = 7_000
const SELECTION_ATTACH_MAX = 4_000

function truncateAttach(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…(truncated)'
}

async function fetchCodebaseContext(query: string): Promise<string> {
  try {
    const res = await window.api.context.codebaseQuery(query)
    if (!res.text?.trim()) return '\n[Codebase context: no matches]\n'
    const label =
      res.source === 'bm25'
        ? 'Codebase hits (BM25)'
        : res.source === 'scan'
          ? 'Codebase hits (scan)'
          : 'Codebase context'
    // Engine already formats a header; add a thin wrapper for empty-source edge cases
    if (res.text.includes('[Codebase hits') || res.text.includes('[Codebase context')) {
      return `\n${res.text}\n`
    }
    return `\n[${label}]\n${res.text}\n`
  } catch {
    return ''
  }
}

function codebaseQueryFallback(
  cleanText: string,
  userText: string,
  openFile?: { path: string },
  history?: ChatMessage[]
): string {
  const stripped = cleanText.replace(/@codebase\b/gi, '').trim()
  if (stripped) return stripped
  const withoutMention = userText.replace(/@codebase\b/gi, '').trim()
  if (withoutMention) return withoutMention
  if (openFile?.path && openFile.path !== 'untitled.ts') {
    const base = openFile.path.split(/[/\\]/).pop() ?? openFile.path
    return base.replace(/\.[^.]+$/, '') || base
  }
  if (history) {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]
      if (m?.role === 'user' && m.content?.trim()) {
        const t = m.content.replace(/@\w+/g, '').trim()
        if (t) return t.slice(0, 120)
      }
    }
  }
  return 'project structure'
}

/** Synthetic tool row for file-change summary (not sent to the model). */
export const FILES_CHANGED_TOOL = '__files_changed__'

export interface TurnFileChange {
  path: string
  added: number
  removed: number
  deleted?: boolean
}

function removeChecklistBubbles(messages: ChatMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.id === AGENT_CHECKLIST_MSG_ID) messages.splice(i, 1)
  }
}

function recordTurnFileChange(
  map: Map<string, TurnFileChange>,
  name: string,
  pathRaw: string | undefined,
  codePreview: string | undefined,
  args?: Record<string, unknown>
): void {
  if (!pathRaw?.trim()) return
  const path = pathRaw.replace(/\\/g, '/')
  let added = 0
  let removed = 0
  let deleted = name === 'delete_file'
  if (name === 'delete_file') {
    deleted = true
  } else {
    const fromPreview = diffStatFromCodePreview(name, codePreview)
    if (fromPreview && (fromPreview.added > 0 || fromPreview.removed > 0)) {
      added = fromPreview.added
      removed = fromPreview.removed
    } else if (name === 'apply_diff' && args) {
      const search = typeof args.search_block === 'string' ? args.search_block : ''
      const replace = typeof args.replace_block === 'string' ? args.replace_block : ''
      removed = search ? search.split('\n').length : 0
      added = replace ? replace.split('\n').length : 0
    } else if (codePreview?.trim()) {
      added = codePreview.split('\n').length
    }
  }
  const prev = map.get(path)
  if (prev) {
    map.set(path, {
      path,
      added: prev.added + added,
      removed: prev.removed + removed,
      deleted: prev.deleted || deleted
    })
  } else {
    map.set(path, { path, added, removed, deleted })
  }
}

function appendFilesChangedSummary(
  messages: ChatMessage[],
  map: Map<string, TurnFileChange>
): void {
  if (map.size === 0) return
  const files = [...map.values()]
  messages.push({
    id: uid(),
    role: 'assistant',
    content: JSON.stringify({ files }),
    toolName: FILES_CHANGED_TOOL
  })
}

function upsertPlanBubble(
  messages: ChatMessage[],
  content: string,
  stats?: ChatMessageStats
): void {
  const msg: ChatMessage = {
    id: AGENT_PLAN_MSG_ID,
    role: 'assistant',
    content,
    ...(stats ? { stats } : {})
  }
  const idx = messages.findIndex((m) => m.id === AGENT_PLAN_MSG_ID)
  if (idx >= 0) messages[idx] = msg
  else messages.push(msg)
}

function injectChecklistIntoSystem(apiMessages: ApiMessage[], cl: AgentChecklist): void {
  if (apiMessages[0]?.role !== 'system') return
  const block = formatChecklist(cl)
  const base = stripChecklistBlock(apiMessages[0].content ?? '')
  apiMessages[0] = { ...apiMessages[0], content: block ? base + block : base }
}

function uid(): string {
  return crypto.randomUUID()
}

export function extractJsonStringField(partial: string, field: string): string | null {
  const key = `"${field}"`
  const idx = partial.indexOf(key)
  if (idx === -1) return null
  const colon = partial.indexOf(':', idx + key.length)
  if (colon === -1) return null
  let i = colon + 1
  while (i < partial.length && /\s/.test(partial[i]!)) i++
  if (partial[i] !== '"') return null
  i++
  let out = ''
  while (i < partial.length) {
    const c = partial[i]!
    if (c === '\\' && i + 1 < partial.length) {
      const n = partial[i + 1]!
      if (n === 'n') {
        out += '\n'
        i += 2
        continue
      }
      if (n === 't') {
        out += '\t'
        i += 2
        continue
      }
      if (n === 'r') {
        out += '\r'
        i += 2
        continue
      }
      if (n === '"' || n === '\\' || n === '/') {
        out += n
        i += 2
        continue
      }
      if (n === 'u' && i + 5 < partial.length) {
        const hex = partial.slice(i + 2, i + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
      }
      out += n
      i += 2
      continue
    }
    if (c === '"') break
    out += c
    i++
  }
  return out
}

function isTruncatedToolJson(raw: string): boolean {
  const text = raw.trim()
  if (!text) return true
  try {
    JSON.parse(text)
    return false
  } catch {
    /* incomplete */
  }
  // Unbalanced braces / open string → likely hit max_tokens mid-tool-call
  let braces = 0
  let inStr = false
  let esc = false
  for (const ch of text) {
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') braces++
    if (ch === '}') braces--
  }
  return inStr || braces !== 0 || !text.endsWith('}')
}

function parseToolArguments(raw: string): {
  args: Record<string, unknown>
  parseError?: string
  truncated?: boolean
} {
  const text = (raw || '').trim() || '{}'
  try {
    const args = JSON.parse(text) as Record<string, unknown>
    const coerced = coerceToolRelativePath(args)
    if (coerced) args.relative_path = coerced
    else if (typeof args.content === 'string') {
      const inferred = inferWritePathFromContent(args.content)
      if (inferred) args.relative_path = inferred
    }
    return { args }
  } catch {
    /* fall through */
  }

  const truncated = isTruncatedToolJson(text)

  // Repair common truncation: close open string + braces
  for (const suffix of ['"}', '"}}', '"}]', '"}]}']) {
    try {
      return {
        args: JSON.parse(text + suffix) as Record<string, unknown>,
        truncated: true,
        parseError: 'Tool JSON was truncated (likely max_tokens).'
      }
    } catch {
      /* try next */
    }
  }

  const relative_path =
    extractJsonStringField(text, 'relative_path') ??
    extractJsonStringField(text, 'path') ??
    extractJsonStringField(text, 'file') ??
    extractJsonStringField(text, 'filename') ??
    extractJsonStringField(text, 'file_path') ??
    extractJsonStringField(text, 'filepath')
  const content = extractJsonStringField(text, 'content')
  const command = extractJsonStringField(text, 'command')
  const search_block = extractJsonStringField(text, 'search_block')
  const replace_block = extractJsonStringField(text, 'replace_block')
  const dir_path = extractJsonStringField(text, 'dir_path')
  const query = extractJsonStringField(text, 'query')

  const args: Record<string, unknown> = {}
  if (relative_path != null) args.relative_path = relative_path
  if (content != null) args.content = content
  if (command != null) args.command = command
  if (search_block != null) args.search_block = search_block
  if (replace_block != null) args.replace_block = replace_block
  if (dir_path != null) args.dir_path = dir_path
  if (query != null) args.query = query
  if (/append"\s*:\s*true/.test(text)) args.append = true

  const coerced = coerceToolRelativePath(args)
  if (coerced) args.relative_path = coerced
  else if (typeof args.content === 'string') {
    const inferred = inferWritePathFromContent(args.content)
    if (inferred) args.relative_path = inferred
  }

  if (Object.keys(args).length > 0) {
    return {
      args,
      truncated: truncated || true,
      parseError:
        'Tool JSON truncated/invalid; recovered fields heuristically.'
    }
  }

  return {
    args: {},
    truncated: true,
    parseError: `Failed to parse tool arguments as JSON (${text.slice(0, 120)}…)`
  }
}

function estimateChars(msgs: ApiMessage[]): number {
  let n = 0
  for (const m of msgs) {
    n += (m.content?.length ?? 0) + 32
    if (m.tool_calls) {
      for (const t of m.tool_calls) {
        n += t.function.name.length + t.function.arguments.length + 64
      }
    }
  }
  return n
}

function estimateTokens(msgs: ApiMessage[]): number {
  return Math.ceil(estimateChars(msgs) / CHARS_PER_TOKEN)
}

function shouldCompactForOverflow(msgs: ApiMessage[], ctxSize: number): boolean {
  const ctx = ctxSize > 0 ? ctxSize : 8192
  const budget = Math.max(2048, ctx - CTX_RESERVE_TOKENS)
  return estimateTokens(msgs) >= budget
}

function slimToolArgs(name: string, argsJson: string): string {
  const path = extractJsonStringField(argsJson, 'relative_path')
  const cmd = extractJsonStringField(argsJson, 'command')
  if (path) {
    return JSON.stringify({
      relative_path: path,
      content: `[omitted ${argsJson.length} chars — file on disk]`,
      note: 'use read_file if you need contents'
    })
  }
  if (cmd) {
    return JSON.stringify({ command: cmd.slice(0, 200) })
  }
  return argsJson.length > 400 ? argsJson.slice(0, 400) + '…' : argsJson
}

function slimMessage(m: ApiMessage): ApiMessage {
  if (m.role === 'tool') {
    const c = m.content ?? ''
    if (c.length <= 900) return m
    return {
      ...m,
      content: c.slice(0, 500) + '\n…[truncated]…\n' + c.slice(-300)
    }
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return {
      ...m,
      tool_calls: m.tool_calls.map((t) => ({
        ...t,
        function: {
          ...t.function,
          arguments:
            t.function.arguments.length > 600
              ? slimToolArgs(t.function.name, t.function.arguments)
              : t.function.arguments
        }
      }))
    }
  }
  if ((m.content?.length ?? 0) > 2_000 && m.role === 'user') {
    const c = m.content ?? ''
    return { ...m, content: c.slice(0, 1_200) + '\n…\n' + c.slice(-400) }
  }
  return m
}

/** Never insert a user turn after tools — breaks Devstral Jinja. */
function appendToolHint(msgs: ApiMessage[], hint: string): void {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'tool') {
      msgs[i] = {
        ...msgs[i]!,
        content: `${msgs[i]!.content ?? ''}\n\n[AGENT_HINT]: ${hint}`
      }
      return
    }
  }
}

function pushUserMessage(msgs: ApiMessage[], content: string): void {
  const last = msgs[msgs.length - 1]
  // Devstral: never user directly after tool — bridge with assistant first
  if (last?.role === 'tool') {
    msgs.push({
      role: 'assistant',
      content: '(tool results received — continuing)'
    })
  }
  const end = msgs[msgs.length - 1]
  if (end?.role === 'user') {
    end.content = `${end.content ?? ''}\n\n${content}`
  } else {
    msgs.push({ role: 'user', content })
  }
}

async function compactApiMessages(
  msgs: ApiMessage[],
  checklist?: AgentChecklist,
  queue?: QueueManager
): Promise<{ messages: ApiMessage[]; summary: string }> {
  if (msgs.length < 6) {
    return {
      messages: normalizeApiMessages(msgs.map(slimMessage)),
      summary: ''
    }
  }

  const head = msgs.slice(0, 1) // system
  // Slim write_file payloads so one compact pass is enough
  const rawTail = msgs.slice(-10).map(slimMessage)
  const middle = msgs.slice(1, -10)

  const digestLines: string[] = []
  const written = new Set<string>()
  for (const m of middle) {
    if (m.role === 'tool') {
      const brief = (m.content ?? '').slice(0, 180).replace(/\s+/g, ' ')
      digestLines.push(`- tool: ${brief}`)
      const pathMatch2 = (m.content ?? '').match(
        /(?:to|on)\s+"?([A-Za-z0-9_./\\-]+\.[a-zA-Z0-9]+)"?/
      )
      if (pathMatch2?.[1]) written.add(pathMatch2[1].replace(/\\/g, '/'))
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const t of m.tool_calls) {
        digestLines.push(`- called: ${t.function.name}`)
        const p = extractJsonStringField(t.function.arguments || '', 'relative_path')
        if (p) written.add(p.replace(/\\/g, '/'))
      }
    } else if (m.role === 'user' || m.role === 'assistant') {
      const brief = (m.content ?? '').slice(0, 120).replace(/\s+/g, ' ')
      if (brief) digestLines.push(`- ${m.role}: ${brief}`)
    }
  }

  let llmSummary = ''
  if (queue && middle.length > 0) {
    llmSummary = await llmSummarizeMiddle(queue, middle)
  }

  const tree = await fetchProjectTreeDigest()
  const fromHeuristic =
    written.size > 0
      ? `\nAlready touched paths (do NOT recreate; append or apply_patch only):\n` +
        [...written].slice(-60).map((p) => `- ${p}`).join('\n')
      : ''

  let cl = checklist ? { ...checklist, done: [...checklist.done], incomplete: [...checklist.incomplete], failed: [...checklist.failed], shells: [...checklist.shells] } : emptyChecklist()
  if (checklist) {
    for (const p of written) {
      if (
        !cl.done.some((d) => normPath(d) === normPath(p)) &&
        !cl.incomplete.some((d) => normPath(d) === normPath(p))
      ) {
        pushUnique(cl.done, p)
      }
    }
  } else {
    for (const p of written) pushUnique(cl.done, p)
  }
  const checklistBlock = formatChecklist(cl) || fromHeuristic

  const sys = head[0] ?? { role: 'system', content: '' }
  const memoryBody =
    llmSummary.trim() ||
    digestLines.slice(-40).join('\n') ||
    '(no prior middle turns)'
  const digestBlock =
    '\n\n[Context compacted due to context-window pressure]\n' +
    memoryBody +
    checklistBlock +
    tree +
    '\n\nCRITICAL: Continue from EXISTING files only. Never rewrite a file that already exists; use append=true or apply_patch. Do not create alternate filenames.'

  // Drop orphan tool rows from tail (must follow an assistant tool_calls)
  let tail = rawTail
  while (tail.length && tail[0]?.role === 'tool') {
    tail = tail.slice(1)
  }

  const compacted: ApiMessage[] = [
    {
      role: 'system',
      content: `${stripChecklistBlock(sys.content ?? '')}${digestBlock}`
    },
    ...tail
  ]
  return {
    messages: normalizeApiMessages(compacted),
    summary: memoryBody
  }
}

async function llmSummarizeMiddle(
  queue: QueueManager,
  middle: ApiMessage[]
): Promise<string> {
  const lines: string[] = []
  for (const m of middle) {
    if (m.role === 'tool') {
      lines.push(`tool: ${(m.content ?? '').slice(0, 200).replace(/\s+/g, ' ')}`)
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const t of m.tool_calls) {
        const p = extractJsonStringField(t.function.arguments || '', 'relative_path')
        lines.push(`called ${t.function.name}${p ? ` ${p}` : ''}`)
      }
      if (m.content?.trim()) {
        lines.push(`assistant: ${m.content.slice(0, 160).replace(/\s+/g, ' ')}`)
      }
    } else if (m.role === 'user' || m.role === 'assistant') {
      const brief = (m.content ?? '').slice(0, 240).replace(/\s+/g, ' ')
      if (brief) lines.push(`${m.role}: ${brief}`)
    }
  }
  const blob = lines.join('\n').slice(0, 14_000)
  if (!blob.trim()) return ''
  try {
    const res = await queue.compact({
      messages: [
        {
          role: 'system',
          content:
            'Summarize this coding-agent conversation for continuity. Keep: user goals, decisions, file paths touched, remaining work, and errors. Max 350 words. Plain text only.'
        },
        { role: 'user', content: blob }
      ],
      maxTokens: 512
    })
    return (res.text ?? '').trim()
  } catch {
    return ''
  }
}

async function buildApiMessages(
  history: ChatMessage[],
  userText: string,
  openFile?: { path: string; content: string },
  settings?: {
    systemPrompt?: string
    reasoningBudgetEnabled?: boolean
    reasoningBudget?: number
    reasoningBudgetMessage?: string
    agentAutoApprove?: boolean
    agentThinkThrough?: boolean
  },
  checklist?: AgentChecklist,
  selection?: EditorSelectionContext | null,
  attachments?: FileAttachment[],
  mode: AgentTurnMode = 'agent'
): Promise<ApiMessage[]> {
  let system =
    mode === 'plan'
      ? SYSTEM_PLAN
      : settings?.agentAutoApprove
        ? SYSTEM
        : SYSTEM_CONFIRM
  if (settings?.systemPrompt?.trim()) {
    system += `\n\n${settings.systemPrompt.trim()}`
  }
  system += `\n\n${formatNowForAgent()}`
  const projectRules = await fetchProjectRules()
  if (projectRules) {
    system += `\n\n${projectRules}`
  }
  if (mode !== 'plan' && settings?.agentThinkThrough !== false) {
    system += THINK_THROUGH
  }
  if (mode !== 'plan' && settings?.agentAutoApprove) {
    system +=
      '\n\nAuto-approve is ON (full agent rights): write_file, apply_patch, apply_diff, create_directory, delete_file, execute_terminal_command, and MCP tools are ALL pre-authorized with NO dialogs and NO Accept/Reject stops. Never ask the user whether to create, edit, delete, or run anything — call the tools immediately and keep going until the task is done. Shell runs in the visible IDE Terminal.'
  }
  if (settings?.reasoningBudgetEnabled && settings.reasoningBudgetMessage) {
    system += `\n\nReasoning budget: ${settings.reasoningBudget ?? 8192} tokens. When the budget is exhausted, conclude with: "${settings.reasoningBudgetMessage}"`
  }
  // Small open-file tip only — dumping full buffer every turn kills long tasks
  if (openFile?.path && openFile.path !== 'untitled.ts') {
    system += `\n\nCurrently focused file: ${openFile.path}`
  }

  const cl = checklist ?? buildChecklistFromHistory(history)
  if (mode !== 'plan') {
    system += formatChecklist(cl)
  }

  const summaryMsg = history.find((m) => m.id === THREAD_SUMMARY_MSG_ID)
  const summaryContent = summaryMsg?.content?.trim() ?? ''
  if (summaryContent) {
    system += `\n\n${summaryContent}`
  }

  const eligible: ChatMessage[] = []
  for (const m of history) {
    if (
      m.id === 'welcome' ||
      m.id === AGENT_CHECKLIST_MSG_ID ||
      m.id === THREAD_SUMMARY_MSG_ID
    ) {
      continue
    }
    if (m.pending || m.streaming) continue
    if (m.toolName) continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (!m.content?.trim()) continue
    eligible.push(m)
  }
  const kept = summaryContent
    ? eligible.slice(-RECENT_TURNS_WITH_SUMMARY)
    : eligible

  const turns: ApiMessage[] = []
  for (const m of kept) {
    const content = m.content?.trim()
    if (!content) continue

    const last = turns[turns.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content ?? ''}\n\n${content}`
    } else {
      turns.push({ role: m.role, content })
    }
  }

  while (turns.length && turns[0].role !== 'user') {
    turns.shift()
  }

  const tree = await fetchProjectTreeDigest()
  const mentions = parseComposerMentions(userText)
  const codebaseBlock = mentions.codebase
    ? await fetchCodebaseContext(
        codebaseQueryFallback(mentions.cleanText, userText, openFile, history)
      )
    : ''

  let fileBlock = ''
  if (mentions.file) {
    if (openFile?.path && openFile.path !== 'untitled.ts') {
      fileBlock =
        `\n[Attached @file: ${openFile.path}]\n\`\`\`\n` +
        truncateAttach(openFile.content ?? '', FILE_ATTACH_MAX) +
        '\n\`\`\`\n'
    } else {
      fileBlock = '\n[Attached @file: no file open]\n'
    }
  }

  let selectionBlock = ''
  if (mentions.selection) {
    if (selection?.text?.trim()) {
      selectionBlock =
        `\n[Attached @selection: ${selection.path}:${selection.startLine}-${selection.endLine}]\n\`\`\`\n` +
        truncateAttach(selection.text, SELECTION_ATTACH_MAX) +
        '\n\`\`\`\n'
    } else {
      selectionBlock = '\n[Attached @selection: no selection in editor]\n'
    }
  }

  let attachBlock = ''
  if (attachments?.length) {
    const parts: string[] = ['\n[Manually attached files]']
    let budget = 14_000
    for (const a of attachments) {
      if (budget <= 0) {
        parts.push(`…(+${attachments.length - parts.length + 1} more truncated)`)
        break
      }
      const body = truncateAttach(a.content ?? '', Math.min(FILE_ATTACH_MAX, budget))
      budget -= body.length
      parts.push(`\n[Attached: ${a.path}]\n\`\`\`\n${body}\n\`\`\``)
    }
    attachBlock = parts.join('\n') + '\n'
  }

  const surgical =
    looksLikeCorrection(mentions.cleanText) && !looksLikeExplicitRewrite(mentions.cleanText)
      ? SURGICAL_EDIT_HINT
      : ''
  const userPayload =
    mentions.cleanText +
    surgical +
    attachBlock +
    fileBlock +
    selectionBlock +
    codebaseBlock +
    tree

  const last = turns[turns.length - 1]
  if (last?.role === 'user') {
    last.content = `${last.content ?? ''}\n\n${userPayload}`
  } else {
    turns.push({ role: 'user', content: userPayload })
  }

  return [{ role: 'system', content: system }, ...turns]
}

function summarizeArgs(args: Record<string, unknown>): string {
  const path = args.relative_path ?? args.dir_path ?? args.query ?? args.command
  if (typeof path === 'string') return path
  try {
    return JSON.stringify(args).slice(0, 100)
  } catch {
    return Object.keys(args).join(', ')
  }
}

function parseToolDraft(
  name: string,
  argsJson: string
): {
  label: string
  filePath?: string
  codePreview?: string
} {
  const filePath =
    extractJsonStringField(argsJson, 'relative_path') ??
    extractJsonStringField(argsJson, 'path') ??
    extractJsonStringField(argsJson, 'file') ??
    extractJsonStringField(argsJson, 'filename') ??
    extractJsonStringField(argsJson, 'file_path') ??
    extractJsonStringField(argsJson, 'filepath') ??
    extractJsonStringField(argsJson, 'dir_path') ??
    undefined

  if (name === 'write_file') {
    const code = extractJsonStringField(argsJson, 'content') ?? ''
    return {
      label: `✎ writing ${filePath || '…'}`,
      filePath,
      codePreview: code
    }
  }

  if (name === 'apply_diff') {
    const code =
      extractJsonStringField(argsJson, 'replace_block') ??
      extractJsonStringField(argsJson, 'search_block') ??
      ''
    return {
      label: `✎ patching ${filePath || '…'}`,
      filePath,
      codePreview: code
    }
  }

  if (name === 'apply_patch') {
    const patch = extractJsonStringField(argsJson, 'patch') ?? ''
    const updatePath =
      patch.match(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/)?.[1] ?? filePath
    return {
      label: `✎ apply_patch ${updatePath || '…'}`,
      filePath: updatePath,
      codePreview: patch.slice(0, 4000)
    }
  }

  if (name === 'explore_subagent') {
    const goal = extractJsonStringField(argsJson, 'goal') ?? '…'
    return { label: `⌕ explore · ${goal.slice(0, 60)}` }
  }

  if (name === 'delete_file') {
    return { label: `🗑 delete ${filePath || '…'}`, filePath }
  }

  if (name === 'create_directory') {
    return { label: `📁 mkdir ${filePath || '…'}`, filePath }
  }

  if (name === 'read_file') {
    return { label: `📖 read ${filePath || '…'}`, filePath }
  }

  if (name === 'list_directory') {
    return { label: `📂 list ${filePath || '.'}`, filePath }
  }

  if (name === 'search_codebase') {
    const q = extractJsonStringField(argsJson, 'query') ?? '…'
    return { label: `⌕ ${q}` }
  }

  if (name === 'web_search') {
    const q = extractJsonStringField(argsJson, 'query') ?? '…'
    return { label: `🌐 web ${q}` }
  }

  if (name === 'execute_terminal_command') {
    const cmd = extractJsonStringField(argsJson, 'command') ?? ''
    return { label: `▹ shell ${cmd || '…'}`, codePreview: cmd || undefined }
  }
  if (name === 'read_terminal') {
    return { label: '▹ read terminal', codePreview: undefined }
  }

  return { label: `▸ ${name || 'tool'}`, filePath }
}

function statsFromResult(
  result: {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
    timings?: {
      prompt_n?: number
      predicted_n?: number
      prompt_ms?: number
      predicted_ms?: number
      prompt_per_second?: number
      predicted_per_second?: number
    }
  },
  wallMs?: number
): ChatMessageStats | undefined {
  const promptTokens = result.usage?.prompt_tokens ?? result.timings?.prompt_n
  const completionTokens =
    result.usage?.completion_tokens ?? result.timings?.predicted_n
  const totalTokens =
    result.usage?.total_tokens ??
    (promptTokens != null || completionTokens != null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined)
  const tps = result.timings?.predicted_per_second
  const promptTps = result.timings?.prompt_per_second
  const genMs =
    result.timings?.predicted_ms != null
      ? Math.round(result.timings.predicted_ms)
      : undefined
  const elapsedMs =
    wallMs != null && wallMs >= 0 ? Math.round(wallMs) : undefined

  if (
    tps == null &&
    promptTps == null &&
    promptTokens == null &&
    completionTokens == null &&
    genMs == null &&
    elapsedMs == null
  ) {
    return undefined
  }
  return {
    tps: tps != null ? Math.round(tps * 10) / 10 : undefined,
    promptTps: promptTps != null ? Math.round(promptTps) : undefined,
    promptTokens,
    completionTokens,
    totalTokens,
    genMs,
    elapsedMs
  }
}

function attachStatsToLastVisible(
  messages: ChatMessage[],
  stats: ChatMessageStats
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.id === 'welcome') continue
    if (m.streaming) continue
    if (!m.content?.trim() && !m.codePreview && !m.toolName) continue
    const prev = m.stats
    messages[i] = {
      ...m,
      stats: {
        ...prev,
        ...stats,
        // Keep last known token counts when this round omitted usage.
        promptTokens: stats.promptTokens ?? prev?.promptTokens,
        completionTokens: stats.completionTokens ?? prev?.completionTokens,
        totalTokens:
          stats.totalTokens ??
          (stats.promptTokens != null || stats.completionTokens != null
            ? (stats.promptTokens ?? 0) + (stats.completionTokens ?? 0)
            : prev?.totalTokens)
      }
    }
    return
  }
}

export function formatReverbPrompt(revisedText: string): string {
  return (
    'The user revised their in-progress task. Continue from the current repository state. ' +
    'Do not undo or redo work already completed unless the revision requires it.\n\n' +
    'Revised task:\n' +
    revisedText
  )
}

export async function runAgentTurn(params: {
  queue: QueueManager
  history: ChatMessage[]
  userText: string
  openFile?: { path: string; content: string }
  selection?: EditorSelectionContext | null
  attachments?: FileAttachment[]
  onUpdate: (messages: ChatMessage[]) => void
  onStats?: (stats: ChatMessageStats) => void
  onOpenPath?: (relativePath: string) => void
  maxRounds?: number
  signal?: AbortSignal
  mode?: AgentTurnMode
  sessionId?: string
  onUserMessageCreated?: (id: string) => void
  /**
   * Soft-continue after revising an in-progress user message.
   * Reuses `messageId` for the user bubble; API sees formatReverbPrompt(userText).
   * `history` must be messages *before* that user bubble.
   */
  reverbContinue?: { messageId: string }
  /** UI language for user-facing pause / timeout hints */
  uiLanguage?: UiLanguage
}): Promise<ChatMessage[]> {
  const isPlan = params.mode === 'plan'
  const maxRounds = isPlan ? 1 : (params.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const uiLang: UiLanguage = isUiLanguage(params.uiLanguage)
    ? params.uiLanguage
    : DEFAULT_UI_LANGUAGE
  const tAgent = (key: 'chat.agent.pausedRounds' | 'chat.agent.genTimeout', vars?: Record<string, string | number>) =>
    translate(uiLang, key, vars)
  const userMessageId = params.reverbContinue?.messageId ?? uid()
  const messages: ChatMessage[] = [
    ...params.history.filter((m) => !m.pending && !m.streaming),
    { id: userMessageId, role: 'user', content: params.userText }
  ]
  params.onUserMessageCreated?.(userMessageId)
  params.onUpdate([...messages])

  const turnStartedAt = Date.now()
  const turnFileChanges = new Map<string, TurnFileChange>()

  const commitTurnCheckpoint = (): void => {
    if (!params.sessionId || isPlan) return
    void window.api.checkpoints
      .commit({
        sessionId: params.sessionId,
        messageId: userMessageId,
        label: params.userText.replace(/\s+/g, ' ').trim().slice(0, 80)
      })
      .catch(() => {
        /* non-fatal */
      })
  }

  const finishWithTiming = (msgs: ChatMessage[]): ChatMessage[] => {
    clearPlanningRows(msgs)
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.streaming) {
        msgs[i] = { ...msgs[i]!, streaming: false }
      }
    }
    appendFilesChangedSummary(msgs, turnFileChanges)
    attachStatsToLastVisible(msgs, { turnElapsedMs: Date.now() - turnStartedAt })
    params.onUpdate([...msgs])
    commitTurnCheckpoint()
    return msgs
  }

  const finishStopped = (note = '⏹ Stopped.'): ChatMessage[] => {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.streaming) {
        messages[i] = {
          ...messages[i]!,
          streaming: false,
          content: messages[i]!.content?.trim() ? messages[i]!.content : '(stopped)'
        }
      }
    }
    messages.push({ id: uid(), role: 'assistant', content: note })
    return finishWithTiming(messages)
  }

  if (params.signal?.aborted) return finishStopped()

  const appSettings = await window.api.settings.get()
  params.queue.applySettings(appSettings)

  let checklist = buildChecklistFromHistory(params.history)
  removeChecklistBubbles(messages)
  if (!isPlan) {
    params.onUpdate([...messages])
  }

  const apiUserText = params.reverbContinue
    ? formatReverbPrompt(params.userText)
    : params.userText
  let apiMessages: ApiMessage[] = await buildApiMessages(
    params.history,
    apiUserText,
    params.openFile,
    appSettings,
    checklist,
    params.selection,
    params.attachments,
    isPlan ? 'plan' : 'agent'
  )

  let completedTools = 0
  let earlyDoneNudges = 0
  let roleRepairAttempts = 0
  let jsonRepairAttempts = 0
  let markupRepairAttempts = 0
  let toolLoopHits = 0
  let missingPathHits = 0
  let usedWebSearch = false
  /** null until a test command runs */
  let lastNodeTestOk: boolean | null = null
  let ranCliSmoke = false
  const incompleteAppendsByPath = new Map<string, number>()
  const identicalToolCounts = new Map<string, number>()
  const ctxSize = appSettings.ctxSize > 0 ? appSettings.ctxSize : 8192
  const thinkThrough = !isPlan && appSettings.agentThinkThrough !== false
  const autoApprove = appSettings.agentAutoApprove === true
  const userWantsWebSearch =
    /web_search|cite\s+1\s+url|under a ["']?Refs|search the web|from search/i.test(
      params.userText
    )
  const userWantsNodeTest =
    /node:test|node\s+--test|npm\s+test/i.test(params.userText)
  const userWantsCli =
    /\bCLI\b|stdin|argv|first argv|command.?line/i.test(params.userText)

  let agentTools: unknown[] = [...AGENT_TOOL_SCHEMAS]
  if (!isPlan) {
    try {
      const listed = await window.api.agent.listTools()
      if (Array.isArray(listed) && listed.length > 0) agentTools = listed
    } catch {
      /* keep builtins */
    }
  }

  for (let round = 0; round < maxRounds; round++) {
    if (params.signal?.aborted) return finishStopped()
    clearPlanningRows(messages)

    // Compact only on context overflow — never on a timer / per-file
    if (round > 0 && shouldCompactForOverflow(apiMessages, ctxSize)) {
      const compacted = await compactApiMessages(
        apiMessages,
        checklist,
        params.queue
      )
      apiMessages = compacted.messages
      if (compacted.summary) upsertThreadSummary(messages, compacted.summary)
      if (shouldCompactForOverflow(apiMessages, ctxSize)) {
        apiMessages = normalizeApiMessages(apiMessages.map(slimMessage))
      }
      messages.push({
        id: uid(),
        role: 'assistant',
        content: `↻ Context near limit (${estimateTokens(apiMessages)}/${ctxSize} tok est.) — compacted to continue…`
      })
      params.onUpdate([...messages])
    }

    if (!isPlan) injectChecklistIntoSystem(apiMessages, checklist)

    const streamId = uid()
    let streamBubbleCreated = false
    const ensureStreamBubble = (): void => {
      if (streamBubbleCreated) return
      streamBubbleCreated = true
      messages.push({
        id: streamId,
        role: 'assistant',
        content: '',
        streaming: true
      })
      params.onUpdate([...messages])
    }

    const toolDraft = new Map<number, { name: string; arguments: string }>()
    const toolMsgByIndex = new Map<number, string>()
    const callStartedAt = Date.now()
    const streamAc = new AbortController()
    const onOuterAbort = (): void => {
      streamAc.abort(params.signal?.reason ?? 'aborted')
    }
    if (params.signal?.aborted) {
      streamAc.abort(params.signal.reason ?? 'aborted')
    } else {
      params.signal?.addEventListener('abort', onOuterAbort, { once: true })
    }
    let streamAbortReason: string | null = null
    const abortStream = (reason: string): void => {
      if (streamAc.signal.aborted) return
      streamAbortReason = reason
      streamAc.abort(reason)
    }

    const result = await params.queue.chatStream({
      messages: normalizeApiMessages(apiMessages),
      ...(isPlan ? {} : { tools: agentTools }),
      maxTokens: appSettings.limitResponseLength
        ? appSettings.maxTokens
        : AGENT_MAX_TOKENS,
      signal: streamAc.signal,
      onToken: (token) => {
        if (streamAc.signal.aborted) return
        clearPlanningRows(messages)
        ensureStreamBubble()
        const idx = messages.findIndex((m) => m.id === streamId)
        if (idx === -1) return
        messages[idx] = {
          ...messages[idx],
          content: messages[idx].content + token,
          streaming: true
        }
        params.onUpdate([...messages])
      },
      onToolDelta: isPlan
        ? undefined
        : (delta) => {
            if (streamAc.signal.aborted) return
            clearPlanningRows(messages)
            const prev = toolDraft.get(delta.index) ?? { name: '', arguments: '' }
            if (delta.name) prev.name += delta.name
            if (delta.arguments) prev.arguments += delta.arguments
            toolDraft.set(delta.index, prev)

            const parsed = parseToolDraft(prev.name, prev.arguments)
            const inferredPath =
              !parsed.filePath && parsed.codePreview
                ? inferWritePathFromContent(parsed.codePreview)
                : null
            const draftPath = parsed.filePath || inferredPath || undefined
            // Never abort because path hasn't appeared yet — models often emit
            // content first and relative_path last; cutting early drops the path.
            if (prev.arguments.length > MAX_TOOL_ARG_CHARS) {
              abortStream('tool_args_too_large')
              return
            }
            if (!prev.name && !parsed.label.replace(/^[▸▹✎]+\s*/, '').trim()) return

            let draftArgs: Record<string, unknown> = {}
            try {
              draftArgs = JSON.parse(prev.arguments || '{}') as Record<string, unknown>
            } catch {
              draftArgs = {}
              if (draftPath) draftArgs.relative_path = draftPath
            }
            if (draftPath && !coerceToolRelativePath(draftArgs)) {
              draftArgs.relative_path = draftPath
            }
            const draftActivity = prev.name
              ? activityForTool(prev.name, draftArgs, { streaming: true })
              : undefined

            let msgId = toolMsgByIndex.get(delta.index)
            if (!msgId) {
              msgId = uid()
              toolMsgByIndex.set(delta.index, msgId)
              messages.push({
                id: msgId,
                role: 'assistant',
                content: draftActivity
                  ? formatActivityLabel(draftActivity)
                  : parsed.label,
                toolName: prev.name || 'tool',
                streaming: true,
                filePath: draftPath,
                codePreview: parsed.codePreview,
                activity: draftActivity
              })
            } else {
              const tIdx = messages.findIndex((m) => m.id === msgId)
              if (tIdx !== -1) {
                messages[tIdx] = {
                  ...messages[tIdx],
                  content: draftActivity
                    ? formatActivityLabel(draftActivity)
                    : parsed.label,
                  toolName: prev.name || messages[tIdx].toolName,
                  streaming: true,
                  filePath: draftPath ?? messages[tIdx].filePath,
                  codePreview: parsed.codePreview ?? messages[tIdx].codePreview,
                  activity: draftActivity ?? messages[tIdx].activity
                }
              }
            }
            params.onUpdate([...messages])
          },
      priority: 'NORMAL'
    })
    params.signal?.removeEventListener('abort', onOuterAbort)

    // Soft stream guard: runaway size only (never missing-path — that was a regression)
    const softAbort = streamAbortReason === 'tool_args_too_large'

    if (softAbort) {
      result.aborted = false
      result.error = undefined
    }

    // Never execute tools from a cancelled / half-aborted stream
    if ((params.signal?.aborted || result.aborted) && !softAbort) {
      for (const id of toolMsgByIndex.values()) {
        const i = messages.findIndex((m) => m.id === id)
        if (i !== -1 && messages[i]?.streaming) {
          messages[i] = {
            ...messages[i],
            streaming: false,
            content: `⏹ ${messages[i].toolName || 'tool'} interrupted`
          }
        }
      }
      const si = messages.findIndex((m) => m.id === streamId)
      if (si !== -1 && messages[si]?.streaming) {
        messages[si] = {
          ...messages[si],
          streaming: false,
          content: messages[si].content?.trim() || '⏹ Stopped'
        }
      }
      params.onUpdate([...messages])
      return finishStopped()
    }

    // Abort clears toolCalls in the queue — rebuild from live draft for soft size guard
    if (softAbort && (!result.toolCalls?.length) && toolDraft.size > 0) {
      result.toolCalls = [...toolDraft.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, t]) => Boolean(t.name))
        .map(([index, t]) => ({
          id: `soft-${index}-${uid().slice(0, 8)}`,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments }
        }))
      result.finishReason = 'length'
    }

    const sIdx = messages.findIndex((m) => m.id === streamId)
    const stats = statsFromResult(result, Date.now() - callStartedAt)
    if (stats) params.onStats?.(stats)
    if (sIdx !== -1) {
      if (!result.text?.trim()) {
        messages.splice(sIdx, 1)
        if (stats) attachStatsToLastVisible(messages, stats)
      } else {
        const prev = messages[sIdx]
        const prevStats = prev?.stats
        const mergedStats = stats
          ? {
              ...prevStats,
              ...stats,
              promptTokens: stats.promptTokens ?? prevStats?.promptTokens,
              completionTokens: stats.completionTokens ?? prevStats?.completionTokens,
              totalTokens:
                stats.totalTokens ??
                (stats.promptTokens != null || stats.completionTokens != null
                  ? (stats.promptTokens ?? 0) + (stats.completionTokens ?? 0)
                  : prevStats?.totalTokens)
            }
          : prevStats
        messages[sIdx] = {
          ...messages[sIdx],
          content: result.text || messages[sIdx].content || '(empty)',
          streaming: false,
          stats: mergedStats
        }
      }
      params.onUpdate([...messages])
    } else if (stats) {
      attachStatsToLastVisible(messages, stats)
      params.onUpdate([...messages])
    }

    if (result.aborted || result.error) {
      const errText = result.error ?? 'aborted'
      // Internal stream guards must never surface as fatal chat errors
      if (
        /write_file_missing_path|tool_args_too_large|tool_markup_in_content/i.test(
          errText
        )
      ) {
        result.aborted = false
        result.error = undefined
        if ((!result.toolCalls?.length) && toolDraft.size > 0) {
          result.toolCalls = [...toolDraft.entries()]
            .sort((a, b) => a[0] - b[0])
            .filter(([, t]) => Boolean(t.name))
            .map(([index, t]) => ({
              id: `soft-${index}-${uid().slice(0, 8)}`,
              type: 'function' as const,
              function: { name: t.name, arguments: t.arguments }
            }))
          result.finishReason = 'length'
        }
      } else {
      const isTimeout = /^timeout$/i.test(errText.trim())
      if (isTimeout) {
        messages.push({
          id: uid(),
          role: 'assistant',
          content:
            tAgent('chat.agent.genTimeout')
        })
        params.onUpdate([...messages])
        return finishWithTiming(messages)
      }
      const userStopped =
        params.signal?.aborted ||
        /user_stop|cancelled|model_unloaded/i.test(errText)
      if (userStopped || (result.aborted && /user_stop|cancelled|aborted/i.test(errText))) {
        return finishStopped('⏹ Stopped.')
      }
      if (result.aborted) {
        return finishStopped(`⏹ Stopped (${errText}).`)
      }
      const isRoleError =
        /role|jinja|alternat|system message|tool calls and results/i.test(errText)
      const isJsonToolError = /parse tool call|json\.exception|arguments as JSON/i.test(
        errText
      )
      const isOverflow =
        /context|overflow|oom|too many tokens|n_keep|exceed/i.test(errText)

      if (isRoleError) roleRepairAttempts++
      else roleRepairAttempts = 0
      if (isJsonToolError) jsonRepairAttempts++
      else if (!isRoleError) jsonRepairAttempts = 0

      const repairBudgetOk =
        (!isRoleError || roleRepairAttempts <= 2) &&
        (!isJsonToolError || jsonRepairAttempts <= 2)
      const recoverable =
        repairBudgetOk &&
        (isRoleError ||
          isOverflow ||
          isJsonToolError ||
          /timed?\s*out/i.test(errText)) &&
        round < maxRounds - 1

      messages.push({
        id: uid(),
        role: 'assistant',
        content: recoverable
          ? `⚠ ${errText}\n${isOverflow ? 'Compacting…' : isJsonToolError ? 'Retry with smaller tool args…' : 'Repairing message roles…'} retrying`
          : `Error: ${errText}`
      })
      params.onUpdate([...messages])

      if (!recoverable) return finishWithTiming(messages)

      if (isOverflow || shouldCompactForOverflow(apiMessages, ctxSize)) {
        const compacted = await compactApiMessages(
          apiMessages,
          checklist,
          params.queue
        )
        apiMessages = compacted.messages
        if (compacted.summary) upsertThreadSummary(messages, compacted.summary)
      } else {
        apiMessages = normalizeApiMessages(apiMessages)
      }
      // Never insert user after tools — attach hint to last tool or merge into last user
      const last = apiMessages[apiMessages.length - 1]
      const repairHint = isJsonToolError
        ? 'Previous tool JSON was invalid. Prefer apply_diff with a short unique search_block, or write_file with ≤800 chars. Do not resend a huge apply_patch.'
        : `Previous model response failed: ${errText.slice(0, 240)}\n` +
          'Continue the unfinished task. Prefer smaller write_file chunks and relative paths only. Never overwrite existing files — append=true or apply_diff.'
      if (last?.role === 'tool') {
        appendToolHint(apiMessages, repairHint)
      } else {
        pushUserMessage(apiMessages, repairHint)
      }
      apiMessages = normalizeApiMessages(apiMessages)
      continue
      }
    }

    // Plan mode: one tools-off turn → pending plan bubble
    if (isPlan) {
      const streamed =
        sIdx !== -1 ? (messages.find((m) => m.id === streamId)?.content ?? '') : ''
      const planText = (result.text?.trim() || streamed.trim() || '(empty plan)')
      const si = messages.findIndex((m) => m.id === streamId)
      if (si !== -1) messages.splice(si, 1)
      for (const id of toolMsgByIndex.values()) {
        const i = messages.findIndex((m) => m.id === id)
        if (i !== -1) messages.splice(i, 1)
      }
      upsertPlanBubble(messages, setPlanStatus(planText, 'pending'), stats)
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    // Soft-recover when generation cut off mid tool-call
    if (
      result.finishReason === 'length' &&
      result.toolCalls?.length &&
      round < maxRounds - 1
    ) {
      // fall through — write handler marks INCOMPLETE_WRITE
    } else if (result.finishReason === 'length' && !result.toolCalls?.length) {
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          '⚠ Reply hit max_tokens mid-generation. Continuing with a smaller next step…'
      })
      params.onUpdate([...messages])
      pushUserMessage(
        apiMessages,
        'Your previous reply was cut off (max_tokens). Continue from where you left off with smaller write_file chunks (append=true).'
      )
      continue
    }

    const toolCalls = result.toolCalls
    if (
      !toolCalls?.length &&
      looksLikeToolMarkupLeak(result.text ?? '') &&
      round < maxRounds - 1
    ) {
      markupRepairAttempts++
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          markupRepairAttempts > MAX_MARKUP_REPAIR_ATTEMPTS
            ? '⚠ Model leaked tool-call syntax into plain text. Stopping to avoid a write loop.'
            : '⚠ Detected leaked tool-call syntax in the reply (not a real tool call). Asking the model to use structured tools…'
      })
      params.onUpdate([...messages])
      if (markupRepairAttempts > MAX_MARKUP_REPAIR_ATTEMPTS) {
        return finishWithTiming(messages)
      }
      pushUserMessage(
        apiMessages,
        'Your previous reply contained raw tool markup (<tool_call>, [:channel:], call:write_file, etc.) as plain text. ' +
          'That is NOT executed. Use only the structured function/tools API: write_file / create_directory / apply_patch with JSON arguments. ' +
          'Never put tool syntax inside write_file content.'
      )
      continue
    }

    if (toolCalls?.length) {
      apiMessages.push({
        role: 'assistant',
        content: result.text?.trim() ? result.text : null,
        tool_calls: toolCalls
      })

      for (const [index, call] of toolCalls.entries()) {
        const name = call.function.name as AgentToolName
        const parsedArgs = parseToolArguments(call.function.arguments || '{}')
        const args = parsedArgs.args
        const resolvedPath =
          name === 'write_file'
            ? resolveWriteFilePath(args)
            : coerceToolRelativePath(args)
        if (resolvedPath) args.relative_path = resolvedPath

        const codePreview =
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
                    : undefined
        const filePath =
          resolvedPath ??
          (typeof args.patch === 'string'
            ? (args.patch.match(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/)?.[1] ??
              undefined)
            : undefined)

        let statusId = toolMsgByIndex.get(index)
        const runningActivity = activityForTool(name, args, { streaming: true })
        if (!statusId) {
          statusId = uid()
          messages.push({
            id: statusId,
            role: 'assistant',
            content: formatActivityLabel(runningActivity),
            toolName: name,
            streaming: true,
            filePath,
            codePreview,
            activity: runningActivity
          })
        } else {
          const tIdx = messages.findIndex((m) => m.id === statusId)
          if (tIdx !== -1) {
            messages[tIdx] = {
              ...messages[tIdx],
              content: formatActivityLabel(runningActivity),
              toolName: name,
              streaming: true,
              filePath: filePath ?? messages[tIdx].filePath,
              codePreview: codePreview ?? messages[tIdx].codePreview,
              activity: runningActivity
            }
          }
        }
        // Paint running state before blocking IPC (long shell)
        if (name === 'execute_terminal_command') {
          const tIdx = messages.findIndex((m) => m.id === statusId)
          if (tIdx !== -1) {
            const shellAct = activityForTool(name, args, { streaming: true })
            messages[tIdx] = {
              ...messages[tIdx],
              content: formatActivityLabel(shellAct),
              streaming: true,
              activity: shellAct
            }
          }
        }
        params.onUpdate([...messages])

        if (params.signal?.aborted) return finishStopped()

        let exploreFileCount: number | undefined
        let toolResult: AgentToolResult

        const fp = fingerprintToolCall(name, args)
        const identicalCount = (identicalToolCounts.get(fp) ?? 0) + 1
        identicalToolCounts.set(fp, identicalCount)
        const identicalLimit =
          name === 'create_directory' ? MAX_IDENTICAL_TOOL_CALLS : MAX_IDENTICAL_TOOL_CALLS + 1
        if (identicalCount > identicalLimit) {
          toolLoopHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              `TOOL_LOOP: identical ${name} repeated ${identicalCount} times` +
              (filePath ? ` on "${filePath}"` : '') +
              '. Stop repeating. Continue with a different file/step or finish the task.'
          }
        } else if (name === 'explore_subagent') {
          const explore = await runExploreSubagent({
            queue: params.queue,
            goal: String(args.goal ?? ''),
            focusPaths: Array.isArray(args.focus_paths)
              ? args.focus_paths.map(String)
              : undefined,
            signal: params.signal,
            onProgress: (_label, prog) => {
              const tIdx = messages.findIndex((m) => m.id === statusId)
              if (tIdx !== -1) {
                const act = activityForTool(name, args, {
                  streaming: true,
                  fileCount: prog?.fileCount
                })
                messages[tIdx] = {
                  ...messages[tIdx],
                  content: formatActivityLabel(act),
                  streaming: true,
                  activity: act
                }
                params.onUpdate([...messages])
              }
            }
          })
          exploreFileCount = explore.fileCount
          toolResult = {
            id: call.id,
            name,
            ok: explore.ok,
            content: explore.content,
            error: explore.error
          }
        } else {
        const cutByLength = result.finishReason === 'length'
        const contentStr =
          typeof args.content === 'string' ? args.content : ''
        const pathStr =
          typeof args.relative_path === 'string' ? args.relative_path : ''
        const pathKey = pathStr.replace(/\\/g, '/')
        const codeIncomplete =
          name === 'write_file' &&
          Boolean(pathStr) &&
          Boolean(contentStr) &&
          // Only when the model/stream was cut off — not heuristic "looks unfinished"
          // (that false-failed successful writes and left the explorer empty).
          (Boolean(parsedArgs.truncated) || cutByLength)

        if (parsedArgs.parseError && Object.keys(args).length === 0) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              parsedArgs.parseError +
              ' REQUIRED: rewrite with a smaller write_file chunk (or append=true on the same path).'
          }
        } else if (
          name === 'write_file' &&
          !resolveWriteFilePath(args)
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'MISSING_PATH: relative_path is required BEFORE content ' +
              '(e.g. relative_path="index.html"). Do not stream a whole file without a path.'
          }
        } else if (
          name === 'create_directory' &&
          !coerceToolRelativePath(args)
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'MISSING_PATH: relative_path is required for create_directory (e.g. "assets").'
          }
        } else if (name === 'write_file' && looksLikeToolMarkupLeak(contentStr)) {
          // Strip leaked markup; still write the source body if anything remains
          const cleaned = contentStr
            .replace(/<\/?tool_call\b[^>]*>/gi, '')
            .replace(/<\|tool_call\|[^|]*/gi, '')
            .replace(/\[:channel:[^\]]*\]?/gi, '')
            .replace(/\[:tool[^\]]*\]?/gi, '')
            .replace(/call:write_file\b[^]*/gi, '')
            .trim()
          if (cleaned.length >= 8 && resolveWriteFilePath({ ...args, content: cleaned })) {
            args.content = cleaned
            // fall through by re-invoking below via recursive structure — invoke now
            toolResult = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: { ...args, content: cleaned }
            })
            if (toolResult.ok) {
              toolResult = {
                ...toolResult,
                content: `${toolResult.content}\n(note: stripped leaked tool markup from content)`
              }
            }
          } else {
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error:
                'TOOL_MARKUP_IN_CONTENT: write_file content was mostly tool-call syntax. ' +
                'Call write_file again with ONLY the source file body and relative_path.'
            }
          }
        } else if (
          name === 'write_file' &&
          args.overwrite === true &&
          !args.append &&
          looksLikeCorrection(params.userText) &&
          !looksLikeExplicitRewrite(params.userText)
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'OVERWRITE_BLOCKED: this turn is a correction. Call read_file, then apply_patch (or apply_diff) on the existing file. ' +
              'overwrite=true is only allowed if the user explicitly asks to rewrite the whole file.'
          }
        } else if (name === 'write_file' && codeIncomplete && pathStr && contentStr) {
          const appendN = (incompleteAppendsByPath.get(pathKey) ?? 0) + 1
          incompleteAppendsByPath.set(pathKey, appendN)
          // Always try to persist — never fail the UI when bytes landed on disk.
          const partial = await window.api.agent.invoke({
            id: call.id,
            name,
            arguments: {
              ...args,
              append: Boolean(args.append)
            }
          })
          let saved = partial
          if (
            !partial.ok &&
            /FILE_EXISTS/i.test(partial.error ?? partial.content ?? '')
          ) {
            saved = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: { ...args, append: true }
            })
          }
          const tail = contentStr.slice(-200)
          if (!saved.ok) {
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: saved.content || '',
              error: saved.error ?? 'incomplete write failed'
            }
          } else if (appendN > MAX_INCOMPLETE_APPENDS_PER_PATH) {
            toolLoopHits++
            toolResult = {
              id: call.id,
              name,
              ok: true,
              content:
                `Wrote ${contentStr.length} chars to ${pathStr} (file on disk). ` +
                `INCOMPLETE_WRITE_LIMIT: stop tiny appends — finish with one larger append (≥200 chars) or move on.`,
              editReview: saved.editReview
            }
          } else {
            // ok:true so explorer updates and UI is not "Edited · failed"
            toolResult = {
              id: call.id,
              name,
              ok: true,
              content:
                `Wrote partial content to ${pathStr} (${contentStr.length} chars) — file is on disk. ` +
                `INCOMPLETE_WRITE: continue with write_file append=true on THE SAME path "${pathStr}" after:\n<<<\n${tail}\n>>>`,
              editReview: saved.editReview
            }
          }
        } else {
          toolResult = await window.api.agent.invoke({
            id: call.id,
            name,
            arguments: args
          })
          // Same-turn rewrite of a file we already started → append instead of hard fail
          if (
            name === 'write_file' &&
            !toolResult.ok &&
            /FILE_EXISTS/i.test(toolResult.error ?? toolResult.content ?? '') &&
            pathStr &&
            contentStr
          ) {
            const pathInFlight =
              incompleteAppendsByPath.has(pathKey) ||
              checklist.incomplete.some(
                (p) => p.replace(/\\/g, '/') === pathKey
              )
            if (pathInFlight) {
              const appended = await window.api.agent.invoke({
                id: call.id,
                name,
                arguments: { ...args, append: true }
              })
              if (appended.ok) {
                const stillCut =
                  Boolean(parsedArgs.truncated) || cutByLength
                if (stillCut) {
                  const n = (incompleteAppendsByPath.get(pathKey) ?? 0) + 1
                  incompleteAppendsByPath.set(pathKey, n)
                  const tail = contentStr.slice(-200)
                  toolResult = {
                    id: call.id,
                    name,
                    ok: true,
                    content:
                      `Appended ${contentStr.length} chars to ${pathStr} (on disk). ` +
                      `INCOMPLETE_WRITE: continue append=true on "${pathStr}" after:\n<<<\n${tail}\n>>>`,
                    editReview: appended.editReview
                  }
                } else {
                  toolResult = {
                    ...appended,
                    content: `${appended.content} (auto-appended after FILE_EXISTS)`
                  }
                }
              }
            }
          } else if (parsedArgs.parseError && toolResult.ok) {
            toolResult = {
              ...toolResult,
              content: `${toolResult.content}\n(note: ${parsedArgs.parseError})`
            }
          }
        }
        }

        completedTools++

        if (/MISSING_PATH/i.test(toolResult.error ?? toolResult.content ?? '')) {
          missingPathHits++
        }

        if (name === 'web_search' && toolResult.ok) usedWebSearch = true
        if (name === 'execute_terminal_command') {
          const cmd = String(args.command ?? '')
          if (/node\s+--test|npm\s+test/i.test(cmd)) {
            // Later red test clears a prior green
            lastNodeTestOk = toolResult.ok
          }
          if (
            /(cli\.js|npm\s+start|node\s+src\/)/i.test(cmd) &&
            toolResult.ok
          ) {
            ranCliSmoke = true
          }
        }

        applyToolToChecklist(checklist, name, args, toolResult)

        const content = toolResult.ok
          ? toolResult.content.slice(0, TOOL_RESULT_CHARS)
          : `${toolResult.error ? `ERROR: ${toolResult.error}\n` : ''}${toolResult.content}`.slice(
              0,
              TOOL_RESULT_CHARS
            )

        if (
          params.signal?.aborted ||
          /USER_STOPPED|Interrupted by Stop/i.test(content)
        ) {
          const idx = messages.findIndex((m) => m.id === statusId)
          if (idx !== -1) {
            messages[idx] = {
              ...messages[idx],
              content: `⏹ ${name} interrupted`,
              toolName: name,
              streaming: false
            }
          }
          params.onUpdate([...messages])
          return finishStopped()
        }

        const idx = messages.findIndex((m) => m.id === statusId)
        if (idx !== -1) {
          const incomplete = /INCOMPLETE_WRITE/i.test(content)
          const incompleteSaved =
            incomplete &&
            toolResult.ok &&
            !/INCOMPLETE_WRITE_LIMIT/i.test(content)
          const reviewPath =
            toolResult.editReview?.path ??
            (filePath ? filePath.replace(/\\/g, '/') : undefined)
          // Auto-approve: apply edits immediately (no Accept/Reject in thread)
          if (
            autoApprove &&
            reviewPath &&
            toolResult.editReview?.status === 'pending'
          ) {
            try {
              await window.api.agent.acceptEdit(reviewPath)
            } catch {
              /* ignore */
            }
            if (toolResult.editReview) {
              toolResult = {
                ...toolResult,
                editReview: { ...toolResult.editReview, status: 'accepted' }
              }
            }
          }
          const showReview =
            !autoApprove &&
            (name === 'write_file' ||
              name === 'apply_diff' ||
              name === 'apply_patch') &&
            Boolean(reviewPath) &&
            toolResult.ok &&
            toolResult.editReview?.status === 'pending'
          const doneActivity = activityForTool(name, args, {
            streaming: false,
            ok: toolResult.ok,
            partial: incompleteSaved,
            resultContent: content,
            fileCount: exploreFileCount
          })
          const errNote =
            !toolResult.ok && (toolResult.error || toolResult.content)
              ? ` — ${(toolResult.error || toolResult.content).replace(/\s+/g, ' ').slice(0, 140)}`
              : ''
          messages[idx] = {
            ...messages[idx],
            content: formatActivityLabel(doneActivity) + errNote,
            toolName: name,
            streaming: false,
            activity: doneActivity,
            codePreview:
              name === 'write_file' ||
              name === 'apply_diff' ||
              name === 'apply_patch'
                ? (codePreview ?? messages[idx].codePreview)
                : undefined,
            filePath: filePath ?? messages[idx].filePath,
            editReview: showReview
              ? { path: reviewPath!, status: 'pending' }
              : autoApprove && reviewPath && toolResult.ok
                ? { path: reviewPath, status: 'accepted' }
                : messages[idx].editReview
          }

          if (
            toolResult.ok &&
            (name === 'write_file' ||
              name === 'apply_diff' ||
              name === 'apply_patch' ||
              name === 'delete_file')
          ) {
            const changePath = reviewPath ?? filePath
            const preview = codePreview ?? messages[idx].codePreview
            if (name === 'apply_patch' && typeof args.patch === 'string') {
              const patchPaths = [
                ...args.patch.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/g)
              ].map((m) => m[1]!)
              const paths =
                patchPaths.length > 0
                  ? patchPaths
                  : changePath
                    ? [changePath]
                    : []
              for (let pi = 0; pi < paths.length; pi++) {
                recordTurnFileChange(
                  turnFileChanges,
                  name,
                  paths[pi],
                  pi === 0 ? preview : undefined,
                  args
                )
              }
            } else {
              recordTurnFileChange(turnFileChanges, name, changePath, preview, args)
            }
          }
        }

        apiMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content
        })
        params.onUpdate([...messages])
        // Do not auto-open every edited/created file — agents can touch hundreds of paths.
        // Users open paths from chat file chips / explorer when they want a tab.
      }

      // Hints on tool result — inserting `user` after `tool` breaks Devstral Jinja
      const lastTool = apiMessages[apiMessages.length - 1]
      if (lastTool?.role === 'tool') {
        const tc = lastTool.content ?? ''
        if (/INCOMPLETE_WRITE_LIMIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'INCOMPLETE_WRITE_LIMIT: do not append tiny chunks to that path. Write a larger chunk (≥200 chars) once, or move on to the next unfinished file.'
          )
        } else if (/MISSING_PATH/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'MISSING_PATH: call write_file with relative_path FIRST (e.g. "index.html"), then a short content chunk. Never omit the path.'
          )
        } else if (/TOOL_MARKUP_IN_CONTENT|TOOL_LOOP/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'Do not repeat the failed call. Use structured tools only; write_file content must be pure source code with no tool markup.'
          )
        } else if (/INCOMPLETE_WRITE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'INCOMPLETE_WRITE: next call MUST be write_file with append=true on the SAME path only. Do not start another file.'
          )
        } else if (/FILE_EXISTS/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'FILE_EXISTS: use append=true to continue or apply_patch / apply_diff to edit. Do not overwrite or invent a duplicate filename.'
          )
        } else if (/OVERWRITE_BLOCKED/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'OVERWRITE_BLOCKED: read_file the existing path, then apply_patch (or apply_diff) for a minimal fix. Do not regenerate the whole file.'
          )
        } else if (/PROCESS_ENDED/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'PROCESS_ENDED: the user closed the app or it finished normally. Do NOT rewrite or relaunch. Stop and wait for the user.'
          )
        } else if (/TERMINAL_ERROR|ERROR_FOCUS|Traceback \(most recent call last\)/i.test(tc)) {
          appendToolHint(
            apiMessages,
            thinkThrough
              ? 'TERMINAL_ERROR: In <think>, name the root cause and 1–2 fix options, then pick one. ' +
                  'Fix the exact file/line from ERROR_FOCUS with read_file + apply_patch, then re-run the same command. Do not guess.'
              : 'TERMINAL_ERROR: fix the exact file/line from ERROR_FOCUS with read_file + apply_patch, then re-run the same command. Do not guess.'
          )
        } else if (
          thinkThrough &&
          /✗|ERROR|failed|INCOMPLETE/i.test(tc) &&
          !/✓/.test(tc)
        ) {
          appendToolHint(
            apiMessages,
            'Tool failed: write a short <think> with what went wrong, options, and the next concrete step — then act.'
          )
        }
      }
      apiMessages = normalizeApiMessages(apiMessages)
      if (params.signal?.aborted) return finishStopped()
      if (toolLoopHits >= MAX_TOOL_LOOP_HITS || missingPathHits >= MAX_MISSING_PATH_HITS) {
        messages.push({
          id: uid(),
          role: 'assistant',
          content:
            missingPathHits >= MAX_MISSING_PATH_HITS
              ? '⚠ Stopped: write_file/create_directory without relative_path (nothing was saved). Send a follow-up asking to write index.html / styles.css / app.js with paths first.'
              : '⚠ Stopped: agent repeated the same tool calls (or tiny incomplete writes). Check the files in the explorer, then send a follow-up.'
        })
        return finishWithTiming(messages)
      }
      upsertPlanningNextMoves(messages)
      params.onUpdate([...messages])
      continue
    }

    // Final assistant text must enter apiMessages before any follow-up user nudge
    const finalText = (result.text ?? '').trim()
    if (finalText) {
      const lastApi = apiMessages[apiMessages.length - 1]
      if (lastApi?.role === 'assistant' && !lastApi.tool_calls?.length) {
        lastApi.content = `${lastApi.content ?? ''}\n\n${finalText}`
      } else {
        apiMessages.push({ role: 'assistant', content: finalText })
      }
      apiMessages = normalizeApiMessages(apiMessages)
    }

    const {
      hardMissing,
      acceptanceDone,
      looksPrematureDone
    } = evaluateAcceptanceGate({
      finalText,
      userWantsNodeTest,
      userWantsWebSearch,
      userWantsCli,
      lastNodeTestOk,
      usedWebSearch,
      ranCliSmoke,
      incompleteCount: checklist.incomplete.length,
      failedCount: checklist.failed.length,
      completedTools
    })

    if (
      earlyDoneNudges < 3 &&
      round < maxRounds - 1 &&
      looksPrematureDone
    ) {
      earlyDoneNudges++
      const tree = await fetchProjectTreeDigest()
      const reqBlock =
        hardMissing.length > 0
          ? `\nMissing before you may finish:\n- ${hardMissing.join('\n- ')}\n`
          : ''
      const fixFirst = hardMissing.some((m) =>
        /test FAILED|until green/i.test(m)
      )
      pushUserMessage(
        apiMessages,
        'Do not stop yet.' +
          reqBlock +
          (fixFirst
            ? 'Do NOT repeat a success summary. Fix the failing command first.\n'
            : 'Verify the project tree against the required structure. Create any MISSING files only (no rewrites).\n') +
          tree
      )
      apiMessages = normalizeApiMessages(apiMessages)
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          hardMissing.length > 0
            ? '↻ Acceptance incomplete — finish required checks…'
            : '↻ Checking for missing files before finishing…'
      })
      params.onUpdate([...messages])
      continue
    }

    params.onUpdate([...messages])
    return finishWithTiming(messages)
  }

  // Soft end: resume hint so "continue" / «продолжи» works
  messages.push({
    id: uid(),
    role: 'assistant',
    content: tAgent('chat.agent.pausedRounds', {
      rounds: maxRounds,
      tools: completedTools
    })
  })
  return finishWithTiming(messages)
}
