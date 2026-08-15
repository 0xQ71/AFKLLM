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

/** Models often emit "*** Begin Patch ***" / "*** End Patch ***" (trailing stars). */
const BEGIN_RE = /^\*{3}\s*Begin Patch\b[\s*]*$/i
const END_RE = /^\*{3}\s*End Patch\b[\s*]*$/i
function isPatchEnd(trimmed: string): boolean {
  return trimmed === END || END_RE.test(trimmed)
}

/** Strip optional fence; normalize newlines. Also convert unified diffs to apply_patch. */
export function normalizePatchInput(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n').trim()
  const fence = s.match(/^```(?:patch|diff)?\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1]!.trim()
  if (looksLikeUnifiedDiff(s)) {
    s = convertUnifiedDiffToApplyPatch(s)
  }
  return s
}

/** Detect git/unified diff that models often send instead of *** Begin Patch. */
export function looksLikeUnifiedDiff(text: string): boolean {
  const t = text.trim()
  // Pure Codex form without unified ---/+++ headers → leave alone.
  if (
    /^\*{3}\s*(Add|Update|Delete) File:/im.test(t) &&
    !/^---\s+(?:a\/)?\S+/m.test(t) &&
    !/^diff --git\s+/m.test(t)
  ) {
    return false
  }
  if (
    /^\*{3}\s*Begin Patch/im.test(t) &&
    !/^---\s+(?:a\/)?\S+/m.test(t) &&
    !/^\+\+\+\s+(?:b\/)?\S+/m.test(t) &&
    !/^diff --git\s+/m.test(t)
  ) {
    return false
  }
  return (
    /^---\s+(?:a\/)?\S+/m.test(t) ||
    /^\+\+\+\s+(?:b\/)?\S+/m.test(t) ||
    /^diff --git\s+/m.test(t)
  )
}

/**
 * Convert a simple unified/git diff into Codex apply_patch Update File form.
 * Best-effort — multi-file diffs become multiple Update File ops.
 */
export function convertUnifiedDiffToApplyPatch(raw: string): string {
  // Drop Codex wrappers if the model mixed them with unified headers.
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/^\*{3}\s*Begin Patch\b[\s*]*\n?/gim, '')
    .replace(/^\*{3}\s*End Patch\b[\s*]*\n?/gim, '')
  const lines = cleaned.split('\n')
  const out: string[] = ['*** Begin Patch']
  let i = 0
  let currentPath = ''
  let inHunk = false

  const flushPath = (): void => {
    /* no-op — Update File header already emitted */
  }

  while (i < lines.length) {
    const L = lines[i]!
    const t = L.trim()
    if (/^diff --git\s+/.test(t)) {
      inHunk = false
      i++
      continue
    }
    // Already-Codex Update File inside a mixed patch — keep path, skip unified ---.
    const updateHdr = t.match(/^\*{3}\s*Update File:\s*(\S+)/i) || t.match(/^Update File:\s*(\S+)/i)
    if (updateHdr) {
      currentPath = normalizeRelPath(updateHdr[1]!)
      out.push(`*** Update File: ${currentPath}`)
      inHunk = false
      i++
      continue
    }
    const minus = t.match(/^---\s+(?:a\/)?(.+)$/)
    if (minus) {
      const p = minus[1]!.replace(/^b\//, '').trim()
      if (p !== '/dev/null') {
        currentPath = normalizeRelPath(p)
        out.push(`*** Update File: ${currentPath}`)
      }
      inHunk = false
      i++
      continue
    }
    if (/^\+\+\+\s+/.test(t)) {
      i++
      continue
    }
    if (t.startsWith('@@')) {
      out.push('@@')
      inHunk = true
      i++
      continue
    }
    if (inHunk || currentPath) {
      if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+')) {
        out.push(L)
        inHunk = true
        i++
        continue
      }
      if (t === '' && inHunk) {
        out.push(' ')
        i++
        continue
      }
      if (/^index\s+|^\-\-\-\s+|^\+\+\+\s+|^diff --git/.test(t)) {
        inHunk = false
        continue
      }
    }
    i++
  }
  flushPath()
  out.push('*** End Patch')
  return out.join('\n')
}

export function parseApplyPatch(raw: string): ParseApplyPatchResult {
  const text = normalizePatchInput(raw)
  if (!text) {
    return { ok: false, ops: [], error: 'patch is empty' }
  }

  const lines = text.split('\n')
  let i = 0
  // Missing Begin/End OK if file ops present; tolerate trailing "***".
  if (lines[i] && (lines[i]!.trim() === BEGIN || BEGIN_RE.test(lines[i]!.trim()))) i++

  const ops: PatchOp[] = []

  while (i < lines.length) {
    const line = lines[i]!.trimEnd()
    const trimmed = line.trim()
    if (!trimmed || isPatchEnd(trimmed)) {
      i++
      if (isPatchEnd(trimmed)) break
      continue
    }

    if (trimmed.startsWith(ADD) || /^Add File:/i.test(trimmed)) {
      const path = trimmed.startsWith(ADD)
        ? trimmed.slice(ADD.length).trim()
        : trimmed.replace(/^Add File:/i, '').trim()
      if (!path) return { ok: false, ops: [], error: 'Add File missing path' }
      i++
      const addLines: string[] = []
      while (i < lines.length) {
        const L = lines[i]!
        const t = L.trim()
        if (
          isPatchEnd(t) ||
          t.startsWith('*** Add File:') ||
          t.startsWith('*** Update File:') ||
          t.startsWith('*** Delete File:') ||
          t.startsWith('*** Move to File:') ||
          /^Add File:/i.test(t) ||
          /^Update File:/i.test(t) ||
          /^Delete File:/i.test(t) ||
          /^Move to File:/i.test(t)
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

    if (trimmed.startsWith(DELETE) || /^Delete File:/i.test(trimmed)) {
      const path = trimmed.startsWith(DELETE)
        ? trimmed.slice(DELETE.length).trim()
        : trimmed.replace(/^Delete File:/i, '').trim()
      if (!path) return { ok: false, ops: [], error: 'Delete File missing path' }
      ops.push({ type: 'delete', path: normalizeRelPath(path) })
      i++
      continue
    }

    if (
      trimmed.startsWith(UPDATE) ||
      trimmed.startsWith(MOVE) ||
      /^Update File:/i.test(trimmed) ||
      /^Move to File:/i.test(trimmed)
    ) {
      const path = trimmed.startsWith(UPDATE)
        ? trimmed.slice(UPDATE.length).trim()
        : trimmed.startsWith(MOVE)
          ? trimmed.slice(MOVE.length).trim()
          : /^Update File:/i.test(trimmed)
            ? trimmed.replace(/^Update File:/i, '').trim()
            : trimmed.replace(/^Move to File:/i, '').trim()
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
          isPatchEnd(t) ||
          t.startsWith('*** Add File:') ||
          t.startsWith('*** Update File:') ||
          t.startsWith('*** Delete File:') ||
          t.startsWith('*** Move to File:') ||
          /^Add File:/i.test(t) ||
          /^Update File:/i.test(t) ||
          /^Delete File:/i.test(t) ||
          /^Move to File:/i.test(t)
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
    if (idx >= 0) {
      content = content.slice(0, idx) + after + content.slice(idx + before.length)
      continue
    }

    const beforeTrim = before.replace(/\n$/, '')
    const idx2 = beforeTrim && beforeTrim !== before ? indexOfUnique(content, beforeTrim) : -1
    if (idx2 >= 0) {
      content =
        content.slice(0, idx2) +
        after.replace(/\n$/, '') +
        content.slice(idx2 + beforeTrim.length)
      continue
    }

    // Fuzzy: match ignoring leading/trailing whitespace per line (weak models drift on indent).
    const fuzzy = findFuzzyLineRange(content, beforeLines)
    if (!fuzzy.ok) {
      return {
        ok: false,
        error:
          `hunk mismatch (#${hi + 1}): could not find unique context in file.\n` +
          `Expected excerpt:\n<<<\n${before.slice(0, 400)}\n>>>`
      }
    }
    const fileLines = content.split('\n')
    const mappedAfter = mapFuzzyAfterLines(
      fileLines.slice(fuzzy.start, fuzzy.end),
      beforeLines,
      afterLines
    )
    content = [
      ...fileLines.slice(0, fuzzy.start),
      ...mappedAfter,
      ...fileLines.slice(fuzzy.end)
    ].join('\n')
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

/** Collapse indent/trailing space for fuzzy compare. */
export function normalizeLineForFuzzy(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[ \t]+$/g, '').trimStart()
}

/**
 * Find a unique contiguous range in `content` whose lines match `needleLines`
 * after whitespace normalization. Returns [start, end) line indices.
 */
export function findFuzzyLineRange(
  content: string,
  needleLines: string[]
): { ok: true; start: number; end: number } | { ok: false } {
  const needles = needleLines.map(normalizeLineForFuzzy)
  // Drop empty trailing fuzzy lines that models often invent
  while (needles.length > 0 && needles[needles.length - 1] === '') needles.pop()
  if (needles.length === 0) return { ok: false }

  const hay = content.split('\n').map(normalizeLineForFuzzy)

  const tryMatch = (need: string[]): { start: number; end: number }[] => {
    const matches: Array<{ start: number; end: number }> = []
    if (need.length === 0) return matches
    for (let i = 0; i <= hay.length - need.length; i++) {
      let ok = true
      for (let j = 0; j < need.length; j++) {
        if (hay[i + j] !== need[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push({ start: i, end: i + need.length })
    }
    return matches
  }

  let matches = tryMatch(needles)
  if (matches.length === 1) {
    return { ok: true, start: matches[0]!.start, end: matches[0]!.end }
  }

  // Shrink from both ends (drop weak context) until a unique window remains.
  let lo = 0
  let hi = needles.length
  while (hi - lo > 2) {
    const trimmed = needles.slice(lo + 1, hi - 1)
    if (trimmed.length < 1) break
    matches = tryMatch(trimmed)
    if (matches.length === 1) {
      return { ok: true, start: matches[0]!.start, end: matches[0]!.end }
    }
    if (matches.length === 0) {
      // Try dropping only leading or only trailing context next.
      const dropLead = tryMatch(needles.slice(lo + 1, hi))
      if (dropLead.length === 1) {
        return { ok: true, start: dropLead[0]!.start, end: dropLead[0]!.end }
      }
      const dropTrail = tryMatch(needles.slice(lo, hi - 1))
      if (dropTrail.length === 1) {
        return { ok: true, start: dropTrail[0]!.start, end: dropTrail[0]!.end }
      }
      break
    }
    lo++
    hi--
  }

  // Prefer changed lines only (-/+) when context is noisy: caller passes mixed;
  // here retry with non-empty needles that look distinctive (length ≥ 8).
  const distinctive = needles.filter((n) => n.length >= 8)
  if (distinctive.length >= 1 && distinctive.length < needles.length) {
    matches = tryMatch(distinctive)
    if (matches.length === 1) {
      return { ok: true, start: matches[0]!.start, end: matches[0]!.end }
    }
  }

  return { ok: false }
}

/**
 * Build replacement lines: keep original indent from matched file lines where
 * a "before" line maps to an "after" line with the same fuzzy body.
 */
function mapFuzzyAfterLines(
  matchedFileLines: string[],
  beforeLines: string[],
  afterLines: string[]
): string[] {
  // Prefer preserving the file's own indentation style for context lines.
  const beforeNorm = beforeLines.map(normalizeLineForFuzzy)
  const indentOf = (line: string): string => {
    const m = line.match(/^[ \t]*/)
    return m ? m[0]! : ''
  }
  const indentByNorm = new Map<string, string>()
  for (let i = 0; i < matchedFileLines.length; i++) {
    const key = beforeNorm[i] ?? normalizeLineForFuzzy(matchedFileLines[i] ?? '')
    if (key && !indentByNorm.has(key)) {
      indentByNorm.set(key, indentOf(matchedFileLines[i] ?? ''))
    }
  }
  const fallbackIndent =
    matchedFileLines.length > 0 ? indentOf(matchedFileLines[0]!) : ''

  return afterLines.map((line) => {
    const norm = normalizeLineForFuzzy(line)
    if (!norm) return ''
    const prefer = indentByNorm.get(norm)
    if (prefer != null) return prefer + norm
    // New/changed line: keep model indent if present, else file fallback
    const modelIndent = indentOf(line)
    return (modelIndent || fallbackIndent) + norm
  })
}

/**
 * Exact → newline-normalized → whitespace-fuzzy search/replace.
 * Shared by apply_diff (AgentToolRegistry).
 */
export function applySearchReplaceFuzzy(
  original: string,
  searchBlock: string,
  replaceBlock: string,
  replaceAll = false
):
  | { ok: true; content: string; normalized?: boolean; replacements: number }
  | { ok: false; error: string } {
  const tryOnce = (
    hay: string,
    needle: string,
    rep: string
  ):
    | { ok: true; content: string; replacements: number }
    | { ok: false; error: string } => {
    if (!needle) return { ok: false, error: 'not found' }
    const n = hay.split(needle).length - 1
    if (n === 0) return { ok: false, error: 'not found' }
    if (n > 1 && !replaceAll) {
      return {
        ok: false,
        error: `matched ${n} times — must be unique. Pass replace_all=true to replace all ${n} occurrences.`
      }
    }
    return {
      ok: true,
      content: replaceAll && n > 1 ? hay.split(needle).join(rep) : hay.replace(needle, rep),
      replacements: n
    }
  }

  const exact = tryOnce(original, searchBlock, replaceBlock)
  if (exact.ok) return exact

  const normOrig = original.replace(/\r\n/g, '\n')
  const normSearch = searchBlock.replace(/\r\n/g, '\n')
  const normReplace = replaceBlock.replace(/\r\n/g, '\n')
  const soft = tryOnce(normOrig, normSearch, normReplace)
  if (soft.ok) {
    return { ok: true, content: soft.content, normalized: true, replacements: soft.replacements }
  }

  if (exact.error?.includes('times') || soft.error?.includes('times')) {
    return {
      ok: false,
      error: exact.error?.includes('times')
        ? exact.error
        : (soft.error ?? 'search_block matched multiple times — must be unique')
    }
  }

  const searchLines = normSearch.split('\n')
  const replaceLines = normReplace.split('\n')
  const fuzzy = findFuzzyLineRange(normOrig, searchLines)
  if (!fuzzy.ok) {
    return { ok: false, error: `search_block not found` }
  }
  const fileLines = normOrig.split('\n')
  const mapped = mapFuzzyAfterLines(
    fileLines.slice(fuzzy.start, fuzzy.end),
    searchLines,
    replaceLines
  )
  const next = [
    ...fileLines.slice(0, fuzzy.start),
    ...mapped,
    ...fileLines.slice(fuzzy.end)
  ].join('\n')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  return {
    ok: true,
    content: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next,
    normalized: true,
    replacements: 1
  }
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
  'web_search',
  'get_diagnostics'
] as const

export function filterExploreToolSchemas<T extends { function: { name: string } }>(
  schemas: readonly T[]
): T[] {
  const allow = new Set<string>(EXPLORE_SUBAGENT_TOOL_NAMES)
  return schemas.filter((s) => allow.has(s.function.name))
}
