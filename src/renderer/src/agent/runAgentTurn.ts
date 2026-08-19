import { AGENT_TOOL_SCHEMAS, type AgentToolName, type AgentToolResult } from '../../../shared/types'
import { allowsFullOverwrite } from '../../../shared/writeThresholds'
import type { ProjectStack } from '../../../shared/projectStack'
import {
  AGENT_RULES_V2,
  SYSTEM_CORE_V2,
  SYSTEM_CONFIRM_CORE_V2,
  buildStackSystemSection,
  formatSurgicalFollowUpHint,
  isHtmlOnlyStacks
} from './loop/prompts'
import { honestClosingNote, isNextActionNarration, resolveTurnCloser } from './loop/report'
import { type StepEvidence } from './loop/evidence'
import { advanceTodosOnEvidence } from './loop/plan'
import {
  inferredVerifyMode,
  formatVerifyNudge,
  verifyAlreadyRan,
  shouldNudgeVerify
} from './loop/verify'
import { THREAD_SUMMARY_MSG_ID, isAgentClosingMessageId, relocateAgentCloser, withoutCloserToolChrome, type PersistedChatMessage } from '../../../shared/chats'
import { visionReusesChatModel } from '../../../shared/visionDetect'
import {
  DEFAULT_UI_LANGUAGE,
  isUiLanguage,
  type UiLanguage
} from '../../../shared/i18n'
import type { QueueManager } from '../llm/queueManager'
import { translate } from '../i18n/messages'
import {
  AGENT_CHECKLIST_MSG_ID,
  AGENT_TODO_MSG_ID,
  isAgentTodoMessageId,
  applyToolToChecklist,
  advanceTodosOnTool,
  buildChecklistFromHistory,
  emptyChecklist,
  formatChecklist,
  formatTodoUiContent,
  todoCardFailed,
  hasThinkBlock,
  normalizeApiMessages,
  parseComposerMentions,
  parsePlanBlock,
  parseThinkBlocks,
  promoteThinkOnlyAnswer,
  formatNowForAgent,
  stripChecklistBlock,
  stripCompactBlocks,
  stripPlanBlock,
  stripThinkBlocks,
  stripThinkTags,
  sanitizeThinkProse,
  extractThinkInner,
  formatLiveThinkContent,
  liveThinkProse,
  displayThinkProse,
  isEllipsisOnly,
  findPlanLeakIndex,
  findCodeLeakIndex,
  stripCodeLeakFromThink,
  coerceProductPlan,
  thinkBodyLooksLikeCodeDump,
  thinkLooksLikeChecklist,
  packReadFileForAgent,
  readFileCharBudget,
  readFileRangeCacheKey,
  resolveExhaustedReadBudget,
  contentLooksStructurallyComplete,
  cssLooksLikeRealStylesheet,
  wrapThinkForUi,
  todosAllDone,
  pendingPlanWork,
  isFileWorkPlanStep,
  shouldNudgeRemainingFileWork,
  reopenTodosForMissingViteReact,
  looksLikeOpenHtmlCommand,
  isLandingJsPath,
  looksLikeLandingBuildTask,
  looksLikeEmptyOrStubWriteContent,
  formatEmptyWriteError,
  formatWriteRedirectChip,
  evaluateAcceptanceGate,
  userAskedForCliSmoke,
  looksLikeFromScratchRunTask,
  isCliVerifyCommand,
  cliVerifyLooksSuccessful,
  fingerprintToolCall,
  looksLikeToolMarkupLeak,
  salvageLeakedToolCalls,
  stripLeakedToolMarkup,
  coerceToolRelativePath,
  resolveWriteFilePath,
  inferWritePathFromContent,
  extractAssistantHtmlDump,
  looksLikeAssistantHtmlDump,
  isBrowserPlanStep,
  settlePlanAfterWork,
  isJunkPlanStep,
  isFalseSuccessProse,
  preferUserFacingCloser,
  looksTruncatedCloser,
  isRedundantPlanCompleteProse,
  isAgentChatNoise,
  detectProseStutter,
  dedupeStutteringProse,
  looksLikeChatQa,
  looksLikeImageQa,
  looksLikeFileEditRequest,
  looksLikeSurgicalFollowUp,
  looksLikeI18nFollowUp,
  looksLikeThemeToggleRequest,
  looksLikeExplicitRewrite,
  allowsComposerFullRewrite,
  looksLikeFinishMissingLandingFiles,
  shouldHandoffWriteToApply,
  shouldBlockSurgicalOverwrite,
  shouldBlockSurgicalCssRewrite,
  isComposerApplyPath,
  priorCompleteForWritePath,
  shouldPersistIncompleteWrite,
  buildApplyHandoffArgs,
  isSourcePath,
  filterPlanToCurrentRequest,
  parseGlobalRenameIntent,
  apiContentText,
  mergeChecklistIntoSystem,
  type AgentChecklist,
  type AgentTodoStep,
  type ApiMessage
} from './agentPure'
import { runExploreSubagent } from './runExploreSubagent'
import {
  buildActivityFromTool,
  formatActivityLabel,
  type ComposerActivity
} from './composerActivity'
import { diffStatFromCodePreview } from '../../../shared/diffStat'
import { isAfkllmInternalHtmlPath } from '../../../shared/localPreview'
import { stubWriteFileArgs } from './loop/compactWrites'
import { formatI18nCloserWhy, inventedI18nVerifierPath } from './loop/i18nSanity'
import { formatEditSanityHint, isEditSanityFailure } from './loop/editSanity'
import {
  formatScratchWriteFileHint,
  formatWriteFileRequiredError,
  formatLandingJsBeforeHtmlHint,
  isCappedLandingWritePath,
  isLandingPageScriptPath,
  isViteConfigPath,
  landingBundleReady,
  looksLikeViteReactTask,
  looksLikeViteReactFromScratch,
  userAskedViteReactPreview,
  looksLikeDevOrPreviewCommand,
  shellResultOpenedPreview,
  markPreviewFromShell,
  collectPathsFromTreeText,
  viteReactScaffoldMissing,
  formatViteReactScaffoldHint,
  formatViteReactPreviewHint,
  shouldRequireWriteFileForApply
} from './loop/landingWriteCap'
import {
  AGENT_MAX_TOKENS,
  maxTokensForAgent,
  shouldCompactForOverflow as ctxShouldCompact
} from './loop/ctxBudget'

const RECENT_TURNS_WITH_SUMMARY = 12

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function loopPathKey(p: string): string {
  return normPath(p).toLowerCase()
}

/**
 * Push a transient "↻ …" status bubble, skipping it when the last message is an
 * identical status line. Prevents duplicates like two "Доделываю план по порядку".
 */
function pushStatusBubble(messages: ChatMessage[], content: string): void {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && !last.toolName && last.content === content) {
    return
  }
  messages.push({ id: uid(), role: 'assistant', content })
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
  AGENT_TODO_MSG_ID,
  isAgentTodoMessageId,
  applyToolToChecklist,
  advanceTodosOnTool,
  buildChecklistFromHistory,
  formatChecklist,
  formatTodoUiContent,
  todoCardFailed,
  hasThinkBlock,
  normalizeApiMessages,
  parseComposerMentions,
  parsePlanBlock,
  parseThinkBlocks,
  promoteThinkOnlyAnswer,
  stripPlanBlock
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
  images?: Array<{ id: string; path: string; mime: string; name?: string }>
  /** File pills on the user bubble (any attached file). */
  files?: ChatFileRef[]
  stats?: ChatMessageStats
  editReview?: { path: string; status: 'pending' | 'accepted' | 'rejected' }
  activity?: ComposerActivity
  /** Disk +/- for this tool row (preferred over counting codePreview). */
  diffStat?: { added: number; removed: number }
}

export interface ChatFileRef {
  id: string
  path: string
  name: string
  mime: string
  extLabel: string
  kind: 'image' | 'pdf' | 'docx' | 'text' | 'binary'
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

export interface ImageAttachment {
  id: string
  path: string
  mime: string
  name?: string
  /** Optional preview data URL for composer thumbnails */
  previewUrl?: string
}

/** Composer-attached PDF/DOCX (text extract + optional vision page images). */
export interface DocumentAttachment {
  id: string
  path: string
  name: string
  kind: 'pdf' | 'docx'
  text: string
  pageImages?: ImageAttachment[]
  note?: string
}

/** Unified composer drop target (any file). */
export interface ComposerFileAttachment extends ChatFileRef {
  previewUrl?: string
  text?: string
  pageImages?: ImageAttachment[]
  note?: string
}

/** Describe attached images via vision. Keep-loaded uses port+2; else cold-swap. */
async function describeImagesWithVision(params: {
  queue: QueueManager
  userText: string
  images: Array<{ id: string; path: string; mime: string; name?: string }>
  signal?: AbortSignal
  keepLoaded: boolean
  directAnswer?: boolean
}): Promise<string> {
  await window.api.slots.ensure('vision')
  if (params.signal?.aborted) {
    if (!params.keepLoaded) {
      await window.api.slots.ensure('chat').catch(() => undefined)
    }
    throw new Error('aborted')
  }

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text:
        (params.directAnswer
          ? 'Answer the user about this image in their language. 2–8 sentences. No tools, no <plan>, no todos, no “task complete”, no P.S., no offer to build a page. Then stop.\n\nUser request:\n'
          : 'Describe the attached image(s) / document page scan(s) in detail for a coding agent. Focus on UI layout, text, tables, diagrams, errors, and anything relevant to this user request. Be concrete and concise (max ~400 words).\n\nUser request:\n') +
        params.userText.slice(0, 2000)
    }
  ]

  for (const img of params.images.slice(0, 4)) {
    try {
      const url = await window.api.chatImages.readDataUrl(img.path)
      parts.push({ type: 'image_url', image_url: { url } })
    } catch {
      /* skip unreadable */
    }
  }

  const status = await window.api.llm.status()
  const visionUrl =
    params.keepLoaded && status.visionBaseUrl?.trim()
      ? status.visionBaseUrl.trim()
      : undefined
  if (params.keepLoaded && !visionUrl) {
    throw new Error(
      status.visionError?.trim() ||
        'Vision model is not loaded. Press Load in Settings → Model (Keep vision loaded).'
    )
  }

  try {
    const res = await params.queue.chatStream({
      messages: [
        {
          role: 'system',
          content:
            'You are a vision assistant. Describe images accurately for a software engineer. No tools. Plain text only.'
        },
        { role: 'user', content: parts }
      ],
      maxTokens: 768,
      priority: 'NORMAL',
      signal: params.signal,
      ...(visionUrl ? { baseUrl: visionUrl } : {})
    })
    return (res.text ?? '').trim()
  } finally {
    if (!params.keepLoaded) {
      await window.api.slots.ensure('chat')
    }
  }
}

const AGENT_RULES = AGENT_RULES_V2

const IMAGE_GEN_RULES_ON = `
- Image generation (Image mode ON):
  1) To CREATE an image: call generate_image ONCE with a clear prompt (+ optional relative_path). Use Settings size (often 1024²); do not invent huge resolutions.
  2) Text in images (critical): FLUX cannot render readable words — it produces gibberish glyphs.
     For UI/dashboard/hero art: explicitly say "no text, no letters, no logos, no watermarks, blank panels" in the prompt.
     Only ask for readable text if the user explicitly wants lettering; even then results are unreliable.
     Optional negative_prompt may add extras; Settings already bans common text artifacts.
  3) After generate_image succeeds: do NOT read_file the PNG, do NOT write_file/edit it, do NOT describe pixels from disk. Note the saved path briefly.
     If the user ALSO asked for code, HTML/CSS, other files, or further steps — CONTINUE those tools. Do not end the whole turn only because an image was saved.
     Stop after the image ONLY when image creation was the sole request.
  4) If generate_image FAILS, times out, or returns a blank/white image: do NOT call generate_image again this turn. Continue the rest of the task (HTML: CSS gradient/placeholder; other stacks: skip the image) and say the image step failed.
  5) NEVER generate_image or write_file for favicon.ico / favicon.png — skip favicon or use a tiny inline SVG in HTML.
  6) Keep image prompts focused — do not dump file contents or long plans into the prompt unless the user asked.
  7) Wiring an image into HTML/CSS: if the file already contains that src/path (or a duplicate <img>), do NOT patch again — one write_file overwrite=true to leave a single correct <img>, then STOP. Never stack multiple identical <img> tags. Max one verify read_file after the edit.
`

const IMAGE_GEN_RULES_OFF = `
- Image generation is OFF. Do not call generate_image or create images until the user enables Image mode in the composer.
`

/** Exported for Context Usage estimates (without embedding in SYSTEM twice). */
export { AGENT_RULES, IMAGE_GEN_RULES_ON, IMAGE_GEN_RULES_OFF }

const SYSTEM_CORE = SYSTEM_CORE_V2

const SYSTEM_CONFIRM_CORE = SYSTEM_CONFIRM_CORE_V2

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
Think-through protocol (mandatory — always on):
The app first runs ONE THINK-ONLY completion, then PLAN_ONLY, then tools.
1) <think> — ONE DeepThink (6–12 sentences) about THIS prompt: goal, constraints, approach, file order, risks, how you verify.
   FORBIDDEN in think: <plan>, todos, HTML/CSS/JS, write_file, claiming "Сделано"/"done" before tools succeed.
2) PLAN_ONLY: <plan> with 3–6 atomic product steps. FORBIDDEN plan rows: "if patch fails rewrite whole file", tool names, CSS class dumps.
This runs again for EVERY user message. Earlier reasoning in the conversation belongs to previous messages — it never exempts you from thinking about the current one.
Within one message, after the prelude: NEVER open another <think> or <plan>. Call tools immediately.
Execute-round notes (if any) and the closer MUST match the user's language. Russian user → Russian notes, not "CSS written successfully".
Do NOT Start-Process / browser / done-summary until non-browser plan steps are done.
`

export {
  SYSTEM_CORE,
  SYSTEM_CONFIRM_CORE,
  SYSTEM_PLAN,
  THINK_THROUGH
}

/** Open/show preview intent when index.html is already built — skip plan ceremony. */
export function looksLikeOpenLandingOnly(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 80) return false
  // Real edit/rename work is never "just open".
  if (parseGlobalRenameIntent(t)) return false
  if (
    /помен|переимен|назван|бренд|northline|afkllm|цвет|theme|тем[аы]|faq|исправ|добав|убер|перепис|rewrite|accent|фиолет|ширин|overflow|стил|css|текст|измени/i.test(
      t
    )
  ) {
    return false
  }
  // Do NOT use \b after Cyrillic — JS treats it as non-word, so «открой лендинг» never matched.
  return (
    /^(открой|open|покажи|show)([\s\u00a0]|$)/i.test(t) &&
    /лендинг|landing|index\.html|превью|preview|браузер|browser/i.test(t)
  )
}

/**
 * Skip forced think→plan ONLY for ultra-short confirms
 * («ок», «продолжи»). Feature requests (theme toggle, etc.) always get think.
 * Never use keywords like «исправ/белый» — only message shape.
 */
export function shouldSkipThinkPlanCeremony(
  userText: string,
  history: ChatMessage[]
): boolean {
  const t = userText.trim()
  if (!t) return false
  // Micro confirms / continue only — anything longer needs think.
  // Note: JS \b is ASCII-only; do not use it for Cyrillic tokens.
  if (t.length > 48) return false
  if (
    !/^(ок|ok|да|yes|ладно|продолжи|continue|ещё|еще|дальше|go)([!.…]*|\s.*)?$/i.test(
      t
    )
  ) {
    return false
  }
  if (looksLikeLandingBuildTask(t)) return false
  if (looksLikeExplicitRewrite(t)) return false
  let hasPriorWork = false
  for (const m of history) {
    if (isAgentTodoMessageId(m.id)) hasPriorWork = true
    if (
      m.toolName === 'write_file' ||
      m.toolName === 'apply_diff' ||
      m.toolName === 'apply_patch'
    ) {
      hasPriorWork = true
    }
  }
  return hasPriorWork
}

const DEFAULT_MAX_ROUNDS = 64
const TOOL_RESULT_CHARS = 6_000
/** Cyrillic/code runs denser than English. */
const CHARS_PER_TOKEN = 3.2
/** Cap forced append loops on the same path when stream was truncated. */
const MAX_INCOMPLETE_APPENDS_PER_PATH = 4
/** Source files: after this many incomplete writes, demand one full overwrite. */
const MAX_INCOMPLETE_SOURCE_APPENDS = 2
/** Identical tool+args repeats before TOOL_LOOP nudge (turn continues). */
const MAX_IDENTICAL_TOOL_CALLS = 2
/** Repeated read_file of the SAME range — allow a few, with a turn-wide budget. */
const MAX_READS_PER_PATH = 6
const MAX_READS_TURN_BUDGET = 8
/** Soft recovery threshold — after this, stop looping. */
const MAX_TOOL_LOOP_HITS = 2
/** Successful apply_patch/apply_diff on one path before forcing finish. */
const MAX_PATCH_OK_PER_PATH = 4
const MAX_MARKUP_REPAIR_ATTEMPTS = 2
/** Absolute safety cap for a single tool-arguments JSON blob. */
const MAX_TOOL_ARG_CHARS = 96_000
const MAX_MISSING_PATH_HITS = 3
/** Stop overflow compact/retry loops that inflate context. */
const MAX_OVERFLOW_REPAIRS = 2
/** Transient llama disconnects (fetch failed) before giving up the turn. */
const MAX_FETCH_REPAIRS = 3
/** Small-file overwrite is allowed even on correction turns. */
function allowsLandingOverwrite(relativePath: string, contentChars: number): boolean {
  return allowsFullOverwrite(relativePath, contentChars)
}
/** Failed apply_patch/apply_diff on one path before suggesting overwrite. */
const MAX_PATCH_FAILS_BEFORE_OVERWRITE = 4
/** Hard cap for system prompt after compact. */
const COMPACT_SYSTEM_MAX_CHARS = 6_000
const COMPACT_TAIL_MAX_MSGS = 6
const COMPACT_TOOL_RESULT_MAX = 600
/** Newest read_file results survive compact at this size (not 480 chars). */
const COMPACT_READ_RESULT_MAX = 4_000

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
/** Ceiling only — real size is ctx-aware via attachCharBudget(). */
const DOC_ATTACH_MAX = 24_000
const SELECTION_ATTACH_MAX = 4_000
/** Cyrillic/technical text denser than Latin; be conservative for attach packing. */
const ATTACH_CHARS_PER_TOKEN = 2.4

function attachCharBudget(ctxSize: number, attachmentCount: number): number {
  const ctx = ctxSize > 0 ? ctxSize : 8192
  // system + tools schema + completion reserve leave a thin user-payload slice on 8k
  const tokenBudget = Math.max(700, Math.floor(ctx * 0.45))
  const total = Math.floor(tokenBudget * ATTACH_CHARS_PER_TOKEN)
  const per = Math.floor(total / Math.max(1, attachmentCount))
  return Math.min(DOC_ATTACH_MAX, Math.max(1_200, per))
}

/**
 * Fit a document extract into maxChars without keeping only the TOC head.
 * Skips dotted leaders / short numbered outline lines, then packs head+mid+tail.
 */
function packDocumentExtract(raw: string, maxChars: number): string {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.length <= maxChars) return text

  const lines = text.split('\n')
  const kept: string[] = []
  let skippedToc = 0
  for (const line of lines) {
    const t = line.trim()
    const looksToc =
      (/\.{2,}\s*\d+\s*$/.test(t) && t.length < 120) ||
      (/^(\d+[\d.]*)\s+\S/.test(t) && t.length < 70 && !/[.!?…]$/.test(t)) ||
      (/^(Глава|Раздел|Section|Chapter)\s+[\d.]+/i.test(t) && t.length < 60)
    if (looksToc && kept.length > 12) {
      skippedToc++
      if (skippedToc < 80) continue
    } else {
      skippedToc = 0
    }
    kept.push(line)
  }
  let body = kept.join('\n').trim()
  if (body.length < Math.min(800, text.length * 0.2)) body = text
  if (body.length <= maxChars) {
    return skippedToc > 0 ? `${body}\n\n…(оглавление сжато)` : body
  }

  const head = Math.floor(maxChars * 0.34)
  const mid = Math.floor(maxChars * 0.38)
  const tail = Math.max(400, maxChars - head - mid - 24)
  const midStart = Math.max(head, Math.floor((body.length - mid) / 2))
  return (
    body.slice(0, head).trimEnd() +
    '\n\n…\n\n' +
    body.slice(midStart, midStart + mid).trim() +
    '\n\n…\n\n' +
    body.slice(-tail).trimStart()
  )
}

function truncateAttach(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…'
}

async function llmCompressDocument(
  queue: QueueManager,
  name: string,
  text: string
): Promise<string> {
  const sample = packDocumentExtract(text, 9_000)
  try {
    const res = await queue.compact({
      messages: [
        {
          role: 'system',
          content:
            'Compress this document for Q&A continuity. Keep: product/system name, purpose, scope, key procedures, safety/limits, important numbers. Drop table-of-contents lists and repeated headings. Same language as the document. Max 320 words. Plain text only.'
        },
        {
          role: 'user',
          content: `Document: ${name}\n\n${sample}`
        }
      ],
      maxTokens: 560
    })
    const out = (res.text ?? '').trim()
    if (out.length > 80) return out
  } catch {
    /* fall through */
  }
  return packDocumentExtract(text, 3_500)
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
    const id = messages[i]?.id
    if (id === AGENT_CHECKLIST_MSG_ID) messages.splice(i, 1)
  }
}

/** Keep prior-turn plan cards in history: rename live id so the next upsert cannot delete them. */
function archiveLiveTodoBubble(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (m.id === AGENT_TODO_MSG_ID) {
      m.id = `${AGENT_TODO_MSG_ID}-${Date.now()}`
    }
    if (m.id === AGENT_PLAN_MSG_ID) {
      m.id = `${AGENT_PLAN_MSG_ID}-${Date.now()}`
    }
  }
}

function closingMessageId(userMessageId: string): string {
  return `agent-closing-${userMessageId}`
}

function looksLikeClosingSummary(text: string): boolean {
  const t = text.trim()
  if (t.length < 48 || /^↻ /.test(t) || /^⏹ /.test(t)) return false
  if (isNextActionNarration(t)) return false
  if (hasThinkBlock(t) && !stripThinkBlocksLive(t).trim()) return false
  return (
    /что\s+изменил|как\s+проверить|what\s+changed|how\s+to\s+(verify|check)|file paths?|путь|paths?:/i.test(
      t
    ) ||
    /превью\s+открыт|preview\s+opened|открыт[оа]\s+в\s+(браузер|приложении|AFKLLM)/i.test(t) ||
    (/localhost:\d+|dev server|файл[аы]?\s+создан|created \d+ files|port \d{4}/i.test(t) &&
      !/now I need to|let me |запускаю/i.test(t)) ||
    (/^\s*[-*•\d]/m.test(t) &&
      /создан|измен|обнов|added|updated|edited|fixed|написан|готово|done\b/i.test(t))
  )
}

/** Status ↻ chatter may go; think + user-facing prose must stay in the transcript. */
function isKeepableChatBubble(m: ChatMessage | undefined): boolean {
  if (!m) return false
  if (isClosingMessageId(m.id)) return true
  const c = (m.content ?? '').trim()
  if (!c) return false
  if (/<\s*(?:think|thinking)\s*>/i.test(c)) return true
  if (/^↻ /.test(c)) return false
  return true
}

/** Persist the turn closing summary so later turns cannot splice/overwrite it away. */
function isClosingMessageId(id: string | undefined): boolean {
  return isAgentClosingMessageId(id)
}

function persistableChatMessage(m: ChatMessage): PersistedChatMessage {
  return withoutCloserToolChrome({
    id: m.id,
    role: m.role,
    content: m.content ?? '',
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(m.filePath ? { filePath: m.filePath } : {}),
    ...(m.codePreview ? { codePreview: m.codePreview } : {}),
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.files?.length ? { files: m.files } : {}),
    ...(m.stats ? { stats: m.stats } : {}),
    ...(m.activity ? { activity: m.activity } : {})
  })
}

function transcriptOpenedPreview(msgs: ChatMessage[]): boolean {
  for (const m of msgs) {
    if (m.toolName !== 'execute_terminal_command' && m.toolName !== 'verify_project') {
      continue
    }
    if (
      markPreviewFromShell({
        command: m.activity?.command ?? '',
        content: `${m.codePreview ?? ''}\n${m.content ?? ''}`,
        ok: m.activity?.status !== 'error'
      })
    ) {
      return true
    }
  }
  return false
}

function ensureClosingMessage(
  messages: ChatMessage[],
  userMessageId: string,
  text: string
): void {
  const content = stripThinkBlocks(text).trim()
  if (!content || /^↻ /.test(content) || /^⏹ /.test(content)) return
  const hostCloser = /превью\s+открыто в приложении|preview is open in the app/i.test(content)
  if (!hostCloser && isAgentChatNoise(content) && content.length < 80) return
  const id = closingMessageId(userMessageId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || m.toolName) continue
    if (m.id === id) continue
    if (/^↻\s*(Пишу заключение|Writing closing)/i.test(m.content ?? '')) {
      messages.splice(i, 1)
      continue
    }
    if ((m.content ?? '').trim() === content) {
      messages.splice(i, 1)
    }
  }
  const bubble: ChatMessage = { id, role: 'assistant', content, streaming: false }
  const existing = messages.findIndex((m) => m.id === id)
  if (existing >= 0) messages.splice(existing, 1)
  const filesIdx = messages.findIndex((m) => m.toolName === FILES_CHANGED_TOOL)
  if (filesIdx >= 0) messages.splice(filesIdx, 0, bubble)
  else messages.push(bubble)
}

/** Live plan card (model-authored <plan>). Place AFTER think, not before. */
function upsertTodoBubble(
  messages: ChatMessage[],
  steps: AgentTodoStep[],
  opts?: { afterId?: string; failed?: boolean }
): void {
  if (steps.length === 0) return
  const msg: ChatMessage = {
    id: AGENT_TODO_MSG_ID,
    role: 'assistant',
    content: formatTodoUiContent(steps, { failed: opts?.failed })
  }
  const existing = messages.findIndex((m) => m.id === AGENT_TODO_MSG_ID)
  if (existing >= 0) messages.splice(existing, 1)

  let insertAt = messages.length
  if (opts?.afterId) {
    const a = messages.findIndex((m) => m.id === opts.afterId)
    if (a >= 0) insertAt = a + 1
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.role !== 'assistant' || m.toolName) continue
      if (
        m.id === AGENT_CHECKLIST_MSG_ID ||
        m.id === AGENT_PLAN_MSG_ID ||
        isAgentTodoMessageId(m.id)
      ) {
        continue
      }
      insertAt = i + 1
      break
    }
  }
  messages.splice(insertAt, 0, msg)
}

function logAgentToolEvent(message: string, extra?: Record<string, string | number | boolean | null>): void {
  try {
    console.info('[agent:tool]', message, extra ?? '')
    void window.api.telemetry.report({
      kind: 'info',
      message,
      source: 'agent:tool',
      ...(extra ? { extra } : {})
    })
  } catch {
    /* ignore */
  }
}

function recordTurnFileChange(
  map: Map<string, TurnFileChange>,
  name: string,
  pathRaw: string | undefined,
  codePreview: string | undefined,
  args?: Record<string, unknown>,
  diskStat?: { added: number; removed: number } | null
): void {
  if (!pathRaw?.trim()) return
  const path = pathRaw.replace(/\\/g, '/')
  let added = 0
  let removed = 0
  let deleted = name === 'delete_file'
  if (name === 'delete_file') {
    deleted = true
    if (diskStat && (diskStat.added > 0 || diskStat.removed > 0)) {
      added = diskStat.added
      removed = diskStat.removed
    }
  } else if (diskStat && (diskStat.added > 0 || diskStat.removed > 0)) {
    added = diskStat.added
    removed = diskStat.removed
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
  apiMessages[0] = {
    ...apiMessages[0],
    content: mergeChecklistIntoSystem(apiContentText(apiMessages[0].content), block)
  }
}

function uid(): string {
  return crypto.randomUUID()
}

/** Start-Process / ii / Invoke-Item of a local HTML file — one preview per turn. */
function isHtmlPreviewShell(cmd: string): boolean {
  const c = String(cmd ?? '')
  if (!c.trim()) return false
  if (looksLikeOpenHtmlCommand(c)) return true
  if (/start\s+https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(c)) return true
  return (
    /\.html?\b/i.test(c) &&
    /Start-Process|Invoke-Item|\bii\b|explorer\.exe/i.test(c)
  )
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
    n += apiContentText(m.content).length + 32
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
  return ctxShouldCompact(estimateTokens(msgs), ctxSize)
}

/** Stub write_file bodies in history only when ctx is actually 99% full. */
function maybeSlimWritesForCtx(msgs: ApiMessage[], ctxSize: number): void {
  if (!ctxShouldCompact(estimateTokens(msgs), ctxSize)) return
  slimCompletedWriteToolCalls(msgs)
}

/** Drop bulky write/patch payloads from history so we don't compact after every file. */
function countLinesFromWriteArgs(argsJson: string): number | null {
  const content = extractJsonStringField(argsJson, 'content')
  if (!content) return null
  return content.split(/\r?\n/).length
}

function writeOnDiskStubArgs(path: string | null, lines: number | null, latest: boolean, omittedChars = 0): string {
  return stubWriteFileArgs({
    relativePath: path,
    lineCount: lines,
    latest,
    omittedChars
  })
}

/** Keep path + wrote OK; drop full content. Do not put FILE_COMPLETE into args-shaped stubs. */
function slimWriteSuccessResult(content: string): string | null {
  const c = content.trim()
  if (!/^(Wrote |Appended )/i.test(c)) return null
  const path =
    c.match(/bytes to\s+(\S+?)(?:\s|\(|$)/i)?.[1] ||
    c.match(/"([A-Za-z0-9_./\\-]+\.[a-zA-Z0-9]+)"/)?.[1] ||
    null
  const lines = c.match(/lines=(\d+)/i)?.[1]
  const flags = content
    .split('\n')
    .filter((l) =>
      /I18N_SANITY|EDIT_SANITY|LANDING_CONTRACT|WRITE_ONCE|WRITE_FILE_REQUIRED|INCOMPLETE_WRITE|EMPTY_WRITE|AGENT_HINT/i.test(
        l
      )
    )
    .join('\n')
  const stub =
    `${(path || 'file').replace(/\\/g, '/')}: wrote OK` +
    (lines ? ` (${lines} lines)` : '') +
    '. Body omitted from history.'
  return flags ? `${stub}\n${flags}` : stub
}

function collectOnDiskWritePaths(msgs: ApiMessage[]): string[] {
  const written = new Set<string>()
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const t of m.tool_calls) {
        if (
          t.function.name !== 'write_file' &&
          t.function.name !== 'apply_patch' &&
          t.function.name !== 'apply_diff'
        ) {
          continue
        }
        const p = extractJsonStringField(t.function.arguments || '', 'relative_path')
        if (p) written.add(p.replace(/\\/g, '/'))
      }
    }
    if (m.role === 'tool') {
      const c = apiContentText(m.content)
      if (!/Wrote |Appended |FILE_COMPLETE/i.test(c)) continue
      const pathMatch = c.match(
        /(?:to|on)\s+"?([A-Za-z0-9_./\\-]+\.[a-zA-Z0-9]+)"?/
      )
      if (pathMatch?.[1]) written.add(pathMatch[1].replace(/\\/g, '/'))
    }
  }
  return [...written]
}

function slimCompletedWriteToolCalls(msgs: ApiMessage[]): void {
  const lastByPath = new Map<string, { msgI: number; callI: number }>()
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m?.role !== 'assistant' || !m.tool_calls?.length) continue
    m.tool_calls.forEach((t, callI) => {
      const name = t.function.name
      if (
        name !== 'write_file' &&
        name !== 'apply_patch' &&
        name !== 'apply_diff' &&
        name !== 'generate_image'
      ) {
        return
      }
      const path = extractJsonStringField(t.function.arguments || '', 'relative_path')
      if (!path) return
      lastByPath.set(path.replace(/\\/g, '/').toLowerCase(), { msgI: i, callI })
    })
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m?.role !== 'assistant' || !m.tool_calls?.length) continue
    let changed = false
    const nextCalls = m.tool_calls.map((t, callI) => {
      const name = t.function.name
      if (
        name !== 'write_file' &&
        name !== 'apply_patch' &&
        name !== 'apply_diff' &&
        name !== 'generate_image'
      ) {
        return t
      }
      const argsJson = t.function.arguments || ''
      const path = extractJsonStringField(argsJson, 'relative_path')
      const key = path ? path.replace(/\\/g, '/').toLowerCase() : ''
      const last = key ? lastByPath.get(key) : undefined
      const latest = Boolean(last && last.msgI === i && last.callI === callI)
      if (argsJson.length < 500 && !latest) return t
      changed = true
      return {
        ...t,
        function: {
          ...t.function,
          arguments: writeOnDiskStubArgs(
            path,
            countLinesFromWriteArgs(argsJson),
            latest,
            argsJson.length
          )
        }
      }
    })
    if (changed) {
      msgs[i] = { ...m, tool_calls: nextCalls }
    }
  }
}

function slimToolArgs(name: string, argsJson: string): string {
  const path = extractJsonStringField(argsJson, 'relative_path')
  const cmd = extractJsonStringField(argsJson, 'command')
  if (path) {
    return stubWriteFileArgs({
      relativePath: path,
      omittedChars: argsJson.length,
      latest: true
    })
  }
  if (cmd) {
    return JSON.stringify({ command: cmd.slice(0, 200) })
  }
  return argsJson.length > 400 ? argsJson.slice(0, 400) + '…' : argsJson
}

function slimMessage(m: ApiMessage, opts?: { keepReadsFull?: boolean }): ApiMessage {
  if (m.role === 'tool') {
    const c = apiContentText(m.content)
    const writeStub = slimWriteSuccessResult(c)
    if (writeStub) return { ...m, content: writeStub }
    if (c.length <= COMPACT_TOOL_RESULT_MAX) return { ...m, content: c }
    // Squeezing a fresh read down to 480 chars made the model forget the file
    // and read it again — the second loop path. Keep the newest reads usable.
    if (opts?.keepReadsFull && /^\[read_file (?:meta|range)\]/i.test(c.trim())) {
      return { ...m, content: c.slice(0, COMPACT_READ_RESULT_MAX) }
    }
    return {
      ...m,
      content:
        c.slice(0, 280) +
        '\n…[truncated]…\n' +
        c.slice(-200)
    }
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return {
      ...m,
      content: apiContentText(m.content).slice(0, 800),
      tool_calls: m.tool_calls.map((t) => ({
        ...t,
        function: {
          ...t.function,
          arguments:
            t.function.arguments.length > 400
              ? slimToolArgs(t.function.name, t.function.arguments)
              : t.function.arguments
        }
      }))
    }
  }
  if (apiContentText(m.content).length > 1_500 && (m.role === 'user' || m.role === 'assistant')) {
    const c = apiContentText(m.content)
    if (m.role === 'user' && (/\[Document:/i.test(c) || /\[File:/i.test(c))) {
      return { ...m, content: packDocumentExtract(c, 3_600) }
    }
    return { ...m, content: c.slice(0, 900) + '\n…\n' + c.slice(-300) }
  }
  return m
}

/** Last-resort shrink: keep full system/rules; drop history, not AGENT_RULES. */
function nuclearFitMessages(msgs: ApiMessage[], ctxSize: number): ApiMessage[] {
  const sys = msgs.find((m) => m.role === 'system')
  const sysText = stripCompactBlocks(
    stripChecklistBlock(apiContentText(sys?.content ?? ''))
  ).trim()
  const onDisk = collectOnDiskWritePaths(msgs)
  const diskNote =
    onDisk.length > 0
      ? `\n\nOn disk FILE_COMPLETE (do not rewrite, do not apply_diff from scratch):\n` +
        onDisk.map((p) => `- ${p}`).join('\n')
      : ''
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  let userText = apiContentText(lastUser?.content ?? '')
  if (/\[Document:/i.test(userText) || /\[File:/i.test(userText)) {
    userText = packDocumentExtract(userText, 2_800)
  } else {
    userText =
      userText.slice(0, 1_500) ||
      'Continue the unfinished task. Prefer short tool calls. Do not read binary/image files as text.'
  }
  if (!userText.trim()) {
    userText =
      'Continue the unfinished task. Prefer short tool calls. Do not read binary/image files as text.'
  }
  userText = (userText + diskNote).trim()
  const out = normalizeApiMessages([
    { role: 'system', content: sysText },
    { role: 'user', content: userText }
  ])
  // Truncate the user turn only — never slice system/rules.
  const budgetChars = Math.max(2000, (ctxSize > 0 ? ctxSize : 8192) * CHARS_PER_TOKEN * 0.5)
  if (estimateChars(out) > budgetChars && out[1]) {
    out[1] = {
      ...out[1],
      content: apiContentText(out[1].content).slice(0, Math.floor(budgetChars * 0.35))
    }
  }
  return out
}

async function compactApiMessages(
  msgs: ApiMessage[],
  checklist?: AgentChecklist,
  queue?: QueueManager,
  ctxSize = 8192
): Promise<{ messages: ApiMessage[]; summary: string }> {
  // The newest reads live in the tail — keep those readable, slim older ones hard.
  const tailStart = Math.max(0, msgs.length - COMPACT_TAIL_MAX_MSGS)
  const slimmedAll = msgs.map((m, i) =>
    slimMessage(m, { keepReadsFull: i >= tailStart })
  )

  if (slimmedAll.length < 4) {
    let messages = normalizeApiMessages(slimmedAll)
    if (shouldCompactForOverflow(messages, ctxSize)) {
      messages = nuclearFitMessages(messages, ctxSize)
    }
    return { messages, summary: '' }
  }

  const head = slimmedAll.slice(0, 1) // system
  const rawTail = slimmedAll.slice(-COMPACT_TAIL_MAX_MSGS)
  const middle = slimmedAll.slice(1, -COMPACT_TAIL_MAX_MSGS)

  const digestLines: string[] = []
  const written = new Set<string>()
  for (const m of middle) {
    if (m.role === 'tool') {
      const brief = apiContentText(m.content).slice(0, 120).replace(/\s+/g, ' ')
      digestLines.push(`- tool: ${brief}`)
      const pathMatch2 = apiContentText(m.content).match(
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
      const brief = apiContentText(m.content).slice(0, 100).replace(/\s+/g, ' ')
      if (brief) digestLines.push(`- ${m.role}: ${brief}`)
    }
  }

  let llmSummary = ''
  if (queue && middle.length > 0 && estimateChars(middle) < 40_000) {
    llmSummary = await llmSummarizeMiddle(queue, middle)
  }

  const tree = await fetchProjectTreeDigest()
  const fromHeuristic =
    written.size > 0
      ? `\nOn disk FILE_COMPLETE (do not recreate; do not apply_diff from scratch):\n` +
        [...written].slice(-40).map((p) => `- ${p}`).join('\n')
      : ''

  let cl = checklist
    ? {
        ...checklist,
        done: [...checklist.done],
        incomplete: [...checklist.incomplete],
        failed: [...checklist.failed],
        shells: [...checklist.shells]
      }
    : emptyChecklist()
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

  const sys = head[0] ?? { role: 'system' as const, content: '' }
  const memoryBody =
    (llmSummary.trim() || digestLines.slice(-30).join('\n') || '(no prior middle turns)').slice(
      0,
      800
    )
  const digestBlock =
    '\n\n[Context compacted due to context-window pressure]\n' +
    memoryBody +
    checklistBlock +
    tree.slice(0, 600) +
    '\n\nCRITICAL: Paths listed above are already on disk (FILE_COMPLETE). ' +
    'Next missing landing file → write_file with the COMPLETE file. ' +
    'Do not apply_diff a new/incomplete module. Do not invent duplicate filenames. ' +
    'Never read .png/.jpg/.webp/.gif as text.'

  // Drop orphan tool rows from tail (must follow an assistant tool_calls)
  let tail = rawTail
  while (tail.length && tail[0]?.role === 'tool') {
    tail = tail.slice(1)
  }

  const sysBase = stripCompactBlocks(stripChecklistBlock(apiContentText(sys.content)))
  // Cap the digest only — never slice AGENT_RULES / system.
  const digestOnly =
    digestBlock.length > COMPACT_SYSTEM_MAX_CHARS
      ? digestBlock.slice(0, COMPACT_SYSTEM_MAX_CHARS) + '\n…[compact digest truncated]'
      : digestBlock
  const sysContent = sysBase + digestOnly

  let compacted: ApiMessage[] = [
    {
      role: 'system',
      content: sysContent
    },
    ...tail
  ]
  let messages = normalizeApiMessages(compacted.map((m) => slimMessage(m)))
  if (shouldCompactForOverflow(messages, ctxSize)) {
    messages = nuclearFitMessages(messages, ctxSize)
  }
  return {
    messages,
    summary: memoryBody
  }
}

/** Never insert a user turn after tools — breaks Devstral Jinja. */
function appendToolHint(msgs: ApiMessage[], hint: string): void {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'tool') {
      msgs[i] = {
        ...msgs[i]!,
        content: `${apiContentText(msgs[i]!.content)}\n\n[AGENT_HINT]: ${hint}`
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
    end.content = `${apiContentText(end.content)}\n\n${content}`
  } else {
    msgs.push({ role: 'user', content })
  }
}

async function llmSummarizeMiddle(
  queue: QueueManager,
  middle: ApiMessage[]
): Promise<string> {
  const lines: string[] = []
  for (const m of middle) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('\n')
          : ''
    if (m.role === 'tool') {
      lines.push(`tool: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const t of m.tool_calls) {
        const p = extractJsonStringField(t.function.arguments || '', 'relative_path')
        lines.push(`called ${t.function.name}${p ? ` ${p}` : ''}`)
      }
      if (text.trim()) {
        lines.push(`assistant: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      }
    } else if (m.role === 'user' || m.role === 'assistant') {
      const brief = text.slice(0, 240).replace(/\s+/g, ' ')
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
    agentImageGenEnabled?: boolean
  },
  checklist?: AgentChecklist,
  selection?: EditorSelectionContext | null,
  attachments?: FileAttachment[],
  mode: AgentTurnMode = 'agent',
  ctxSize = 8192,
  stacks: ProjectStack[] = []
): Promise<ApiMessage[]> {
  let system =
    mode === 'plan'
      ? SYSTEM_PLAN
      : settings?.agentAutoApprove
        ? SYSTEM
        : SYSTEM_CONFIRM
  if (stacks.length >= 0 && mode !== 'plan') {
    system += buildStackSystemSection(stacks)
  }
  if (settings?.systemPrompt?.trim()) {
    system += `\n\n${settings.systemPrompt.trim()}`
  }
  system += `\n\n${formatNowForAgent()}`
  const projectRules = await fetchProjectRules()
  if (projectRules) {
    system += `\n\n${projectRules}`
  }
  if (mode !== 'plan') {
    system += THINK_THROUGH
  }
  if (mode !== 'plan') {
    system += settings?.agentImageGenEnabled ? IMAGE_GEN_RULES_ON : IMAGE_GEN_RULES_OFF
  }
  if (mode !== 'plan' && settings?.agentAutoApprove) {
    system +=
      '\n\nAuto-approve is ON (full agent rights): write_file, apply_patch, apply_diff, create_directory, delete_file, execute_terminal_command, and MCP tools are ALL pre-authorized with NO dialogs and NO Accept/Reject stops. Never ask the user whether to create, edit, delete, or run anything — call the tools immediately and keep going until the task is done. Shell runs in the visible IDE Terminal.'
  }
  if (settings?.reasoningBudgetEnabled) {
    const budget = settings.reasoningBudget ?? 8192
    const msg = settings.reasoningBudgetMessage?.trim() || 'I have to answer now.'
    system += `\n\nReasoning budget (resets every new model completion this turn): up to ${budget} tokens for <think>. Use only what you need — do not pad. When the budget for this completion is exhausted, stop thinking and continue with tools/answer. Closing line if cut off: "${msg}"`
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
      isAgentTodoMessageId(m.id) ||
      m.id === AGENT_CHECKLIST_MSG_ID ||
      m.id === THREAD_SUMMARY_MSG_ID
    ) {
      continue
    }
    if (m.pending || m.streaming) continue
    if (m.toolName) continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (!m.content?.trim()) continue
    if (m.role === 'assistant' && isAgentChatNoise(m.content)) continue
    eligible.push(m)
  }
  const kept = summaryContent
    ? eligible.slice(-RECENT_TURNS_WITH_SUMMARY)
    : eligible

  const turns: ApiMessage[] = []
  for (const m of kept) {
    // Prior <think>/<plan> belong to earlier messages. Left in, the model reads
    // "prelude already happened" and answers the next THINK_ONLY with nothing.
    const content =
      m.role === 'assistant'
        ? stripThinkBlocks(stripPlanBlock(m.content ?? '')).trim() ||
          stripThinkTags(promoteThinkOnlyAnswer(m.content ?? '')).trim()
        : m.content?.trim()
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
    const parts: string[] = [
      '\n[User-attached files — primary source for this turn. Answer the user directly; do not narrate that a file was attached.]'
    ]
    const perDoc = attachCharBudget(ctxSize, attachments.length)
    let budget = perDoc * Math.max(1, attachments.length)
    for (const a of attachments) {
      if (budget <= 0) {
        parts.push(`…(+${attachments.length - parts.length + 1} more truncated)`)
        break
      }
      const isDoc =
        a.path.startsWith('document/') || a.path.startsWith('file/')
      const label = a.path.startsWith('document/')
        ? `Document: ${a.path.slice('document/'.length)}`
        : a.path.startsWith('file/')
          ? `File: ${a.path.slice('file/'.length)}`
          : `File: ${a.path}`
      const cap = isDoc ? Math.min(DOC_ATTACH_MAX, perDoc) : Math.min(FILE_ATTACH_MAX, perDoc)
      const raw = a.content ?? ''
      const body = isDoc
        ? packDocumentExtract(raw, Math.min(cap, budget))
        : truncateAttach(raw, Math.min(cap, budget))
      budget -= body.length
      parts.push(`\n[${label}]\n\`\`\`\n${body}\n\`\`\``)
    }
    attachBlock = parts.join('\n') + '\n'
  }

  const userPayload =
    mentions.cleanText +
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

function sanitizeStreamAssistantText(raw: string): string {
  const stripped = stripPlanBlock(raw)
  if (!stripped.trim()) return ''
  const prose = sanitizeThinkProse(stripped)
  if (thinkBodyLooksLikeCodeDump(stripped)) {
    if (hasThinkBlock(stripped)) {
      const rest = stripThinkBlocksLive(stripped).trim()
      if (prose && rest) return `${wrapThinkForUi(prose)}\n\n${rest}`
      if (prose) return wrapThinkForUi(prose)
      // Fenced closer / file list — keep visible, do not empty the bubble.
      return rest || stripped
    }
    return stripped
  }
  if (hasThinkBlock(stripped)) {
    const rest = stripPlanBlock(
      stripped.replace(/<\s*(?:think|thinking)\s*>[\s\S]*?(?:<\s*\/\s*(?:think|thinking)\s*>|$)/gi, '')
    ).trim()
    if (prose && rest) return `${wrapThinkForUi(prose)}\n\n${rest}`
    if (prose) return wrapThinkForUi(prose)
    return rest || stripped
  }
  return promoteThinkOnlyAnswer(stripped)
}

/** Remove finished + in-progress <think> so a second «Думал» fold never appears. */
function stripThinkBlocksLive(text: string): string {
  let s = text ?? ''
  s = s.replace(
    /<\s*(?:think|thinking)\s*>[\s\S]*?(?:<\s*\/\s*(?:think|thinking)\s*>)/gi,
    ''
  )
  const open = s.search(/<\s*(?:think|thinking)\s*>/i)
  if (open >= 0) s = s.slice(0, open)
  return s.replace(/\n{3,}/g, '\n\n').trimStart()
}

function attachStatsToLastVisible(
  messages: ChatMessage[],
  stats: ChatMessageStats
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.id === 'welcome') continue
    if (isAgentTodoMessageId(m.id) || m.id === AGENT_CHECKLIST_MSG_ID) continue
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
  images?: ImageAttachment[]
  documents?: DocumentAttachment[]
  /** File pills on the user bubble */
  files?: ChatFileRef[]
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
  /** 2 = honest language-agnostic loop (default via settings.agentLoopV2). */
  loopVersion?: 1 | 2
}): Promise<ChatMessage[]> {
  const isPlan = params.mode === 'plan'
  const maxRounds = isPlan ? 1 : (params.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const uiLang: UiLanguage = isUiLanguage(params.uiLanguage)
    ? params.uiLanguage
    : DEFAULT_UI_LANGUAGE
  const tAgent = (key: 'chat.agent.pausedRounds' | 'chat.agent.genTimeout', vars?: Record<string, string | number>) =>
    translate(uiLang, key, vars)
  const userMessageId = params.reverbContinue?.messageId ?? uid()
  const docAttachments = (params.documents ?? []).slice(0, 4)
  const docPageImages = docAttachments.flatMap((d) => d.pageImages ?? [])
  const imageRefs = [...(params.images ?? []), ...docPageImages]
    .slice(0, 4)
    .map((img) => ({
      id: img.id,
      path: img.path,
      mime: img.mime,
      ...(img.name ? { name: img.name } : {})
    }))
  const docFileAttachments: FileAttachment[] = docAttachments
    .filter((d) => d.text.trim())
    .map((d) => ({
      path: `document/${d.name}`,
      content:
        (d.note ? `(${d.note})\n` : '') + d.text
    }))
  const mergedAttachments = [...(params.attachments ?? []), ...docFileAttachments]
  const fileRefs = (params.files ?? []).slice(0, 8).map((f) => ({
    id: f.id,
    path: f.path,
    name: f.name,
    mime: f.mime,
    extLabel: f.extLabel,
    kind: f.kind
  }))
  const messages: ChatMessage[] = [
    ...params.history.filter((m) => !m.pending && !m.streaming),
    {
      id: userMessageId,
      role: 'user',
      content: params.userText,
      ...(imageRefs.length ? { images: imageRefs } : {}),
      ...(fileRefs.length ? { files: fileRefs } : {})
    }
  ]
  params.onUserMessageCreated?.(userMessageId)
  params.onUpdate([...messages])

  const turnStartedAt = Date.now()
  const turnFileChanges = new Map<string, TurnFileChange>()
  const writtenOkPaths = new Set<string>()
  let lastClosingText = ''
  let mutatingEditOk = false
  let htmlPreviewOpened = false

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
    if (!htmlPreviewOpened && transcriptOpenedPreview(msgs)) {
      htmlPreviewOpened = true
    }
    if (htmlPreviewOpened && (mutatingEditOk || turnFileChanges.size > 0)) {
      lastClosingText = resolveTurnCloser({
        lastClosingText,
        lang: uiLang,
        paths: [...turnFileChanges.keys()],
        previewOpened: true
      })
      ensureClosingMessage(msgs, userMessageId, lastClosingText)
    } else if (lastClosingText.trim()) {
      ensureClosingMessage(msgs, userMessageId, lastClosingText)
    }
    relocateAgentCloser(msgs, closingMessageId(userMessageId))
    appendFilesChangedSummary(msgs, turnFileChanges)
    attachStatsToLastVisible(msgs, { turnElapsedMs: Date.now() - turnStartedAt })
    params.onUpdate([...msgs])
    if (params.sessionId && !isPlan) {
      void window.api.chats.updateMessages(params.sessionId, msgs.map(persistableChatMessage))
    }
    commitTurnCheckpoint()
    return msgs
  }

  const finishStopped = (note?: string): ChatMessage[] => {
    const stopNote =
      note ??
      (uiLang === 'ru' ? '⏹ Остановлено пользователем.' : '⏹ Stopped by user.')
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.streaming) {
        messages[i] = {
          ...messages[i]!,
          streaming: false,
          content: messages[i]!.content?.trim() ? messages[i]!.content : '(stopped)'
        }
      }
    }
    messages.push({ id: uid(), role: 'assistant', content: stopNote })
    return finishWithTiming(messages)
  }

  if (params.signal?.aborted) return finishStopped()

  const appSettings = await window.api.settings.get()
  params.queue.applySettings(appSettings)
  const ctxSize = appSettings.ctxSize > 0 ? appSettings.ctxSize : 8192
  let stacks: ProjectStack[] = []
  try {
    const snap = await window.api.context.stack()
    stacks = Array.isArray(snap?.stacks) ? snap.stacks : []
  } catch {
    stacks = []
  }
  const evidenceLog: StepEvidence[] = []

  let checklist = buildChecklistFromHistory(params.history)
  let todoSteps: AgentTodoStep[] = []
  let planFrozen = false
  let lastHtmlWrite = ''
  let lastHtmlWritePath = 'index.html'
  let lastJsWrite = ''
  let lastJsWritePath = ''
  let lastCssWrite = ''
  let lastCssWritePath = ''
  let i18nSanityFailed = false
  let lastI18nHint = ''
  let i18nRecoveryEdits = 0
  let editSanityFailed = false
  let truncatedCloserNudged = false
  const completeLandingWritesByPath = new Map<string, number>()
  const landingRecoveryUsedByPath = new Set<string>()
  const completeHtmlByPath = new Set<string>()

  const invokeApplyHandoff = async (
    callId: string,
    relativePath: string,
    contentSnippet: string
  ): Promise<AgentToolResult> => {
    const result = await window.api.agent.invoke({
      id: callId,
      name: 'apply_diff',
      arguments: buildApplyHandoffArgs({
        relativePath,
        userText: params.userText,
        content: contentSnippet
      })
    })
    const note = result.ok ? ' (write_file handed off to apply_diff)' : ''
    return {
      ...result,
      name: 'apply_diff',
      content: `${result.content || ''}${note}`.trim()
    }
  }

  const bufferCompleteForPath = (relativePath: string): boolean =>
    priorCompleteForWritePath({
      relativePath,
      lastHtml: lastHtmlWrite,
      lastJs: lastJsWrite,
      lastCss: lastCssWrite
    })

  const pathLooksCompleteOnDisk = async (relativePath: string): Promise<boolean> => {
    if (bufferCompleteForPath(relativePath)) return true
    const key = loopPathKey(relativePath)
    if (key && completeHtmlByPath.has(key) && /\.html?$/i.test(relativePath)) return true
    try {
      const disk = await window.api.workspace.readFile(relativePath)
      if (!disk.ok || typeof disk.content !== 'string' || !disk.content.trim()) {
        return false
      }
      return contentLooksStructurallyComplete(disk.content, relativePath)
    } catch {
      return false
    }
  }

  const surgicalCssBlocked = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    cssPath: string
  ): Promise<boolean> => {
    if (!/\.css$/i.test(cssPath)) return false
    if (toolName !== 'write_file' && toolName !== 'apply_diff' && toolName !== 'apply_patch') {
      return false
    }
    const search = typeof toolArgs.search_block === 'string' ? toolArgs.search_block : ''
    const replace = typeof toolArgs.replace_block === 'string' ? toolArgs.replace_block : ''
    const content = typeof toolArgs.content === 'string' ? toolArgs.content : ''
    const huge =
      (toolName === 'write_file' &&
        (Boolean(toolArgs.overwrite) ||
          Boolean(toolArgs.allow_full_rewrite) ||
          content.length >= 3000)) ||
      (toolName === 'apply_diff' &&
        (search.length >= 1800 ||
          (search.length >= 900 && replace.length >= 1800) ||
          replace.length >= 4000)) ||
      (toolName === 'apply_patch' &&
        typeof toolArgs.patch === 'string' &&
        toolArgs.patch.length >= 4000)
    if (!huge) return false
    let cssDisk = lastCssWrite
    if (!cssLooksLikeRealStylesheet(cssDisk)) {
      try {
        const disk = await window.api.workspace.readFile(cssPath)
        if (disk.ok && typeof disk.content === 'string') cssDisk = disk.content
      } catch {
        /* missing */
      }
    }
    return shouldBlockSurgicalCssRewrite({
      userText: params.userText,
      cssOnDisk: cssDisk
    })
  }

  let planFinishNudges = 0
  let scaffoldFinishNudges = 0
  let previewNudges = 0
  let sectionFillTried = true
  /** A mutating edit (write_file / apply_diff / apply_patch) succeeded this turn. */
  /** Last mutating edit failed (path / parse / apply) — used for honest failure summary. */
  let mutatingEditFailed = false
  let lastMutatingFailDetail = ''
  let bestLiveProse = ''
  let thinkBubbleId: string | null = null
  archiveLiveTodoBubble(messages)
  removeChecklistBubbles(messages)
  if (!isPlan) {
    params.onUpdate([...messages])
  }

  let effectiveUserText = params.reverbContinue
    ? formatReverbPrompt(params.userText)
    : params.userText

  if (imageRefs.length > 0) {
    const reuseVision = visionReusesChatModel({
      chatPath: appSettings.modelPath,
      visionPath: appSettings.visionModelPath,
      mmprojPath: appSettings.visionMmprojPath
    })
    if (!reuseVision && !appSettings.visionModelPath?.trim()) {
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          'Images or scanned document pages are attached, but no vision model is configured. If Chat is already a VL GGUF, leave Vision empty and set mmproj. Otherwise pick a Vision GGUF in Settings → Model, then retry.'
      })
      return finishWithTiming(messages)
    }
    try {
      const imageQa = looksLikeImageQa(params.userText, true)
      const description = await describeImagesWithVision({
        queue: params.queue,
        userText: params.userText,
        images: imageRefs,
        signal: params.signal,
        keepLoaded: reuseVision || appSettings.visionKeepLoaded === true,
        directAnswer: imageQa
      })
      if (params.signal?.aborted) return finishStopped()
      if (imageQa && description.trim()) {
        messages.push({
          id: uid(),
          role: 'assistant',
          content: description.trim()
        })
        return finishWithTiming(messages)
      }
      if (description.trim()) {
        const label = docPageImages.length
          ? '[Document page notes]'
          : '[Image notes]'
        effectiveUserText =
          `${effectiveUserText}\n\n${label}\n${description.trim()}\n\n` +
          `(Reply to the user in their language, outside any <think> block. Do not narrate that an attachment exists.)`.trim()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      messages.push({
        id: uid(),
        role: 'assistant',
        content: `Vision analysis failed: ${msg}`
      })
      return finishWithTiming(messages)
    }
  }

  // LLM-compress oversized docs before packing into the prompt (keeps meaning on small ctx).
  let preparedAttachments = mergedAttachments
  if (mergedAttachments.length > 0) {
    const per = attachCharBudget(ctxSize, mergedAttachments.length)
    const next: FileAttachment[] = []
    for (const a of mergedAttachments) {
      const isDoc = a.path.startsWith('document/') || a.path.startsWith('file/')
      const raw = a.content ?? ''
      if (isDoc && raw.length > per * 1.35) {
        const name = a.path.replace(/^(document|file)\//, '')
        messages.push({
          id: uid(),
          role: 'assistant',
          content:
            '↻ Compressing attached document to fit context…'
        })
        params.onUpdate([...messages])
        const compressed = await llmCompressDocument(params.queue, name, raw)
        next.push({ path: a.path, content: compressed })
      } else if (isDoc) {
        next.push({ path: a.path, content: packDocumentExtract(raw, per) })
      } else {
        next.push({
          path: a.path,
          content: truncateAttach(raw, Math.min(FILE_ATTACH_MAX, per))
        })
      }
    }
    preparedAttachments = next
  }

  let apiMessages: ApiMessage[] = await buildApiMessages(
    params.history,
    effectiveUserText,
    params.openFile,
    appSettings,
    checklist,
    params.selection,
    preparedAttachments,
    isPlan ? 'plan' : 'agent',
    ctxSize,
    stacks
  )

  // Compact write bodies / history only at 99% ctx — never after every file.
  maybeSlimWritesForCtx(apiMessages, ctxSize)
  if (shouldCompactForOverflow(apiMessages, ctxSize)) {
    const beforeTok = estimateTokens(apiMessages)
    messages.push({
      id: uid(),
      role: 'assistant',
      content: `↻ Context near limit (${beforeTok}/${ctxSize} tok est.) — compacting before reply…`
    })
    params.onUpdate([...messages])
    const compacted = await compactApiMessages(
      apiMessages,
      checklist,
      params.queue,
      ctxSize
    )
    apiMessages = compacted.messages
    if (compacted.summary) upsertThreadSummary(messages, compacted.summary)
    if (shouldCompactForOverflow(apiMessages, ctxSize)) {
      apiMessages = nuclearFitMessages(apiMessages, ctxSize)
    }
  }

  let completedTools = 0
  /** Consecutive rounds that only looked at code — nudge to actually write. */
  let readOnlyRounds = 0
  let readOnlyNudges = 0
  let earlyDoneNudges = 0
  let roleRepairAttempts = 0
  let jsonRepairAttempts = 0
  let overflowRepairs = 0
  let fetchRepairs = 0
  let markupRepairAttempts = 0
  let toolLoopHits = 0
  let missingPathHits = 0
  let loopRecoveryWarned = false
  let concludeAsked = false
  let settledStopAsked = false
  /** Nudge when model paints "writing…" then returns zero tools after think/plan. */
  let emptyToolNudges = 0
  /** Once the model emits <think> this turn, later tool rounds may skip re-thinking. */
  let thinkSatisfied = false
  const coercePlan = (plan: AgentTodoStep[] | null | undefined): AgentTodoStep[] =>
    filterPlanToCurrentRequest(
      coerceProductPlan(plan, {
        userText: params.userText,
        surgical: looksLikeSurgicalFollowUp(params.userText)
      }).filter((s) => !isJunkPlanStep(s.text)),
      params.userText
    )
  const paintTodo = (
    steps: AgentTodoStep[],
    opts?: { afterId?: string }
  ): void => {
    const clean = steps.filter((s) => !isJunkPlanStep(s.text))
    if (clean.length === 0) {
      archiveLiveTodoBubble(messages)
      return
    }
    upsertTodoBubble(messages, clean, {
      ...opts,
      failed: todoCardFailed({ mutatingEditFailed, mutatingEditOk })
    })
  }
  let usedWebSearch = false
  /** null until a test command runs */
  let lastNodeTestOk: boolean | null = null
  let ranCliSmoke = false
  const incompleteAppendsByPath = new Map<string, number>()
  const identicalToolCounts = new Map<string, number>()
  /** Failed apply_patch / apply_diff counts per path — unlock overwrite after 4. */
  const patchFailsByPath = new Map<string, number>()
  /** Pathless patch failures (parse/format errors) — bound the endless loop. */
  let patchParseFails = 0
  /** Successful patches per path — stop endless "add img again" loops. */
  const patchOkByPath = new Map<string, number>()
  /** Repeated read_file counts per path — stop Think re-verify loops. */
  const readCountsByPath = new Map<string, number>()
  let readFileCalls = 0
  /** How many times each path+range was requested — a new range is not a loop. */
  const readRangeCounts = new Map<string, number>()
  /** Hard cap — model must not restart image gen mid-turn (even with a tweaked prompt). */
  let generateImageCalls = 0
    /** After first successful HTML preview open, block further Start-Process / open loops. */
    /** Keyed by path|start-end so a cache hit can never serve a different range. */
    const readFileCache = new Map<string, string>()
    /** Newest read per path — kept fuller than other tool results during compact. */
    const lastReadByPath = new Map<string, string>()
  /** FILE_COMPLETE redirects — escalate to overwrite, do not fake-stop. */
  let fileCompleteHits = 0
  /** SMART_APPLY_FAIL / APPLY_UNAVAILABLE — escalate to overwrite. */
  let smartApplyFailHits = 0
  let htmlOverwriteEscalated = false
  /** After hard-stop, skip further tool rounds. */
  let forceEndTurn = false
  const skipCeremony =
    !isPlan && shouldSkipThinkPlanCeremony(params.userText, params.history)
  const chatQa =
    !isPlan &&
    (looksLikeChatQa(params.userText, params.history) ||
      looksLikeImageQa(params.userText, imageRefs.length > 0))
  const thinkThrough = !isPlan && !skipCeremony && !chatQa
  const autoApprove = appSettings.agentAutoApprove === true

  // Landing shortcuts (open preview / brand rename / adaptive-CSS inject) are gone:
  // every edit must come from a real tool call so the UI cannot report instant fake success.
  const openPreviewOnly = false as boolean

  const userWantsWebSearch =
    /web_search|cite\s+1\s+url|under a ["']?Refs|search the web|from search/i.test(
      params.userText
    )
  const userWantsNodeTest =
    /node:test|node\s+--test|npm\s+test/i.test(params.userText)
  const userWantsCli = userAskedForCliSmoke(params.userText)

  let agentTools: unknown[] = [...AGENT_TOOL_SCHEMAS]
  if (!isPlan) {
    try {
      const listed = await window.api.agent.listTools()
      if (Array.isArray(listed) && listed.length > 0) agentTools = listed
    } catch {
      /* keep builtins */
    }
  }
  if (!appSettings.agentImageGenEnabled) {
    agentTools = agentTools.filter((tool) => {
      const name =
        tool &&
        typeof tool === 'object' &&
        'function' in tool &&
        tool.function &&
        typeof tool.function === 'object' &&
        'name' in tool.function
          ? String((tool.function as { name?: unknown }).name ?? '')
          : tool && typeof tool === 'object' && 'name' in tool
            ? String((tool as { name?: unknown }).name ?? '')
            : ''
      return name !== 'generate_image'
    })
  }
  // Chat Q&A (weather / clothing): only optional web_search — never invent a website.
  if (chatQa) {
    agentTools = agentTools.filter((tool) => {
      const name =
        tool &&
        typeof tool === 'object' &&
        'function' in tool &&
        tool.function &&
        typeof tool.function === 'object' &&
        'name' in tool.function
          ? String((tool.function as { name?: unknown }).name ?? '')
          : tool && typeof tool === 'object' && 'name' in tool
            ? String((tool as { name?: unknown }).name ?? '')
            : ''
      return name === 'web_search'
    })
  }
  if (
    looksLikeSurgicalFollowUp(params.userText) &&
    !/github\.com|web_search|поиск в интернет|search the web|факты из/i.test(params.userText)
  ) {
    agentTools = agentTools.filter((tool) => {
      const name =
        tool &&
        typeof tool === 'object' &&
        'function' in tool &&
        tool.function &&
        typeof tool.function === 'object' &&
        'name' in tool.function
          ? String((tool.function as { name?: unknown }).name ?? '')
          : tool && typeof tool === 'object' && 'name' in tool
            ? String((tool as { name?: unknown }).name ?? '')
            : ''
      return name !== 'web_search'
    })
  }

  // Think ON: THINK-ONLY completion first (stream every token), then a separate PLAN completion.
  if (thinkThrough) {
    if (params.signal?.aborted) return finishStopped()
    const preludeId = uid()
    thinkBubbleId = preludeId
    // Create the bubble on first real prose — empty <think></think> caused a blank fold flash.
    const ensureThinkBubble = (content: string): number => {
      let idx = messages.findIndex((m) => m.id === preludeId)
      if (idx === -1) {
        messages.push({
          id: preludeId,
          role: 'assistant',
          content,
          streaming: true
        })
        idx = messages.length - 1
      }
      return idx
    }

    const thinkBudgetTok = appSettings.reasoningBudgetEnabled
      ? Math.min(Math.max(1024, appSettings.reasoningBudget ?? 1800), 2560)
      : 1800
    const thinkMaxTokens = openPreviewOnly
      ? Math.min(384, AGENT_MAX_TOKENS)
      : Math.min(thinkBudgetTok, AGENT_MAX_TOKENS)
    const minThinkChars = openPreviewOnly ? 40 : 200
    const enoughThinkChars = openPreviewOnly ? 120 : 1400

    const paintThink = (raw: string): void => {
      const prose = liveThinkProse(raw)
      if (prose.length > bestLiveProse.length && !isEllipsisOnly(prose)) {
        bestLiveProse = prose
      }
      const body = prose.trim() ? prose : bestLiveProse
      // Stay silent until we have something worth showing (one fold, no empty→text blink).
      if (!body.trim()) return
      const idx = ensureThinkBubble(
        formatLiveThinkContent(`<think>\n${body}\n</think>`)
      )
      messages[idx] = {
        ...messages[idx]!,
        content: formatLiveThinkContent(`<think>\n${body}\n</think>`),
        streaming: true
      }
      params.onUpdate([...messages])
    }

    const isStockThink = (prose: string): boolean =>
      prose.length < minThinkChars &&
      /разбираю запрос|дальше действую tools|working from the user request|next:\s*tools|acting with tools/i.test(
        prose
      )

    // One think completion; retry only if that stream was empty (Gemma/Qwen
    // sometimes emit reasoning_content with no `content` — salvage is in SSE).
    const streamThinkOnce = async (): Promise<{ text: string; aborted: boolean }> => {
      const ac = new AbortController()
      const onOuter = (): void => {
        ac.abort(params.signal?.reason ?? 'aborted')
      }
      if (params.signal?.aborted) {
        ac.abort(params.signal.reason ?? 'aborted')
      } else {
        params.signal?.addEventListener('abort', onOuter, { once: true })
      }
      let codeDumpAbort = false
      let budgetAbort = false
      let rawAccum = ''
      const streamed = await params.queue.chatStream({
        messages: normalizeApiMessages(apiMessages),
        maxTokens: thinkMaxTokens,
        signal: ac.signal,
        onToken: (token) => {
          if (ac.signal.aborted) return
          rawAccum += token
          paintThink(rawAccum)
          // Generation leaked into think — cut immediately (keep prose before the fence).
          if (findCodeLeakIndex(rawAccum) >= 0) {
            codeDumpAbort = true
            ac.abort('think_code_dump')
            return
          }
          // Model started a plan mid-think — cut think and leave plan for PLAN_ONLY.
          if (findPlanLeakIndex(rawAccum) >= 0 && liveThinkProse(rawAccum).length >= minThinkChars) {
            ac.abort('think_plan_leak')
            return
          }
          if (thinkBodyLooksLikeCodeDump(rawAccum) && liveThinkProse(rawAccum).length > 80) {
            codeDumpAbort = true
            ac.abort('think_code_dump')
            return
          }
          const proseLen = liveThinkProse(rawAccum).length
          // Soft cap — prefer a fuller DeepThink over an early cut that looked like a "new" think.
          if (proseLen >= enoughThinkChars) {
            budgetAbort = true
            ac.abort('think_budget')
            return
          }
          const estTok = proseLen / CHARS_PER_TOKEN
          if (proseLen >= minThinkChars && estTok >= thinkBudgetTok) {
            budgetAbort = true
            ac.abort('think_budget')
          }
        },
        priority: 'NORMAL'
      })
      params.signal?.removeEventListener('abort', onOuter)
      if (params.signal?.aborted && /user_stop/i.test(String(params.signal.reason ?? ''))) {
        return { text: '', aborted: true }
      }
      let text = (rawAccum || streamed.text || '').trim()
      if (budgetAbort && text && !hasThinkBlock(text)) {
        text = `<think>\n${liveThinkProse(text)}\n</think>`
      }
      if (streamed.aborted && !codeDumpAbort && !budgetAbort) {
        return { text, aborted: false }
      }
      return { text, aborted: false }
    }

    const thinkPrompt = openPreviewOnly
      ? 'THINK_ONLY (tools DISABLED). Output ONLY a short <think>…</think> — nothing after it.\n' +
        '2–4 sentences in the USER\'s language: they asked to open/show the landing; note that index.html is already on disk; ' +
        'you will open it in Browser with no rebuild and no plan.\n' +
        'FORBIDDEN: <plan>, todos, code, tools, HTML.\n' +
        'Stop right after </think>.'
      : 'THINK_ONLY (tools DISABLED). Output ONLY a <think>…</think> block — nothing after it.\n' +
        'Write first-person reasoning in the USER\'s language (like DeepSeek DeepThink):\n' +
        '- 8–14 sentences (~160–320 words). Stream immediately — do not stay silent then dump.\n' +
        '- Cover: goal, hard constraints (what is FORBIDDEN), structure / file order, visuals, risks, how you verify.\n' +
        '- Tie points to THIS user message — no filler; one continuous thought, not a stub.\n' +
        `Budget for THIS completion: ≤${thinkBudgetTok} tokens — use most of it for real reasoning.\n` +
        'FORBIDDEN: <plan>, [Plan], todos, HTML/CSS/JS, code fences, write_file, tools.\n' +
        'Stop right after </think>.'

    pushUserMessage(apiMessages, thinkPrompt)
    apiMessages = normalizeApiMessages(apiMessages)

    const pickThinkProse = (roundText: string): string =>
      [stripCodeLeakFromThink(liveThinkProse(roundText)), stripCodeLeakFromThink(bestLiveProse)]
        .filter(
          (p) =>
            p &&
            !isEllipsisOnly(p) &&
            !isStockThink(p) &&
            !thinkBodyLooksLikeCodeDump(p) &&
            !/^думаю над запросом|^thinking about the request/i.test(p.trim())
        )
        .sort((a, b) => b.length - a.length)[0] ?? ''

    let thinkRound = await streamThinkOnce()
    if (thinkRound.aborted) {
      const idx = messages.findIndex((m) => m.id === preludeId)
      if (idx !== -1) {
        messages[idx] = {
          ...messages[idx]!,
          streaming: false,
          content: formatLiveThinkContent(messages[idx]!.content ?? '')
        }
        params.onUpdate([...messages])
      }
      return finishStopped()
    }

    // Prefer the longest real prose we saw while streaming — never wipe a fold the user already saw.
    let streamedBest = pickThinkProse(thinkRound.text)
    // Keep whatever streamed into the bubble even if filters were picky (false-success
    // patterns in think must not delete a real DeepThink the user already watched).
    let keptLive = stripCodeLeakFromThink(bestLiveProse).trim()
    let finalProse = streamedBest || (keptLive.length >= 40 ? keptLive : '')

    if (!finalProse && keptLive.length < 40 && !params.signal?.aborted) {
      pushUserMessage(
        apiMessages,
        'THINK_ONLY retry: previous reply was empty. Output ONLY a <think>…</think> block NOW — ' +
          '8–14 sentences in the USER\'s language. No <plan>, tools, or code. Stop after </think>.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      thinkRound = await streamThinkOnce()
      if (thinkRound.aborted) {
        const idx = messages.findIndex((m) => m.id === preludeId)
        if (idx !== -1) {
          messages[idx] = {
            ...messages[idx]!,
            streaming: false,
            content: formatLiveThinkContent(messages[idx]!.content ?? '')
          }
          params.onUpdate([...messages])
        }
        return finishStopped()
      }
      streamedBest = pickThinkProse(thinkRound.text)
      keptLive = stripCodeLeakFromThink(bestLiveProse).trim()
      finalProse = streamedBest || (keptLive.length >= 40 ? keptLive : '')
    }
    const thinkMissingNote =
      uiLang === 'ru'
        ? 'Модель не выдала рассуждение — перехожу к плану и tools.'
        : 'Model produced no reasoning — continuing to plan and tools.'
    const uiThink = finalProse
      ? formatLiveThinkContent(`<think>\n${finalProse}\n</think>`)
      : formatLiveThinkContent(`<think>\n${thinkMissingNote}\n</think>`)
    let pIdx = messages.findIndex((m) => m.id === preludeId)
    if (pIdx === -1) {
      // Empty think never created a bubble — still show the fold so "Думал:" is visible.
      messages.push({
        id: preludeId,
        role: 'assistant',
        content: uiThink,
        streaming: false
      })
      pIdx = messages.length - 1
      params.onUpdate([...messages])
    } else {
      // Never replace a non-empty live think fold with the "no reasoning" status line.
      const prevThink = liveThinkProse(messages[pIdx]!.content ?? '').trim()
      const nextContent =
        !finalProse && prevThink.length >= 40
          ? formatLiveThinkContent(`<think>\n${prevThink}\n</think>`)
          : uiThink
      messages[pIdx] = {
        ...messages[pIdx]!,
        streaming: false,
        content: nextContent
      }
      params.onUpdate([...messages])
    }

    if (finalProse || keptLive.length >= 40) {
      apiMessages.push({
        role: 'assistant',
        content: finalProse
          ? uiThink
          : formatLiveThinkContent(`<think>\n${keptLive}\n</think>`)
      })
    }

    {
    const surgicalPlan = looksLikeSurgicalFollowUp(params.userText)
    const i18nPlan = looksLikeI18nFollowUp(params.userText)
    pushUserMessage(
      apiMessages,
      surgicalPlan
        ? 'PLAN_ONLY (tools still DISABLED). Output ONLY <plan>…</plan> with 2–4 ATOMIC steps for THIS user message only ' +
            `(«${params.userText.trim().slice(0, 160)}»). ` +
            'FORBIDDEN: restating earlier chat work (weather, clothing, old sections), ' +
            (i18nPlan
              ? 'rewriting the whole landing, Create index.html / Explore GitHub, web_search, README.md, '
              : 'RU/EN i18n unless asked, rewriting the whole file/module, ') +
            'tool names, code, <think>. Stop after </plan>.'
        : 'PLAN_ONLY (tools still DISABLED). Output ONLY <plan>…</plan> with 3–9 ATOMIC steps from the user request ' +
            'and your prior <think> (what to create/change, in order). ' +
            'If the user asked CSS/JS/assets before index.html, list steps in that dependency order (folders/assets → CSS → JS → HTML → README → preview). ' +
            'If they asked a fact from the internet, include a step like «найти актуальную версию в интернете» (do not write the tool name web_search). ' +
            'Edit/create steps BEFORE run/test. Summary last. ' +
            'FORBIDDEN as step text: tool names (execute_terminal_command, write_file, Start-Process, read_file, explore_subagent, web_search), CSS class names as steps, ' +
            'syntax-check shells, GitHub curl/clone, «Закрыть», mega-steps, code, <think>. Stop after </plan>.'
    )
    apiMessages = normalizeApiMessages(apiMessages)

    let planAccum = ''
    const planAc = new AbortController()
    const onPlanOuter = (): void => {
      planAc.abort(params.signal?.reason ?? 'aborted')
    }
    if (params.signal?.aborted) {
      planAc.abort(params.signal.reason ?? 'aborted')
    } else {
      params.signal?.addEventListener('abort', onPlanOuter, { once: true })
    }
    await params.queue.chatStream({
      messages: normalizeApiMessages(apiMessages),
      maxTokens: 768,
      signal: planAc.signal,
      onToken: (token) => {
        if (planAc.signal.aborted) return
        planAccum += token
        if (findCodeLeakIndex(planAccum) >= 0) {
          planAc.abort('plan_code_leak')
          return
        }
        const bounded = /<\s*\/\s*plan\s*>/i.test(planAccum)
          ? planAccum
          : /<\s*plan\b|\[\s*plan\s*\]/i.test(planAccum)
            ? `${planAccum}\n</plan>`
            : planAccum
        const livePlan = parsePlanBlock(bounded)
        if (livePlan?.length && !planFrozen) {
          todoSteps = coercePlan(livePlan)
          paintTodo(todoSteps, { afterId: preludeId })
          params.onUpdate([...messages])
        }
      },
      priority: 'NORMAL'
    })
    params.signal?.removeEventListener('abort', onPlanOuter)
    if (params.signal?.aborted && /user_stop/i.test(String(params.signal.reason ?? ''))) {
      return finishStopped()
    }
    const parsePlanAccum = (raw: string): AgentTodoStep[] | null =>
      parsePlanBlock(raw) ||
      parsePlanBlock(`${raw}\n</plan>`) ||
      parsePlanBlock(`<plan>\n${raw}\n</plan>`)

    let planFromPrelude = parsePlanAccum(planAccum)

    // Silence here used to leave the turn with no plan card at all.
    if (!coercePlan(planFromPrelude).length && !params.signal?.aborted) {
      pushUserMessage(
        apiMessages,
        'No plan was received. Output ONLY the <plan>…</plan> block now — 3–6 short steps for THIS request, ' +
          'one per line starting with "- ". No think, no code, no tool names.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      let retryAccum = ''
      const retryAc = new AbortController()
      const onRetryOuter = (): void => {
        retryAc.abort(params.signal?.reason ?? 'aborted')
      }
      if (params.signal?.aborted) {
        retryAc.abort(params.signal.reason ?? 'aborted')
      } else {
        params.signal?.addEventListener('abort', onRetryOuter, { once: true })
      }
      await params.queue.chatStream({
        messages: normalizeApiMessages(apiMessages),
        maxTokens: 512,
        signal: retryAc.signal,
        onToken: (token) => {
          if (retryAc.signal.aborted) return
          retryAccum += token
          if (findCodeLeakIndex(retryAccum) >= 0) {
            retryAc.abort('plan_code_leak')
            return
          }
          const livePlan = parsePlanAccum(retryAccum)
          if (livePlan?.length && !planFrozen) {
            todoSteps = coercePlan(livePlan)
            paintTodo(todoSteps, { afterId: preludeId })
            params.onUpdate([...messages])
          }
        },
        priority: 'NORMAL'
      })
      params.signal?.removeEventListener('abort', onRetryOuter)
      if (params.signal?.aborted && /user_stop/i.test(String(params.signal.reason ?? ''))) {
        return finishStopped()
      }
      planFromPrelude = parsePlanAccum(retryAccum) ?? planFromPrelude
    }
    // Always show a product plan (sections from think/prompt) — never tool-name fluff.
    planFromPrelude = coercePlan(planFromPrelude)
    if (planFromPrelude?.length) {
      todoSteps = planFromPrelude
      planFrozen = true
      paintTodo(todoSteps, { afterId: preludeId })
      params.onUpdate([...messages])
    }

    if (planFromPrelude?.length) {
      apiMessages.push({
        role: 'assistant',
        content: `<plan>\n${planFromPrelude.map((s) => `- [ ] ${s.text}`).join('\n')}\n</plan>`
      })
    }
    const executeLangRule =
      uiLang === 'ru'
        ? ' Пиши заметки execute и заключение ПО-РУССКИ. Запрещён английский meta («CSS written successfully», «Now I need to write», «I should summarize in Russian») — сразу пиши текст для пользователя. Инструменты не комментируй (их показывают чипы). В заключении вставь реальный stdout, не только exit_code.'
        : ' User-facing notes and the closer must match the UI language. Do not narrate tool calls — chips already show them. In the closer, paste real stdout, not only exit_code.'
    pushUserMessage(
      apiMessages,
      allowsComposerFullRewrite(params.userText)
        ? 'Think/plan already recorded. Do NOT output another <think> or <plan>. ' +
            'Call tools NOW to execute the plan IN ORDER. This is a from-scratch / full rebuild: ' +
            'write_file overwrite=true allow_full_rewrite=true with the COMPLETE file for each path. Leftover files from a failed turn may be overwritten with the FULL professional file. ' +
            'If the user already listed product facts, prefer writing CSS/JS/assets then HTML; search or fetch only if a required URL is missing. ' +
            'Do NOT call apply_diff / Apply to regenerate a whole CSS/JS/HTML file that is not on disk yet. ' +
            'data-i18n tags MUST contain visible default-language text (JS only swaps on toggle — never empty <h1 data-i18n>). ' +
            'After styles.css exists, index.html MUST reuse its class names; inline SVG needs width/height; JS keys must match HTML data-i18n. ' +
            'After CSS+HTML+JS exist, Start-Process once and STOP. ' +
            'Do not Start-Process / browser / done-summary until non-browser plan steps are done. ' +
            'If a tool edit fails, say so honestly — never claim "Сделано" / "done" when the change did not apply.' +
            executeLangRule
        : 'Think/plan already recorded. Do NOT output another <think> or <plan>. ' +
            'Call tools NOW to execute the plan IN ORDER. YOU decide: create missing files with write_file; ' +
            'edit existing HTML/CSS/JS with apply_diff instruction (or a short search_block) — never write_file overwrite a complete module. ' +
            'Do not Start-Process / browser / done-summary until non-browser plan steps are done — ' +
            'EXCEPT when index.html is already a complete landing on disk and the user wants it opened: then Start-Process first. ' +
            'If a tool edit fails, say so honestly — never claim "Сделано" / "done" when the change did not apply.' +
            executeLangRule
    )
    apiMessages = normalizeApiMessages(apiMessages)
    thinkSatisfied = true
    } // end !openPreviewOnly plan phase
  } else if ((skipCeremony || chatQa) && !isPlan) {
    // Ultra-short confirm / chat Q&A — go straight to answer or tools (no second think/plan).
    thinkSatisfied = true
    pushUserMessage(
      apiMessages,
      chatQa
        ? 'Chat Q&A follow-up: answer ONLY in prose in the user\'s language. ' +
            'If [Image notes] are present, answer from those notes in 2–8 sentences. ' +
            'FORBIDDEN: write_file, apply_diff, apply_patch, <plan>, todos, creating files, ' +
            '"задача завершена", P.S., offering to build a page, repeating goodbye. One short answer, then stop.'
        : 'Short confirm: skip another <think>/<plan>. Call tools NOW. ' +
            'YOU decide from disk: create missing files with write_file; edit existing with apply_diff/apply_patch. ' +
            'Never rewrite a finished HTML landing for a small tweak. Be honest if an edit fails.'
    )
    apiMessages = normalizeApiMessages(apiMessages)
  }

  if (
    !isPlan &&
    (looksLikeSurgicalFollowUp(params.userText) ||
      looksLikeThemeToggleRequest(params.userText))
  ) {
    thinkSatisfied = true
    pushUserMessage(
      apiMessages,
      formatSurgicalFollowUpHint({
        stacks,
        i18nFix: looksLikeI18nFollowUp(params.userText),
        themeToggle:
          looksLikeThemeToggleRequest(params.userText) &&
          !looksLikeI18nFollowUp(params.userText)
      })
    )
    apiMessages = normalizeApiMessages(apiMessages)
  }

  let lastNoToolFingerprint = ''
  let proseStutterHits = 0

  const pinFallbackCloserIfNeeded = (): void => {
    const closer = resolveTurnCloser({
      lastClosingText,
      lang: uiLang,
      paths: [...turnFileChanges.keys()],
      previewOpened: htmlPreviewOpened
    })
    lastClosingText = closer
    ensureClosingMessage(messages, userMessageId, closer)
  }

  for (let round = 0; round < maxRounds; round++) {
    if (params.signal?.aborted) return finishStopped()
    if (forceEndTurn) {
      if (!mutatingEditFailed && !editSanityFailed && !i18nSanityFailed) {
        todoSteps = settlePlanAfterWork(todoSteps, {
          previewOpened: htmlPreviewOpened,
          edited: mutatingEditOk
        })
      }
      if (todoSteps.length > 0) {
        paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
      }
      pinFallbackCloserIfNeeded()
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }
    logAgentToolEvent('round start', {
      round,
      thinkSatisfied,
      completedTools,
      loopV2: params.loopVersion === 2
    })
    clearPlanningRows(messages)

    maybeSlimWritesForCtx(apiMessages, ctxSize)
    if (round > 0 && shouldCompactForOverflow(apiMessages, ctxSize)) {
      const beforeTok = estimateTokens(apiMessages)
      const compacted = await compactApiMessages(
        apiMessages,
        checklist,
        params.queue,
        ctxSize
      )
      apiMessages = compacted.messages
      if (compacted.summary) upsertThreadSummary(messages, compacted.summary)
      if (shouldCompactForOverflow(apiMessages, ctxSize)) {
        apiMessages = nuclearFitMessages(apiMessages, ctxSize)
      }
      messages.push({
        id: uid(),
        role: 'assistant',
        content: `↻ Context near limit (${beforeTok}/${ctxSize} tok est.) — compacted to continue…`
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
        content: skipCeremony
          ? uiLang === 'ru'
            ? '↻ Правлю…'
            : '↻ Editing…'
          : uiLang === 'ru'
            ? '↻ Пишу по плану…'
            : '↻ Writing from the plan…',
        streaming: true
      })
      params.onUpdate([...messages])
    }
    // Show progress immediately — do not wait for first token (long TTFT looks stuck).
    if (!isPlan && thinkSatisfied) ensureStreamBubble()

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

    let lastStreamActivity = Date.now()
    let sawStreamActivity = false
    const STREAM_IDLE_MS = 75_000
    const idleWatch = setInterval(() => {
      if (streamAc.signal.aborted) return
      if (!sawStreamActivity) return
      if (Date.now() - lastStreamActivity >= STREAM_IDLE_MS) {
        abortStream('stream_idle')
      }
    }, 5_000)

    let result: Awaited<ReturnType<typeof params.queue.chatStream>>
    try {
      result = await params.queue.chatStream({
      messages: normalizeApiMessages(apiMessages),
      ...(isPlan ? {} : { tools: agentTools }),
      // Coding turns need a tool call; chat Q&A may answer in prose (optional web_search).
      ...(isPlan || completedTools > 0 || chatQa
        ? {}
        : { toolChoice: 'required' as const }),
      maxTokens: (() => {
        const room = maxTokensForAgent(ctxSize, estimateTokens(apiMessages))
        return appSettings.limitResponseLength
          ? Math.min(appSettings.maxTokens, room)
          : room
      })(),
      signal: streamAc.signal,
      onToken: (token) => {
        if (streamAc.signal.aborted) return
        sawStreamActivity = true
        lastStreamActivity = Date.now()
        clearPlanningRows(messages)
        ensureStreamBubble()
        const idx = messages.findIndex((m) => m.id === streamId)
        if (idx === -1) return
        const prevContent = messages[idx].content ?? ''
        // Drop status / think-wait lines once real tokens arrive.
        const base = /^↻ /i.test(prevContent.trim()) ? '' : prevContent
        // If this bubble was already promoted to a write preview, append into codePreview.
        if (messages[idx].toolName === 'write_file' && messages[idx].codePreview != null) {
          const nextCode = (messages[idx].codePreview ?? '') + token
          const path =
            messages[idx].filePath || inferWritePathFromContent(nextCode) || undefined
          messages[idx] = {
            ...messages[idx],
            content: path ? `✎ writing ${path}` : '✎ writing…',
            toolName: 'write_file',
            filePath: path,
            codePreview: nextCode,
            streaming: true
          }
          params.onUpdate([...messages])
          return
        }
        const nextContent = base + token
        // Stuck repeating the same paragraph with no tool draft — cut early.
        if (
          !isPlan &&
          thinkSatisfied &&
          toolDraft.size === 0 &&
          detectProseStutter(nextContent)
        ) {
          abortStream('prose_stutter')
          messages[idx] = {
            ...messages[idx],
            content:
              uiLang === 'ru'
                ? '↻ Модель зациклила текст без инструментов — требую tool call…'
                : '↻ Model looped prose without tools — requiring a tool call…',
            streaming: true
          }
          params.onUpdate([...messages])
          return
        }
        // Model dumped HTML as plain text instead of write_file — show live code stream.
        if (!isPlan && looksLikeAssistantHtmlDump(nextContent)) {
          const code = extractAssistantHtmlDump(nextContent) || nextContent
          const path = inferWritePathFromContent(code) || undefined
          messages[idx] = {
            ...messages[idx],
            content: path ? `✎ writing ${path}` : '✎ writing…',
            toolName: 'write_file',
            filePath: path,
            codePreview: code,
            streaming: true
          }
          params.onUpdate([...messages])
          return
        }
        messages[idx] = {
          ...messages[idx],
          content: nextContent,
          streaming: true
        }
        if (thinkThrough && hasThinkBlock(nextContent)) thinkSatisfied = true
        // Do not let later streams replace the frozen prelude plan.
        if (!isPlan && !planFrozen) {
          const livePlan = parsePlanBlock(nextContent)
          if (livePlan?.length) {
            todoSteps = livePlan
            paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
          }
        }
        params.onUpdate([...messages])
      },
      onToolDelta: isPlan
        ? undefined
        : (delta) => {
            if (streamAc.signal.aborted) return
            sawStreamActivity = true
            lastStreamActivity = Date.now()
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
            // Think already ran as a separate completion. Never abort tool
            // deltas to "force think" — that discarded the only real work.
            if (!prev.name && !parsed.label.replace(/^[▸▹✎]+\s*/, '').trim()) return

            // Drop the temporary «Пишу по плану…» status bubble once real tools stream.
            {
              const sIdx = messages.findIndex((m) => m.id === streamId)
              if (
                sIdx !== -1 &&
                !messages[sIdx]!.toolName &&
                /^↻ /.test((messages[sIdx]!.content ?? '').trim())
              ) {
                messages.splice(sIdx, 1)
                streamBubbleCreated = false
              }
            }

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
    } finally {
      clearInterval(idleWatch)
    }
    params.signal?.removeEventListener('abort', onOuterAbort)

    // Soft stream guards: size runaway, stall, or prose stutter — keep any tool draft.
    const softAbort =
      streamAbortReason === 'tool_args_too_large' ||
      streamAbortReason === 'stream_idle' ||
      streamAbortReason === 'prose_stutter'

    if (softAbort) {
      result.aborted = false
      result.error = undefined
    }

    if (streamAbortReason) {
      logAgentToolEvent('stream abort', {
        round,
        reason: streamAbortReason,
        draft: toolDraft.size,
        toolCalls: result.toolCalls?.length ?? 0
      })
    }

    // Never treat internal llama/queue aborts as the user hitting Stop.
    const isUserStop =
      (params.signal?.aborted &&
        /user_stop/i.test(String(params.signal.reason ?? ''))) ||
      /user_stop/i.test(String(result.error ?? ''))

    if (isUserStop) {
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
          content: wrapThinkForUi(displayThinkProse(messages[si]!.content) || bestLiveProse || '')
        }
      }
      params.onUpdate([...messages])
      return finishStopped()
    }

    if (result.aborted && !softAbort) {
      result.aborted = false
      if (!result.error || /^(aborted|cancelled)$/i.test(result.error)) {
        result.error = undefined
      }
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
        if (isKeepableChatBubble(messages[sIdx])) {
          messages[sIdx] = { ...messages[sIdx]!, streaming: false }
        } else if (!isClosingMessageId(messages[sIdx]?.id) && !concludeAsked) {
          messages.splice(sIdx, 1)
        }
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
          content: sanitizeStreamAssistantText(
            result.text || messages[sIdx].content || ''
          ),
          streaming: false,
          stats: mergedStats
        }
        // Keep each generation's think visible. Only rewrite the bubble when
        // this round is the closing summary (one closing card).
        if (thinkThrough && thinkSatisfied) {
          const rawBubble = messages[sIdx].content ?? ''
          if (isClosingMessageId(messages[sIdx].id)) {
            // Already pinned — leave alone.
          } else {
            const stripped = stripThinkBlocksLive(rawBubble)
            const salvaged =
              stripped.trim() ||
              stripPlanBlock(promoteThinkOnlyAnswer(result.text || rawBubble)).trim()
            if (salvaged && (concludeAsked || settledStopAsked)) {
              lastClosingText = salvaged
              const thinkInner = extractThinkInner(rawBubble)
              if (thinkInner && thinkInner.trim().length >= 20) {
                messages[sIdx] = {
                  ...messages[sIdx]!,
                  content: wrapThinkForUi(thinkInner),
                  streaming: false
                }
                ensureClosingMessage(messages, userMessageId, salvaged)
              } else {
                ensureClosingMessage(messages, userMessageId, salvaged)
                const leftover = messages.findIndex((m) => m.id === streamId)
                if (
                  leftover >= 0 &&
                  !isClosingMessageId(messages[leftover]?.id) &&
                  (messages[leftover]?.content ?? '').trim() === salvaged
                ) {
                  messages.splice(leftover, 1)
                }
              }
            } else if (salvaged && looksLikeClosingSummary(salvaged)) {
              lastClosingText = salvaged
            }
          }
        }
        // Keep plain-text HTML dumps visible as a write preview (don't wipe the stream).
        const rawFinal = result.text || (sIdx !== -1 ? messages[sIdx]?.content : '') || ''
        const sIdxNow = messages.findIndex((m) => m.id === streamId)
        if (
          sIdxNow !== -1 &&
          !result.toolCalls?.length &&
          (looksLikeAssistantHtmlDump(rawFinal) ||
            (messages[sIdxNow].toolName === 'write_file' && messages[sIdxNow].codePreview))
        ) {
          const code =
            messages[sIdxNow].codePreview ||
            extractAssistantHtmlDump(rawFinal) ||
            rawFinal
          const path =
            messages[sIdxNow].filePath ||
            inferWritePathFromContent(code) ||
            'index.html'
          messages[sIdxNow] = {
            ...messages[sIdxNow],
            content: `✎ writing ${path}`,
            toolName: 'write_file',
            filePath: path,
            codePreview: code,
            streaming: false,
            stats: mergedStats
          }
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
        /write_file_missing_path|tool_args_too_large|tool_markup_in_content|stream_idle|prose_stutter/i.test(
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
      const userStopped = /user_stop/i.test(errText)
      if (userStopped) {
        return finishStopped()
      }
      if (result.aborted || /^(aborted|cancelled)$/i.test(errText.trim())) {
        // llama.cpp often ends a stream with aborted after tools — not a user Stop.
        result.aborted = false
        result.error = undefined
      } else {
      const isRoleError =
        /role|jinja|alternat|system message|tool calls and results/i.test(errText)
      const isJsonToolError = /parse tool call|json\.exception|arguments as JSON/i.test(
        errText
      )
      const isOverflow =
        /context|overflow|oom|too many tokens|n_keep|exceed|413/i.test(errText)
      const isFetchGlitch =
        /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|UND_ERR/i.test(
          errText
        )

      if (isRoleError) roleRepairAttempts++
      else roleRepairAttempts = 0
      if (isJsonToolError) jsonRepairAttempts++
      else if (!isRoleError) jsonRepairAttempts = 0
      if (isOverflow) overflowRepairs++
      if (isFetchGlitch) fetchRepairs++

      const overflowBudgetOk = !isOverflow || overflowRepairs <= MAX_OVERFLOW_REPAIRS
      const fetchBudgetOk = !isFetchGlitch || fetchRepairs <= MAX_FETCH_REPAIRS
      const repairBudgetOk =
        (!isRoleError || roleRepairAttempts <= 2) &&
        (!isJsonToolError || jsonRepairAttempts <= 2) &&
        overflowBudgetOk &&
        fetchBudgetOk
      const recoverable =
        repairBudgetOk &&
        (isRoleError ||
          isOverflow ||
          isJsonToolError ||
          isFetchGlitch ||
          /timed?\s*out/i.test(errText)) &&
        round < maxRounds - 1

      messages.push({
        id: uid(),
        role: 'assistant',
        content: recoverable
          ? `⚠ ${errText.slice(0, 500)}\n${
              isFetchGlitch
                ? 'Chat server hiccup — retrying…'
                : isOverflow
                  ? 'Compacting…'
                  : isJsonToolError
                    ? 'Retry with smaller tool args…'
                    : 'Repairing message roles…'
            } retrying`
          : isOverflow && !overflowBudgetOk
            ? `Error: context still exceeds ${ctxSize} tokens after ${MAX_OVERFLOW_REPAIRS} compact attempts. Start a new chat or raise ctx size. Do not read image/binary files as text.`
            : `Error: ${errText.slice(0, 800)}`
      })
      params.onUpdate([...messages])

      if (!recoverable) return finishWithTiming(messages)

      if (isFetchGlitch) {
        await new Promise((r) => setTimeout(r, 600 * fetchRepairs))
        continue
      }

      if (isOverflow || shouldCompactForOverflow(apiMessages, ctxSize)) {
        const compacted = await compactApiMessages(
          apiMessages,
          checklist,
          params.queue,
          ctxSize
        )
        apiMessages = compacted.messages
        if (compacted.summary) upsertThreadSummary(messages, compacted.summary)
        if (shouldCompactForOverflow(apiMessages, ctxSize)) {
          apiMessages = nuclearFitMessages(apiMessages, ctxSize)
        }
      } else {
        apiMessages = normalizeApiMessages(apiMessages.map((m) => slimMessage(m)))
      }
      // Never insert user after tools — attach hint to last tool or merge into last user
      const last = apiMessages[apiMessages.length - 1]
      const repairHint = isJsonToolError
        ? 'Previous tool JSON was invalid. Prefer apply_diff with a short unique search_block, or write_file with ≤800 chars. Do not resend a huge apply_patch.'
        : isOverflow
          ? 'Context was compacted to fit. Answer from the compressed document/notes still in this prompt. Do not dump a table of contents. Never read .png/.jpg/.webp as text.'
          : `Previous model response failed: ${errText.slice(0, 240)}\n` +
            'Continue the unfinished task. Existing HTML → apply_diff (search_block or instruction). New files → write_file. Keep relative_path set.'
      if (last?.role === 'tool') {
        appendToolHint(apiMessages, repairHint)
      } else {
        pushUserMessage(apiMessages, repairHint)
      }
      apiMessages = normalizeApiMessages(apiMessages.map((m) => slimMessage(m)))
      continue
      }
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

    let toolCalls = result.toolCalls
    if (!toolCalls?.length && looksLikeToolMarkupLeak(result.text ?? '')) {
      const salvaged = salvageLeakedToolCalls(result.text ?? '')
      const stripped = stripLeakedToolMarkup(result.text ?? '')
      if (stripped !== (result.text ?? '')) {
        result.text = stripped
        const si = messages.findIndex((m) => m.id === streamId)
        if (si !== -1) {
          const cleaned = sanitizeStreamAssistantText(stripped)
          messages[si] = {
            ...messages[si]!,
            content: cleaned || messages[si]!.content,
            streaming: false
          }
          params.onUpdate([...messages])
        }
      }
      if (salvaged.length) {
        toolCalls = salvaged
        result.toolCalls = salvaged
      }
    }
    logAgentToolEvent('round result', {
      round,
      toolCalls: toolCalls?.length ?? 0,
      draft: toolDraft.size,
      finishReason: String(result.finishReason ?? ''),
      aborted: Boolean(result.aborted),
      abortReason: streamAbortReason ?? '',
      error: String(result.error ?? '').slice(0, 120),
      textLen: (result.text ?? '').length,
      textHead: (result.text ?? '').slice(0, 120).replace(/\n/g, ' ')
    })
    if (
      !toolCalls?.length &&
      looksLikeToolMarkupLeak(result.text ?? '') &&
      round < maxRounds - 1
    ) {
      markupRepairAttempts++
      const htmlReady = contentLooksStructurallyComplete(lastHtmlWrite, 'index.html')
      const cssReady = cssLooksLikeRealStylesheet(lastCssWrite)
      const jsReady = contentLooksStructurallyComplete(lastJsWrite, 'js/main.js')
      const keepGoingForLanding =
        (!htmlReady || !cssReady || !jsReady) &&
        (looksLikeFinishMissingLandingFiles(params.userText) ||
          looksLikeLandingBuildTask(params.userText) ||
          allowsComposerFullRewrite(params.userText))
      const coreLandingReady = htmlReady && cssReady && jsReady
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          markupRepairAttempts > MAX_MARKUP_REPAIR_ATTEMPTS &&
          !keepGoingForLanding &&
          !coreLandingReady
            ? '⚠ Model leaked tool-call syntax into plain text. Stopping to avoid a write loop.'
            : '⚠ Detected leaked tool-call syntax in the reply (not a real tool call). Asking the model to use structured tools…'
      })
      params.onUpdate([...messages])
      if (markupRepairAttempts > MAX_MARKUP_REPAIR_ATTEMPTS) {
        if (keepGoingForLanding && markupRepairAttempts <= MAX_MARKUP_REPAIR_ATTEMPTS + 3) {
          const missing = !cssReady ? 'styles.css' : !htmlReady ? 'index.html' : 'js/main.js'
          pushUserMessage(
            apiMessages,
            `Landing files are still missing. Call write_file NOW with relative_path="${missing}", ` +
              'overwrite=true, and the FULL file in the JSON content argument. ' +
              'Do not paste <tool_call> or call:write_file as plain text.'
          )
          apiMessages = normalizeApiMessages(apiMessages)
          continue
        }
        if (coreLandingReady && markupRepairAttempts <= MAX_MARKUP_REPAIR_ATTEMPTS + 2) {
          pushUserMessage(
            apiMessages,
            'Core landing files are on disk. Call write_file for README.md (how to open) or ' +
              'Start-Process (Resolve-Path .\\index.html) ONCE. Use structured tools, not <tool_call> XML.'
          )
          apiMessages = normalizeApiMessages(apiMessages)
          continue
        }
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

    // Plain HTML in the assistant stream is visible as a preview — but nothing is saved until write_file.
    if (
      !toolCalls?.length &&
      looksLikeAssistantHtmlDump(
        result.text ||
          messages.find((m) => m.id === streamId)?.codePreview ||
          messages.find((m) => m.id === streamId)?.content ||
          ''
      ) &&
      round < maxRounds - 1
    ) {
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          uiLang === 'ru'
            ? '↻ HTML в чате не сохраняет файл — вызываю write_file…'
            : '↻ HTML in chat does not save the file — calling write_file…'
      })
      params.onUpdate([...messages])
      pushUserMessage(
        apiMessages,
        'You dumped HTML as plain text — that does NOT save the file. ' +
          'Call write_file NOW with relative_path (e.g. index.html), overwrite=true, and the FULL HTML in the content argument. ' +
          'No markdown fences, no <think>, no plan — just the tool call.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      continue
    }

    if (toolCalls?.length) {
      // Think already ran as a separate completion. Never discard real tool calls.
      thinkSatisfied = true

      const parsedPlan = parsePlanBlock(result.text)
      if (parsedPlan?.length && !planFrozen) {
        todoSteps = coercePlan(parsedPlan)
        planFrozen = true
        paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
        params.onUpdate([...messages])
      }

      apiMessages.push({
        role: 'assistant',
        content: result.text?.trim() ? result.text : null,
        tool_calls: toolCalls
      })

      // Keep think / user-facing prose; only drop sticky «Правлю…» status.
      {
        const siClear = messages.findIndex((m) => m.id === streamId)
        if (siClear !== -1) {
          if (isKeepableChatBubble(messages[siClear])) {
            messages[siClear] = { ...messages[siClear]!, streaming: false }
          } else {
            messages.splice(siClear, 1)
          }
        }
      }

      for (const [index, call] of toolCalls.entries()) {
        let name = call.function.name as AgentToolName
        const parsedArgs = parseToolArguments(call.function.arguments || '{}')
        const args = parsedArgs.args
        const resolvedPath =
          name === 'write_file'
            ? resolveWriteFilePath(args)
            : coerceToolRelativePath(args)
        if (resolvedPath) args.relative_path = resolvedPath

        // Unlock full rewrite for from-scratch / explicit rewrite, or non-HTML after patch-fail limit.
        // Small surgical follow-ups on finished HTML must never auto-escalate to whole-file overwrite.
        if (name === 'write_file' && resolvedPath) {
          const pk = loopPathKey(resolvedPath)
          const fails = pk ? (patchFailsByPath.get(pk) ?? 0) : 0
          const isHtml = /\.html?$/i.test(resolvedPath)
          if (
            allowsComposerFullRewrite(params.userText) ||
            (!isHtml && fails >= MAX_PATCH_FAILS_BEFORE_OVERWRITE)
          ) {
            args.allow_full_rewrite = true
            if (allowsComposerFullRewrite(params.userText)) args.overwrite = true
          }
        }

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
            content:
              name === 'apply_patch' || name === 'apply_diff'
                ? uiLang === 'ru'
                  ? '✎ Применяю правку…'
                  : '✎ Applying edit…'
                : formatActivityLabel(runningActivity),
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
              content:
                name === 'apply_patch' || name === 'apply_diff'
                  ? uiLang === 'ru'
                    ? '✎ Применяю правку…'
                    : '✎ Applying edit…'
                  : formatActivityLabel(runningActivity),
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
        let syntheticResult = true

        const fp = fingerprintToolCall(name, args)
        const identicalCount = (identicalToolCounts.get(fp) ?? 0) + 1
        identicalToolCounts.set(fp, identicalCount)
        if (name === 'generate_image') generateImageCalls++
        const pathKeyForLoop = loopPathKey(filePath || '')
        const readRangeKey =
          name === 'read_file' && pathKeyForLoop
            ? readFileRangeCacheKey(pathKeyForLoop, args.start_line, args.end_line)
            : ''
        // Only a REPEATED range burns the budget: a full read plus a couple of
        // distinct ranges is legitimate work, not a loop.
        const repeatedRange = readRangeKey ? readRangeCounts.has(readRangeKey) : false
        if (readRangeKey) {
          readRangeCounts.set(readRangeKey, (readRangeCounts.get(readRangeKey) ?? 0) + 1)
          if (repeatedRange) {
            readCountsByPath.set(
              pathKeyForLoop,
              (readCountsByPath.get(pathKeyForLoop) ?? 0) + 1
            )
            readFileCalls++
          }
        }
        const identicalLimit =
          name === 'generate_image'
            ? 1
            : name === 'read_file'
              ? MAX_READS_PER_PATH
              : name === 'create_directory'
                ? MAX_IDENTICAL_TOOL_CALLS
                : name === 'execute_terminal_command' &&
                    isHtmlPreviewShell(String(args.command ?? ''))
                  ? 1
                  : MAX_IDENTICAL_TOOL_CALLS + 1
        const readsOnPath = pathKeyForLoop
          ? (readCountsByPath.get(pathKeyForLoop) ?? 0)
          : 0
        if (name === 'generate_image' && generateImageCalls > 1) {
          toolLoopHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'TOOL_LOOP: generate_image already ran this turn (including any internal retry). Do NOT call it again — finish remaining files or summarize.'
          }
        } else if (
          await surgicalCssBlocked(name, args, String(resolvedPath || filePath || ''))
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'SURGICAL_CSS: do NOT rewrite this stylesheet. Use apply_diff with a SMALL search_block ' +
              '(navbar / header / theme rules only, typically < 80 lines). Leave the rest of the stylesheet untouched.'
          }
        } else if (
          name === 'read_file' &&
          pathKeyForLoop &&
          (readsOnPath > MAX_READS_PER_PATH || readFileCalls > MAX_READS_TURN_BUDGET)
        ) {
          // Cache is keyed by path+range: returning another range's body (or an
          // empty string with ok:true) made the model distrust the result and
          // retry forever. Serve only an exact hit; otherwise fail honestly.
          const cached = readRangeKey ? readFileCache.get(readRangeKey) : undefined
          const budgeted = resolveExhaustedReadBudget(cached, filePath || pathKeyForLoop)
          toolResult = {
            id: call.id,
            name,
            ...budgeted
          }
        } else if (
          name === 'execute_terminal_command' &&
          looksLikeViteReactFromScratch(params.userText) &&
          !looksLikeSurgicalFollowUp(params.userText) &&
          looksLikeDevOrPreviewCommand(String(args.command ?? ''))
        ) {
          const cmd = String(args.command ?? '')
          const missingNow = viteReactScaffoldMissing([
            ...writtenOkPaths,
            ...turnFileChanges.keys()
          ])
          if (missingNow.length) {
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error: formatViteReactScaffoldHint(missingNow)
            }
          } else if (htmlPreviewOpened) {
            toolLoopHits++
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error:
                'TOOL_LOOP: preview already opened this turn (PREVIEW_URL). ' +
                'Write the closing summary as visible assistant text OUTSIDE <think>, then STOP. Do not rerun npm.'
            }
          } else {
            toolResult = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: args
            })
            syntheticResult = false
            if (markPreviewFromShell({
              command: String(args.command ?? ''),
              content: toolResult.content,
              ok: toolResult.ok
            })) {
              htmlPreviewOpened = true
            }
          }
        } else if (
          name === 'execute_terminal_command' &&
          isHtmlPreviewShell(String(args.command ?? ''))
        ) {
          const cmd = String(args.command ?? '')
          if (isAfkllmInternalHtmlPath(cmd) || /browser\.html/i.test(cmd)) {
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error:
                'REFUSED: that path is an AFKLLM internal file, not the workspace landing. Open the project index.html instead.'
            }
          } else if (htmlPreviewOpened) {
            toolLoopHits++
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error:
                'TOOL_LOOP: HTML preview already opened this turn. Do NOT Start-Process again — write a short user summary and finish.'
            }
          } else {
            toolResult = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: args
            })
            syntheticResult = false
            if (toolResult.ok) htmlPreviewOpened = true
          }
        } else if (identicalCount > identicalLimit) {
          toolLoopHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              name === 'generate_image'
                ? 'TOOL_LOOP: generate_image already attempted. Do NOT retry image gen — finish remaining files or summarize.'
                : `TOOL_LOOP: identical ${name} repeated ${identicalCount} times` +
                  (filePath ? ` on "${filePath}"` : '') +
                  '. Stop repeating. Continue with a different file/step or finish the task.'
          }
        } else if (
          (name === 'apply_patch' || name === 'apply_diff') &&
          pathKeyForLoop &&
          (patchFailsByPath.get(pathKeyForLoop) ?? 0) >= MAX_PATCH_FAILS_BEFORE_OVERWRITE
        ) {
          toolLoopHits++
          const isHtml = /\.html?$/i.test(filePath || pathKeyForLoop)
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error: isHtml && !allowsComposerFullRewrite(params.userText)
              ? `PATCH_FAIL_LIMIT: apply_patch/apply_diff already failed ${MAX_PATCH_FAILS_BEFORE_OVERWRITE}+ times on "${filePath}". ` +
                'STOP calling apply_diff/apply_patch on this path. Write an honest short failure summary for the user (what you tried). Do NOT rewrite the whole file.'
              : `PATCH_FAIL_LIMIT: apply_patch/apply_diff already failed ${MAX_PATCH_FAILS_BEFORE_OVERWRITE}+ times on "${filePath}". ` +
                (allowsComposerFullRewrite(params.userText)
                  ? formatScratchWriteFileHint()
                  : 'STOP retrying. One write_file overwrite=true with allow_full_rewrite=true if appropriate, or honest failure summary.')
          }
        } else if (
          (name === 'apply_diff' || name === 'apply_patch') &&
          !String(args.relative_path ?? '').trim() &&
          !filePath
        ) {
          missingPathHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'MISSING_PATH: relative_path is required for apply_diff (e.g. "js/main.js"). ' +
              'Do not call apply_diff without a path.'
          }
        } else if (
          (name === 'apply_diff' || name === 'apply_patch') &&
          shouldRequireWriteFileForApply({
            fromScratch: allowsComposerFullRewrite(params.userText),
            path: filePath || String(args.relative_path ?? ''),
            completeWritesThisTurn:
              completeLandingWritesByPath.get(
                loopPathKey(filePath || String(args.relative_path ?? ''))
              ) ?? 0
          })
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error: formatWriteFileRequiredError(filePath || String(args.relative_path ?? ''))
          }
        } else if (
          name === 'apply_diff' &&
          !String(args.search_block ?? '').trim() &&
          /replace\s+entire|entire\s+html|whole\s+(html|file|landing)|complete\s+single[- ]?page\s+landing|replace\s+.*\s+with\s+a\s+complete|полный\s+(html|файл|лендинг)|перепис\w*\s+(весь|целиком)/i.test(
            String(args.instruction ?? '')
          )
        ) {
          toolLoopHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'SURGICAL_EDIT: instruction asks to replace the entire file. Forbidden. ' +
              'Do not rewrite this file. If it is already complete: summarize ' +
              '(HTML stack: preview once; compiler stacks: verify_project once). ' +
              'Otherwise one SHORT apply_diff (search_block or a one-line instruction).'
          }
        } else if (
          (name === 'apply_patch' || name === 'apply_diff') &&
          pathKeyForLoop &&
          (patchOkByPath.get(pathKeyForLoop) ?? 0) >= MAX_PATCH_OK_PER_PATH
        ) {
          toolLoopHits++
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              `PATCH_OK_LIMIT: already applied ${MAX_PATCH_OK_PER_PATH} successful patches to "${filePath}". ` +
              'Stop patching. Write a short summary — no more read/patch loops. Do NOT rewrite the whole file.'
          }
        } else if (name === 'get_diagnostics') {
          const htmlOnly = isHtmlOnlyStacks(stacks)
          if (htmlOnly) {
            toolResult = {
              id: call.id,
              name,
              ok: true,
              content:
                'SKIP: static HTML has no IDE diagnostics. Do not call get_diagnostics again. ' +
                'If the preview is open, write a short summary and stop.'
            }
          } else {
            syntheticResult = false
            toolResult = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: args
            })
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
          syntheticResult = false
        } else {
        const cutByLength = result.finishReason === 'length'
        const contentStr =
          typeof args.content === 'string' ? args.content : ''
        const pathStr =
          typeof args.relative_path === 'string' ? args.relative_path : ''
        const pathKey = loopPathKey(pathStr)
        const codeIncomplete =
          name === 'write_file' &&
          Boolean(pathStr) &&
          Boolean(contentStr) &&
          // Only when the model/stream was cut off — not heuristic "looks unfinished"
          // (that false-failed successful writes and left the explorer empty).
          (Boolean(parsedArgs.truncated) || cutByLength) &&
          !contentLooksStructurallyComplete(contentStr)

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
        } else if (name === 'generate_image' && !appSettings.agentImageGenEnabled) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error: 'Image mode is off. Turn on Image in the composer to allow generate_image.'
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
          name === 'write_file' &&
          looksLikeEmptyOrStubWriteContent(
            'content' in args ? args.content : undefined,
            pathStr || String(resolvedPath || '')
          )
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error: formatEmptyWriteError(pathStr || String(resolvedPath || 'file'))
          }
        } else if (
          name === 'write_file' &&
          inventedI18nVerifierPath(pathStr || String(resolvedPath || ''), params.userText)
        ) {
          toolResult = {
            id: call.id,
            name,
            ok: false,
            content: '',
            error:
              'INVENTED_FILE: do not write tmp/check.js (or check.js) to audit i18n. ' +
              'Call read_file on index.html and js/main.js. Align data-i18n keys with the JS dict in ONE write_file on js/main.js. Stop — do not loop patches.'
          }
        } else if (
          name === 'write_file' &&
          pathStr &&
          shouldHandoffWriteToApply({
            userText: params.userText,
            relativePath: pathStr
          }) &&
          !Boolean(args.append) &&
          !Boolean(args.allow_full_rewrite) &&
          (await pathLooksCompleteOnDisk(pathStr))
        ) {
          // Existing complete html/css/js on a small follow-up → Apply locates + inserts.
          name = 'apply_diff'
          toolResult = await invokeApplyHandoff(call.id, pathStr, contentStr)
          syntheticResult = false
        } else if (
          name === 'write_file' &&
          shouldBlockSurgicalOverwrite({
            userText: params.userText,
            relativePath: String(resolvedPath || filePath || args.relative_path || ''),
            overwrite: Boolean(args.overwrite) || Boolean(args.allow_full_rewrite)
          })
        ) {
          const blockPath = String(resolvedPath || filePath || args.relative_path || '')
          if (blockPath && isComposerApplyPath(blockPath)) {
            name = 'apply_diff'
            toolResult = await invokeApplyHandoff(call.id, blockPath, contentStr)
            syntheticResult = false
          } else {
            toolResult = {
              id: call.id,
              name,
              ok: false,
              content: '',
              error:
                'SURGICAL_EDIT: do not overwrite this existing HTML/CSS/JS file. ' +
                'Use apply_diff with a short instruction. Do NOT rewrite the whole file.'
            }
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
            syntheticResult = false
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
        } else if (name === 'write_file' && codeIncomplete && pathStr && contentStr) {
          const knownComplete =
            bufferCompleteForPath(pathStr) || (await pathLooksCompleteOnDisk(pathStr))
          if (
            !shouldPersistIncompleteWrite({
              knownComplete
            })
          ) {
            if (
              shouldHandoffWriteToApply({
                userText: params.userText,
                relativePath: pathStr
              })
            ) {
              name = 'apply_diff'
              toolResult = await invokeApplyHandoff(call.id, pathStr, contentStr)
              syntheticResult = false
            } else {
              toolResult = {
                id: call.id,
                name,
                ok: false,
                content: '',
                error:
                  `FILE_COMPLETE: "${pathStr}" is already a complete file and this chunk was truncated. ` +
                  (allowsComposerFullRewrite(params.userText)
                    ? 'This is a rebuild — next call MUST be write_file overwrite=true allow_full_rewrite=true with the COMPLETE file. Do NOT retry Apply.'
                    : 'Do NOT rewrite it. Use apply_diff with a short instruction, or send the complete file.')
              }
            }
          } else {
          const appendN = (incompleteAppendsByPath.get(pathKey) ?? 0) + 1
          incompleteAppendsByPath.set(pathKey, appendN)
          const landing = allowsLandingOverwrite(pathStr, contentStr.length)
          const sourceLimit =
            isSourcePath(pathStr) && appendN >= MAX_INCOMPLETE_SOURCE_APPENDS
          // New / incomplete file: persist bytes, then append.
          const partial = await window.api.agent.invoke({
            id: call.id,
            name,
            arguments: {
              ...args,
              append: Boolean(args.append) && !landing
            }
          })
          syntheticResult = false
          let saved = partial
          if (
            !partial.ok &&
            /FILE_EXISTS/i.test(partial.error ?? partial.content ?? '') &&
            !bufferCompleteForPath(pathStr) &&
            !knownComplete
          ) {
            saved = await window.api.agent.invoke({
              id: call.id,
              name,
              arguments: {
                ...args,
                ...(landing ? { overwrite: true, append: false } : { append: true })
              }
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
          } else if (landing || sourceLimit || appendN > MAX_INCOMPLETE_APPENDS_PER_PATH) {
            if (!landing || sourceLimit) toolLoopHits++
            toolResult = {
              id: call.id,
              name,
              ok: true,
              content:
                `Wrote ${contentStr.length} chars to ${pathStr} (file on disk). ` +
                (sourceLimit || (!landing && appendN > MAX_INCOMPLETE_APPENDS_PER_PATH)
                  ? `INCOMPLETE_WRITE_LIMIT: stop tiny appends on "${pathStr}" — next call MUST be write_file overwrite=true with the COMPLETE file in one shot.`
                  : `INCOMPLETE_WRITE: next call write_file overwrite=true on "${pathStr}" with the COMPLETE file in one shot (do not tiny-append).`),
              editReview: saved.editReview
            }
          } else {
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
          }
        } else {
          toolResult = await window.api.agent.invoke({
            id: call.id,
            name,
            arguments: args
          })
          syntheticResult = false
          // Same-turn rewrite of a file we already started → append / landing overwrite
          if (
            name === 'write_file' &&
            !toolResult.ok &&
            /FILE_EXISTS|STUB_ON_DISK/i.test(toolResult.error ?? toolResult.content ?? '') &&
            pathStr &&
            contentStr
          ) {
            const pathInFlight =
              incompleteAppendsByPath.has(pathKey) ||
              checklist.incomplete.some((p) => loopPathKey(p) === pathKey)
            const stubReplace = /STUB_ON_DISK/i.test(
              toolResult.error ?? toolResult.content ?? ''
            )
            const landingRewrite =
              allowsLandingOverwrite(pathStr, contentStr.length) &&
              (/<!DOCTYPE\s+html|<html[\s>]/i.test(contentStr) ||
                contentLooksStructurallyComplete(contentStr, pathStr) ||
                contentStr.length >= 1500)
            if (pathInFlight && !landingRewrite && !stubReplace) {
              const appended = await window.api.agent.invoke({
                id: call.id,
                name,
                arguments: { ...args, append: true }
              })
              if (appended.ok) {
                const stillCut =
                  (Boolean(parsedArgs.truncated) || cutByLength) &&
                  !contentLooksStructurallyComplete(contentStr)
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
            } else if (landingRewrite || pathInFlight || stubReplace) {
              const priorComplete =
                bufferCompleteForPath(pathStr) ||
                (await pathLooksCompleteOnDisk(pathStr))
              const priorBody = /\.html?$/i.test(pathStr)
                ? lastHtmlWrite
                : /\.(jsx?|mjs|cjs)$/i.test(pathStr)
                  ? lastJsWrite
                  : /\.css$/i.test(pathStr)
                    ? lastCssWrite
                    : ''
              const incomingComplete = contentLooksStructurallyComplete(contentStr, pathStr)
              const incomingIncomplete =
                !incomingComplete ||
                (priorBody.length > 0 && contentStr.length < priorBody.length * 0.85)
              const patchFails = pathKey
                ? (patchFailsByPath.get(pathKey) ?? 0)
                : 0
              const allowFull =
                allowsComposerFullRewrite(params.userText) ||
                (patchFails >= MAX_PATCH_FAILS_BEFORE_OVERWRITE &&
                  !/\.html?$/i.test(pathStr))
              if (
                priorComplete &&
                !allowFull &&
                shouldHandoffWriteToApply({
                  userText: params.userText,
                  relativePath: pathStr
                })
              ) {
                name = 'apply_diff'
                toolResult = await invokeApplyHandoff(call.id, pathStr, contentStr)
              } else if (priorComplete && !allowFull) {
                toolResult = {
                  id: call.id,
                  name,
                  ok: false,
                  content: '',
                  error:
                    `FILE_COMPLETE: "${pathStr}" is already a complete file. Do NOT rewrite it. ` +
                    'Use apply_diff with a short instruction for the requested change only.'
                }
              } else if (priorComplete && incomingIncomplete && !allowFull) {
                toolResult = {
                  id: call.id,
                  name,
                  ok: false,
                  content: '',
                  error:
                    `FILE_COMPLETE: "${pathStr}" is already a complete file. Do NOT rewrite it. ` +
                    'Finish remaining plan steps with apply_diff instruction, or summarize.'
                }
              } else {
                // Allowed full rewrite (explicit request or patch-fail limit).
                const overwritten = await window.api.agent.invoke({
                  id: call.id,
                  name,
                  arguments: {
                    ...args,
                    overwrite: true,
                    append: false,
                    allow_full_rewrite: true
                  }
                })
                if (overwritten.ok) {
                  toolResult = {
                    ...overwritten,
                    content: `${overwritten.content} (auto-overwrite after FILE_EXISTS)`
                  }
                }
              }
            }
          } else if (
            name === 'write_file' &&
            !toolResult.ok &&
            /FILE_COMPLETE|SURGICAL_EDIT/i.test(toolResult.error ?? toolResult.content ?? '') &&
            pathStr &&
            shouldHandoffWriteToApply({
              userText: params.userText,
              relativePath: pathStr
            }) &&
            !Boolean(args.allow_full_rewrite)
          ) {
            name = 'apply_diff'
            toolResult = await invokeApplyHandoff(call.id, pathStr, contentStr)
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
          if (toolResult.ok && isCliVerifyCommand(cmd)) {
            ranCliSmoke = cliVerifyLooksSuccessful(cmd, toolResult.content, toolResult.ok)
          }
          if (
            isHtmlPreviewShell(cmd) ||
            markPreviewFromShell({
              command: cmd,
              content: toolResult.content,
              ok: toolResult.ok
            })
          ) {
            htmlPreviewOpened = true
          }
        }
        if (name === 'verify_project' && shellResultOpenedPreview(toolResult.content)) {
          htmlPreviewOpened = true
        }

        // Track apply_patch / apply_diff failures → unlock overwrite after 2 fails.
        if (
          (name === 'apply_patch' || name === 'apply_diff') &&
          !toolResult.ok &&
          !/WRITE_ONCE|WRITE_FILE_REQUIRED/i.test(toolResult.error ?? '')
        ) {
          const failPath = (
            toolResult.editReview?.path ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            filePath ||
            ''
          )
            .replace(/\\/g, '/')
            .trim()
          if (!failPath) {
            // Parse/format failure (e.g. "*** Begin Patch ***" envelope, no path).
            patchParseFails++
            const hint =
              patchParseFails >= MAX_PATCH_FAILS_BEFORE_OVERWRITE
                ? 'PATCH_FAIL_LIMIT: apply_patch keeps failing to parse. STOP using apply_patch. ' +
                  'Use apply_diff with relative_path + search_block/instruction (Chat applies the patch). Do NOT full-rewrite HTML. ' +
                  'Do NOT wrap the body in "*** Begin Patch ***".'
                : 'apply_patch parse error. Prefer apply_diff (relative_path + search_block or instruction); do not re-send the same malformed patch.'
            toolResult = {
              ...toolResult,
              content: `${toolResult.content || ''}\n${hint}`.trim(),
              error: toolResult.error ? `${toolResult.error}\n${hint}` : hint
            }
          } else {
            const n = (patchFailsByPath.get(loopPathKey(failPath)) ?? 0) + 1
            patchFailsByPath.set(loopPathKey(failPath), n)
            if (n >= MAX_PATCH_FAILS_BEFORE_OVERWRITE) {
              const isHtml = /\.html?$/i.test(failPath)
              const scratch = allowsComposerFullRewrite(params.userText)
              const hint = scratch
                ? `PATCH_FAIL_LIMIT: apply_patch/apply_diff failed ${n} times on "${failPath}". ` +
                  formatScratchWriteFileHint()
                : isHtml
                ? `PATCH_FAIL_LIMIT: apply_patch/apply_diff failed ${n} times on "${failPath}". ` +
                  `STOP rewriting. Try ONE different apply_diff with a shorter unique search_block from the file on disk, ` +
                  `or write an honest failure summary. Do NOT write_file the whole file.`
                : `PATCH_FAIL_LIMIT: apply_patch/apply_diff failed ${n} times on "${failPath}". ` +
                  `NOW use write_file with overwrite=true, allow_full_rewrite=true, and the full corrected file content. Do not retry the same hunk.`
              toolResult = {
                ...toolResult,
                content: `${toolResult.content || ''}\n${hint}`.trim(),
                error: toolResult.error
                  ? `${toolResult.error}\n${hint}`
                  : hint
              }
            }
          }
        } else if (
          (name === 'apply_patch' || name === 'apply_diff') &&
          toolResult.ok
        ) {
          const okPath = (
            toolResult.editReview?.path ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            filePath ||
            ''
          )
            .replace(/\\/g, '/')
            .trim()
          if (okPath) {
            const key = loopPathKey(okPath)
            patchOkByPath.set(key, (patchOkByPath.get(key) ?? 0) + 1)
          }
        }

        applyToolToChecklist(checklist, name, args, toolResult)
        if (
          toolResult.ok &&
          (name === 'write_file' || name === 'apply_diff' || name === 'apply_patch')
        ) {
          const wrotePath = (
            toolResult.editReview?.path ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            filePath ||
            ''
          )
            .replace(/\\/g, '/')
            .trim()
          const extraReadme =
            looksLikeSurgicalFollowUp(params.userText) &&
            /(?:^|\/)readme\.md$/i.test(wrotePath) &&
            !/readme/i.test(params.userText)
          if (!extraReadme) {
            mutatingEditOk = true
            mutatingEditFailed = false
          }
          if (wrotePath) writtenOkPaths.add(wrotePath)
        } else if (
          !toolResult.ok &&
          (name === 'write_file' || name === 'apply_diff' || name === 'apply_patch') &&
          !/WRITE_ONCE|WRITE_FILE_REQUIRED/i.test(toolResult.error ?? '')
        ) {
          mutatingEditFailed = true
          const failPath =
            (
              toolResult.editReview?.path ||
              (typeof args.relative_path === 'string' ? args.relative_path : '') ||
              filePath ||
              ''
            )
              .replace(/\\/g, '/')
              .trim() || '(no path)'
          const errBrief = String(toolResult.error || toolResult.content || 'edit failed')
            .replace(/\s+/g, ' ')
            .slice(0, 160)
          lastMutatingFailDetail = `${failPath}: ${errBrief}`
        }
        if (toolResult.ok && name === 'write_file' && typeof args.content === 'string') {
          const body = args.content
          const wp =
            filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '')
          const looksHtmlDoc =
            /<!DOCTYPE\s+html|<html[\s>]/i.test(body) && /<\/html/i.test(body)
          if (looksHtmlDoc || (wp && /\.html?$/i.test(wp))) {
            lastHtmlWrite = args.append ? `${lastHtmlWrite}${body}` : body
            if (wp) lastHtmlWritePath = wp
          }
          if (wp && /\.(jsx?|tsx|mjs|cjs)$/i.test(wp) && !isViteConfigPath(wp)) {
            lastJsWrite = args.append ? `${lastJsWrite}${body}` : body
            lastJsWritePath = wp
          }
          if (wp && /\.css$/i.test(wp)) {
            lastCssWrite = args.append ? `${lastCssWrite}${body}` : body
            lastCssWritePath = wp
          }
          if (wp) writtenOkPaths.add(wp.replace(/\\/g, '/'))
          if (
            contentLooksStructurallyComplete(lastHtmlWrite)
          ) {
            const writtenKey = loopPathKey(wp)
            if (writtenKey) completeHtmlByPath.add(writtenKey)
          }
        }
        // Surgical HTML edits never pass full file as args.content — refresh from disk
        // so later evidence can match the file the model actually patched.
        if (
          toolResult.ok &&
          (name === 'apply_diff' || name === 'apply_patch') &&
          /\.html?$/i.test(filePath || String(args.relative_path ?? ''))
        ) {
          const htmlPath =
            filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            lastHtmlWritePath ||
            'index.html'
          try {
            const disk = await window.api.workspace.readFile(htmlPath)
            if (
              disk.ok &&
              typeof disk.content === 'string' &&
              (/<html[\s>]|<!DOCTYPE/i.test(disk.content) ||
                contentLooksStructurallyComplete(disk.content))
            ) {
              lastHtmlWrite = disk.content
              lastHtmlWritePath = htmlPath
              if (contentLooksStructurallyComplete(lastHtmlWrite)) {
                const k = loopPathKey(htmlPath)
                if (k) completeHtmlByPath.add(k)
              }
            }
          } catch {
            /* ignore — plan may still close via soft-step rules */
          }
        }
        if (
          toolResult.ok &&
          (name === 'apply_diff' || name === 'apply_patch') &&
          /\.(jsx?|tsx|mjs|cjs)$/i.test(filePath || String(args.relative_path ?? '')) &&
          !isViteConfigPath(filePath || String(args.relative_path ?? ''))
        ) {
          const jsPath =
            filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            lastJsWritePath
          try {
            const disk = await window.api.workspace.readFile(jsPath)
            if (disk.ok && typeof disk.content === 'string') {
              lastJsWrite = disk.content
              lastJsWritePath = jsPath
            }
          } catch {
            /* ignore */
          }
        }
        if (
          toolResult.ok &&
          (name === 'apply_diff' || name === 'apply_patch') &&
          /\.css$/i.test(filePath || String(args.relative_path ?? ''))
        ) {
          const cssPath =
            filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            lastCssWritePath
          try {
            const disk = await window.api.workspace.readFile(cssPath)
            if (disk.ok && typeof disk.content === 'string') {
              lastCssWrite = disk.content
              lastCssWritePath = cssPath
            }
          } catch {
            /* ignore */
          }
        }
        if (
          toolResult.ok &&
          (name === 'write_file' || name === 'apply_diff' || name === 'apply_patch') &&
          !/INCOMPLETE_WRITE/i.test(toolResult.content ?? '')
        ) {
          const written =
            filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '') ||
            lastJsWritePath ||
            lastHtmlWritePath
          let html = lastHtmlWrite
          if (!html && /\.html?$/i.test(written)) {
            try {
              const disk = await window.api.workspace.readFile(written || 'index.html')
              if (disk.ok && typeof disk.content === 'string') html = disk.content
            } catch {
              /* ignore */
            }
          }
          if (!html) {
            try {
              const disk = await window.api.workspace.readFile(lastHtmlWritePath || 'index.html')
              if (
                disk.ok &&
                typeof disk.content === 'string' &&
                contentLooksStructurallyComplete(disk.content, lastHtmlWritePath || 'index.html')
              ) {
                html = disk.content
                lastHtmlWrite = disk.content
              }
            } catch {
              /* ignore */
            }
          }
          let body =
            (typeof args.content === 'string' && name === 'write_file' ? args.content : '') ||
            (/\.html?$/i.test(written) ? lastHtmlWrite : '') ||
            (/\.(jsx?|tsx|mjs|cjs)$/i.test(written) ? lastJsWrite : '') ||
            (/\.css$/i.test(written) ? lastCssWrite : '') ||
            ''
          if (!body && written) {
            try {
              const disk = await window.api.workspace.readFile(written)
              if (disk.ok && typeof disk.content === 'string') body = disk.content
            } catch {
              /* ignore */
            }
          }
          const capKey = loopPathKey(written)
          const writesBefore = capKey
            ? (completeLandingWritesByPath.get(capKey) ?? 0)
            : 0
          if (
            allowsComposerFullRewrite(params.userText) &&
            capKey &&
            isCappedLandingWritePath(written) &&
            contentLooksStructurallyComplete(body, written)
          ) {
            completeLandingWritesByPath.set(capKey, writesBefore + 1)
          }
          const sanity = formatEditSanityHint({
            path: written,
            content: body,
            html: html || lastHtmlWrite,
            js: lastJsWrite,
            css: lastCssWrite,
            cssPath: lastCssWritePath,
            jsPath: lastJsWritePath,
            userText: params.userText
          })
          if (sanity && isEditSanityFailure(sanity)) {
            toolResult = {
              ...toolResult,
              content: `${toolResult.content || ''}\n${sanity}`.trim()
            }
            editSanityFailed = /EDIT_SANITY/i.test(sanity)
            i18nSanityFailed = /I18N_SANITY/i.test(sanity)
            if (i18nSanityFailed) lastI18nHint = sanity
          } else {
            editSanityFailed = false
            i18nSanityFailed = false
          }
          if (
            isLandingPageScriptPath(written) &&
            !looksLikeViteReactTask(params.userText, lastHtmlWrite || html, written) &&
            !contentLooksStructurallyComplete(lastHtmlWrite || html || '', 'index.html')
          ) {
            toolResult = {
              ...toolResult,
              content: `${toolResult.content || ''}\n${formatLandingJsBeforeHtmlHint()}`.trim()
            }
          }
          if (
            looksLikeViteReactFromScratch(params.userText) &&
            !looksLikeSurgicalFollowUp(params.userText)
          ) {
            const missingNow = viteReactScaffoldMissing([
              ...writtenOkPaths,
              ...turnFileChanges.keys(),
              written
            ])
            if (missingNow.length) {
              toolResult = {
                ...toolResult,
                content: `${toolResult.content || ''}\n${formatViteReactScaffoldHint(missingNow)}`.trim()
              }
            }
          }
        }
        if (
          toolResult.ok &&
          name === 'read_file' &&
          readRangeKey &&
          !syntheticResult &&
          typeof toolResult.content === 'string'
        ) {
          readFileCache.set(readRangeKey, toolResult.content)
          lastReadByPath.set(pathKeyForLoop, toolResult.content)
        }
        if (
          toolResult.ok &&
          name === 'read_file' &&
          typeof toolResult.content === 'string' &&
          !/^\[read_file (?:meta|range)\]/i.test(toolResult.content.trim()) &&
          (/\.html?$/i.test(filePath || '') ||
            /<html[\s>]|<!DOCTYPE/i.test(toolResult.content)) &&
          contentLooksStructurallyComplete(toolResult.content)
        ) {
          lastHtmlWrite = toolResult.content
          if (filePath) lastHtmlWritePath = filePath
        }
        if (!syntheticResult) {
          const advanced = advanceTodosOnEvidence(todoSteps, evidenceLog, {
            name,
            ok: toolResult.ok,
            path: filePath,
            command: typeof args.command === 'string' ? args.command : undefined,
            content: toolResult.content
          })
          todoSteps = advanced.steps
          evidenceLog.splice(0, evidenceLog.length, ...advanced.evidence)
          if (todoSteps.length > 0) {
            paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
          }
        }
        if (
          !toolResult.ok ||
          /TOOL_LOOP|INCOMPLETE_WRITE_LIMIT|FILE_EXISTS|FILE_COMPLETE|STUB_ON_DISK|EMPTY_WRITE|PATCH_OK_LIMIT|PATCH_FAIL_LIMIT|SMART_APPLY_FAIL|APPLY_UNAVAILABLE|THINK_REQUIRED|SURGICAL_EDIT|SURGICAL_CSS|I18N_SANITY|EDIT_SANITY|WRITE_ONCE|WRITE_FILE_REQUIRED/i.test(
            toolResult.error ?? toolResult.content ?? ''
          )
        ) {
          if (/FILE_COMPLETE/i.test(toolResult.error ?? toolResult.content ?? '')) {
            fileCompleteHits++
          }
          if (/SMART_APPLY_FAIL|APPLY_UNAVAILABLE/i.test(toolResult.error ?? toolResult.content ?? '')) {
            smartApplyFailHits++
          }
          logAgentToolEvent(
            `${name}: ${toolResult.error || toolResult.content || (toolResult.ok ? 'ok' : 'fail')}`.slice(
              0,
              500
            ),
            {
              tool: name,
              ok: toolResult.ok,
              path: filePath || null
            }
          )
        }

        let content = toolResult.ok
          ? toolResult.content.slice(0, TOOL_RESULT_CHARS)
          : `${toolResult.error ? `ERROR: ${toolResult.error}\n` : ''}${toolResult.content}`.slice(
              0,
              TOOL_RESULT_CHARS
            )
        if (toolResult.ok && name === 'read_file') {
          const readBudget = readFileCharBudget(ctxSize)
          // Head-only slice looked like EOF → false "file truncated at ~250 lines".
          if (/^\[read_file (?:meta|range)\]/i.test(toolResult.content.trim())) {
            content = toolResult.content.slice(0, Math.max(readBudget, 12_000))
          } else {
            content = packReadFileForAgent(toolResult.content, {
              ctxSize,
              relativePath:
                typeof args.relative_path === 'string' ? args.relative_path : ''
            })
          }
        }
        // Keep image-gen out of the context window — never pass bytes or long blobs back.
        if (name === 'generate_image') {
          const out =
            toolResult.filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : 'generated/image.png')
          if (toolResult.ok) {
            content = `OK: saved ${out.replace(/\\/g, '/')}. IMAGE_DONE — do not read_file or edit the PNG. Continue other requested work if any.`
          } else {
            content =
              `ERROR: ${(toolResult.error || 'image gen failed').slice(0, 400)}\n` +
              'IMAGE_GEN_FAILED: do NOT call generate_image again this turn. Continue remaining work without the image (HTML: CSS/placeholder; other stacks: skip it).'
          }
        } else if (
          toolResult.ok &&
          (name === 'write_file' || name === 'apply_patch' || name === 'apply_diff')
        ) {
          // Don't keep multi-KB file bodies in the tool transcript — that forced compact after every write.
          const p =
            toolResult.filePath ||
            (typeof args.relative_path === 'string' ? args.relative_path : '')
          content = (toolResult.content || `OK: wrote ${p}`).slice(0, 400)
        }

        if (
          !toolResult.ok &&
          (params.signal?.aborted ||
            /USER_STOPPED|Interrupted by Stop/i.test(content))
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

        // generate_image succeeded — keep the result even if the user/system
        // aborted during chat-model restore (otherwise the PNG is invisible).
        if (
          toolResult.ok &&
          name === 'generate_image' &&
          params.signal?.aborted
        ) {
          const idx = messages.findIndex((m) => m.id === statusId)
          const outPath =
            toolResult.filePath ||
            (typeof args.relative_path === 'string'
              ? args.relative_path
              : filePath)
          let images = messages[idx]?.images
          if (outPath && params.sessionId) {
            try {
              const root = await window.api.workspace.getRoot()
              if (root) {
                const abs = outPath.match(/^[a-zA-Z]:[\\/]/)
                  ? outPath
                  : `${root.replace(/[\\/]+$/, '')}/${outPath.replace(/^[/\\]+/, '')}`
                const meta = await window.api.chatImages.import({
                  sessionId: params.sessionId,
                  sourcePath: abs.replace(/\//g, '\\'),
                  name: outPath.split(/[/\\]/).pop()
                })
                images = [meta]
              }
            } catch {
              /* preview optional */
            }
          }
          if (idx !== -1) {
            const doneActivity = activityForTool(name, args, {
              streaming: false,
              ok: true,
              resultContent: content
            })
            messages[idx] = {
              ...messages[idx],
              content: formatActivityLabel(doneActivity),
              toolName: name,
              streaming: false,
              activity: doneActivity,
              filePath: outPath ?? messages[idx].filePath,
              images
            }
          }
          params.onUpdate([...messages])
          return finishStopped('⏹ Stopped after image gen (chat restore). Image was saved.')
        }

        const idx = messages.findIndex((m) => m.id === statusId)
        if (idx !== -1) {
          const incomplete = /INCOMPLETE_WRITE/i.test(content)
          const incompleteSaved =
            incomplete &&
            toolResult.ok &&
            !/INCOMPLETE_WRITE_LIMIT/i.test(content)
          const softRedirect =
            !toolResult.ok &&
            /FILE_COMPLETE|FILE_EXISTS|STUB_ON_DISK|EMPTY_WRITE|OVERWRITE_BLOCKED|INLINE_ASSET|SURGICAL_EDIT|SURGICAL_CSS/i.test(
              toolResult.error ?? toolResult.content ?? content
            )
          const reviewPath =
            toolResult.editReview?.path ??
            (filePath ? filePath.replace(/\\/g, '/') : undefined)
          // Retarget styles.css → index.html: show the real path in the activity chip.
          const displayPath =
            reviewPath ||
            (typeof args.relative_path === 'string' ? args.relative_path : undefined)
          const activityArgs =
            displayPath &&
            typeof args.relative_path === 'string' &&
            args.relative_path.replace(/\\/g, '/') !== displayPath
              ? { ...args, relative_path: displayPath }
              : args
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
          const doneActivity = activityForTool(name, activityArgs, {
            streaming: false,
            ok: toolResult.ok,
            partial: incompleteSaved,
            resultContent: content,
            fileCount: exploreFileCount
          })
          const errNote =
            !toolResult.ok &&
            !softRedirect &&
            (toolResult.error || toolResult.content)
              ? ` — ${(toolResult.error || toolResult.content)
                  .replace(/\s+/g, ' ')
                  .slice(0, name === 'generate_image' ? 400 : 140)}`
              : softRedirect
                ? formatWriteRedirectChip(
                    toolResult.error ?? toolResult.content ?? content,
                    uiLang
                  )
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
                : name === 'execute_terminal_command'
                  ? (content || messages[idx].codePreview || '').slice(0, 4000)
                  : undefined,
            filePath:
              toolResult.filePath ||
              displayPath ||
              filePath ||
              messages[idx].filePath,
            editReview: showReview
              ? { path: reviewPath!, status: 'pending' }
              : autoApprove && reviewPath && toolResult.ok
                ? { path: reviewPath, status: 'accepted' }
                : messages[idx].editReview,
            diffStat: toolResult.diffStat ?? messages[idx].diffStat
          }
          if (
            name === 'execute_terminal_command' &&
            markPreviewFromShell({
              command: String(args.command ?? ''),
              content,
              ok: toolResult.ok
            })
          ) {
            htmlPreviewOpened = true
          }

          if (toolResult.ok && name === 'generate_image' && params.sessionId) {
            const outPath =
              toolResult.filePath ||
              (typeof args.relative_path === 'string'
                ? args.relative_path
                : filePath)
            if (outPath) {
              try {
                const root = await window.api.workspace.getRoot()
                if (root) {
                  const abs = /^[a-zA-Z]:[\\/]/.test(outPath)
                    ? outPath
                    : `${root.replace(/[\\/]+$/, '')}\\${outPath.replace(/^[/\\]+/, '').replace(/\//g, '\\')}`
                  const meta = await window.api.chatImages.import({
                    sessionId: params.sessionId,
                    sourcePath: abs,
                    name: outPath.split(/[/\\]/).pop()
                  })
                  messages[idx] = {
                    ...messages[idx],
                    filePath: outPath.replace(/\\/g, '/'),
                    images: [meta]
                  }
                }
              } catch {
                /* preview optional — file is still on disk */
              }
            }
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
                  args,
                  toolResult.diffStat
                )
              }
            } else {
              recordTurnFileChange(
                turnFileChanges,
                name,
                changePath,
                preview,
                args,
                toolResult.diffStat
              )
            }
          }
        }

        apiMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content
        })
        maybeSlimWritesForCtx(apiMessages, ctxSize)
        params.onUpdate([...messages])
        // Do not auto-open every edited/created file — agents can touch hundreds of paths.
        // Users open paths from chat file chips / explorer when they want a tab.
      }

      // After generate_image-only rounds, still let the model continue when the
      // user asked for more than images (landing page + hero, etc.).
      // (Former early-return stopped mixed tasks after the first PNG.)

      if (htmlPreviewOpened || mutatingEditOk) {
        if (!mutatingEditFailed && !editSanityFailed && !i18nSanityFailed) {
          todoSteps = settlePlanAfterWork(todoSteps, {
            previewOpened: htmlPreviewOpened,
            edited: mutatingEditOk
          })
        }
        if (todoSteps.length > 0) {
          paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
        }
      }

      const workSettled =
        htmlPreviewOpened &&
        mutatingEditOk
      const cliWorkDone =
        looksLikeFromScratchRunTask(params.userText) &&
        mutatingEditOk &&
        ranCliSmoke &&
        !mutatingEditFailed &&
        !editSanityFailed
      if (workSettled || cliWorkDone) {
        settledStopAsked = true
        concludeAsked = true
        pinFallbackCloserIfNeeded()
        params.onUpdate([...messages])
        return finishWithTiming(messages)
      }

      // Hints on tool result — inserting `user` after `tool` breaks Devstral Jinja
      const lastTool = apiMessages[apiMessages.length - 1]
      if (lastTool?.role === 'tool') {
        const tc = apiContentText(lastTool.content)
        if (/IMAGE_DONE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'IMAGE_DONE: do not read_file/edit the PNG. If the user also asked for code or other files, continue those tools now. If the request was image-only, one short confirmation is enough.'
          )
        } else if (/INCOMPLETE_WRITE_LIMIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'INCOMPLETE_WRITE_LIMIT: do not append tiny chunks to that path. Write a larger chunk (≥200 chars) once, or move on to the next unfinished file.'
          )
        } else if (/READ_BUDGET/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'READ_BUDGET: stop reading. You already have this file in the transcript. ' +
              'Locate code with search_codebase (it does literal text search), then call apply_diff with an exact search_block.'
          )
        } else if (/MISSING_PATH/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'MISSING_PATH: call write_file or apply_diff with relative_path FIRST (e.g. "js/main.js"). Never omit the path.'
          )
        } else if (/TOOL_MARKUP_IN_CONTENT|TOOL_LOOP/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'Do not repeat the failed call. Use structured tools only; write_file content must be pure source code with no tool markup.'
          )
        } else if (/WRITE_FILE_REQUIRED/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'WRITE_FILE_REQUIRED: this landing file is new or not complete this turn. ' +
              formatScratchWriteFileHint()
          )
        } else if (/CLI_EMPTY|GO_SPLIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            /GO_SPLIT/i.test(tc)
              ? 'GO_SPLIT: regexp.Split(s, n) — n=0 returns nil (no words). Use n=-1 to split all. Then re-run. Do not stop.'
              : 'CLI_EMPTY: exit_code=0 but stdout has no counted words. Fix the tokenizer and re-run go run / python. Do not write a closing summary yet.'
          )
        } else if (/I18N_SANITY|EDIT_SANITY|LANDING_CONTRACT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            /I18N_SANITY/i.test(tc) && !/HTML class names are not in CSS|Inline SVG|stylesheet/i.test(tc)
              ? /visible fallback|no visible fallback/i.test(tc)
                ? `${(lastI18nHint || tc).split('\n')[0]} ` +
                  'Fix index.html ONCE: put visible default-language text inside data-i18n tags. ' +
                  'Reuse CSS class names. Match JS keys. Then STOP. Do not rewrite js/main.js.'
                : `${(lastI18nHint || tc).split('\n')[0]} ` +
                  'Fix js/main.js ONCE (string dict + matching keys), then STOP. ' +
                  'Do not write tmp/check.js, node -e, or rename HTML keys in a loop. ' +
                  'Do not claim the language switcher works yet.'
              : /structurally incomplete/i.test(tc)
                ? 'EDIT_SANITY: the last file is structurally incomplete. Finish THAT path before claiming done. Do not start another file.'
                : 'LANDING_CONTRACT: HTML/CSS/JS must be ONE page. Reuse class names already in styles.css ' +
                  '(do not invent .site-header if CSS has .navbar). Size inline SVG (width/height). ' +
                  'JS #id and data-i18n keys must match HTML. apply_diff the mismatched file. ' +
                  'Do NOT Start-Process / claim done until the contract holds.'
          )
        } else if (/INCOMPLETE_WRITE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'INCOMPLETE_WRITE: if this is a NEW unfinished file, next call MUST be write_file append=true on the SAME path. ' +
              'If the file was already complete, do NOT overwrite — apply_diff with a short instruction only.'
          )
        } else if (/EMPTY_WRITE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'EMPTY_WRITE: relative_path alone is not a write. Call write_file with the FULL file in content. ' +
              'Do not copy compact stubs (note / FILE_COMPLETE on disk / [omitted]).'
          )
        } else if (/STUB_ON_DISK/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'STUB_ON_DISK: that path is a placeholder, not a finished file. ' +
              'Call write_file overwrite=true with the FULL content. Do not apply_diff the stub.'
          )
        } else if (/FILE_COMPLETE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            allowsComposerFullRewrite(params.userText)
              ? 'FILE_COMPLETE: this is a from-scratch / full rebuild. Do NOT retry Apply. ' +
                'Call write_file overwrite=true allow_full_rewrite=true with the COMPLETE file content for that path.'
              : 'FILE_COMPLETE: that file is already on disk and looks finished. Do NOT write_file / overwrite / rewrite it. ' +
                'Call apply_diff with a short instruction (or a unique search_block). Then verify or summarize.'
          )
        } else if (/SMART_APPLY_FAIL|APPLY_UNAVAILABLE/i.test(tc)) {
          appendToolHint(
            apiMessages,
            allowsComposerFullRewrite(params.userText)
              ? 'SMART_APPLY_FAIL: Apply cannot patch a new or incomplete landing file. ' +
                formatScratchWriteFileHint()
              : 'APPLY_UNAVAILABLE / SMART_APPLY_FAIL: Chat could not apply the patch. ' +
                'Call apply_diff with an exact short search_block. Never write_file overwrite a complete module.'
          )
        } else if (/FILE_EXISTS/i.test(tc)) {
          appendToolHint(
            apiMessages,
            allowsComposerFullRewrite(params.userText)
              ? 'FILE_EXISTS: this is a rebuild. Call write_file overwrite=true allow_full_rewrite=true with the COMPLETE file. Do NOT apply_diff a whole module.'
              : 'FILE_EXISTS: existing HTML/CSS/JS → apply_diff with a short instruction (or search_block). ' +
                'write_file overwrite only for a NEW small file or an explicit full rewrite.'
          )
        } else if (/INLINE_ASSET/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'Decide from disk: if CSS is only inline in index.html and the tweak is small, apply_diff there. ' +
              'If the user wants styles.css or a multi-file layout, create styles.css and link it — that is allowed.'
          )
        } else if (/SURGICAL_CSS/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'SURGICAL_CSS: styles.css must stay intact. apply_diff only the navbar/header rules ' +
              '(small search_block). Do not overwrite or regenerate the stylesheet.'
          )
        } else if (/SURGICAL_EDIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'SURGICAL_EDIT: do not dump the whole file. apply_diff with a short instruction only ' +
              '(no whole-file search_block). Do NOT write_file overwrite.'
          )
        } else if (/OVERWRITE_BLOCKED/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'OVERWRITE_BLOCKED: prefer apply_diff/apply_patch. Full overwrite of a complete file needs an explicit rewrite request (allow_full_rewrite). Never use patch-fail as an excuse to rewrite the whole file.'
          )
        } else if (/PATCH_OK_LIMIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'PATCH_OK_LIMIT: stop apply_patch/apply_diff on that path. Do NOT rewrite this file. Write a short honest summary (compiler stacks: verify_project once if not done).'
          )
        } else if (/PATCH_FAIL_LIMIT/i.test(tc)) {
          appendToolHint(
            apiMessages,
            /html|landing|<\/html>/i.test(tc)
              ? 'PATCH_FAIL_LIMIT on HTML: do NOT rewrite. Summarize failure and stop (Chat already tried Morph apply if available).'
              : 'PATCH_FAIL_LIMIT: stop retrying apply_patch/apply_diff. For non-HTML you may write_file with overwrite=true and allow_full_rewrite=true.'
          )
        } else if (/PROCESS_ENDED/i.test(tc)) {
          appendToolHint(
            apiMessages,
            'PROCESS_ENDED: the user closed the app or it finished normally. Do NOT rewrite or relaunch. Stop and wait for the user.'
          )
        } else if (
          /COMPILER_MISSING/i.test(tc) ||
          (/не распознано|not recognized|CommandNotFoundException/i.test(tc) &&
            /\bg\+\+|gcc(?:\.exe)?/i.test(tc))
        ) {
          appendToolHint(
            apiMessages,
            'COMPILER_MISSING: g++ is not in PATH. Do not winget, choco, or download MinGW/7z. ' +
              'Run MSVC: cl /EHsc /Fe:wordfreq wordfreq.cpp then .\\wordfreq.exe test.txt. ' +
              'If cl is missing, stop and say so.'
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
          !/✓/.test(tc) &&
          !/TOOL_LOOP|PATCH_OK_LIMIT|PATCH_FAIL_LIMIT|IMAGE_/i.test(tc)
        ) {
          appendToolHint(
            apiMessages,
            'Tool failed: one short <think> with the cause and next step, then ONE corrective tool call (prefer apply_diff for HTML tweaks). Do not re-read the same file in a loop.'
          )
        }
      }
      apiMessages = normalizeApiMessages(apiMessages)
      if (params.signal?.aborted) return finishStopped()

      // Reading and searching forever without writing is how turns burned 60+
      // rounds. After three such rounds, demand the edit.
      {
        const inspectedOnly = toolCalls.every((c) =>
          ['read_file', 'search_codebase', 'list_directory', 'get_diagnostics'].includes(
            c.function.name
          )
        )
        readOnlyRounds = inspectedOnly ? readOnlyRounds + 1 : 0
        if (readOnlyRounds >= 3 && readOnlyNudges < 2) {
          readOnlyNudges++
          readOnlyRounds = 0
          appendToolHint(
            apiMessages,
            'You have only inspected code for three rounds. Make the edit NOW with write_file / apply_diff ' +
              '(dependency file first, then the file that references it). No more read_file or search_codebase ' +
              'until something has been written.'
          )
          apiMessages = normalizeApiMessages(apiMessages)
        }
      }

      const htmlPatchFailHard = [...patchFailsByPath.entries()].some(
        ([p, n]) =>
          n >= MAX_PATCH_FAILS_BEFORE_OVERWRITE && /\.html?$/i.test(p)
      )
      if (
        !htmlOverwriteEscalated &&
        (fileCompleteHits >= 2 || smartApplyFailHits >= 2 || htmlPatchFailHard)
      ) {
        htmlOverwriteEscalated = true
        fileCompleteHits = 0
        smartApplyFailHits = 0
        appendToolHint(
          apiMessages,
          allowsComposerFullRewrite(params.userText)
            ? 'Apply/patch is stuck on this from-scratch landing. ' + formatScratchWriteFileHint()
            : 'Apply/patch is stuck on this file. Do NOT write_file / overwrite / rewrite it whole. ' +
              'One apply_diff with replace_all=true if this is a rename, or a short honest summary of what failed.'
        )
        apiMessages = normalizeApiMessages(apiMessages)
      }

      // Repeated identical tools: stop. Do not reset the counter and wander.
      if (toolLoopHits >= MAX_TOOL_LOOP_HITS || missingPathHits >= MAX_MISSING_PATH_HITS) {
        const missing = missingPathHits >= MAX_MISSING_PATH_HITS
        const alreadyWarned = loopRecoveryWarned
        if (!loopRecoveryWarned) {
          loopRecoveryWarned = true
          messages.push({
            id: uid(),
            role: 'assistant',
            content: missing
              ? translate(uiLang, 'chat.agent.recoveringPath')
              : translate(uiLang, 'chat.agent.recoveringTools')
          })
          params.onUpdate([...messages])
        }
        if (!missing && (htmlPreviewOpened || mutatingEditOk)) {
          concludeAsked = true
          settledStopAsked = true
          if (!mutatingEditFailed && !editSanityFailed && !i18nSanityFailed) {
            todoSteps = settlePlanAfterWork(todoSteps, {
              previewOpened: htmlPreviewOpened,
              edited: mutatingEditOk
            })
          }
          if (todoSteps.length > 0) {
            paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
          }
          if (alreadyWarned) {
            forceEndTurn = true
            pinFallbackCloserIfNeeded()
            params.onUpdate([...messages])
            return finishWithTiming(messages)
          }
          appendToolHint(
            apiMessages,
            'CRITICAL: stop repeating tools. Preview/edits already happened. Write a short summary NOW. No more Start-Process, apply_diff, or get_diagnostics.'
          )
          apiMessages = normalizeApiMessages(apiMessages)
          params.onUpdate([...messages])
          continue
        }
        if (missing) missingPathHits = 0
        else toolLoopHits = 0
        appendToolHint(
          apiMessages,
          missing
            ? 'CRITICAL: previous writes had no relative_path. Call write_file/create_directory WITH relative_path (e.g. src/main.py or index.html). Then continue the task.'
            : 'CRITICAL recovery: do NOT repeat the same tool+args. One different edit or a short honest summary. Do not Start-Process again if the preview is open.'
        )
        apiMessages = normalizeApiMessages(apiMessages)
      }
      upsertPlanningNextMoves(messages)
      params.onUpdate([...messages])
      continue
    }

    // Final assistant text must enter apiMessages before any follow-up user nudge
    const rawFinal = preferUserFacingCloser((result.text ?? '').trim(), uiLang)
    const stuttered = streamAbortReason === 'prose_stutter' || detectProseStutter(rawFinal)
    const cleanFinal = stuttered ? dedupeStutteringProse(rawFinal) : rawFinal

    // Chat Q&A: prose answer is success — never demand tools or loop closings.
    if (
      chatQa &&
      !toolCalls?.length &&
      cleanFinal.trim().length >= 40 &&
      !looksLikeSurgicalFollowUp(params.userText)
    ) {
      const si = messages.findIndex((m) => m.id === streamId)
      const answer = cleanFinal.trim()
      if (si !== -1) {
        messages[si] = {
          ...messages[si]!,
          streaming: false,
          content: answer
        }
      } else {
        ensureClosingMessage(messages, userMessageId, answer)
      }
      lastClosingText = answer
      if (todoSteps.length > 0) {
        todoSteps = todoSteps.map((s) => ({ ...s, status: 'done' as const }))
        paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
      }
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    // Think+plan done but no tool call. Nudge a few times, then stop honestly.
    // We never "apply the edit ourselves" — that produced instant fake success.
    const fakeProgress =
      !toolCalls?.length &&
      (isFalseSuccessProse(cleanFinal) ||
        /файлы?\s+создан|создаю\s+(styles|js\/|index)|files?\s+created/i.test(cleanFinal))
    const fp = cleanFinal.replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase()
    const repeatedNoToolProse =
      !toolCalls?.length &&
      completedTools === 0 &&
      Boolean(fp) &&
      fp === lastNoToolFingerprint
    if (repeatedNoToolProse || stuttered) {
      proseStutterHits++
      emptyToolNudges = Math.max(emptyToolNudges, 1)
    }
    if (!toolCalls?.length && completedTools === 0 && fp) {
      lastNoToolFingerprint = fp
    }

    // Stutter on chat Q&A only — never accept fake "created files" prose as a coding done.
    if (
      chatQa &&
      stuttered &&
      !toolCalls?.length &&
      cleanFinal.trim().length >= 80 &&
      !looksLikeFileEditRequest(params.userText)
    ) {
      const si = messages.findIndex((m) => m.id === streamId)
      if (si !== -1) {
        messages[si] = {
          ...messages[si]!,
          streaming: false,
          content: cleanFinal.trim()
        }
      }
      lastClosingText = cleanFinal.trim()
      ensureClosingMessage(messages, userMessageId, lastClosingText)
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    const wantsFileEdit = looksLikeFileEditRequest(params.userText)
    const emptyNudgeLimit =
      fakeProgress || wantsFileEdit || looksLikeSurgicalFollowUp(params.userText) || proseStutterHits > 0
        ? wantsFileEdit || fakeProgress
          ? 5
          : 2
        : 3
    if (
      !chatQa &&
      !toolCalls?.length &&
      thinkSatisfied &&
      completedTools === 0 &&
      emptyToolNudges < emptyNudgeLimit &&
      round < maxRounds - 1
    ) {
      emptyToolNudges++
      const si = messages.findIndex((m) => m.id === streamId)
      if (si !== -1) {
        messages[si] = {
          ...messages[si]!,
          streaming: false,
          content:
            uiLang === 'ru'
              ? fakeProgress || /создаю|созданн|обновляю/i.test(cleanFinal)
                ? '↻ Текст без tools ничего не меняет — нужен apply_diff / write_file…'
                : streamAbortReason === 'prose_stutter'
                  ? '↻ Обрыв зацикленного текста — жду реальный вызов инструментов…'
                  : '↻ Плана мало — жду реальный вызов инструментов…'
              : fakeProgress || /creating|created files|updating/i.test(cleanFinal)
                ? '↻ Prose changes nothing — need apply_diff / write_file…'
                : streamAbortReason === 'prose_stutter'
                  ? '↻ Cut stuttering prose — waiting for a real tool call…'
                  : '↻ A plan is not enough — waiting for a real tool call…'
        }
      }
      params.onUpdate([...messages])
      pushUserMessage(
        apiMessages,
        (fakeProgress || isFalseSuccessProse(cleanFinal)
          ? 'STOP narrating. You claimed files were created/updated but called ZERO tools — disk is unchanged. '
          : streamAbortReason === 'prose_stutter'
            ? 'STOP narrating. You looped the same prose with ZERO tool calls — nothing changed on disk. '
            : 'You produced text but NO tool call, so nothing changed on disk. ') +
          'Act NOW with a structured tool call: ' +
          (looksLikeSurgicalFollowUp(params.userText)
            ? formatSurgicalFollowUpHint({
                stacks,
                i18nFix: looksLikeI18nFollowUp(params.userText)
              }) + ' '
            : 'list_directory / read_file to inspect, then write_file for a missing file or apply_diff / apply_patch for an existing one. ') +
          `User request: «${params.userText.trim().slice(0, 240)}». ` +
          'Never answer "Готово" / "Файлы созданы" / "Done" without a successful tool call — that is a lie.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      continue
    }

    if (
      !chatQa &&
      !toolCalls?.length &&
      thinkSatisfied &&
      completedTools === 0 &&
      (emptyToolNudges >= emptyNudgeLimit || (proseStutterHits >= 2 && !wantsFileEdit))
    ) {
      const siStop = messages.findIndex((m) => m.id === streamId)
      if (siStop !== -1) {
        messages[siStop] = {
          ...messages[siStop]!,
          streaming: false,
          content:
            uiLang === 'ru'
              ? '⏹ Модель так и не вызвала инструменты — правки на диск не попали.'
              : '⏹ Model never called tools — nothing was written to disk.'
        }
      }
      messages.push({
        id: uid(),
        role: 'assistant',
        content:
          uiLang === 'ru'
            ? wantsFileEdit
              ? 'Задача не выполнена: модель только описала правки, но не вызвала apply_diff / write_file. Файлы нетронуты. Нажми Send ещё раз или Stop → повтори запрос.'
              : 'Ничего не изменено: модель не вызвала ни одного инструмента, файлы на диске нетронуты. Задача не выполнена — переформулируй запрос или назови конкретный файл.'
            : wantsFileEdit
              ? 'Task not done: the model only narrated edits and never called apply_diff / write_file. Files untouched. Press Send again or Stop → retry.'
              : 'Nothing changed: the model never called a tool, so files on disk are untouched. Task not completed — rephrase or name the exact file.'
      })
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    const planOnly = parsePlanBlock(cleanFinal)
    if (planOnly?.length && todoSteps.length === 0) {
      todoSteps = coercePlan(planOnly)
      planFrozen = true
      paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
    }
    let finalText = stripPlanBlock(
      looksLikeFileEditRequest(params.userText) ||
        looksLikeViteReactFromScratch(params.userText)
        ? stripThinkBlocks(cleanFinal)
        : promoteThinkOnlyAnswer(cleanFinal)
    )
    const claimsEditSuccess =
      /сделано|готово|исправлен|fixed|done\.|task completed|полностью работает|fully working|полностью готов|визуально проверен|файлы?\s+создан|files?\s+created/i.test(
        finalText
      )
    const claimsVisualOk = /визуально проверен|visually verified|проверено в (браузер|browser)|opened in.*browser/i.test(
      finalText
    )
    const asksFaqShade =
      /прошу уточнить|please clarify|какой именно фон|bg-primary|bg-tertiary|--bg-primary|--bg-tertiary/i.test(
        finalText
      ) &&
      /faq|accordion|т[её]мн|бел/i.test(params.userText)
    if (
      (htmlPreviewOpened || mutatingEditOk) &&
      !mutatingEditFailed &&
      !editSanityFailed
    ) {
      todoSteps = settlePlanAfterWork(todoSteps, {
        previewOpened: htmlPreviewOpened,
        edited: mutatingEditOk
      })
    }
    if (todoSteps.length > 0) {
      paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
    }
    const planStillOpen = pendingPlanWork(todoSteps).length > 0
    const falseSuccess =
      claimsEditSuccess &&
      (planStillOpen ||
        mutatingEditFailed ||
        (!mutatingEditOk && completedTools > 0) ||
        editSanityFailed)
    if (falseSuccess) {
      const why = i18nSanityFailed
        ? formatI18nCloserWhy(lastI18nHint, uiLang)
        : editSanityFailed
          ? uiLang === 'ru'
            ? 'Последняя запись файла структурно неполная — не рапортуем успех.'
            : 'The last file write is structurally incomplete — not reporting success.'
        : planStillOpen
          ? uiLang === 'ru'
            ? `В плане ещё есть незакрытые шаги: ${pendingPlanWork(todoSteps)
                .map((s) => s.text)
                .slice(0, 3)
                .join('; ')}.`
            : `Plan still has open steps: ${pendingPlanWork(todoSteps)
                .map((s) => s.text)
                .slice(0, 3)
                .join('; ')}.`
          : mutatingEditFailed
            ? uiLang === 'ru'
              ? `Правка не применилась${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}.`
              : `Edit did not apply${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}.`
            : uiLang === 'ru'
              ? 'Нет успешной правки файла в этом ходе.'
              : 'No successful file edit in this turn.'
      finalText =
        uiLang === 'ru'
          ? `${why} Задача не выполнена — не рапортуем успех.`
          : `${why} Task not completed — not reporting success.`
      // Replace the last non-tool assistant bubble that claimed success.
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!m || m.role !== 'assistant' || m.toolName) continue
        if (
          isAgentTodoMessageId(m.id) ||
          m.id === AGENT_CHECKLIST_MSG_ID ||
          m.id === AGENT_PLAN_MSG_ID ||
          isClosingMessageId(m.id) ||
          m.id === thinkBubbleId ||
          /<\s*(?:think|thinking)\s*>/i.test(m.content ?? '')
        ) {
          continue
        }
        if (/сделано|готово|исправлен|fixed|done\.|task completed/i.test(m.content ?? '')) {
          messages[i] = { ...m, content: finalText, streaming: false }
          break
        }
      }
    } else if (claimsVisualOk && !htmlPreviewOpened) {
      finalText = finalText
        .replace(/визуально проверен[оа]?\s*(в\s+AFKLLM\s+Browser)?[.;,]?/gi, '')
        .replace(/visually verified[.;,]?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
      if (uiLang === 'ru') {
        finalText =
          (finalText ? `${finalText} ` : '') +
          '(Превью в браузере не открывалось — утверждение о визуальной проверке убрано.)'
      } else {
        finalText =
          (finalText ? `${finalText} ` : '') +
          '(Browser preview was not opened — visual-verification claim removed.)'
      }
    }

    if (
      looksTruncatedCloser(finalText) &&
      !truncatedCloserNudged &&
      round < maxRounds - 1
    ) {
      truncatedCloserNudged = true
      pushUserMessage(
        apiMessages,
        uiLang === 'ru'
          ? 'Заключение обрезано (обрыв URL или незакрытая кавычка). Допиши последнее предложение целиком. Без новых tool calls, если задача иначе готова.'
          : 'The closing summary was truncated (cut URL or unmatched backtick). Finish the last sentence completely. No new tool calls if the work is otherwise done.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru' ? '↻ Дописываю заключение…' : '↻ Finishing truncated closer…'
      )
      params.onUpdate([...messages])
      continue
    }

    if (finalText || cleanFinal) {
      const lastApi = apiMessages[apiMessages.length - 1]
      if (lastApi?.role === 'assistant' && !lastApi.tool_calls?.length) {
        lastApi.content = `${apiContentText(lastApi.content)}\n\n${
          falseSuccess ? finalText : cleanFinal
        }`
      } else if (cleanFinal) {
        apiMessages.push({
          role: 'assistant',
          content: falseSuccess ? finalText : cleanFinal
        })
      }
      apiMessages = normalizeApiMessages(apiMessages)
      // Keep UI message without <plan> tags (card shows steps).
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (
          m?.role === 'assistant' &&
          !m.toolName &&
          !isAgentTodoMessageId(m.id) &&
          m.id !== AGENT_CHECKLIST_MSG_ID &&
          m.id !== AGENT_PLAN_MSG_ID &&
          /<\s*plan\s*>/i.test(m.content ?? '')
        ) {
          messages[i] = { ...m, content: stripPlanBlock(m.content ?? '') }
          break
        }
      }
    }

    const viteScratch =
      looksLikeViteReactFromScratch(params.userText) &&
      !looksLikeSurgicalFollowUp(params.userText)
    const viteMissing = viteScratch
      ? viteReactScaffoldMissing([
          ...writtenOkPaths,
          ...turnFileChanges.keys(),
          ...collectPathsFromTreeText(await fetchProjectTreeDigest())
        ])
      : []
    const previewWanted = viteScratch && userAskedViteReactPreview(params.userText)
    const previewOk = !previewWanted || htmlPreviewOpened
    const closerVisible = preferUserFacingCloser(finalText || cleanFinal, uiLang).trim()

    const dropPrematureCloser = (): void => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!m || m.role !== 'assistant') continue
        if (isAgentTodoMessageId(m.id)) continue
        if (isClosingMessageId(m.id)) {
          messages.splice(i, 1)
          lastClosingText = ''
          continue
        }
        if (m.toolName) continue
        if (/^↻ /.test(m.content ?? '') || /^⏹ /.test(m.content ?? '')) continue
        const visible = preferUserFacingCloser(m.content ?? '', uiLang)
        if (looksLikeClosingSummary(visible)) {
          messages.splice(i, 1)
          break
        }
      }
    }

    if (
      viteScratch &&
      viteMissing.length > 0 &&
      completedTools > 0 &&
      scaffoldFinishNudges < 4 &&
      round < maxRounds - 1
    ) {
      dropPrematureCloser()
      scaffoldFinishNudges++
      todoSteps = reopenTodosForMissingViteReact(todoSteps, viteMissing)
      if (todoSteps.length > 0) {
        paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
      }
      const tree = await fetchProjectTreeDigest()
      pushUserMessage(apiMessages, formatViteReactScaffoldHint(viteMissing) + tree)
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru'
          ? '↻ Vite+React ещё не собран — дописываю недостающие файлы…'
          : '↻ Vite+React scaffold incomplete — writing missing files…'
      )
      params.onUpdate([...messages])
      continue
    }

    const viteWorkDone =
      (!viteScratch || viteMissing.length === 0) &&
      previewOk &&
      !mutatingEditFailed &&
      !editSanityFailed

    if (
      viteWorkDone &&
      !(looksLikeFromScratchRunTask(params.userText) && !ranCliSmoke)
    ) {
      if (closerVisible.length >= 48) lastClosingText = closerVisible
      pinFallbackCloserIfNeeded()
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    if (
      previewWanted &&
      viteMissing.length === 0 &&
      !htmlPreviewOpened &&
      mutatingEditOk &&
      previewNudges < 1 &&
      round < maxRounds - 1
    ) {
      dropPrematureCloser()
      previewNudges++
      pushUserMessage(apiMessages, formatViteReactPreviewHint())
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru'
          ? '↻ Файлы есть — запускаю dev-сервер и превью…'
          : '↻ Files are on disk — starting dev server and preview…'
      )
      params.onUpdate([...messages])
      continue
    }

    // After tools ran with no visible closing summary — only conclude when the plan is done.
    if (
      completedTools > 0 &&
      !finalText.trim() &&
      !lastClosingText.trim() &&
      !concludeAsked &&
      round < maxRounds - 1 &&
      pendingPlanWork(todoSteps).length === 0 &&
      !(viteScratch && viteMissing.length > 0) &&
      !(previewWanted && !htmlPreviewOpened)
    ) {
      concludeAsked = true
      const changedThisTurn = [...turnFileChanges.values()]
        .map((c) => `${c.path} (+${c.added} −${c.removed})`)
        .join(', ')
      const scopeNote = uiLang === 'ru'
        ? 'Только про ЭТУ просьбу пользователя. Не пересказывай, что делал в предыдущих сообщениях чата — ' +
          'ни секции, ни правки, которые уже были готовы до этого запроса.' +
          (changedThisTurn ? ` Изменено сейчас: ${changedThisTurn}.` : '')
        : 'Cover ONLY the current user request. Do not restate work from earlier messages in this chat — ' +
          'no sections or edits that already existed before this request.' +
          (changedThisTurn ? ` Changed now: ${changedThisTurn}.` : '')
      const concludeHint =
        mutatingEditFailed
          ? uiLang === 'ru'
            ? `Правка не удалась${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}. Напиши честное короткое заключение: что не применилось и почему. ${scopeNote} Без ложного «Сделано». Без новых tool calls, если больше нечего пробовать; иначе один corrective apply_diff.`
            : `The edit failed${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}. Write an honest short summary: what did not apply and why. ${scopeNote} Do not claim "done". No new tools if nothing left to try; otherwise one corrective apply_diff.`
          : uiLang === 'ru'
            ? `Инструменты уже выполнены. Напиши краткое заключение (2–5 пунктов) ОБЫЧНЫМ текстом, не внутри <think>: что изменилось, пути файлов, как проверить. Покажи реальный stdout терминала, не только exit_code. ${scopeNote} Если превью/dev уже с exit_code=0 — это успех: заключение один раз и STOP, не повторяй npm. Иначе один следующий tool, затем заключение.`
            : `Tools already ran. Write a short closing summary (2–5 bullets) as visible text OUTSIDE <think>: what changed, file paths, how to verify. Paste real stdout, not only exit_code. ${scopeNote} If preview/dev already exited 0, that is success: one closer and STOP — do not rerun npm. Otherwise one next tool, then the summary.`
      pushUserMessage(apiMessages, concludeHint)
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru' ? '↻ Пишу заключение…' : '↻ Writing closing summary…'
      )
      params.onUpdate([...messages])
      continue
    }

    // Surgical turn ended with failed edits and a success-sounding (or empty) close — inject honest failure.
    if (
      mutatingEditFailed &&
      completedTools > 0 &&
      pendingPlanWork(todoSteps).length === 0 &&
      (falseSuccess || claimsEditSuccess || (!finalText.trim() && concludeAsked))
    ) {
      const honest =
        uiLang === 'ru'
          ? `Правка не применилась${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}. Задача не выполнена.`
          : `Edit did not apply${lastMutatingFailDetail ? ` (${lastMutatingFailDetail})` : ''}. Task not completed.`
      const last = messages[messages.length - 1]
      const alreadyHonest =
        last &&
        last.role === 'assistant' &&
        !last.toolName &&
        /не применил|did not apply|не выполнен/i.test(last.content ?? '')
      if (!alreadyHonest) {
        messages.push({ id: uid(), role: 'assistant', content: honest })
        params.onUpdate([...messages])
      }
      return finishWithTiming(messages)
    }

    const {
      hardMissing,
      acceptanceDone,
      looksPrematureDone: gatePremature
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
      completedTools,
      mutatingEditOk,
      mutatingEditFailed
    })
    const looksPrematureDone =
      gatePremature ||
      falseSuccess ||
      (planStillOpen && claimsEditSuccess && round < maxRounds - 1) ||
      (mutatingEditFailed && claimsEditSuccess && round < maxRounds - 1) ||
      (editSanityFailed && claimsEditSuccess && round < maxRounds - 1)

    const surgicalSettled =
      looksLikeSurgicalFollowUp(params.userText) &&
      mutatingEditOk &&
      !mutatingEditFailed &&
      !editSanityFailed

    const i18nNudgeCapHit =
      i18nSanityFailed && (earlyDoneNudges >= 1 || i18nRecoveryEdits >= 1)
    const bundleReady = landingBundleReady(completeLandingWritesByPath)
    const htmlCapKey = loopPathKey(lastHtmlWritePath || 'index.html')
    const htmlRecoveryOpen =
      i18nSanityFailed &&
      /visible fallback|no visible fallback/i.test(lastI18nHint) &&
      !landingRecoveryUsedByPath.has(htmlCapKey) &&
      (completeLandingWritesByPath.get(htmlCapKey) ?? 0) >= 1
    const skipLandingRewriteNudge = bundleReady && !htmlRecoveryOpen
    const nudgeCap = i18nSanityFailed || htmlRecoveryOpen ? 1 : 3

    if (
      !skipLandingRewriteNudge &&
      !i18nNudgeCapHit &&
      earlyDoneNudges < nudgeCap &&
      round < maxRounds - 1 &&
      looksPrematureDone &&
      !surgicalSettled
    ) {
      earlyDoneNudges++
      const tree = await fetchProjectTreeDigest()
      const reqBlock =
        hardMissing.length > 0
          ? `\nMissing before you may finish:\n- ${hardMissing.join('\n- ')}\n`
          : ''
      const openPlan =
        planStillOpen
          ? `\nOpen plan steps still pending:\n- ${pendingPlanWork(todoSteps)
              .map((s) => s.text)
              .slice(0, 5)
              .join('\n- ')}\n`
          : ''
      const fixFirst = hardMissing.some((m) =>
        /test FAILED|until green/i.test(m)
      )
      pushUserMessage(
        apiMessages,
        'Do not stop yet.' +
          reqBlock +
          openPlan +
          (i18nSanityFailed
            ? `${(lastI18nHint || 'I18N_SANITY').split('\n')[0]}\n` +
              (/visible fallback|no visible fallback/i.test(lastI18nHint)
                ? 'Fix index.html ONCE (visible text in data-i18n tags), then STOP. Do not rewrite js/main.js.\n'
                : 'Fix js/main.js ONCE, then STOP. Do not write tmp/check.js, node -e, or loop HTML key renames.\n')
            : editSanityFailed
              ? 'EDIT_SANITY: last write is structurally incomplete. Finish that file, then verify. Do not claim done.\n'
              : fixFirst
                ? 'Do NOT repeat a success summary. Fix the failing command first.\n'
                : mutatingEditFailed
                  ? 'An edit failed — use apply_diff (not a full-file rewrite) or honestly report failure.\n'
                  : 'Verify remaining plan steps. Patch existing files only (no full rewrites).\n') +
          tree
      )
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        i18nSanityFailed
          ? uiLang === 'ru'
            ? `↻ ${formatI18nCloserWhy(lastI18nHint, 'ru')} — одна правка js/main.js…`
            : `↻ ${formatI18nCloserWhy(lastI18nHint, 'en')} — one js/main.js fix…`
          : editSanityFailed
            ? uiLang === 'ru'
              ? '↻ Файл ещё неполный — не рапортуем успех…'
              : '↻ File still incomplete — not reporting success…'
          : hardMissing.length > 0
            ? uiLang === 'ru'
              ? '↻ Проверки не закрыты — доделываю…'
              : '↻ Acceptance incomplete — finish required checks…'
            : planStillOpen
              ? uiLang === 'ru'
                ? '↻ В плане ещё есть шаги…'
                : '↻ Plan still has open steps…'
              : uiLang === 'ru'
                ? '↻ Не рапортуем успех — проверяю остаток…'
                : '↻ Not reporting success yet…'
      )
      params.onUpdate([...messages])
      continue
    }

    const workLeft = pendingPlanWork(todoSteps)
    const landingComplete =
      Boolean(lastHtmlWrite) && contentLooksStructurallyComplete(lastHtmlWrite)
    const fileWorkLeft = workLeft.filter((s) => isFileWorkPlanStep(s.text))
    const missingNamedFiles = fileWorkLeft.some((s) =>
      /index\.html|readme|\.md\b|styles\.css|main\.js|package\.json/i.test(s.text)
    )

    // Q&A / web_search: answer already in chat — never loop «Доделываю план» 3×.
    const qaAnswerDone =
      Boolean(finalText.trim()) &&
      finalText.trim().length >= 40 &&
      !mutatingEditOk &&
      !mutatingEditFailed &&
      (usedWebSearch || isRedundantPlanCompleteProse(finalText))

    if (
      (qaAnswerDone || isRedundantPlanCompleteProse(finalText)) &&
      fileWorkLeft.length === 0 &&
      !(
        viteScratch &&
        (viteMissing.length > 0 ||
          (userAskedViteReactPreview(params.userText) && !htmlPreviewOpened))
      )
    ) {
      if (todoSteps.length > 0) {
        todoSteps = todoSteps.map((s) =>
          s.status === 'done' || isBrowserPlanStep(s.text)
            ? s
            : { ...s, status: 'done' as const }
        )
        paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
      }
      if (finalText.trim() && (concludeAsked || looksLikeClosingSummary(finalText) || usedWebSearch)) {
        lastClosingText = finalText.trim()
        ensureClosingMessage(messages, userMessageId, lastClosingText)
      }
      if (htmlPreviewOpened && mutatingEditOk) pinFallbackCloserIfNeeded()
      params.onUpdate([...messages])
      return finishWithTiming(messages)
    }

    // Remaining plan rows that still need file/shell work (not search/Q&A fluff).
    if (
      shouldNudgeRemainingFileWork({
        fileWorkCount: fileWorkLeft.length,
        completedTools,
        landingComplete,
        missingNamedFiles,
        surgicalFollowUp: looksLikeSurgicalFollowUp(params.userText),
        mutatingEditOk,
        planFinishNudges
      }) &&
      round < maxRounds - 1
    ) {
      planFinishNudges++
      const pendingList = fileWorkLeft.map((s) => `- ${s.text}`).join('\n')
      const needHtml =
        fileWorkLeft.some((s) => /index\.html|\bhtml\b/i.test(s.text)) && !lastHtmlWrite
      pushUserMessage(
        apiMessages,
        'PLAN_INCOMPLETE: these files are still missing:\n' +
          pendingList +
          (needHtml
            ? '\nindex.html is still missing — call write_file for it NOW. Do not summarize.\n'
            : '\nCall write_file for the next missing path NOW. Do not write a summary yet.\n')
      )
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru' ? '↻ Доделываю план по порядку…' : '↻ Finishing the plan in order…'
      )
      params.onUpdate([...messages])
      continue
    }

    const pendingBrowser = todoSteps.filter(
      (s) => s.status !== 'done' && isBrowserPlanStep(s.text)
    )
    // The agent must open the preview through its own tool call — the editor
    // no longer opens index.html behind the model's back.
    if (
      !htmlPreviewOpened &&
      pendingBrowser.length > 0 &&
      completedTools > 0 &&
      mutatingEditOk &&
      planFinishNudges < 2 &&
      round < maxRounds - 1 &&
      /готов|done|создан|finished|complete/i.test(finalText)
    ) {
      planFinishNudges++
      const pendingList = pendingBrowser.map((s) => `- ${s.text}`).join('\n')
      pushUserMessage(
        apiMessages,
        'PLAN_INCOMPLETE: preview is still pending:\n' +
          pendingList +
          '\nOpen the page yourself with execute_terminal_command (static HTML: Start-Process (Resolve-Path .\\index.html); dev server: the printed Local: URL). Never open the LLM API port. Then one line of summary.'
      )
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru' ? '↻ Прошу открыть превью, затем заключение…' : '↻ Asking to open preview, then summary…'
      )
      params.onUpdate([...messages])
      continue
    }

    if (htmlPreviewOpened) {
      paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
    }

    if (
      shouldNudgeVerify({ userText: params.userText, stacks }) &&
      !verifyAlreadyRan(evidenceLog) &&
      mutatingEditOk &&
      round < maxRounds - 1 &&
      planFinishNudges < 2
    ) {
      planFinishNudges++
      pushUserMessage(
        apiMessages,
        formatVerifyNudge(inferredVerifyMode(params.userText), uiLang)
      )
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru' ? '↻ Проверяю сборку/тесты стека…' : '↻ Verifying stack build/tests…'
      )
      params.onUpdate([...messages])
      continue
    }

    const honest = honestClosingNote({
      mutatingEditOk,
      mutatingEditFailed,
      lastFail: lastMutatingFailDetail,
      evidence: evidenceLog,
      previewOpened: htmlPreviewOpened,
      claimsVisualOk,
      lang: uiLang
    })
    if (honest) {
      finalText = honest
      lastClosingText = honest
      ensureClosingMessage(messages, userMessageId, honest)
    } else if (
      finalText.trim() &&
      (concludeAsked ||
        looksLikeClosingSummary(finalText) ||
        (completedTools > 0 && finalText.trim().length >= 60))
    ) {
      lastClosingText = finalText.trim()
      ensureClosingMessage(messages, userMessageId, lastClosingText)
    }

    if (
      previewWanted &&
      viteMissing.length === 0 &&
      !htmlPreviewOpened &&
      mutatingEditOk &&
      previewNudges < 2 &&
      round < maxRounds - 1
    ) {
      previewNudges++
      dropPrematureCloser()
      pushUserMessage(apiMessages, formatViteReactPreviewHint())
      apiMessages = normalizeApiMessages(apiMessages)
      pushStatusBubble(
        messages,
        uiLang === 'ru'
          ? '↻ Файлы есть — запускаю dev-сервер и превью…'
          : '↻ Files are on disk — starting dev server and preview…'
      )
      params.onUpdate([...messages])
      continue
    }

    if (
      htmlPreviewOpened && mutatingEditOk && !mutatingEditFailed && !editSanityFailed
    ) {
      pinFallbackCloserIfNeeded()
    } else if (mutatingEditOk && ranCliSmoke) {
      pinFallbackCloserIfNeeded()
    }

    if (todoSteps.length > 0 && todosAllDone(todoSteps)) {
      paintTodo(todoSteps, { afterId: thinkBubbleId ?? undefined })
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
