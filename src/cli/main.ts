#!/usr/bin/env node
// afk — AFKLLM command-line agent.
//
//   afk                         interactive session
//   afk "fix the build"         interactive, starts with this prompt
//   afk -p "explain src/x.ts"   print mode: run once, print the answer, exit
//   afk --auto                  start in AUTO MODE
//   afk serve --stdio           headless core: NDJSON commands on stdin, events on stdout
//   afk api                     backend for an external harness: llama-server on /v1 + AFKLLM tools on /mcp
//
// Model: --model <profile|file.gguf> starts llama-server (profiles: q38, q38-128k, q38-160k, flash = Qwen3.8-Flash-Next on Strata, or ~/.afkllm/cli.json),
//        --url http://127.0.0.1:8080 uses a running llama-server instead.
import { createInterface } from 'node:readline'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Agent } from '../core/agent'
import { LlmClient } from '../core/llm'
import { CONFIG_DIR, defaultProfileName, ensureServer, lanIPv4, loadConfig, profileForModel, profiles, startLanProxy, type ModelProfile, type RunningServer } from '../core/server'
import { imageGenMissing } from '../core/imagegen'
import { mcpRoute, searchRoute } from '../core/harness'
import { TranslatorWorker, translateRoutes, translatorMissing } from '../core/translate'
import { dangerousFolder, isDirectory } from '../core/workspace'
import { createInterface as createLineReader } from 'node:readline/promises'
import { GpuSwap, killListener, waitDown } from '../core/swap'
import { strataMissing } from '../core/strata'
import type { GenerateImageRequest, GenerateImageResult } from '../core/tools'
import { PERMISSION_MODES, type AgentEvent, type PermissionDecision, type PermissionMode } from '../core/types'
import { c } from './ansi'
import { App } from './app'

interface Args {
  prompt: string
  print: boolean
  serve: boolean
  api: boolean
  llama: boolean
  mode: PermissionMode
  model?: string
  url?: string
  ctx?: number
  port?: number
  resume?: string | true
  outputFormat: 'text' | 'stream-json'
  keepServer: boolean
  lan: boolean
  listModels: boolean
  json: boolean
  verbose: boolean
  cwd: string
  maxTurns?: number
}

const USAGE = `afk — AFKLLM local coding agent

Usage: afk [options] [prompt]
       afk serve --stdio
       afk api [--lan]           backend for an agent harness: OpenAI /v1 + MCP tools /mcp (127.0.0.1:<port>); Ctrl+C stops it
       afk llama [-m <profile>]  only llama-server for a profile, on <port>+1 (default 18301), until Ctrl+C; a later
                                 afk api reuses it, and the model survives the proxy stopping or crashing
       afk models [--json]       list the model profiles (afk api loads the one a client names as its model)

Options:
  -p, --print               run the prompt non-interactively and print the result
  --auto                    AUTO MODE: act without asking (risky actions still ask / are refused)
  --mode <m>                default | acceptEdits | plan | auto
  -m, --model <profile|gguf> model profile (q38, q38-128k, q38-160k, flash) or a .gguf path
  --url <url>               use a running llama-server instead of starting one
  --ctx <n>                 context size when starting llama-server
  --port <n>                llama-server port (default 18300)
  -c, --continue            resume the most recent session in this folder
  -r, --resume [id]         resume a session
  --output-format <f>       text | stream-json   (print mode)
  -v, --verbose             print mode: stream the model's thinking and text live to stderr
  --max-turns <n>           stop after n model turns
  --keep-server             leave llama-server running on exit (faster next start)
  --lan                     afk api: listen on all interfaces (other PCs), not only 127.0.0.1
  --cwd <dir>               project folder (default: current directory)
  -h, --help
`

function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: '', print: false, serve: false, api: false, llama: false, mode: 'default', outputFormat: 'text', keepServer: false, lan: false, listModels: false, json: false, verbose: false, cwd: process.cwd() }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${x} needs a value`)
      return v
    }
    switch (x) {
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0)
      // eslint-disable-next-line no-fallthrough
      case '-p': case '--print': a.print = true; break
      case '--auto': a.mode = 'auto'; break
      case '--mode': {
        const m = next()
        const found = PERMISSION_MODES.find((p) => p.toLowerCase() === m.toLowerCase())
        if (!found) throw new Error(`unknown mode ${m}`)
        a.mode = found
        break
      }
      case '-m': case '--model': a.model = next(); break
      case '--url': a.url = next(); break
      case '--ctx': a.ctx = Number(next()); break
      case '--port': a.port = Number(next()); break
      case '--think': break // thinking is always on; flag kept so old scripts do not fail
      case '-c': case '--continue': a.resume = true; break
      case '-r': case '--resume':
        a.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true
        break
      case '--output-format': a.outputFormat = next() === 'stream-json' ? 'stream-json' : 'text'; break
      case '--max-turns': a.maxTurns = Number(next()); break
      case '--keep-server': a.keepServer = true; break
      case '--lan': a.lan = true; break
      case '--json': a.json = true; break
      case '-v': case '--verbose': a.verbose = true; break
      case '--cwd': a.cwd = resolve(next()); break
      case '--stdio': break
      default:
        if (x === 'serve' && !rest.length) a.serve = true
        else if (x === 'api' && !rest.length) a.api = true
        else if (x === 'llama' && !rest.length) a.llama = true
        else if (x === 'models' && !rest.length) a.listModels = true
        else rest.push(x)
    }
  }
  a.prompt = rest.join(' ')
  return a
}

/** The name the chosen profile goes by: a profile name, or the .gguf path given with -m. */
function profileName(a: Args, cfg = loadConfig()): string {
  const name = a.model ?? process.env.AFK_MODEL ?? defaultProfileName(cfg)
  return profiles(cfg)[name] ? name : resolve(name)
}

function pickProfile(a: Args): ModelProfile {
  const cfg = loadConfig()
  const all = profiles(cfg)
  const name = a.model ?? process.env.AFK_MODEL ?? defaultProfileName(cfg)
  if (all[name]) return all[name]
  if (/\.gguf$/i.test(name) && existsSync(name)) {
    return { label: name.split(/[\\/]/).pop()!, model: resolve(name), ctx: a.ctx ?? 32768, args: { 'n-gpu-layers': '99' }, sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 } }
  }
  throw new Error(`unknown model profile "${name}". Known: ${Object.keys(all).join(', ')}, or pass a .gguf path`)
}

async function connect(a: Args, quiet: boolean): Promise<{ llm: LlmClient; profile?: ModelProfile; server?: RunningServer }> {
  if (a.url) {
    const llm = new LlmClient(a.url)
    await llm.probe()
    return { llm }
  }
  const profile = pickProfile(a)
  const tty = process.stderr.isTTY && !quiet
  let lastLen = 0
  const server = await ensureServer(profile, loadConfig(), {
    port: a.port, ctx: a.ctx,
    onProgress: (msg) => {
      if (!tty) return
      const line = `${c.brand('✻')} ${msg}`
      process.stderr.write('\r' + line + ' '.repeat(Math.max(0, lastLen - line.length)))
      lastLen = line.length
    },
  })
  if (tty && lastLen) process.stderr.write('\r\x1b[2K')
  const llm = new LlmClient(server.url)
  await llm.probe()
  return { llm, profile, server }
}

type GenFn = (req: GenerateImageRequest, signal?: AbortSignal) => Promise<GenerateImageResult>

/**
 * Image generation for this session, when ComfyUI + Qwen-Image are installed and afk manages the llama-server
 * (the swap has to unload and reload it). `say` shows swap progress to the user.
 */
function imageGen(a: Args, conn: { llm: LlmClient; profile?: ModelProfile; server?: RunningServer; ctx?: number; detached?: boolean }, say: (m: string) => void, port = a.port): GenFn | undefined {
  // needs a model afk manages (it has to unload and reload it); the server itself may still be loading
  if (process.env.AFK_IMAGEGEN === '0' || a.url || !conn.profile || imageGenMissing().length) return undefined
  const swap = new GpuSwap({
    llmUrl: () => conn.server?.url ?? conn.llm.baseUrl,
    stopLlm: async () => {
      const s = conn.server
      if (!s) return
      if (s.reused) killListener(Number(new URL(s.url).port))
      else s.stop()
      await waitDown(s.url)
    },
    // the profile loaded now: `afk api` may have switched it since start (conn.ctx: the --ctx override, if still valid)
    startLlm: async () => { conn.server = await ensureServer(conn.profile!, loadConfig(), { port, ctx: 'ctx' in conn ? conn.ctx : a.ctx, detached: conn.detached }) },
    emit: say,
  })
  return async (req, signal) => {
    const r = await swap.generate(req, signal)
    return { ...r, timings: swap.last?.timings ?? r.timings, kvRestored: swap.last?.kvRestored ?? r.kvRestored }
  }
}

/** The model file is there (and for a Strata profile: Strata is installed and its preset set up). */
function profileReady(p: ModelProfile): boolean {
  return existsSync(p.model) && (!p.strata || !strataMissing(p.strata))
}

/** A profile sees images when llama-server is started with a multimodal projector (Strata: its picture reader). */
function hasVision(p?: ModelProfile): boolean {
  return !!p?.args?.mmproj || (!!p?.strata && (p.strata.config as { vision?: unknown } | undefined)?.vision !== false) || process.env.AFK_VISION === '1'
}

// ---------------------------------------------------------------- print mode

async function printMode(a: Args, llm: LlmClient, profile?: ModelProfile, gen?: GenFn): Promise<number> {
  const json = a.outputFormat === 'stream-json'
  let finalText = ''
  let current = ''
  let doneReason = 'end'
  // --verbose: stream the model's thinking (dim) and text to stderr as it is generated
  let live: '' | 'reasoning' | 'text' = ''
  const liveEnd = () => { if (live) process.stderr.write('\n'); live = '' }
  const agent = new Agent({
    cwd: a.cwd, llm, mode: a.mode, sampling: profile?.sampling as any, maxTurns: a.maxTurns, vision: hasVision(profile), generateImage: gen,
    emit: (e: AgentEvent) => {
      if (!json && a.verbose && (e.type === 'reasoning' || e.type === 'text')) {
        if (live !== e.type) {
          liveEnd()
          process.stderr.write(c.dim(e.type === 'reasoning' ? '∴ thinking\n' : '▸ answer\n'))
          live = e.type
        }
        process.stderr.write(e.type === 'reasoning' ? c.dim(e.delta) : e.delta)
      } else if (!json && (e.type === 'tool_call' || e.type === 'text_end' || e.type === 'turn_start' || e.type === 'done')) {
        liveEnd()
      }
      if (json) process.stdout.write(JSON.stringify(e) + '\n')
      else if (e.type === 'tool_call') process.stderr.write(c.dim(`● ${e.label}\n`))
      else if (e.type === 'tool_result') process.stderr.write(c.dim(`  ⎿  ${e.outcome.summary}\n`))
      else if (e.type === 'notice') process.stderr.write(c.dim(`  ⎿  ${e.message}\n`))
      if (e.type === 'turn_start') current = ''
      if (e.type === 'text') current += e.delta
      if (e.type === 'text_end') finalText = current
      if (e.type === 'done') doneReason = e.reason + (e.message ? `: ${e.message}` : '')
    },
    // no ask(): anything needing approval is refused in print mode
  })
  const ac = new AbortController()
  process.on('SIGINT', () => ac.abort())
  let prompt = a.prompt
  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped.trim()) prompt = prompt ? `${prompt}\n\n${piped}` : piped
  }
  if (!prompt.trim()) throw new Error('print mode needs a prompt')
  await agent.run(prompt, ac.signal)
  agent.dispose()
  if (!json) process.stdout.write(finalText.trim() + '\n')
  if (!doneReason.startsWith('end')) {
    if (!json) process.stderr.write(c.red(`stopped: ${doneReason}\n`))
    return 1
  }
  return 0
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (s += d))
    process.stdin.on('end', () => res(s))
  })
}

// ---------------------------------------------------------------- headless stdio protocol

async function serveStdio(a: Args, llm: LlmClient, profile?: ModelProfile, gen?: GenFn): Promise<number> {
  const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
  const pending = new Map<number, (d: PermissionDecision) => void>()
  let nextId = 1
  let ac: AbortController | null = null
  const agent = new Agent({
    cwd: a.cwd, llm, mode: a.mode, sampling: profile?.sampling as any, maxTurns: a.maxTurns, vision: hasVision(profile), generateImage: gen,
    emit: (e) => send(e),
    ask: (req) => new Promise((res) => {
      const id = nextId++
      pending.set(id, res)
      send({ type: 'permission_request', id, request: req })
    }),
  })
  send({ type: 'ready', model: llm.modelName, ctx: llm.ctxSize, mode: agent.mode, cwd: a.cwd })
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    let m: any
    try { m = JSON.parse(line) } catch { send({ type: 'error', message: 'bad json' }); continue }
    switch (m.type) {
      case 'run':
        if (agent.busy) { send({ type: 'error', message: 'busy' }); break }
        ac = new AbortController()
        void agent.run(String(m.text ?? ''), ac.signal).finally(() => send({ type: 'idle' }))
        break
      case 'abort': ac?.abort(); break
      case 'mode': if (PERMISSION_MODES.includes(m.mode)) agent.mode = m.mode; break
      case 'permission_response': {
        const r = pending.get(m.id)
        pending.delete(m.id)
        r?.(m.allow ? { allow: true, remember: !!m.remember } : { allow: false, feedback: m.feedback })
        break
      }
      case 'clear': agent.clear(); send({ type: 'idle' }); break
      case 'compact': await agent.compact(undefined, m.focus ?? ''); send({ type: 'idle' }); break
      case 'state': send({ type: 'state', ...agent.snapshot(), usage: agent.lastUsage }); break
      case 'exit': agent.dispose(); return 0
    }
  }
  agent.dispose()
  return 0
}

// ---------------------------------------------------------------- LAN API

async function openaiModelId(base: string): Promise<string> {
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3000) })
    const j = (await r.json()) as { data?: { id?: string }[] }
    return j.data?.[0]?.id ?? ''
  } catch {
    return ''
  }
}

/**
 * Backend for an external agent harness (DeepSeek Harness, opencode, ...) on this PC or the LAN:
 *   /v1   llama-server (vision projector included) behind a proxy that maps reasoning_effort and fills in the
 *         profile's sampling;
 *   /mcp  AFKLLM tools over MCP: generate_image (GPU swap), screenshot, web_search.
 * While an image is generated the LLM is unloaded; chat requests arriving meanwhile wait for it to come back.
 */
async function serveApi(a: Args): Promise<number> {
  const cfg = loadConfig()
  const profile = pickProfile(a)
  const port = a.port ?? cfg.port ?? 18300
  let lastLen = 0
  const status = (msg: string) => {
    process.stderr.write('\r' + msg + ' '.repeat(Math.max(0, lastLen - msg.length)))
    lastLen = msg.length
  }
  const endStatus = () => { if (lastLen) process.stderr.write('\r\x1b[2K'); lastLen = 0 }
  const line = (msg: string) => { endStatus(); process.stderr.write(msg + '\n') }
  // llama stays on localhost at port+1. The public port is the proxy.
  const server = await ensureServer(profile, cfg, { port: port + 1, ctx: a.ctx, onProgress: status })
  endStatus()
  // A llama-server that was already running (scripts\afk-llama.ps1 window = `afk llama`) is not ours: when this proxy
  // has to restart it (model switch, image generation) the new one is detached too, and this proxy never stops it —
  // the model and its KV cache outlive a proxy crash or restart.
  const conn: { llm: LlmClient; profile?: ModelProfile; server?: RunningServer; ctx?: number; detached?: boolean } = { llm: new LlmClient(server.url), profile, server, ctx: a.ctx, detached: server.reused }
  const all = profiles(cfg)
  let current = profileName(a, cfg)

  // One GPU: image generation and model switches take turns; chat requests wait at the gate meanwhile.
  let gate: Promise<void> | null = null
  let lock: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(async () => {
      let open!: () => void
      gate = new Promise<void>((r) => { open = r })
      try { return await fn() } finally { endStatus(); gate = null; open() }
    })
    lock = run.catch(() => {})
    return run
  }
  // A client (DeepSeek Harness' model picker) names another profile: load it. Llama's KV cache for the old
  // conversation is dropped; the next request re-reads its prompt.
  const onChat = async (model: string | undefined) => {
    const want = profileForModel(model, all)
    if (!want || want === current) return
    await exclusive(async () => {
      if (want === current) return
      const next = all[want]
      line(`model: ${current} → ${want} (${next.label})`)
      const s = conn.server
      if (s) {
        if (s.reused) killListener(Number(new URL(s.url).port))
        else s.stop()
        await waitDown(s.url)
      }
      conn.server = await ensureServer(next, cfg, { port: port + 1, onProgress: status, detached: conn.detached })
      conn.llm = new LlmClient(conn.server.url)
      conn.profile = next
      conn.ctx = undefined
      current = want
      endStatus()
      line(`model ready: ${want} · ${next.label}`)
    })
  }

  // image generation: progress goes to this console (live sampler steps) and to the calling MCP request
  let progressSink: ((m: string) => void) | undefined
  const say = (m: string) => {
    if (/step \d+\/\d+|· \d+s$/.test(m)) status(`  ${m}`)
    else line(`  ${m}`)
    progressSink?.(m)
  }
  const rawGen = imageGen({ ...a, url: undefined }, conn, say, port + 1)
  const generateImage: GenFn | undefined = rawGen && ((req, signal) => exclusive(() => rawGen(req, signal)))
  const vision = hasVision(profile)
  const route = mcpRoute({
    generateImage, vision,
    log: (m) => line(`· ${m}`),
    setImageProgress: (fn) => { progressSink = fn },
  })
  // offline translation (Harness reasoning en→ru, /image prompts ru→en): a CPU worker started on the first request
  const translator = new TranslatorWorker(undefined, (m) => line(`· ${m}`))
  const translatorGap = translatorMissing(translator.cfg)
  const proxy = await startLanProxy({
    listenHost: a.lan ? '0.0.0.0' : '127.0.0.1', listenPort: port, upstreamPort: port + 1,
    sampling: () => conn.profile?.sampling,
    effortBudgets: () => conn.profile?.effortBudgets,
    gate: () => gate ?? Promise.resolve(),
    onChat,
    routes: {
      '/mcp': route,
      '/search': searchRoute((m) => line(`· ${m}`)),
      ...translateRoutes(translator),
      // the profiles a client may pick (DeepSeek Harness lists them in its own config; this is for other clients)
      '/v1/models': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: Object.entries(all).map(([id, p]) => ({
          id, object: 'model', owned_by: 'afkllm', label: p.label, context_window: p.ctx, loaded: id === current, available: profileReady(p),
        })) }))
      },
    },
  })
  const model = (await openaiModelId(server.url)) || profile.model.split(/[\\/]/).pop() || profile.label
  const ips = lanIPv4()
  const missing = imageGenMissing()
  const lines = [
    server.reused ? `reusing llama-server on 127.0.0.1:${port + 1}` : `llama-server on 127.0.0.1:${port + 1}`,
    `proxy on ${a.lan ? '0.0.0.0' : '127.0.0.1'}:${proxy.port} (reasoning_effort high → xhigh, sampling ${Object.entries(profile.sampling).map(([k, v]) => `${k}=${v}`).join(' ')})`,
    `model: ${model}  ·  ${current} · ${profile.label}  ·  vision ${vision ? 'on' : 'off'}`,
    `  other profiles load on request (client model id = profile name): ${Object.keys(all).filter((k) => k !== current).join(', ')}`,
    '',
    'OpenAI-compatible base URL:',
    `  http://127.0.0.1:${proxy.port}/v1`,
    ...(a.lan ? ips.map((ip) => `  http://${ip}:${proxy.port}/v1`) : ['  (this PC only; add --lan for other machines)']),
    'MCP tools (Streamable HTTP):',
    `  http://127.0.0.1:${proxy.port}/mcp   ` + [
      generateImage ? 'generate_image' : `generate_image OFF (${missing.length ? 'missing: ' + missing[0] : 'AFK_IMAGEGEN=0'})`,
      process.platform === 'win32' ? 'screenshot' : '',
      'web_search',
    ].filter(Boolean).join(', '),
    `Offline translation: http://127.0.0.1:${proxy.port}/translate/translatetext  ` +
      (translatorGap.length ? `OFF (scripts\\mt-setup.cmd; missing ${translatorGap[0]})` : 'en→ru, ru→en on the CPU, starts on first use'),
    '',
    'api key: not required (send any string if the client insists)',
    server.reused || a.keepServer
      ? 'Ctrl+C closes the proxy and leaves llama-server running.'
      : 'Ctrl+C stops the proxy and llama-server.',
    ...(a.lan ? ['If another PC cannot connect, allow this afk process through Windows Firewall (node.exe via tsx, or afk.exe).'] : []),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
  process.on('exit', () => {
    proxy.stop()
    translator.stop()
    const s = conn.server
    if (s && !s.reused && !a.keepServer && !conn.detached) s.stop()
  })
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve())
    process.on('SIGTERM', () => resolve())
    process.on('SIGHUP', () => resolve())
  })
  return 0
}

/**
 * `afk llama`: only the model server, in its own window (scripts\afk-llama.ps1 shows its live progress). `afk api`
 * started afterwards reuses it. This process owns the port: when it stops (Ctrl+C, window closed) it stops whatever
 * llama-server listens there, also one that afk api restarted detached after a model switch or an image.
 */
async function serveLlama(a: Args): Promise<number> {
  const cfg = loadConfig()
  const profile = pickProfile(a)
  const port = a.port ?? (cfg.port ?? 18300) + 1
  let lastLen = 0
  const status = (msg: string) => {
    process.stderr.write('\r' + msg + ' '.repeat(Math.max(0, lastLen - msg.length)))
    lastLen = msg.length
  }
  const server = await ensureServer(profile, cfg, { port, ctx: a.ctx, onProgress: status })
  if (lastLen) process.stderr.write('\r\x1b[2K')
  process.stdout.write(`${server.reused ? 'reusing' : 'started'} llama-server ${profileName(a, cfg)} · ${profile.label} on ${server.url}\n` +
    `log: ${server.logPath ?? join(CONFIG_DIR, 'logs', `llama-server-${port}.log`)}\n` +
    'Ctrl+C or closing this window stops the model.\n')
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    server.stop()
    killListener(port) // a detached server afk api started on this port after a model switch / image
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, shutdown)
  // A pending promise does not keep Node alive: without this timer `afk llama` exited as soon as its llama-server child
  // was gone (afk api restarts llama detached after an image or a model switch) or right away when it reused a server,
  // and the window lost its model. It runs until Ctrl+C or the window closes.
  setInterval(() => {}, 1 << 30)
  await new Promise<void>(() => {})
  return 0
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  let a: Args
  try { a = parseArgs(process.argv.slice(2)) } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (a.listModels) {
    const cfg = loadConfig()
    const all = profiles(cfg)
    const def = defaultProfileName(cfg)
    const rows = Object.entries(all).map(([name, p]) => ({ name, label: p.label, ctx: p.ctx, model: p.model, engine: p.strata ? 'strata' : 'llama', available: profileReady(p), default: name === def }))
    if (a.json) process.stdout.write(JSON.stringify(rows) + '\n')
    else for (const r of rows) process.stdout.write(`${r.default ? '*' : ' '} ${r.name.padEnd(12)} ${r.label}${r.available ? '' : '  (file missing)'}\n`)
    return 0
  }
  if (a.llama) {
    try { return await serveLlama(a) } catch (e) {
      process.stderr.write(c.red(`✗ ${(e as Error).message}\n`))
      return 1
    }
  }
  if (a.api) {
    try { return await serveApi(a) } catch (e) {
      process.stderr.write(c.red(`✗ ${(e as Error).message}\n`))
      return 1
    }
  }
  if (!existsSync(a.cwd) || !statSync(a.cwd).isDirectory()) {
    process.stderr.write(`not a directory: ${a.cwd}\n`)
    return 2
  }
  const headless = a.print || a.serve || !process.stdout.isTTY || !process.stdin.isTTY
  // The agent works inside one project folder: the current directory, like `git`. Some folders are a bad place for
  // an autonomous agent (drive roots, the home folder, Windows, Program Files…): ask first.
  if (!headless) {
    const ok = await confirmFolder(a)
    if (!ok) return 0
  } else {
    const why = dangerousFolder(a.cwd, appDir())
    if (why && process.env.AFK_ALLOW_FOLDER !== '1') {
      process.stderr.write(`refusing to work in ${a.cwd}: ${why}. Run afk inside a project folder (or set AFK_ALLOW_FOLDER=1).\n`)
      return 2
    }
  }
  let conn: { llm: LlmClient; profile?: ModelProfile; server?: RunningServer }
  let ready: Promise<void> | undefined
  let modelProgress: ((m: string) => void) | null = null
  try {
    if (!headless && !a.url) {
      // interactive: the UI opens at once and the model loads in the background (first message waits for it)
      const profile = pickProfile(a)
      const port = a.port ?? loadConfig().port ?? 18300
      conn = { llm: new LlmClient(`http://127.0.0.1:${port}`), profile }
      const c0 = conn
      ready = ensureServer(profile, loadConfig(), { port: a.port, ctx: a.ctx, onProgress: (m) => modelProgress?.(m) })
        .then(async (srv) => { c0.server = srv; await c0.llm.probe() })
      ready.catch(() => { /* shown by the TUI */ })
    } else {
      conn = await connect(a, a.serve)
    }
  } catch (e) {
    process.stderr.write(c.red(`✗ ${(e as Error).message}\n`))
    return 1
  }
  const stopServer = () => { if (!a.keepServer) conn.server?.stop() } // conn.server is replaced after an image swap
  process.on('exit', stopServer)
  // Closing the console window (X) sends SIGHUP and Windows kills us ~10 s later without an 'exit' event; SIGTERM
  // likewise. Unload the model either way, or llama-server keeps ~15 GB of VRAM after the CLI is gone.
  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => { stopServer(); setTimeout(() => process.exit(0), 300) })
  }

  // swap progress: every new step at once; a ticking step ("sampling · step 7/25") at most every 3 s
  let lastStep = ''
  let lastAt = 0
  let sink: ((m: string) => void) | null = null // the TUI takes over once it is up
  const say = (m: string) => {
    if (a.serve) return
    if (sink) return sink(m)
    const step = m.replace(/\s*·\s*(step )?\d+(\/\d+|s)$/, '')
    if (step === lastStep && Date.now() - lastAt < 3000) return
    lastStep = step
    lastAt = Date.now()
    process.stderr.write(c.dim(`  ⎿  ${m}\n`))
  }
  const gen = imageGen(a, conn, say)
  if (a.serve) return serveStdio(a, conn.llm, conn.profile, gen)
  if (headless) {
    if (!a.print && !a.prompt) {
      process.stderr.write('stdin/stdout is not a terminal: use -p "<prompt>" or serve --stdio\n')
      return 2
    }
    return printMode(a, conn.llm, conn.profile, gen)
  }

  return new Promise<number>((resolveExit) => {
    const app = new App({
      cwd: a.cwd,
      llm: conn.llm,
      modelLabel: conn.profile?.label ?? (conn.llm.modelName || a.url || 'llama-server'),
      vision: hasVision(conn.profile),
      generateImage: gen,
      theme: (process.env.AFK_THEME as 'black' | 'default' | undefined) ?? ((loadConfig() as { theme?: 'black' | 'default' }).theme) ?? 'black',
      mode: a.mode,
      sampling: (conn.profile?.sampling ?? {}) as Record<string, number>,
      resume: a.resume,
      initialPrompt: a.prompt || undefined,
      ready,
      onExit: () => resolveExit(0),
    })
    sink = (m) => app.activity(m)
    modelProgress = (m) => app.modelProgress(m)
    void app.start()
  })
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`${(e as Error)?.stack ?? e}\n`)
  process.exit(1)
})

/** The folder of an installed afk.exe (single-executable build): never a place to work in. */
function appDir(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (require('node:sea').isSea()) return dirname(process.execPath)
  } catch { /* not a single-executable build */ }
  return undefined
}

/** Ask before working in a dangerous folder; lets the user pick another one. Returns false to exit. */
async function confirmFolder(a: Args): Promise<boolean> {
  for (;;) {
    const why = dangerousFolder(a.cwd, appDir())
    if (!why) return true
    const rl = createLineReader({ input: process.stdin, output: process.stdout })
    try {
      process.stdout.write('\n' + c.yellow(`  ! AFKLLM is about to work in ${a.cwd}`) + '\n' +
        c.dim(`    ${why[0].toUpperCase() + why.slice(1)}. The agent can read, change and run things in this folder.`) + '\n\n' +
        '    1. Yes, work in this folder\n    2. Choose another folder\n    3. Exit\n\n')
      const choice = (await rl.question('  Choose 1-3: ')).trim()
      if (choice === '1') return true
      if (choice === '3' || choice === '') return false
      if (choice === '2') {
        const raw = (await rl.question('  Project folder: ')).trim().replace(/^["']|["']$/g, '')
        const next = resolve(a.cwd, raw)
        if (!raw || !isDirectory(next)) { process.stdout.write(c.red(`  not a folder: ${raw}`) + '\n'); continue }
        a.cwd = next
        process.chdir(next)
      }
    } finally {
      rl.close()
    }
  }
}
