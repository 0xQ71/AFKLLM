import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CodebaseQueryResult, RepoMapSnapshot } from '../../shared/context'

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.next',
  'coverage',
  '.cache',
  'bin',
  'models',
  '.cursor'
])

const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.css',
  '.html',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.toml',
  '.yml',
  '.yaml',
  '.xml',
  '.sql',
  '.sh',
  '.ps1'
])

const PRIORITY_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'readme.md',
  'cargo.toml',
  'pyproject.toml',
  'main.ts',
  'main.py',
  'index.ts',
  'index.tsx',
  'app.tsx',
  'app.ts'
])

const MAP_MAX_CHARS = 3_500
const MAP_MAX_FILES = 100
const QUERY_MAX_HITS = 40
const QUERY_MAX_CHARS = 6_000
const SNIPPET_LINES = 5

/** Compact repo map for agent context (dirs + key files). */
export async function buildRepoMap(root: string): Promise<RepoMapSnapshot> {
  const files: string[] = []
  const dirs: string[] = []
  await walk(root, root, 5, files, dirs)

  files.sort((a, b) => priorityScore(b) - priorityScore(a) || a.localeCompare(b))
  const picked = files.slice(0, MAP_MAX_FILES)

  const byTop = new Map<string, string[]>()
  for (const f of picked) {
    const top = f.includes('/') ? f.slice(0, f.indexOf('/')) + '/' : '(root)'
    const list = byTop.get(top) ?? []
    list.push(f)
    byTop.set(top, list)
  }

  const lines: string[] = [
    '[Repo map — prefer these paths; do not invent duplicates]',
    `files≈${files.length} dirs≈${dirs.length} (showing ${picked.length})`
  ]

  for (const [top, list] of [...byTop.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${top}`)
    for (const f of list.slice(0, 24)) {
      lines.push(`  ${f}`)
    }
    if (list.length > 24) lines.push(`  … +${list.length - 24} more`)
  }

  let text = lines.join('\n')
  if (text.length > MAP_MAX_CHARS) {
    text = text.slice(0, MAP_MAX_CHARS) + '\n…(truncated)'
  }

  return { text, fileCount: files.length, dirCount: dirs.length }
}

/** @codebase snippets — BM25 when ready, else on-demand scan. */
export async function queryCodebase(
  root: string,
  query: string,
  index?: { isReady(): boolean; query(q: string): CodebaseQueryResult | null }
): Promise<CodebaseQueryResult> {
  const q = query.trim()
  if (!q) {
    return { text: '', hits: 0, files: [], source: 'scan' }
  }

  if (index?.isReady()) {
    const hit = index.query(q)
    if (hit && hit.hits > 0) return hit
    if (hit && hit.hits === 0) return { ...hit, source: 'bm25' }
  }

  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8)

  const needles = terms.length ? terms : [q.toLowerCase()]
  const hits: Array<{ path: string; line: number; preview: string; score: number }> = []
  const files = new Set<string>()

  await visitGrep(root, root, needles, hits, QUERY_MAX_HITS)

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const top = hits.slice(0, 24)
  for (const h of top) files.add(h.path)

  const blocks: string[] = [
    `[Codebase context (scan) for query: ${q.slice(0, 120)}]`,
    `hits=${top.length} files=${files.size}`
  ]

  let budget = QUERY_MAX_CHARS
  for (const h of top) {
    const chunk = `${h.path}:${h.line}\n${h.preview}`
    if (chunk.length + 8 > budget) break
    blocks.push('---')
    blocks.push(chunk)
    budget -= chunk.length + 8
  }

  return {
    text: blocks.join('\n'),
    hits: top.length,
    files: [...files],
    source: 'scan'
  }
}

async function walk(
  root: string,
  current: string,
  maxDepth: number,
  files: string[],
  dirs: string[],
  depth = 0
): Promise<void> {
  if (depth > maxDepth) return
  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
    const full = join(current, entry.name)
    const rel = relative(root, full).split(sep).join('/')
    if (entry.isDirectory()) {
      dirs.push(rel)
      await walk(root, full, maxDepth, files, dirs, depth + 1)
    } else if (isTextLike(entry.name)) {
      files.push(rel)
    }
  }
}

async function visitGrep(
  root: string,
  dir: string,
  needles: string[],
  hits: Array<{ path: string; line: number; preview: string; score: number }>,
  limit: number
): Promise<void> {
  if (hits.length >= limit) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (hits.length >= limit) return
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await visitGrep(root, full, needles, hits, limit)
      continue
    }
    if (!isTextLike(entry.name)) continue
    const rel = relative(root, full).split(sep).join('/')
    let text: string
    try {
      text = await fs.readFile(full, 'utf8')
    } catch {
      continue
    }
    if (text.length > 400_000) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) return
      const lower = lines[i]!.toLowerCase()
      let score = 0
      for (const n of needles) {
        if (lower.includes(n)) score += n.length >= 4 ? 2 : 1
      }
      if (rel.toLowerCase().split('/').some((p) => needles.some((n) => p.includes(n)))) {
        score += 1
      }
      if (score === 0) continue
      const from = Math.max(0, i - 1)
      const to = Math.min(lines.length, i + SNIPPET_LINES)
      const preview = lines
        .slice(from, to)
        .map((l, idx) => `${from + idx + 1}| ${l.slice(0, 160)}`)
        .join('\n')
      hits.push({ path: rel, line: i + 1, preview, score })
    }
  }
}

function isTextLike(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXT.has(name.slice(dot).toLowerCase())
}

function priorityScore(rel: string): number {
  const base = rel.split('/').pop()?.toLowerCase() ?? ''
  let s = 0
  if (PRIORITY_NAMES.has(base)) s += 10
  if (rel.startsWith('src/')) s += 3
  if (/\.(ts|tsx|py|go|rs)$/.test(base)) s += 2
  return s
}
