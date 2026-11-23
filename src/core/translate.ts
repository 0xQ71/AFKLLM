// Offline translation inside afk api: DeepSeek Harness reasoning English → Russian, and /image prompts Russian → English.
// afk api answers POST /translate/translatetext in the Microsoft Edge (Bing) protocol that Harness' translator plugin
// speaks (its `bingEndpoint` points here), and forwards to scripts/mt-server.py: OPUS-MT through CTranslate2 int8 on
// the CPU (2 threads, idle priority, no GPU). The worker is started on the first request, restarted if it died, and
// exits by itself after 15 min without requests. Nothing is sent outside this PC; the texts are not logged.
// Setup (venv + models): scripts\mt-setup.cmd. Missing setup → 503 with the reason (Harness shows the original).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CONFIG_DIR, type ProxyRoute } from './server'

const MODELS = process.env.AFK_MODELS_DIR || 'C:\\Models'

export interface TranslatorConfig {
  python: string
  /** mt-server.py; the first existing of these */
  scripts: string[]
  /** CTranslate2 model folder per direction, "en-ru" and "ru-en" */
  models: Record<string, string>
  port: number
  threads: number
}

export function defaultTranslator(): TranslatorConfig {
  const here = process.argv[1] ? dirname(process.argv[1]) : process.cwd()
  return {
    python: join(CONFIG_DIR, 'mt', 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python'),
    scripts: [join(here, '..', '..', 'scripts', 'mt-server.py'), join(CONFIG_DIR, 'mt', 'mt-server.py')],
    models: {
      'en-ru': join(MODELS, 'mt', 'opus-mt-tc-big-en-zle-ct2-int8'),
      'ru-en': join(MODELS, 'mt', 'opus-mt-tc-big-zle-en-ct2-int8'),
    },
    port: 18302,
    threads: 2,
  }
}

/** What is missing for offline translation (empty = ready). */
export function translatorMissing(cfg: TranslatorConfig = defaultTranslator()): string[] {
  const miss: string[] = []
  if (!existsSync(cfg.python)) miss.push(cfg.python)
  if (!cfg.scripts.some((s) => existsSync(s))) miss.push(cfg.scripts[cfg.scripts.length - 1])
  for (const m of Object.values(cfg.models)) if (!existsSync(join(m, 'model.bin'))) miss.push(m)
  return miss
}

export class TranslatorWorker {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  readonly url: string

  constructor(readonly cfg: TranslatorConfig = defaultTranslator(), private log?: (m: string) => void) {
    this.url = `http://127.0.0.1:${cfg.port}`
  }

  private async alive(): Promise<boolean> {
    try { return (await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
  }

  /** Start the worker unless it already answers; one start at a time. */
  async ensure(): Promise<void> {
    if (await this.alive()) return
    this.starting ??= this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start(): Promise<void> {
    const missing = translatorMissing(this.cfg)
    if (missing.length) throw new Error(`offline translation is not installed (run scripts\\mt-setup.cmd): missing ${missing[0]}`)
    const script = this.cfg.scripts.find((s) => existsSync(s))!
    const args = ['-I', script, '--port', String(this.cfg.port), '--threads', String(this.cfg.threads)]
    for (const [dir, path] of Object.entries(this.cfg.models)) args.push('--model', `${dir}=${path}`)
    const child = spawn(this.cfg.python, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    let err = ''
    child.stderr?.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-2000) })
    let exited: number | null | undefined
    child.on('exit', (c) => { exited = c; if (this.child === child) this.child = null })
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000) {
      if (exited !== undefined) throw new Error(`translator exited with code ${exited}: ${err.trim().split(/\r?\n/).slice(-3).join(' | ')}`)
      if (await this.alive()) { this.log?.(`translator ready on ${this.url} (CPU, ${this.cfg.threads} threads, idle priority)`); return }
      await new Promise((r) => setTimeout(r, 300))
    }
    this.stop()
    throw new Error('translator did not start in 60 s')
  }

  /** POST to the worker; one retry after a restart (it may have exited on idle between the check and the call). */
  async forward(pathAndQuery: string, body: Buffer): Promise<{ status: number; body: Buffer }> {
    for (let attempt = 0; ; attempt++) {
      await this.ensure()
      try {
        const r = await fetch(`${this.url}${pathAndQuery}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array(body), signal: AbortSignal.timeout(300_000),
        })
        return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }
      } catch (e) {
        if (attempt >= 1) throw e
      }
    }
  }

  stop(): void {
    const c = this.child
    this.child = null
    if (!c?.pid) return
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    else c.kill()
  }
}

function send(res: ServerResponse, status: number, body: Buffer | string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Routes for startLanProxy: the translate endpoint and /translate/forget (drops the worker's in-memory cache). */
export function translateRoutes(worker: TranslatorWorker): Record<string, ProxyRoute> {
  const passthrough = (path: string): ProxyRoute => async (req: IncomingMessage, res: ServerResponse, body: Buffer) => {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }))
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : ''
    try {
      const r = await worker.forward(path + query, body)
      send(res, r.status, r.body)
    } catch (e) {
      send(res, 503, JSON.stringify({ error: (e as Error).message }))
    }
  }
  return {
    '/translate/translatetext': passthrough('/translate/translatetext'),
    '/translate/forget': async (req, res, body) => {
      // nothing to forget when the worker is not running: do not start it for this
      try {
        const r = await fetch(`${worker.url}/forget`, { method: 'POST', body: new Uint8Array(body), signal: AbortSignal.timeout(3000) })
        send(res, r.status, Buffer.from(await r.arrayBuffer()))
      } catch {
        send(res, 200, JSON.stringify({ ok: true, running: false }))
      }
      void req
    },
  }
}
