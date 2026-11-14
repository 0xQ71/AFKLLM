// AFKLLM as a backend for an external agent harness (DeepSeek Harness, opencode, ...): `afk api` serves the model on
// /v1 and these tools on /mcp (MCP Streamable HTTP, stateless). The harness brings its own read/edit/shell/subagent
// tools; what it lacks on this machine is what lives here:
//   generate_image  Qwen-Image 2.1 through ComfyUI, with the GPU swap (LLM out, image model in, LLM + KV cache back)
//   screenshot      look at a window or the screen (check GUI apps and games the agent started)
//   web_search      keyless multi-engine search (the harness's own search needs a DeepSeek account)
// Tool results carry images as MCP image content, so a vision model sees what it generated or captured.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BackgroundJobs } from './shell'
import { IMAGE_TOOLS, toolByName, type GenerateImageRequest, type GenerateImageResult, type ToolContext } from './tools'
import type { ToolOutcome } from './types'
import { formatSearch, webSearch } from './web'

export type GenFn = (req: GenerateImageRequest, signal?: AbortSignal) => Promise<GenerateImageResult>

export interface HarnessToolsOptions {
  /** image generation with the GPU swap; absent = ComfyUI / Qwen-Image not installed or the model is not ours */
  generateImage?: GenFn
  /** llama-server has a vision projector: return pictures to the model, not just paths */
  vision: boolean
  /** progress lines for the `afk api` console */
  log?: (line: string) => void
  /** routes the GPU swap's progress (stages, sampler steps) to the current call; undefined detaches it */
  setImageProgress?: (fn?: (line: string) => void) => void
}

/** Where generate_image puts a picture whose file_path is relative (the MCP server does not know the session cwd). */
export const DEFAULT_IMAGE_DIR = join(homedir(), '.afkllm', 'images')

interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }

export function harnessToolList(o: Pick<HarnessToolsOptions, 'generateImage'>): McpTool[] {
  const tools: McpTool[] = []
  if (o.generateImage) {
    tools.push({
      name: 'generate_image',
      description:
        'Generate a picture with the local image model (Qwen-Image 2.1) and save it as a PNG: game sprites and ' +
        'backgrounds, textures, illustrations, icons, UI art, mockups, posters. Write the prompt in English as a ' +
        'detailed description of the finished image (subject, style, composition, lighting, colors, background; text ' +
        'to render goes in quotes). For sprites and icons ask for a plain or transparent-looking background and say ' +
        '"centered, full object visible". One call takes 1-2 minutes because the coding model is unloaded from the ' +
        'GPU meanwhile, so decide what you need first, do not call it in a loop, and never call it in parallel. ' +
        'The finished image is returned to you: look at it, and regenerate with a corrected prompt if it does not ' +
        'match. Give file_path as an ABSOLUTE path inside the project (relative paths go to ~/.afkllm/images).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed English description of the image' },
          file_path: { type: 'string', description: 'Absolute path of the .png to write, inside the project' },
          width: { type: 'integer', description: 'Pixels, 256-2048, multiple of 16 (default 1024)' },
          height: { type: 'integer', description: 'Pixels, 256-2048, multiple of 16 (default 1024)' },
          negative_prompt: { type: 'string', description: 'What to avoid (optional)' },
          seed: { type: 'integer', description: 'Fix for reproducible results (optional)' },
        },
        required: ['prompt', 'file_path'],
        additionalProperties: false,
      },
    })
  }
  if (process.platform === 'win32') {
    tools.push({
      name: 'screenshot',
      description:
        'Look at the screen: capture one window (by part of its title or by process name) or, with no arguments, ' +
        'the whole screen, and see the picture. Use it to check GUI apps, games and web pages you started, and ' +
        'whenever the user says something is not visible or looks wrong — do not guess what is on screen. If no ' +
        'window matches you get the list of visible windows instead; a missing window usually means the program ' +
        'never opened it (check its output and code), not that it is hidden.',
      inputSchema: {
        type: 'object',
        properties: {
          window_title: { type: 'string', description: 'Part of the window title, e.g. "Calculator"' },
          process_name: { type: 'string', description: 'Process name without .exe, e.g. "java" or "chrome"' },
        },
        additionalProperties: false,
      },
    })
  }
  tools.push({
    name: 'web_search',
    description:
      'Search the web (several free engines at once, ranked together, plus Read the Docs / MDN / Stack Overflow / ' +
      'GitHub for technical queries) and get titles, URLs and snippets. Search on your own whenever you are not ' +
      'sure: an error message you do not recognise, how an API behaves, a library version, a known technique. ' +
      'Short English queries with the exact names work best ("Godot 4 AudioStreamWAV generate PCM"); add ' +
      'allowed_domains (e.g. ["docs.godotengine.org"]) to stay in official docs. Then read the best one or two ' +
      'pages with web_fetch before relying on them; a snippet alone is not a source.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Results, 1-20 (default 8)' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only these sites (optional)' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never these sites (optional)' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only recent pages (optional)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  })
  return tools
}

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface McpResult { content: McpContent[]; isError?: boolean }

function toMcp(r: ToolOutcome): McpResult {
  const content: McpContent[] = [{ type: 'text', text: r.output }]
  for (const img of r.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mime })
  return r.ok ? { content } : { content, isError: true }
}

const errorResult = (text: string): McpResult => ({ content: [{ type: 'text', text }], isError: true })

function toolContext(cwd: string, o: HarnessToolsOptions, signal?: AbortSignal): ToolContext {
  return {
    cwd, signal, readState: new Map(), todos: [], bg: new BackgroundJobs(join(homedir(), '.afkllm', 'logs')),
    vision: o.vision, generateImage: o.generateImage,
  }
}

/** Run one tool call. Exported for tests; the MCP handler below is a thin wrapper. */
export async function callHarnessTool(name: string, args: Record<string, unknown>, o: HarnessToolsOptions, signal?: AbortSignal): Promise<McpResult> {
  const log = o.log ?? (() => {})
  if (name === 'generate_image') {
    if (!o.generateImage) return errorResult('Image generation is not available: ComfyUI / Qwen-Image are not installed, or afk does not manage this model.')
    const file = String(args.file_path ?? '')
    const cwd = file && isAbsolute(file) ? homedir() : DEFAULT_IMAGE_DIR
    const planned = await IMAGE_TOOLS[0].plan(args, toolContext(cwd, o, signal))
    if (!('execute' in planned)) return toMcp(planned)
    // private (the Harness `/image` command): the prompt is not shown in the console or the progress notifications
    log(args.private === true ? 'generate_image: private prompt (not shown)' : `generate_image: ${String(args.prompt ?? '').slice(0, 160)}`)
    o.setImageProgress?.(log)
    try {
      const r = await planned.execute()
      log(r.ok ? `generate_image: ${r.summary}` : `generate_image failed: ${r.summary}`)
      return toMcp(r)
    } catch (e) {
      log(`generate_image failed: ${(e as Error).message}`)
      return errorResult(`Image generation failed: ${(e as Error).message}`)
    } finally {
      o.setImageProgress?.(undefined)
    }
  }
  if (name === 'screenshot') {
    const tool = toolByName('Screenshot')
    if (!tool || process.platform !== 'win32') return errorResult('Screenshots are only implemented on Windows.')
    const planned = await tool.plan(args, toolContext(homedir(), o, signal)) // saved under ~/.afkllm/screens
    if (!('execute' in planned)) return toMcp(planned)
    try { return toMcp(await planned.execute()) } catch (e) { return errorResult(`Screenshot failed: ${(e as Error).message}`) }
  }
  if (name === 'web_search') {
    const query = String(args.query ?? '').trim()
    if (!query) return errorResult('web_search needs a non-empty "query".')
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined)
    const recency = ['day', 'week', 'month', 'year'].includes(String(args.recency)) ? args.recency as 'day' : undefined
    try {
      const r = await webSearch(query, {
        limit: Number(args.limit) || undefined, allowedDomains: list(args.allowed_domains),
        blockedDomains: list(args.blocked_domains), recency, signal,
      })
      log(`web_search: ${query} → ${r.hits.length} results`)
      return { content: [{ type: 'text', text: formatSearch(r, 'web_fetch') }], isError: r.offline ? true : undefined }
    } catch (e) {
      return errorResult(`Web search failed: ${(e as Error).message}`)
    }
  }
  return errorResult(`Unknown tool: ${name}`)
}

/**
 * GET /search?q=...&limit=8 — the same keyless multi-engine search as the web_search tool, as JSON shaped like a
 * DeepSeek Harness search result ({ sources: [{ url, title, snippet }] }), for the dsh-web-search-afkllm provider
 * plugin: the harness then runs its own web_search tool and shows its own search card. This PC only.
 */
export function searchRoute(log?: (m: string) => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)) }
    if (!isLoopback(req.socket.remoteAddress)) return send(403, { error: 'AFKLLM search is only served to this PC.' })
    const u = new URL(req.url ?? '/', 'http://x')
    const q = (u.searchParams.get('q') ?? '').trim()
    if (!q) return send(400, { error: 'q is required' })
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableEnded) ac.abort() })
    const r = await webSearch(q, { limit: Number(u.searchParams.get('limit')) || undefined, signal: ac.signal })
    log?.(`search: ${q} → ${r.hits.length} results (${Object.keys(r.engines).join(', ') || 'none'})`)
    send(200, {
      sources: r.hits.map((h) => ({ url: h.url, title: h.title, ...(h.snippet ? { snippet: h.snippet } : {}) })),
      engines: r.engines, failed: r.failed, offline: r.offline,
    })
  }
}

export function isLoopback(addr?: string): boolean {
  if (!addr) return false
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

/**
 * The /mcp route for startLanProxy. Stateless Streamable HTTP: a fresh server + transport per request, as the SDK
 * recommends for stateless servers, so a harness restart or reconnect never meets a stale session.
 */
export function mcpRoute(o: HarnessToolsOptions) {
  return async (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> => {
    // screen capture and the GPU swap are for the harness on this PC only, even when /v1 is shared on the LAN
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'AFKLLM tools are only served to this PC.' }, id: null }))
      return
    }
    if (req.method !== 'POST') {
      // no server-initiated streams in stateless mode
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
      return
    }
    let parsed: unknown
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : undefined } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      return
    }
    const server = new Server(
      { name: 'afkllm', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'AFKLLM tools on this PC. generate_image swaps the GPU to the image model (1-2 min, one at a time) and ' +
          'returns the picture; screenshot shows a window or the screen; web_search finds pages for web_fetch.',
      },
    )
    // /mcp?exclude=web_search: a harness that searches through its own web_search (dsh-web-search-afkllm) hides ours
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const exclude = new Set((query.get('exclude') ?? '').split(',').filter(Boolean))
    const pathsOnly = query.get('images') === 'path'
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: harnessToolList(o).filter((t) => !exclude.has(t.name)) }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const token = request.params._meta?.progressToken
      let n = 0
      const progress = (message: string) => {
        o.log?.(message)
        if (token === undefined) return
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } }).catch(() => {})
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      if (!pathsOnly) return await callHarnessTool(request.params.name, args, { ...o, log: progress }, extra.signal) as never
      // images=path: the picture is not returned inline; the model opens the file with the harness's read_image,
      // whose card shows the image, its full path (click to preview) and size in the chat. One copy in context.
      const r = await callHarnessTool(request.params.name, args, { ...o, vision: false, log: progress }, extra.signal)
      if (!r.isError && (request.params.name === 'generate_image' || request.params.name === 'screenshot')) {
        r.content = r.content.filter((c) => c.type !== 'image')
        r.content.push({ type: 'text', text: 'Now call read_image on the saved file: you see the picture, and the user sees it in the chat with its path.' })
      }
      return r as never
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false })
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}) })
    await server.connect(transport)
    await transport.handleRequest(req, res, parsed)
  }
}
