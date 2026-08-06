import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { app } from 'electron'
import { fsSafeRootKey } from '../../shared/workspace'
import {
  buildCorpusStats,
  buildTermFreqs,
  chunkLines,
  rankBm25,
  tokenize,
  type Bm25CorpusStats,
  type Bm25Doc
} from '../../shared/bm25'
import type { CodebaseQueryResult, ContextIndexStatus } from '../../shared/context'

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

const MAX_FILE_BYTES = 400_000
const MAX_FILES = 5_000
const MAX_CHUNKS = 50_000
const CHUNK_LINES = 100
const CHUNK_OVERLAP = 10
const QUERY_TOP_K = 24
const QUERY_MAX_CHARS = 6_000

interface FileMeta {
  mtimeMs: number
  size: number
}

interface StoredChunk {
  id: string
  path: string
  startLine: number
  endLine: number
  text: string
  tf: Record<string, number>
  dl: number
}

interface IndexManifest {
  version: 1
  rootKey: string
  root: string
  builtAt: number
  files: Record<string, FileMeta>
  docCount: number
  avgDl: number
  df: Record<string, number>
  fileCount: number
  chunkCount: number
}

interface MemoryIndex {
  chunks: StoredChunk[]
  docs: Bm25Doc[]
  stats: Bm25CorpusStats
  byPath: Map<string, string[]>
  manifest: IndexManifest
}

/** Per-workspace BM25 index under userData/context-index/{fsSafeRootKey}/. */
export class ContextIndex {
  private root = ''
  private rootKey = '__none__'
  private mem: MemoryIndex | null = null
  private state: ContextIndexStatus['state'] = 'idle'
  private error?: string
  private buildPromise: Promise<void> | null = null
  private invalidateTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPaths = new Set<string>()

  setRoot(root: string): void {
    this.root = root
    this.rootKey = fsSafeRootKey(root)
    this.mem = null
    this.state = 'idle'
    this.error = undefined
  }

  getStatus(): ContextIndexStatus {
    return {
      state: this.state,
      fileCount: this.mem?.manifest.fileCount ?? 0,
      chunkCount: this.mem?.manifest.chunkCount ?? 0,
      builtAt: this.mem?.manifest.builtAt ?? null,
      error: this.error
    }
  }

  isReady(): boolean {
    return this.state === 'ready' && this.mem != null
  }

  /** Load from disk or rebuild (no-op if already building). */
  async ensureReady(): Promise<void> {
    if (!this.root || this.rootKey === '__none__') return
    if (this.state === 'ready' && this.mem) return
    if (this.buildPromise) return this.buildPromise
    this.buildPromise = this.loadOrBuild()
      .catch((e) => {
        this.state = 'error'
        this.error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        this.buildPromise = null
      })
    return this.buildPromise
  }

  /** Debounced update for changed paths (empty = full refresh). */
  invalidate(paths: string[] = []): void {
    for (const p of paths) {
      if (p) this.pendingPaths.add(p.replace(/\\/g, '/'))
    }
    if (paths.length === 0) this.pendingPaths.add('__full__')
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer)
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null
      void this.applyInvalidation()
    }, 1_500)
  }

  query(query: string): CodebaseQueryResult | null {
    if (!this.mem || this.state !== 'ready') return null
    const q = query.trim()
    if (!q) return { text: '', hits: 0, files: [], source: 'bm25' }

    const terms = tokenize(q).slice(0, 12)
    if (terms.length === 0) {
      return { text: '', hits: 0, files: [], source: 'bm25' }
    }

    const ranked = rankBm25(terms, this.mem.docs, this.mem.stats, QUERY_TOP_K)
    const byId = new Map(this.mem.chunks.map((c) => [c.id, c]))
    const files = new Set<string>()
    const blocks: string[] = [
      `[Codebase hits (BM25) for: ${q.slice(0, 120)}]`,
      `hits=${ranked.length}`
    ]
    let budget = QUERY_MAX_CHARS
    let hitCount = 0

    for (const h of ranked) {
      const chunk = byId.get(h.id)
      if (!chunk) continue
      files.add(chunk.path)
      const preview = chunk.text
        .split('\n')
        .slice(0, 12)
        .map((l, i) => `${chunk.startLine + i}| ${l.slice(0, 160)}`)
        .join('\n')
      const block = `${chunk.path}:${chunk.startLine}-${chunk.endLine} (score=${h.score.toFixed(2)})\n${preview}`
      if (block.length + 8 > budget) break
      blocks.push('---')
      blocks.push(block)
      budget -= block.length + 8
      hitCount++
    }

    blocks[1] = `hits=${hitCount} files=${files.size}`
    return {
      text: blocks.join('\n'),
      hits: hitCount,
      files: [...files],
      source: 'bm25'
    }
  }

  private dir(): string {
    return join(app.getPath('userData'), 'context-index', this.rootKey)
  }

  private async loadOrBuild(): Promise<void> {
    this.state = 'building'
    this.error = undefined
    try {
      const loaded = await this.tryLoad()
      if (loaded) {
        this.mem = loaded
        this.state = 'ready'
        void this.refreshStale()
        return
      }
      await this.fullBuild()
    } catch (e) {
      this.state = 'error'
      this.error = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  private async tryLoad(): Promise<MemoryIndex | null> {
    try {
      const raw = await fs.readFile(join(this.dir(), 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw) as IndexManifest
      if (manifest.version !== 1 || manifest.rootKey !== this.rootKey) return null
      const chunksRaw = await fs.readFile(join(this.dir(), 'chunks.json'), 'utf8')
      const chunks = JSON.parse(chunksRaw) as StoredChunk[]
      return memoryFromStored(manifest, chunks)
    } catch {
      return null
    }
  }

  private async fullBuild(): Promise<void> {
    this.state = 'building'
    const filesMeta: Record<string, FileMeta> = {}
    const chunks: StoredChunk[] = []
    let fileCount = 0

    await walkFiles(this.root, this.root, async (rel, abs) => {
      if (fileCount >= MAX_FILES || chunks.length >= MAX_CHUNKS) return false
      try {
        const st = await fs.stat(abs)
        if (st.size > MAX_FILE_BYTES) return true
        const text = await fs.readFile(abs, 'utf8')
        if (/[\u0000]/.test(text.slice(0, 4096))) return true
        filesMeta[rel] = { mtimeMs: st.mtimeMs, size: st.size }
        fileCount++
        appendChunks(chunks, rel, text)
      } catch {
        /* skip */
      }
      return chunks.length < MAX_CHUNKS
    })

    const mem = memoryFromStored(
      {
        version: 1,
        rootKey: this.rootKey,
        root: this.root,
        builtAt: Date.now(),
        files: filesMeta,
        docCount: 0,
        avgDl: 0,
        df: {},
        fileCount,
        chunkCount: chunks.length
      },
      chunks
    )
    this.mem = mem
    await this.persist()
    this.state = 'ready'
  }

  private async refreshStale(): Promise<void> {
    if (!this.mem) return
    const changed: string[] = []
    for (const [rel, meta] of Object.entries(this.mem.manifest.files)) {
      try {
        const st = await fs.stat(join(this.root, ...rel.split('/')))
        if (st.mtimeMs !== meta.mtimeMs || st.size !== meta.size) changed.push(rel)
      } catch {
        changed.push(rel)
      }
    }
    // New files: shallow — full walk only when many changes
    if (changed.length > 0) {
      for (const p of changed) this.pendingPaths.add(p)
      await this.applyInvalidation()
    }
  }

  private async applyInvalidation(): Promise<void> {
    const full = this.pendingPaths.has('__full__')
    const paths = [...this.pendingPaths].filter((p) => p !== '__full__')
    this.pendingPaths.clear()
    if (full || !this.mem) {
      await this.fullBuild()
      return
    }
    if (paths.length === 0) return

    this.state = 'building'
    try {
      const chunkMap = new Map(this.mem.chunks.map((c) => [c.id, c]))
      const byPath = this.mem.byPath
      const filesMeta = { ...this.mem.manifest.files }

      for (const rel of paths) {
        const ids = byPath.get(rel) ?? []
        for (const id of ids) chunkMap.delete(id)
        byPath.delete(rel)
        delete filesMeta[rel]

        const abs = join(this.root, ...rel.split('/'))
        try {
          const st = await fs.stat(abs)
          if (st.isFile() && st.size <= MAX_FILE_BYTES && isTextLike(rel)) {
            const text = await fs.readFile(abs, 'utf8')
            if (!/[\u0000]/.test(text.slice(0, 4096))) {
              const fresh: StoredChunk[] = []
              appendChunks(fresh, rel, text)
              for (const c of fresh) {
                chunkMap.set(c.id, c)
                const list = byPath.get(rel) ?? []
                list.push(c.id)
                byPath.set(rel, list)
              }
              filesMeta[rel] = { mtimeMs: st.mtimeMs, size: st.size }
            }
          }
        } catch {
          /* deleted */
        }
      }

      const chunks = [...chunkMap.values()]
      this.mem = memoryFromStored(
        {
          version: 1,
          rootKey: this.rootKey,
          root: this.root,
          builtAt: Date.now(),
          files: filesMeta,
          docCount: 0,
          avgDl: 0,
          df: {},
          fileCount: Object.keys(filesMeta).length,
          chunkCount: chunks.length
        },
        chunks
      )
      await this.persist()
      this.state = 'ready'
    } catch (e) {
      this.state = 'error'
      this.error = e instanceof Error ? e.message : String(e)
    }
  }

  private async persist(): Promise<void> {
    if (!this.mem) return
    const dir = this.dir()
    await fs.mkdir(dir, { recursive: true })
    const { stats } = this.mem
    const dfObj: Record<string, number> = {}
    if (stats.df instanceof Map) {
      for (const [k, v] of stats.df) dfObj[k] = v
    } else {
      Object.assign(dfObj, stats.df)
    }
    const manifest: IndexManifest = {
      ...this.mem.manifest,
      docCount: stats.docCount,
      avgDl: stats.avgDl,
      df: dfObj,
      chunkCount: this.mem.chunks.length,
      fileCount: Object.keys(this.mem.manifest.files).length,
      builtAt: Date.now()
    }
    this.mem.manifest = manifest
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    await fs.writeFile(join(dir, 'chunks.json'), JSON.stringify(this.mem.chunks), 'utf8')
  }
}

function memoryFromStored(manifest: IndexManifest, chunks: StoredChunk[]): MemoryIndex {
  const docs: Bm25Doc[] = chunks.map((c) => ({
    id: c.id,
    tf: c.tf,
    dl: c.dl
  }))
  const stats =
    manifest.docCount > 0 && Object.keys(manifest.df).length > 0
      ? {
          docCount: manifest.docCount,
          avgDl: manifest.avgDl,
          df: manifest.df
        }
      : buildCorpusStats(docs)

  const dfObj: Record<string, number> = {}
  if (stats.df instanceof Map) {
    for (const [k, v] of stats.df) dfObj[k] = v
  } else {
    Object.assign(dfObj, stats.df)
  }
  manifest.docCount = stats.docCount
  manifest.avgDl = stats.avgDl
  manifest.df = dfObj
  manifest.chunkCount = chunks.length

  const byPath = new Map<string, string[]>()
  for (const c of chunks) {
    const list = byPath.get(c.path) ?? []
    list.push(c.id)
    byPath.set(c.path, list)
  }

  return { chunks, docs, stats, byPath, manifest }
}

function appendChunks(out: StoredChunk[], rel: string, text: string): void {
  for (const ch of chunkLines(text, CHUNK_LINES, CHUNK_OVERLAP)) {
    if (out.length >= MAX_CHUNKS) return
    const tokens = tokenize(`${rel}\n${ch.text}`)
    const tfMap = buildTermFreqs(tokens)
    const tf: Record<string, number> = {}
    for (const [k, v] of tfMap) tf[k] = v
    const id = createHash('sha1')
      .update(`${rel}:${ch.startLine}:${ch.endLine}`)
      .digest('hex')
      .slice(0, 16)
    out.push({
      id,
      path: rel,
      startLine: ch.startLine,
      endLine: ch.endLine,
      text: ch.text.slice(0, 8_000),
      tf,
      dl: tokens.length
    })
  }
}

function isTextLike(name: string): boolean {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXT.has(base.slice(dot).toLowerCase())
}

async function walkFiles(
  root: string,
  current: string,
  onFile: (rel: string, abs: string) => Promise<boolean>,
  depth = 0
): Promise<void> {
  if (depth > 12) return
  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
    const abs = join(current, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(root, abs, onFile, depth + 1)
    } else if (isTextLike(entry.name)) {
      const rel = relative(root, abs).split(sep).join('/')
      const cont = await onFile(rel, abs)
      if (!cont) return
    }
  }
}
