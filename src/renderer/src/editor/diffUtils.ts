import type { SearchReplaceBlock } from '../../../shared/types'
import { formatNowForAgent } from '../agent/agentPure'

const BLOCK_RE =
  /<{6,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={6,}\s*\r?\n([\s\S]*?)\r?\n>{6,}\s*REPLACE/gi

/**
 * Parse one or more SEARCH/REPLACE blocks from model output.
 *
 * Expected format:
 * <<<<<<< SEARCH
 * [original]
 * =======
 * [replacement]
 * >>>>>>> REPLACE
 */
export function parseSearchReplaceBlocks(text: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(BLOCK_RE.source, BLOCK_RE.flags)

  while ((match = re.exec(text)) !== null) {
    const search = match[1].replace(/\r\n/g, '\n')
    const replace = match[2].replace(/\r\n/g, '\n')
    if (search.length || replace.length) {
      blocks.push({ search, replace })
    }
  }

  // Fenced block fallback when model ignored SEARCH/REPLACE
  if (blocks.length === 0) {
    const fence = text.match(/```[\w]*\r?\n([\s\S]*?)```/)
    if (fence?.[1]) {
      blocks.push({ search: '', replace: fence[1].replace(/\r\n/g, '\n').replace(/\n$/, '') })
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
      result.slice(0, hit.start) + block.replace.replace(/\r\n/g, '\n') + result.slice(hit.end)
    applied++
  }

  return { content: result, applied, failed }
}

function findUniqueSearch(
  haystack: string,
  needleRaw: string
): { ok: true; start: number; end: number } | { ok: false; reason: string } {
  const needle = needleRaw.replace(/\r\n/g, '\n')

  // Exact
  const exact = uniqueIndex(haystack, needle)
  if (exact.ok) return exact

  // Line-trim trailing spaces
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
  let start = haystack.indexOf(needle)
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

/** Locate unique occurrence of needle in haystack allowing trailing whitespace per line. */
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

/** Build the system + user prompts for Ctrl+K inline edit. */
export function buildInlineEditMessages(params: {
  instruction: string
  selectedCode: string
  filePath: string
  surroundingContext: string
  languageId: string
}): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `You are a precise code-editing assistant.
Return ONLY one or more SEARCH/REPLACE blocks. No prose, no markdown fences.

Format (exact markers):
<<<<<<< SEARCH
[exact original snippet to find]
=======
[replacement snippet]
>>>>>>> REPLACE

Rules:
- SEARCH must match the file (or a unique substring) EXACTLY, including whitespace.
- Prefer the smallest unique SEARCH that covers the change.
- Multiple disjoint SEARCH/REPLACE blocks are encouraged when several independent edits are needed.
- Do not merge unrelated edits into one block.
- Language: ${params.languageId}

${formatNowForAgent()}`

  const user = `File: ${params.filePath}

Surrounding context (±50 lines):
\`\`\`${params.languageId}
${params.surroundingContext}
\`\`\`

Selected code to edit:
\`\`\`${params.languageId}
${params.selectedCode}
\`\`\`

Instruction: ${params.instruction}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** Extract ±N lines around a 1-based selection range. */
export function extractSurroundingLines(
  fullText: string,
  startLine1: number,
  endLine1: number,
  radius = 50
): string {
  const lines = fullText.replace(/\r\n/g, '\n').split('\n')
  const from = Math.max(0, startLine1 - 1 - radius)
  const to = Math.min(lines.length, endLine1 + radius)
  return lines.slice(from, to).join('\n')
}
