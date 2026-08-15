import type { SearchReplaceBlock } from './types'

/** Keep apply prompts under ~6k tokens so they fit apply ctx (8192). */
const FAST_APPLY_MAX_CHARS = 14_000
const FAST_APPLY_HEAD = 9_000
const FAST_APPLY_TAIL = 4_000

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
  let result = original.replace(/\r\n/g, '\n')
  const failed: ApplyBlocksResult['failed'] = []
  let applied = 0

  for (const [i, block] of blocks.entries()) {
    if (!block.search) {
      result = block.replace
      applied++
      continue
    }

    const hit = findUniqueSearch(result, block.search)
    if (!hit.ok) {
      failed.push({ index: i + 1, reason: hit.reason })
      continue
    }
    result =
      result.slice(0, hit.start) +
      block.replace.replace(/\r\n/g, '\n') +
      result.slice(hit.end)
    applied++
  }

  return { content: result, applied, failed }
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

function clipFileForApply(content: string): { text: string; clipped: boolean } {
  const n = content.replace(/\r\n/g, '\n')
  if (n.length <= FAST_APPLY_MAX_CHARS) return { text: n, clipped: false }
  const head = n.slice(0, FAST_APPLY_HEAD)
  const tail = n.slice(-FAST_APPLY_TAIL)
  return {
    text:
      head +
      `\n\n/* … truncated ${n.length - FAST_APPLY_HEAD - FAST_APPLY_TAIL} chars for apply context … */\n\n` +
      tail,
    clipped: true
  }
}

/** Morph-style prompts for coresident apply model (full-file edit intent). */
export function buildFastApplyMessages(params: {
  instruction: string
  filePath: string
  fileContent: string
}): Array<{ role: 'system' | 'user'; content: string }> {
  const { text, clipped } = clipFileForApply(params.fileContent)
  const system = `You are a precise code-editing assistant (fast apply).
Return ONLY one or more SEARCH/REPLACE blocks. No prose, no markdown fences, no <think>, no explanation.

Format (exact markers — copy these characters):
<<<<<<< SEARCH
[exact original snippet from the file]
=======
[replacement snippet]
>>>>>>> REPLACE

Rules:
- SEARCH must be copied from the file EXACTLY and must be unique.
- Prefer the smallest unique SEARCH (5–40 lines) that covers the change.
- Multiple blocks OK for independent edits.
- Never output a full file dump unless the instruction is an explicit rewrite.
- Prefer the smallest unique SEARCH (5–40 lines) that covers the change.`

  const user = `File: ${params.filePath}${clipped ? ' (middle truncated — SEARCH only from the visible head/tail)' : ''}

Current file content:
\`\`\`
${text}
\`\`\`

Instruction: ${params.instruction}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}
