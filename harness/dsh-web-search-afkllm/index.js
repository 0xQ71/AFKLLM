// DeepSeek Harness search provider "afkllm": the harness's own web_search tool asks AFKLLM's keyless multi-engine
// search (afk api, GET /search) and shows the result in its search card: one line on how many results came from
// which engines (and which did not answer), then the sources with titles, links and snippets.
// Mount: cordis.patch.yml row { id: web-search-afkllm, name: dsh-web-search-afkllm } and web.searchProvider: afkllm.
// Config: { baseURL } (default http://127.0.0.1:18300, env AFKLLM_SEARCH_URL), { timeoutMs } (default 30000).

export const name = 'web-search-afkllm'
export const inject = ['web']

const webError = (message, code = 'WEB_PROVIDER_ERROR', cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code, name: 'WebError' })

class AfkllmSearchProvider {
  id = 'afkllm'
  constructor(options) { this.options = options }
  /** Cheap local check only (no network): the base URL parses. */
  available() { return URL.canParse(this.options.baseURL) }
  async search(request, signal) {
    const u = new URL('/search', this.options.baseURL)
    u.searchParams.set('q', request.query)
    if (request.maxResults) u.searchParams.set('limit', String(request.maxResults))
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    let res
    try {
      res = await fetch(u, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (e) {
      if (signal?.aborted) throw webError('search cancelled', 'WEB_ABORTED', e)
      throw webError(`AFKLLM search at ${u.origin} is not reachable (is "afk api" running?): ${e.message}`, 'WEB_PROVIDER_ERROR', e)
    }
    if (!res.ok) throw webError(`AFKLLM search answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const j = await res.json()
    if (j.offline) throw webError('Web search failed: no internet connection.')
    const sources = (j.sources ?? []).filter((s) => typeof s.url === 'string' && s.url).map((s) => ({
      url: s.url,
      ...(s.title ? { title: s.title } : {}),
      ...(s.snippet ? { snippet: s.snippet } : {}),
    }))
    const engines = Object.entries(j.engines ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')
    const down = Object.keys(j.failed ?? {})
    const content = `${sources.length} results` + (engines ? ` (engines: ${engines})` : '') + (down.length ? `; not answering now: ${down.join(', ')}` : '') +
      '. Read the best one or two pages with web_fetch before relying on a snippet.'
    return { content, sources, truncated: false }
  }
}

export function apply(ctx, config = {}) {
  const baseURL = config.baseURL ?? process.env.AFKLLM_SEARCH_URL ?? 'http://127.0.0.1:18300'
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 30000
  ctx.web.registerSearchProvider(new AfkllmSearchProvider({ baseURL, timeoutMs }))
}
