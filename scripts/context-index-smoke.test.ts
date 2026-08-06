import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCorpusStats,
  buildTermFreqs,
  chunkLines,
  rankBm25,
  tokenize,
  type Bm25Doc
} from '../src/shared/bm25'
import {
  clearWebSearchMemoryCache,
  getWebSearchCached,
  normalizeWebSearchCacheKey,
  pruneWebSearchCache,
  putWebSearchCache,
  setWebSearchCacheDir,
  webSearchCacheHash
} from '../src/main/agent/WebSearch'

describe('tokenize + BM25 ranking', () => {
  it('tokenizes path-ish terms', () => {
    const t = tokenize('Auth Middleware in src/auth/middleware.ts')
    assert.ok(t.includes('auth'))
    assert.ok(t.includes('middleware'))
    assert.ok(t.some((x) => x.includes('middleware.ts') || x === 'middleware'))
  })

  it('ranks the doc with matching rare terms higher', () => {
    const docs: Bm25Doc[] = [
      {
        id: 'a',
        tf: buildTermFreqs(tokenize('hello world common common')),
        dl: 4
      },
      {
        id: 'b',
        tf: buildTermFreqs(tokenize('auth middleware jwt verify')),
        dl: 4
      },
      {
        id: 'c',
        tf: buildTermFreqs(tokenize('common hello list directory')),
        dl: 4
      }
    ]
    const stats = buildCorpusStats(docs)
    const hits = rankBm25(tokenize('auth middleware'), docs, stats, 3)
    assert.equal(hits[0]?.id, 'b')
    assert.ok((hits[0]?.score ?? 0) > 0)
  })
})

describe('chunkLines', () => {
  it('produces overlapping chunks with correct line ranges', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`)
    const chunks = chunkLines(lines.join('\n'), 100, 10)
    assert.ok(chunks.length >= 3)
    assert.equal(chunks[0]!.startLine, 1)
    assert.equal(chunks[0]!.endLine, 100)
    // step = 90 → second chunk starts at line 91
    assert.equal(chunks[1]!.startLine, 91)
    assert.ok(chunks[1]!.startLine < chunks[0]!.endLine)
    const last = chunks[chunks.length - 1]!
    assert.equal(last.endLine, 250)
  })
})

describe('web_search TTL cache', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'afkllm-wsc-'))
    setWebSearchCacheDir(dir)
    clearWebSearchMemoryCache()
  })

  after(async () => {
    clearWebSearchMemoryCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('normalizes key and hashes stably', () => {
    const a = normalizeWebSearchCacheKey('  Foo   Bar ', 8)
    const b = normalizeWebSearchCacheKey('foo bar', 8)
    assert.equal(a, b)
    assert.equal(webSearchCacheHash(a).length, 32)
  })

  it('cache hit returns same hits with cached tag', async () => {
    const hits = [
      { title: 'Doc', url: 'https://example.com', snippet: 'hello', source: 'duckduckgo' }
    ]
    await putWebSearchCache('react hooks', 5, {
      ok: true,
      query: 'react hooks',
      hits,
      sources: ['duckduckgo']
    })
    clearWebSearchMemoryCache()
    const cached = await getWebSearchCached('React   Hooks', 5)
    assert.ok(cached)
    assert.equal(cached!.hits.length, 1)
    assert.equal(cached!.hits[0]!.url, 'https://example.com')
    assert.ok(cached!.sources?.includes('cached'))
    assert.ok(cached!.hits[0]!.source?.includes('cached'))
  })

  it('pruneWebSearchCache removes oldest over max', async () => {
    const pruneDir = await mkdtemp(join(tmpdir(), 'afkllm-prune-'))
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(pruneDir, `f${i}.json`), '{}', 'utf8')
        // stagger mtimes slightly via rewrite order is enough on most FS
        await new Promise((r) => setTimeout(r, 15))
      }
      const removed = await pruneWebSearchCache(pruneDir, 2)
      assert.equal(removed, 3)
      const left = await readdir(pruneDir)
      assert.equal(left.length, 2)
    } finally {
      await rm(pruneDir, { recursive: true, force: true })
    }
  })
})
