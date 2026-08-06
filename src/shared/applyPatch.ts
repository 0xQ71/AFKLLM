/**
 * Codex / OpenAI apply_patch grammar (*** Begin Patch … *** End Patch).
 * Pure — AgentToolRegistry + smoke tests.
 */

export type PatchOpType = 'add' | 'update' | 'delete'

export interface PatchHunkLine {
  kind: ' ' | '-' | '+'
  text: string
}

export interface PatchHunk {
  /** @@ header text without @@ */
  header?: string
  lines: PatchHunkLine[]
}

export interface PatchOp {
  type: PatchOpType
  path: string
  addLines?: string[]
  hunks?: PatchHunk[]
}

export interface ParseApplyPatchResult {
  ok: boolean
  ops: PatchOp[]
  error?: string
}

export interface ApplyHunksResult {
  ok: boolean
  content?: string
  error?: string
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File:'
const UPDATE = '*** Update File:'
const DELETE = '*** Delete File:'
const MOVE = '*** Move to File:' // rename hint only — move not supported

/** Strip optional fence; normalize newlines. */
export function normalizePatchInput(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n').trim()
  const fence = s.match(/^```(?:patch|diff)?\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1]!.trim()
  return s
}

export function parseApplyPatch(raw: string): ParseApplyPatchResult {
  const text = normalizePatchInput(raw)
  if (!text) {
    return { ok: false, ops: [], error: 'patch is empty' }
  }

  const lines = text.split('\n')
  let i = 0
  // Missing Begin/End OK if file ops present
  if (lines[i]?.trim() === BEGIN) i++

  const ops: PatchOp[] = []

  while (i < lines.length) {
    const line = lines[i]!.trimEnd()
    const trimmed = line.trim()
    if (!trimmed || trimmed === END) {
      i++
      if (trimmed === END) break
      continue
    }

    if (trimmed.startsWith(ADD)) {
      const path = trimmed.slice(ADD.length).trim()
      if (!path) return { ok: false, ops: [], error: 'Add File missing path' }
      i++
      const addLines: string[] = []
      while (i < lines.length) {
        const L = lines[i]!
        const t = L.trim()
        if (
          t === END ||
          t.startsWith('*** Add File:') ||
          t.startsWith('*** Update File:') ||
          t.startsWith('*** Delete File:') ||
          t.startsWith('*** Move to File:')
        ) {
          break
        }
        if (L.startsWith('+')) addLines.push(L.slice(1))
        else if (L.startsWith('\\')) {
          /* "\ No newline at end of file" — skip */
        } else if (L.trim() === '') {
          if (i + 1 < lines.length && lines[i + 1]!.trim().startsWith('***')) break
          addLines.push('')
        } else {
          // Models sometimes omit leading +
          addLines.push(L)
        }
        i++
      }
      ops.push({ type: 'add', path: normalizeRelPath(path), addLines })
      continue
    }

    if (trimmed.startsWith(DELETE)) {
      const path = trimmed.slice(DELETE.length).trim()
      if (!path) return { ok: false, ops: [], error: 'Delete File missing path' }
      ops.push({ type: 'delete', path: normalizeRelPath(path) })
      i++
      continue
    }

    if (trimmed.startsWith(UPDATE) || trimmed.startsWith(MOVE)) {
      const path = trimmed.startsWith(UPDATE)
        ? trimmed.slice(UPDATE.length).trim()
        : trimmed.slice(MOVE.length).trim()
      if (!path) return { ok: false, ops: [], error: 'Update File missing path' }
      i++
      if (i < lines.length && lines[i]!.trim().startsWith(MOVE)) {
        i++ // ignore rename target — still patch original path
      }
      const hunks: PatchHunk[] = []
      let current: PatchHunk | null = null

      while (i < lines.length) {
        const L = lines[i]!
        const t = L.trim()
        if (
          t === END ||
          t.startsWith('*** Add File:') ||
          t.startsWith('*** Update File:') ||
          t.startsWith('*** Delete File:') ||
          t.startsWith('*** Move to File:')
        ) {
          break
        }
        if (t.startsWith('@@')) {
          if (current && current.lines.length > 0) hunks.push(current)
          current = { header: t.replace(/^@@/, '').trim(), lines: [] }
          i++
          continue
        }
        if (!current) current = { lines: [] }
        if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+')) {
          current.lines.push({ kind: L[0] as ' ' | '-' | '+', text: L.slice(1) })
          i++
          continue
        }
        if (L.startsWith('\\')) {
          i++
          continue
        }
        if (t === '') {
          current.lines.push({ kind: ' ', text: '' })
          i++
          continue
        }
        break
      }
      if (current && current.lines.length > 0) hunks.push(current)
      if (hunks.length === 0) {
        return {
          ok: false,
          ops: [],
          error: `Update File ${path}: no hunks (need @@ / context / - / + lines)`
        }
      }
      ops.push({ type: 'update', path: normalizeRelPath(path), hunks })
      continue
    }

    return {
      ok: false,
      ops: [],
      error: `Unexpected patch line: ${trimmed.slice(0, 80)}`
    }
  }

  if (ops.length === 0) {
    return { ok: false, ops: [], error: 'No file operations in patch' }
  }
  return { ok: true, ops }
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Apply update hunks: unique "before" match → "after". */
export function applyHunksToText(original: string, hunks: PatchHunk[]): ApplyHunksResult {
  let content = original.replace(/\r\n/g, '\n')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]!
    const beforeLines: string[] = []
    const afterLines: string[] = []
    for (const l of hunk.lines) {
      if (l.kind === ' ' || l.kind === '-') beforeLines.push(l.text)
      if (l.kind === ' ' || l.kind === '+') afterLines.push(l.text)
    }
    if (beforeLines.length === 0 && afterLines.length === 0) continue

    const before = beforeLines.join('\n')
    const after = afterLines.join('\n')

    const idx = indexOfUnique(content, before)
    if (idx < 0) {
      const beforeTrim = before.replace(/\n$/, '')
      const idx2 = beforeTrim && beforeTrim !== before ? indexOfUnique(content, beforeTrim) : -1
      if (idx2 < 0) {
        return {
          ok: false,
          error:
            `hunk mismatch (#${hi + 1}): could not find unique context in file.\n` +
            `Expected excerpt:\n<<<\n${before.slice(0, 400)}\n>>>`
        }
      }
      content =
        content.slice(0, idx2) +
        after.replace(/\n$/, '') +
        content.slice(idx2 + beforeTrim.length)
      continue
    }
    content = content.slice(0, idx) + after + content.slice(idx + before.length)
  }

  if (eol === '\r\n') content = content.replace(/\n/g, '\r\n')
  return { ok: true, content }
}

function indexOfUnique(haystack: string, needle: string): number {
  if (!needle) return -1
  const first = haystack.indexOf(needle)
  if (first < 0) return -1
  const second = haystack.indexOf(needle, first + 1)
  if (second >= 0) return -2 // ambiguous
  return first
}

export function formatApplyPatchResult(
  changed: Array<{ path: string; action: string }>,
  errors: string[]
): string {
  const lines: string[] = []
  if (changed.length) {
    lines.push(`apply_patch: ${changed.length} change(s)`)
    for (const c of changed) lines.push(`  ${c.action} ${c.path}`)
  }
  if (errors.length) {
    lines.push(`errors (${errors.length}):`)
    for (const e of errors) lines.push(`  ${e}`)
  }
  return lines.join('\n') || 'apply_patch: no changes'
}

/** Explore-subagent tools (no writes, no nested explore). */
export const EXPLORE_SUBAGENT_TOOL_NAMES = [
  'read_file',
  'list_directory',
  'search_codebase',
  'web_search'
] as const

export function filterExploreToolSchemas<T extends { function: { name: string } }>(
  schemas: readonly T[]
): T[] {
  const allow = new Set<string>(EXPLORE_SUBAGENT_TOOL_NAMES)
  return schemas.filter((s) => allow.has(s.function.name))
}
