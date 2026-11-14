/**
 * Multi-provider web search without API keys.
 * Providers: DuckDuckGo HTML, Bing HTML, Brave HTML (best-effort),
 * Wikipedia MediaWiki search, Stack Overflow API, HN Algolia.
 * Results are cached in memory + disk (TTL 6h).
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  source?: string
}

export interface WebSearchResult {
  ok: boolean
  query: string
  hits: WebSearchHit[]
  /** Which backends returned hits */
  sources?: string[]
  error?: string
  /** True when providers failed due to no network — soft skip, not a hard tool error */
  skipped?: boolean
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const PROVIDER_TIMEOUT_MS = 10_000
const MAX_HITS = 8
const MAX_SNIPPET = 280

const WEB_SEARCH_TTL_MS = 6 * 60 * 60 * 1000
const WEB_SEARCH_CACHE_MAX = 200

const HTML_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
}

const JSON_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
}

interface DiskCacheEntry {
  key: string
  savedAt: number
  result: WebSearchResult
}

const memoryCache = new Map<string, DiskCacheEntry>()
let webSearchCacheDir: string | null = null

/** Set disk cache directory (main process: userData/web-search-cache). */
export function setWebSearchCacheDir(dir: string): void {
  webSearchCacheDir = dir
}

export function normalizeWebSearchCacheKey(query: string, limit: number): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${q}|${limit}`
}

export function webSearchCacheHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

function tagCachedResult(result: WebSearchResult): WebSearchResult {
  const sources = [...(result.sources ?? [])]
  if (!sources.includes('cached')) sources.push('cached')
  return {
    ...result,
    sources,
    hits: result.hits.map((h) => ({
      ...h,
      source: h.source?.includes('(cached)')
        ? h.source
        : h.source
          ? `${h.source} (cached)`
          : 'cached'
    }))
  }
}

async function readDiskCache(key: string): Promise<DiskCacheEntry | null> {
  if (!webSearchCacheDir) return null
  try {
    const path = join(webSearchCacheDir, `${webSearchCacheHash(key)}.json`)
    const raw = await fs.readFile(path, 'utf8')
    const entry = JSON.parse(raw) as DiskCacheEntry
    if (entry.key !== key || typeof entry.savedAt !== 'number') return null
    if (Date.now() - entry.savedAt > WEB_SEARCH_TTL_MS) return null
    return entry
  } catch {
    return null
  }
}

/** Prune oldest cache files when over max. Exported for smoke. */
export async function pruneWebSearchCache(
  dir: string,
  maxFiles = WEB_SEARCH_CACHE_MAX
): Promise<number> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'))
  if (files.length <= maxFiles) return 0
  const withMtime: Array<{ name: string; mtimeMs: number }> = []
  for (const f of files) {
    try {
      const st = await fs.stat(join(dir, f.name))
      withMtime.push({ name: f.name, mtimeMs: st.mtimeMs })
    } catch {
      /* skip */
    }
  }
  withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const toRemove = withMtime.slice(0, Math.max(0, withMtime.length - maxFiles))
  for (const f of toRemove) {
    try {
      await fs.unlink(join(dir, f.name))
    } catch {
      /* skip */
    }
  }
  return toRemove.length
}

async function writeDiskCache(key: string, result: WebSearchResult): Promise<void> {
  if (!webSearchCacheDir) return
  try {
    await fs.mkdir(webSearchCacheDir, { recursive: true })
    const entry: DiskCacheEntry = { key, savedAt: Date.now(), result }
    const path = join(webSearchCacheDir, `${webSearchCacheHash(key)}.json`)
    await fs.writeFile(path, JSON.stringify(entry), 'utf8')
    memoryCache.set(key, entry)
    await pruneWebSearchCache(webSearchCacheDir)
  } catch {
    /* best-effort */
  }
}

/** Lookup cache (memory then disk). Exported for smoke tests. */
export async function getWebSearchCached(
  query: string,
  limit: number,
  now = Date.now()
): Promise<WebSearchResult | null> {
  const key = normalizeWebSearchCacheKey(query, limit)
  const mem = memoryCache.get(key)
  if (mem && now - mem.savedAt <= WEB_SEARCH_TTL_MS) {
    return tagCachedResult(mem.result)
  }
  const disk = await readDiskCache(key)
  if (disk) {
    memoryCache.set(key, disk)
    return tagCachedResult(disk.result)
  }
  return null
}

/** Write cache entry. Exported for smoke tests. */
export async function putWebSearchCache(
  query: string,
  limit: number,
  result: WebSearchResult
): Promise<void> {
  const key = normalizeWebSearchCacheKey(query, limit)
  const entry: DiskCacheEntry = { key, savedAt: Date.now(), result }
  memoryCache.set(key, entry)
  await writeDiskCache(key, result)
}

/** Clear in-memory cache (tests). */
export function clearWebSearchMemoryCache(): void {
  memoryCache.clear()
}

/** @deprecated public SearX list kept for tests/import compatibility */
export const SEARX_INSTANCES = [
  'https://searx.be',
  'https://search.sapti.me',
  'https://searx.tiekoetter.com'
]

/** Decode common HTML entities in scraped text. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Strip tags and collapse whitespace. */
export function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse DuckDuckGo HTML results page into hits.
 * Exported for smoke tests (fixture HTML).
 */
export function parseDuckDuckGoHtml(html: string, limit = MAX_HITS): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/body>|$)/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && hits.length < limit) {
    const rawHref = decodeHtmlEntities(m[1] ?? '')
    const title = stripTags(m[2] ?? '')
    const rest = m[3] ?? ''
    const snipMatch =
      rest.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i) ??
      rest.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</i)
    const snippet = stripTags(snipMatch?.[1] ?? '').slice(0, MAX_SNIPPET)
    const url = unwrapDdgRedirect(rawHref)
    if (!url || !title) continue
    if (/duckduckgo\.com\/y\.js/i.test(url)) continue
    hits.push({ title, url, snippet, source: 'duckduckgo' })
  }

  if (hits.length === 0) {
    const liteRe =
      /<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    while ((m = liteRe.exec(html)) !== null && hits.length < limit) {
      const url = unwrapDdgRedirect(decodeHtmlEntities(m[1] ?? ''))
      const title = stripTags(m[2] ?? '')
      if (!url || !title || /duckduckgo\.com/i.test(url)) continue
      hits.push({ title, url, snippet: '', source: 'duckduckgo-lite' })
    }
  }

  return hits
}

/** DDG wraps outbound links as //duckduckgo.com/l/?uddg=… */
export function unwrapDdgRedirect(href: string): string {
  let h = href.trim()
  if (h.startsWith('//')) h = 'https:' + h
  try {
    const u = new URL(h)
    if (/duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith('/l/')) {
      const uddg = u.searchParams.get('uddg')
      if (uddg) return decodeURIComponent(uddg)
    }
    return u.toString()
  } catch {
    return h
  }
}

/** Bing wraps links as /ck/a?...&u=a1BASE64… */
export function unwrapBingRedirect(href: string): string {
  const raw = decodeHtmlEntities(href.trim())
  try {
    const u = new URL(raw, 'https://www.bing.com')
    const enc = u.searchParams.get('u')
    if (enc && /^a1/i.test(enc)) {
      const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      if (/^https?:\/\//i.test(decoded)) return decoded
    }
    if (/^https?:\/\//i.test(raw) && !/bing\.com\/ck\//i.test(raw)) return raw
  } catch {
    /* fall through */
  }
  return raw
}

/** Parse Bing SERP HTML (`li.b_algo`). */
export function parseBingHtml(html: string, limit = MAX_HITS): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const blockRe = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && hits.length < limit) {
    const block = m[1] ?? ''
    const link =
      block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<a[^>]*href="([^"]+)"[^>]*h="ID=SERP[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const url = unwrapBingRedirect(link[1] ?? '')
    const title = stripTags(link[2] ?? '')
    const snipMatch =
      block.match(/class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = stripTags(snipMatch?.[1] ?? '').slice(0, MAX_SNIPPET)
    if (!title || !url || !/^https?:\/\//i.test(url)) continue
    if (/bing\.com\//i.test(url)) continue
    hits.push({ title, url, snippet, source: 'bing' })
  }
  return hits
}

/** Parse SearXNG JSON `results` array (kept for tests). */
export function parseSearxJson(raw: unknown, limit = MAX_HITS): WebSearchHit[] {
  if (!raw || typeof raw !== 'object') return []
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const hits: WebSearchHit[] = []
  for (const r of results) {
    if (hits.length >= limit) break
    if (!r || typeof r !== 'object') continue
    const row = r as { title?: unknown; url?: unknown; content?: unknown }
    const title = String(row.title ?? '').trim()
    const url = String(row.url ?? '').trim()
    const snippet = String(row.content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SNIPPET)
    if (!title || !url || !/^https?:\/\//i.test(url)) continue
    hits.push({ title, url, snippet, source: 'searx' })
  }
  return hits
}

/** Parse SearXNG HTML results (best-effort; many instances use antibot). */
export function parseSearxHtml(html: string, limit = MAX_HITS): WebSearchHit[] {
  if (/Making sure you're not a bot|Anubis|Verifying your browser|cf-browser-verification/i.test(html)) {
    return []
  }
  const hits: WebSearchHit[] = []
  const articleRe =
    /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi
  let m: RegExpExecArray | null
  while ((m = articleRe.exec(html)) !== null && hits.length < limit) {
    const block = m[1] ?? ''
    const link =
      block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const url = decodeHtmlEntities(link[1] ?? '').trim()
    const title = stripTags(link[2] ?? '')
    const snipMatch = block.match(/class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\//i)
    const snippet = stripTags(snipMatch?.[1] ?? '').slice(0, MAX_SNIPPET)
    if (!title || !url || !/^https?:\/\//i.test(url)) continue
    hits.push({ title, url, snippet, source: 'searx' })
  }
  return hits
}

/** Parse Brave Search HTML. */
export function parseBraveHtml(html: string, limit = MAX_HITS): WebSearchHit[] {
  if (/Too Many Requests|rate.?limit/i.test(html) && html.length < 100_000) {
    // short 429 body vs large real SERP
  }
  const hits: WebSearchHit[] = []
  const blockRe =
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*heading-serpresult[^"]*"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*heading-serpresult|<\/main>|$)/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && hits.length < limit) {
    const url = decodeHtmlEntities(m[1] ?? '').trim()
    const title = stripTags(m[2] ?? '')
    const rest = m[3] ?? ''
    const snipMatch =
      rest.match(/class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\//i) ??
      rest.match(/class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\//i)
    const snippet = stripTags(snipMatch?.[1] ?? '').slice(0, MAX_SNIPPET)
    if (!title || !url || /brave\.com\/search/i.test(url)) continue
    hits.push({ title, url, snippet, source: 'brave' })
  }
  return hits
}

/** Parse Wikipedia OpenSearch JSON: [query, titles[], desc[], urls[]]. */
export function parseWikipediaOpenSearch(
  raw: unknown,
  limit = MAX_HITS
): WebSearchHit[] {
  if (!Array.isArray(raw) || raw.length < 4) return []
  const titles = raw[1]
  const descs = raw[2]
  const urls = raw[3]
  if (!Array.isArray(titles) || !Array.isArray(urls)) return []
  const hits: WebSearchHit[] = []
  for (let i = 0; i < titles.length && hits.length < limit; i++) {
    const title = String(titles[i] ?? '').trim()
    const url = String(urls[i] ?? '').trim()
    const snippet = String(Array.isArray(descs) ? (descs[i] ?? '') : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SNIPPET)
    if (!title || !url) continue
    hits.push({ title, url, snippet, source: 'wikipedia' })
  }
  return hits
}

/** Parse MediaWiki `list=search` JSON. */
export function parseWikipediaSearch(raw: unknown, limit = MAX_HITS, lang = 'en'): WebSearchHit[] {
  if (!raw || typeof raw !== 'object') return []
  const search = (raw as { query?: { search?: unknown } }).query?.search
  if (!Array.isArray(search)) return []
  const hits: WebSearchHit[] = []
  for (const row of search) {
    if (hits.length >= limit) break
    if (!row || typeof row !== 'object') continue
    const r = row as { title?: unknown; snippet?: unknown }
    const title = String(r.title ?? '').trim()
    if (!title) continue
    const snippet = stripTags(String(r.snippet ?? '')).slice(0, MAX_SNIPPET)
    const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
    hits.push({ title, url, snippet, source: `wikipedia-${lang}` })
  }
  return hits
}

/** Parse Stack Exchange `/search/advanced` or `/search/excerpts` JSON. */
export function parseStackOverflowJson(raw: unknown, limit = MAX_HITS): WebSearchHit[] {
  if (!raw || typeof raw !== 'object') return []
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const hits: WebSearchHit[] = []
  for (const row of items) {
    if (hits.length >= limit) break
    if (!row || typeof row !== 'object') continue
    const r = row as {
      title?: unknown
      link?: unknown
      excerpt?: unknown
      body?: unknown
      tags?: unknown
    }
    const title = decodeHtmlEntities(String(r.title ?? '').trim())
    const url = String(r.link ?? '').trim()
    const excerpt = stripTags(String(r.excerpt ?? r.body ?? ''))
    const tags = Array.isArray(r.tags) ? r.tags.map(String).join(', ') : ''
    const snippet = (excerpt || (tags ? `tags: ${tags}` : '')).slice(0, MAX_SNIPPET)
    if (!title || !url || !/^https?:\/\//i.test(url)) continue
    hits.push({ title, url, snippet, source: 'stackoverflow' })
  }
  return hits
}

/** Parse HN Algolia JSON. */
export function parseHnAlgoliaJson(raw: unknown, limit = MAX_HITS): WebSearchHit[] {
  if (!raw || typeof raw !== 'object') return []
  const rows = (raw as { hits?: unknown }).hits
  if (!Array.isArray(rows)) return []
  const hits: WebSearchHit[] = []
  for (const row of rows) {
    if (hits.length >= limit) break
    if (!row || typeof row !== 'object') continue
    const r = row as {
      title?: unknown
      story_title?: unknown
      url?: unknown
      story_url?: unknown
      objectID?: unknown
      story_text?: unknown
      comment_text?: unknown
    }
    const title = String(r.title ?? r.story_title ?? '').trim()
    let url = String(r.url ?? r.story_url ?? '').trim()
    if (!url && r.objectID != null) {
      url = `https://news.ycombinator.com/item?id=${r.objectID}`
    }
    const snippet = stripTags(String(r.story_text ?? r.comment_text ?? '')).slice(
      0,
      MAX_SNIPPET
    )
    if (!title || !url) continue
    hits.push({ title, url, snippet, source: 'hackernews' })
  }
  return hits
}

/**
 * Round-robin merge across provider batches so one source cannot fill the entire limit.
 * Deduplicate by normalized URL.
 */
export function mergeHits(batches: WebSearchHit[][], limit = MAX_HITS): WebSearchHit[] {
  const seen = new Set<string>()
  const out: WebSearchHit[] = []
  const queues = batches.map((b) => [...b])
  let progressed = true
  while (out.length < limit && progressed) {
    progressed = false
    for (const q of queues) {
      while (q.length > 0) {
        const h = q.shift()!
        const key = h.url.replace(/\/$/, '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(h)
        progressed = true
        break
      }
      if (out.length >= limit) return out
    }
  }
  return out
}

export function formatWebSearchHits(
  query: string,
  hits: WebSearchHit[],
  sources?: string[]
): string {
  if (hits.length === 0) {
    return `No web results for: ${query}`
  }
  const src =
    sources && sources.length > 0 ? ` (via ${sources.join(' + ')})` : ''
  const lines = [`Web search: ${query}${src}`, '']
  hits.forEach((h, i) => {
    const tag = h.source ? ` [${h.source}]` : ''
    lines.push(`${i + 1}. ${h.title}${tag}`)
    lines.push(`   ${h.url}`)
    if (h.snippet) lines.push(`   ${h.snippet}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

/** Stable marker for agent + UI when search is skipped offline. */
export function formatWebSearchSkipped(query: string, reason?: string): string {
  const why = reason?.trim() || 'no internet / network unreachable'
  return (
    `WEB_SEARCH_SKIPPED: ${why}. Query was: ${query}. ` +
    'Continue without web results — do not invent URLs. Prefer local tools (search_codebase, read_file).'
  )
}

export function isWebSearchSkippedContent(content: string): boolean {
  return /WEB_SEARCH_SKIPPED/i.test(content)
}

/** Detect DNS / connect / fetch failures across providers. */
export function looksLikeNetworkError(msg: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPROTO|UND_ERR|fetch failed|network|getaddrinfo|Failed to fetch|socket hang up|aborted|AbortError|timed?\s*out|timeout|CERT_|SSL|UNABLE_TO_VERIFY|unable to connect|no internet/i.test(
    msg
  )
}

function shouldSkipOffline(errors: string[]): boolean {
  if (errors.length === 0) return false
  const network = errors.filter(looksLikeNetworkError)
  const other = errors.filter((e) => !looksLikeNetworkError(e))
  // All failures look like network, or every provider reported a network error
  return network.length > 0 && other.length === 0
}

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
}

/** @deprecated use webSearch — kept for callers/tests */
export async function duckDuckGoSearch(
  query: string,
  limit = MAX_HITS
): Promise<WebSearchResult> {
  return webSearch(query, limit)
}

/**
 * Search the web with several no-key providers; merge & dedupe results.
 * Hits memory + disk TTL cache (6h) keyed by normalized query + limit.
 */
export async function webSearch(
  query: string,
  limit = MAX_HITS
): Promise<WebSearchResult> {
  const q = query.trim()
  if (!q) {
    return { ok: false, query: '', hits: [], error: 'query is required' }
  }

  const cached = await getWebSearchCached(q, limit)
  if (cached) return cached

  try {
    const settled = await Promise.allSettled([
      searchDuckDuckGo(q, limit),
      searchBing(q, limit),
      searchBrave(q, limit),
      searchWikipedia(q, Math.min(5, limit)),
      searchStackOverflow(q, Math.min(5, limit)),
      searchHackerNews(q, Math.min(4, limit))
    ])

    const batches: WebSearchHit[][] = []
    const sources: string[] = []
    const errors: string[] = []

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        if (s.value.hits.length > 0) {
          batches.push(s.value.hits)
          if (s.value.source && !sources.includes(s.value.source)) {
            sources.push(s.value.source)
          }
        } else if (s.value.error) {
          errors.push(s.value.error)
        }
      } else {
        errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason))
      }
    }

    const hits = mergeHits(batches, limit)
    if (hits.length === 0) {
      if (shouldSkipOffline(errors)) {
        return {
          ok: true,
          skipped: true,
          query: q,
          hits: [],
          sources: [],
          error:
            errors.slice(0, 3).join('; ') || 'no internet / network unreachable'
        }
      }
      return {
        ok: false,
        query: q,
        hits: [],
        sources: [],
        error:
          errors.slice(0, 3).join('; ') ||
          'No results from DuckDuckGo / Bing / Brave / Wikipedia / StackOverflow / HN'
      }
    }

    const result: WebSearchResult = { ok: true, query: q, hits, sources }
    void putWebSearchCache(q, limit, result)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (looksLikeNetworkError(msg)) {
      return {
        ok: true,
        skipped: true,
        query: q,
        hits: [],
        sources: [],
        error: msg
      }
    }
    return {
      ok: false,
      query: q,
      hits: [],
      error: msg
    }
  }
}

async function searchDuckDuckGo(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  try {
    const signal = providerSignal()
    let hits = await fetchHtmlAndParseDdg(
      'https://html.duckduckgo.com/html/?' + new URLSearchParams({ q: query }).toString(),
      limit,
      signal,
      'https://html.duckduckgo.com/'
    )
    let source = 'duckduckgo'
    if (hits.length === 0) {
      hits = await fetchHtmlAndParseDdg(
        'https://lite.duckduckgo.com/lite/?' + new URLSearchParams({ q: query }).toString(),
        limit,
        signal,
        'https://lite.duckduckgo.com/'
      )
      source = 'duckduckgo-lite'
    }
    if (hits.length === 0) {
      return { hits: [], source, error: 'duckduckgo: empty' }
    }
    return {
      hits: hits.map((h) => ({ ...h, source: h.source || source })),
      source
    }
  } catch (e) {
    return {
      hits: [],
      source: 'duckduckgo',
      error: `duckduckgo: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function fetchHtmlAndParseDdg(
  url: string,
  limit: number,
  signal: AbortSignal,
  referer: string
): Promise<WebSearchHit[]> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...HTML_HEADERS, Referer: referer },
    signal,
    redirect: 'follow'
  })
  if (!res.ok) return []
  const html = await res.text()
  if (!/result__a|uddg=/i.test(html)) return []
  return parseDuckDuckGoHtml(html, limit)
}

async function searchBing(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  try {
    const url =
      'https://www.bing.com/search?' +
      new URLSearchParams({ q: query, setlang: 'en-US' }).toString()
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...HTML_HEADERS, Referer: 'https://www.bing.com/' },
      signal: providerSignal(),
      redirect: 'follow'
    })
    if (!res.ok) return { hits: [], source: 'bing', error: `bing: HTTP ${res.status}` }
    const hits = parseBingHtml(await res.text(), limit)
    if (hits.length === 0) return { hits: [], source: 'bing', error: 'bing: empty' }
    return { hits, source: 'bing' }
  } catch (e) {
    return {
      hits: [],
      source: 'bing',
      error: `bing: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function searchBrave(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  try {
    const url =
      'https://search.brave.com/search?' +
      new URLSearchParams({ q: query, source: 'web' }).toString()
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...HTML_HEADERS, Referer: 'https://search.brave.com/' },
      signal: providerSignal(),
      redirect: 'follow'
    })
    if (!res.ok) return { hits: [], source: 'brave', error: `brave: HTTP ${res.status}` }
    const hits = parseBraveHtml(await res.text(), limit)
    if (hits.length === 0) return { hits: [], source: 'brave', error: 'brave: empty' }
    return { hits, source: 'brave' }
  } catch (e) {
    return {
      hits: [],
      source: 'brave',
      error: `brave: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function searchWikipedia(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  const langs = /[а-яё]/i.test(query) ? (['ru', 'en'] as const) : (['en', 'ru'] as const)
  for (const lang of langs) {
    try {
      const url =
        `https://${lang}.wikipedia.org/w/api.php?` +
        new URLSearchParams({
          action: 'query',
          list: 'search',
          srsearch: query,
          srlimit: String(limit),
          format: 'json',
          origin: '*'
        }).toString()
      const res = await fetch(url, {
        method: 'GET',
        headers: JSON_HEADERS,
        signal: providerSignal(),
        redirect: 'follow'
      })
      if (!res.ok) continue
      const parsed: unknown = await res.json()
      const hits = parseWikipediaSearch(parsed, limit, lang)
      if (hits.length > 0) {
        return { hits, source: `wikipedia-${lang}` }
      }
    } catch {
      /* try next lang */
    }
  }
  return { hits: [], source: 'wikipedia', error: 'wikipedia: empty' }
}

async function searchStackOverflow(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  try {
    const url =
      'https://api.stackexchange.com/2.3/search/advanced?' +
      new URLSearchParams({
        order: 'desc',
        sort: 'relevance',
        q: query,
        site: 'stackoverflow',
        pagesize: String(limit)
      }).toString()
    const res = await fetch(url, {
      method: 'GET',
      headers: JSON_HEADERS,
      signal: providerSignal(),
      redirect: 'follow'
    })
    if (!res.ok) {
      return { hits: [], source: 'stackoverflow', error: `stackoverflow: HTTP ${res.status}` }
    }
    const hits = parseStackOverflowJson(await res.json(), limit)
    if (hits.length === 0) {
      return { hits: [], source: 'stackoverflow', error: 'stackoverflow: empty' }
    }
    return { hits, source: 'stackoverflow' }
  } catch (e) {
    return {
      hits: [],
      source: 'stackoverflow',
      error: `stackoverflow: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function searchHackerNews(
  query: string,
  limit: number
): Promise<{ hits: WebSearchHit[]; source: string; error?: string }> {
  try {
    const url =
      'https://hn.algolia.com/api/v1/search?' +
      new URLSearchParams({
        query,
        hitsPerPage: String(limit),
        tags: 'story'
      }).toString()
    const res = await fetch(url, {
      method: 'GET',
      headers: JSON_HEADERS,
      signal: providerSignal(),
      redirect: 'follow'
    })
    if (!res.ok) {
      return { hits: [], source: 'hackernews', error: `hackernews: HTTP ${res.status}` }
    }
    const hits = parseHnAlgoliaJson(await res.json(), limit)
    if (hits.length === 0) {
      return { hits: [], source: 'hackernews', error: 'hackernews: empty' }
    }
    return { hits, source: 'hackernews' }
  } catch (e) {
    return {
      hits: [],
      source: 'hackernews',
      error: `hackernews: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}
