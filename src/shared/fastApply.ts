import type { SearchReplaceBlock } from './types'
import { applySearchReplaceFuzzy, findFuzzyLineRange } from './applyPatch'

/** Chars per token for budgeting the apply prompt against the apply slot ctx. */
const APPLY_CHARS_PER_TOKEN = 3.2
/** Context lines kept around a target region. */
const REGION_CONTEXT_LINES = 40

/**
 * Prompt budget from the real apply ctx (not a hardcoded 14k clip, which made
 * the middle of any medium file invisible to the apply model).
 */
export function applyPromptCharBudget(ctxSize?: number): number {
  const ctx = Number.isFinite(ctxSize) && (ctxSize ?? 0) > 0 ? ctxSize! : 16_384
  return Math.max(8_000, Math.floor(ctx * APPLY_CHARS_PER_TOKEN * 0.55))
}

/**
 * Parse one or more SEARCH/REPLACE blocks from model output.
 *
 * Expected format:
 * <<<<<<< SEARCH
 * [original]
 * =======
 * [replacement]
 * >>>>>>> REPLACE
 *
 * Also accepts looser markers (3+ chevrons, *** SEARCH, plain SEARCH/REPLACE lines).
 */
export function parseSearchReplaceBlocks(
  text: string,
  opts?: { allowEmptySearch?: boolean }
): SearchReplaceBlock[] {
  const allowEmpty = opts?.allowEmptySearch === true
  // Strip think / prose wrappers small models sometimes emit
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()

  const patterns = [
    /<{3,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={3,}\s*\r?\n([\s\S]*?)\r?\n>{3,}\s*REPLACE/gi,
    /\*{3,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={3,}\s*\r?\n([\s\S]*?)\r?\n\*{3,}\s*REPLACE/gi,
    /^SEARCH\s*\r?\n([\s\S]*?)\r?\n={3,}\s*\r?\n([\s\S]*?)\r?\nREPLACE\s*$/gim
  ]

  const blocks: SearchReplaceBlock[] = []
  for (const src of patterns) {
    const re = new RegExp(src.source, src.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(cleaned)) !== null) {
      const search = match[1]!.replace(/\r\n/g, '\n')
      const replace = match[2]!.replace(/\r\n/g, '\n')
      if (search.length || (allowEmpty && replace.length)) {
        blocks.push({ search, replace })
      }
    }
    if (blocks.length) break
  }

  // Fenced full-file fallback only when empty SEARCH is allowed (Ctrl+K)
  if (blocks.length === 0 && allowEmpty) {
    const fence = cleaned.match(/```[\w]*\r?\n([\s\S]*?)```/)
    if (fence?.[1]) {
      blocks.push({
        search: '',
        replace: fence[1].replace(/\r\n/g, '\n').replace(/\n$/, '')
      })
    }
  }

  return blocks
}

export interface ApplyBlocksResult {
  content: string
  applied: number
  failed: Array<{ index: number; reason: string }>
}

/**
 * Apply SEARCH/REPLACE blocks sequentially.
 * Continues after failures; uses exact → CRLF-normalized → line-trim unique match.
 */
export function applySearchReplaceBlocks(
  original: string,
  blocks: SearchReplaceBlock[]
): ApplyBlocksResult {
  const crlf = original.includes('\r\n')
  let result = original.replace(/\r\n/g, '\n')
  const failed: ApplyBlocksResult['failed'] = []
  let applied = 0

  for (const [i, block] of blocks.entries()) {
    if (!block.search) {
      result = block.replace
      applied++
      continue
    }

    const replace = block.replace.replace(/\r\n/g, '\n')
    const hit = findUniqueSearch(result, block.search)
    if (hit.ok) {
      result = result.slice(0, hit.start) + replace + result.slice(hit.end)
      applied++
      continue
    }
    // Same fuzzy matcher apply_diff uses. Judging the small apply model by a
    // stricter matcher than a hand-written search_block made no sense.
    const fuzzy = applySearchReplaceFuzzy(result, block.search, replace)
    if (fuzzy.ok) {
      result = fuzzy.content.replace(/\r\n/g, '\n')
      applied++
      continue
    }
    failed.push({ index: i + 1, reason: hit.reason })
  }

  // Windows files must not come back rewritten to LF — that buried the real
  // change under a whole-file line-ending diff.
  return {
    content: crlf ? result.replace(/\n/g, '\r\n') : result,
    applied,
    failed
  }
}

function findUniqueSearch(
  haystack: string,
  needleRaw: string
): { ok: true; start: number; end: number } | { ok: false; reason: string } {
  const needle = needleRaw.replace(/\r\n/g, '\n')

  const exact = uniqueIndex(haystack, needle)
  if (exact.ok) return exact

  const softHay = trimLines(haystack)
  const softNeedle = trimLines(needle)
  if (softNeedle.length > 0) {
    const soft = uniqueIndex(softHay, softNeedle)
    if (soft.ok) {
      const mapped = mapTrimmedMatch(haystack, needle)
      if (mapped) return mapped
    }
  }

  if (exact.reason.includes('matched')) return exact
  return { ok: false, reason: 'SEARCH text not found in document' }
}

function uniqueIndex(
  haystack: string,
  needle: string
): { ok: true; start: number; end: number } | { ok: false; reason: string } {
  if (!needle) return { ok: false, reason: 'empty SEARCH' }
  const start = haystack.indexOf(needle)
  if (start === -1) return { ok: false, reason: 'SEARCH text not found in document' }
  const second = haystack.indexOf(needle, start + 1)
  if (second !== -1) {
    return { ok: false, reason: `SEARCH text matched multiple times — must be unique` }
  }
  return { ok: true, start, end: start + needle.length }
}

function trimLines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
}

function mapTrimmedMatch(
  haystack: string,
  needle: string
): { ok: true; start: number; end: number } | null {
  const nLines = needle.split('\n')
  const hLines = haystack.split('\n')
  const norm = (s: string): string => s.replace(/[ \t]+$/g, '')

  const targets = nLines.map(norm)
  if (!targets.length || targets.every((t) => !t.length)) return null

  const matches: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i <= hLines.length - targets.length; i++) {
    let ok = true
    for (let j = 0; j < targets.length; j++) {
      if (norm(hLines[i + j] ?? '') !== targets[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push({ startLine: i, endLine: i + targets.length - 1 })
    if (matches.length > 1) return null
  }
  if (matches.length !== 1) return null

  const m = matches[0]!
  let start = 0
  for (let i = 0; i < m.startLine; i++) start += (hLines[i]?.length ?? 0) + 1
  let end = start
  for (let i = m.startLine; i <= m.endLine; i++) {
    end += hLines[i]?.length ?? 0
    if (i < m.endLine) end += 1
  }
  return { ok: true, start, end }
}

export interface ApplyRegion {
  /** 1-based inclusive line range the edit targets. */
  startLine: number
  endLine: number
}

interface ApplyWindow {
  text: string
  /** 1-based inclusive range of `text` inside the file. */
  startLine: number
  endLine: number
  totalLines: number
  partial: boolean
}

/**
 * Window of the file sent to the apply model: the whole file when it fits the
 * budget, otherwise the target region plus context. Never a head/tail clip with
 * a hole in the middle.
 */
export function buildApplyWindow(
  fileContent: string,
  region?: ApplyRegion,
  budgetChars = applyPromptCharBudget()
): ApplyWindow {
  const n = fileContent.replace(/\r\n/g, '\n')
  const lines = n.split('\n')
  const totalLines = lines.length
  if (n.length <= budgetChars) {
    return { text: n, startLine: 1, endLine: totalLines, totalLines, partial: false }
  }

  const anchor = region ?? { startLine: 1, endLine: Math.min(totalLines, 200) }
  let from = Math.max(1, Math.min(anchor.startLine, totalLines) - REGION_CONTEXT_LINES)
  let to = Math.min(totalLines, Math.max(anchor.endLine, anchor.startLine) + REGION_CONTEXT_LINES)

  // Grow the window while it fits, so the model sees as much as the ctx allows.
  const sliceLen = (a: number, b: number): number =>
    lines.slice(a - 1, b).join('\n').length
  while (sliceLen(from, to) < budgetChars && (from > 1 || to < totalLines)) {
    const grown = { from, to }
    if (from > 1) grown.from = Math.max(1, from - 20)
    if (to < totalLines) grown.to = Math.min(totalLines, to + 20)
    if (sliceLen(grown.from, grown.to) > budgetChars) break
    from = grown.from
    to = grown.to
  }

  return {
    text: lines.slice(from - 1, to).join('\n'),
    startLine: from,
    endLine: to,
    totalLines,
    partial: !(from === 1 && to === totalLines)
  }
}

/**
 * Best guess at the lines an edit targets, so the apply prompt is a window and
 * not the whole file. Uses the fuzzy range of search_block, then a longest-line
 * anchor, then identifiers quoted in the instruction.
 */
export function locateApplyRegion(
  fileContent: string,
  searchBlock?: string,
  instruction?: string
): ApplyRegion | undefined {
  const normalized = fileContent.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  const search = (searchBlock ?? '').trim()
  if (search) {
    const fuzzy = findFuzzyLineRange(normalized, search.split('\n'))
    if (fuzzy.ok) return { startLine: fuzzy.start + 1, endLine: fuzzy.end }
    const anchors = search
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 10)
      .sort((a, b) => b.length - a.length)
    for (const anchor of anchors.slice(0, 4)) {
      const at = lines.findIndex((l) => l.includes(anchor))
      if (at !== -1) return { startLine: at + 1, endLine: at + 1 }
    }
  }

  const hint = (instruction ?? '').trim()
  if (hint) {
    const tokens = [
      ...hint.matchAll(/["'`]([^"'`\n]{3,60})["'`]/g),
      ...hint.matchAll(/([.#][A-Za-z][\w-]{2,40})/g),
      ...hint.matchAll(/<\/?([a-z][\w-]{1,20})\b/gi)
    ]
      .map((m) => m[1] ?? '')
      .filter(Boolean)
    for (const token of tokens.slice(0, 6)) {
      const needle = token.toLowerCase()
      const at = lines.findIndex((l) => l.toLowerCase().includes(needle))
      if (at !== -1) return { startLine: at + 1, endLine: at + 1 }
    }
  }

  return undefined
}

/** Morph-style prompts for the coresident apply model. */
export function buildFastApplyMessages(params: {
  instruction: string
  filePath: string
  fileContent: string
  region?: ApplyRegion
  ctxSize?: number
  /** Feedback for a second attempt after blocks failed to match. */
  retryNote?: string
}): Array<{ role: 'system' | 'user'; content: string }> {
  const win = buildApplyWindow(
    params.fileContent,
    params.region,
    applyPromptCharBudget(params.ctxSize)
  )
  const system = `You are a precise code-editing assistant (fast apply).
Return ONLY one or more SEARCH/REPLACE blocks. No prose, no markdown fences, no <think>, no explanation.

Format (exact markers — copy these characters):
<<<<<<< SEARCH
[exact original snippet from the file]
=======
[replacement snippet]
>>>>>>> REPLACE

Rules:
- SEARCH must be copied from the shown content EXACTLY (same indentation) and must be unique.
- Prefer the smallest unique SEARCH (5–40 lines) that covers the change.
- Multiple blocks OK for independent edits.
- Never output a full file dump unless the instruction is an explicit rewrite.`

  const header = win.partial
    ? `File: ${params.filePath} — showing lines ${win.startLine}-${win.endLine} of ${win.totalLines}. SEARCH must come from these lines only.`
    : `File: ${params.filePath} (complete, ${win.totalLines} lines)`

  const user = `${header}

Current content:
\`\`\`
${win.text}
\`\`\`

Instruction: ${params.instruction}${params.retryNote ? `\n\n${params.retryNote}` : ''}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}
