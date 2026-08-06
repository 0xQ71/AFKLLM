import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { execSync } from 'node:child_process'
import type { CacheQuant, FlashAttnMode, LoadMode } from '../../shared/settings'

export interface LlamaProcessOptions {
  binaryPath?: string
  modelPath: string
  host?: string
  port?: number
  nGpuLayers?: number
  ctxSize?: number
  cacheTypeK?: CacheQuant | string
  cacheTypeV?: CacheQuant | string
  parallel?: number
  flashAttn?: FlashAttnMode
  threads?: number
  batchSize?: number
  ubatchSize?: number
  fitHardware?: boolean
  kvOffload?: boolean
  kvUnified?: boolean
  ctxCheckpoints?: number
  loadMode?: LoadMode
  contextShift?: boolean
}

export type LlamaProcessState = 'stopped' | 'starting' | 'ready' | 'error'

/** Spawns/supervises local llama-server (OpenAI-compatible REST). */
export class LlamaProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private state: LlamaProcessState = 'stopped'
  private options: Required<
    Pick<
      LlamaProcessOptions,
      | 'host'
      | 'port'
      | 'nGpuLayers'
      | 'ctxSize'
      | 'cacheTypeK'
      | 'cacheTypeV'
      | 'parallel'
      | 'flashAttn'
      | 'threads'
      | 'batchSize'
      | 'ubatchSize'
      | 'fitHardware'
      | 'kvOffload'
      | 'kvUnified'
      | 'ctxCheckpoints'
      | 'loadMode'
      | 'contextShift'
    >
  > &
    LlamaProcessOptions
  private lastError?: string
  private statusDetail = ''
  private recentLogs = ''
  private startEpoch = 0

  constructor(options: LlamaProcessOptions) {
    super()
    this.options = {
      host: '127.0.0.1',
      port: 8080,
      nGpuLayers: 999,
      ctxSize: 8192,
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      parallel: 1,
      flashAttn: 'on',
      threads: 6,
      batchSize: 2048,
      ubatchSize: 512,
      fitHardware: true,
      kvOffload: true,
      kvUnified: true,
      ctxCheckpoints: 32,
      loadMode: 'mmap',
      contextShift: false,
      ...options
    }
  }

  get baseUrl(): string {
    return `http://${this.options.host}:${this.options.port}`
  }

  get currentState(): LlamaProcessState {
    return this.state
  }

  get error(): string | undefined {
    return this.lastError
  }

  get detail(): string {
    return this.statusDetail
  }

  get modelPath(): string {
    return this.options.modelPath
  }

  updateOptions(patch: Partial<LlamaProcessOptions>): void {
    this.options = { ...this.options, ...patch }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start({ force: true })
  }

  /** Adopt healthy orphan on our port (avoids UI stuck after external load). */
  async reconcile(): Promise<boolean> {
    if (this.state === 'ready') return true
    try {
      const res = await fetch(`${this.baseUrl}/health`)
      if (res.ok) {
        this.lastError = undefined
        this.statusDetail = ''
        this.setState('ready')
        return true
      }
      if (res.status === 503) {
        this.statusDetail = 'loading model…'
        if (this.state !== 'starting') this.setState('starting')
      }
    } catch {
      /* not up yet */
    }
    return false
  }

  async start(opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force && this.state === 'ready') return

    if (!opts?.force && this.state === 'starting') {
      if (await this.reconcile()) return
      // Wait for in-flight start instead of no-op forever
      try {
        await this.waitUntilReady(120_000, this.startEpoch)
      } catch {
        /* fall through to fresh start */
      }
      if (this.currentState === 'ready') return
    }

    if (!opts?.force && (await this.reconcile())) return

    const binary = this.resolveBinary()
    if (!existsSync(binary)) {
      this.lastError = `llama-server binary not found: ${binary}`
      this.setState('error')
      throw new Error(this.lastError)
    }
    if (!existsSync(this.options.modelPath)) {
      this.lastError = `Model not found: ${this.options.modelPath}`
      this.setState('error')
      throw new Error(this.lastError)
    }

    this.startEpoch++
    await this.killManagedProcess()
    this.killOrphansOnPort(this.options.port)
    const epoch = this.startEpoch

    this.setState('starting')
    this.lastError = undefined
    this.statusDetail = 'spawning llama-server…'
    this.recentLogs = ''

    const parallel = Math.max(1, this.options.parallel | 0)
    const args = [
      '-m',
      this.options.modelPath,
      '--host',
      this.options.host,
      '--port',
      String(this.options.port),
      '--n-gpu-layers',
      String(this.options.nGpuLayers),
      '--ctx-size',
      String(this.options.ctxSize),
      '--cache-type-k',
      this.options.cacheTypeK,
      '--cache-type-v',
      this.options.cacheTypeV,
      '--parallel',
      String(parallel),
      '--flash-attn',
      this.options.flashAttn,
      '--batch-size',
      String(this.options.batchSize),
      '--ubatch-size',
      String(this.options.ubatchSize),
      '--ctx-checkpoints',
      String(this.options.ctxCheckpoints),
      '--load-mode',
      this.options.loadMode,
      '--fit',
      this.options.fitHardware ? 'on' : 'off',
      '--jinja'
    ]

    if (this.options.threads > 0) {
      args.push('--threads', String(this.options.threads))
    }

    if (this.options.kvOffload) args.push('--kv-offload')
    else args.push('--no-kv-offload')

    if (this.options.kvUnified) args.push('--kv-unified')
    else args.push('--no-kv-unified')

    if (this.options.contextShift) args.push('--context-shift')
    else args.push('--no-context-shift')

    this.process = spawn(binary, args, {
      cwd: dirname(binary),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env }
    })

    const proc = this.process

    const onLog = (chunk: Buffer): void => {
      const line = chunk.toString()
      this.recentLogs = (this.recentLogs + line).slice(-8000)
      this.emit('log', line)

      if (/loading model/i.test(line)) this.statusDetail = 'loading model weights…'
      else if (/offloading|gpu/i.test(line)) this.statusDetail = 'offloading to GPU…'
      else if (/HTTP server listening|listening on|server is listening/i.test(line)) {
        this.statusDetail = 'server listening · waiting for model…'
      }

      if (/failed to load|error loading|CUDA error|out of memory|GGML_ASSERT/i.test(line)) {
        this.lastError = line.trim()
      }
    }

    proc.stdout?.on('data', onLog)
    proc.stderr?.on('data', onLog)

    proc.on('exit', (code) => {
      if (this.process === proc) this.process = null
      if (epoch !== this.startEpoch) return
      if (this.state === 'starting') {
        this.lastError =
          this.lastError ||
          `llama-server exited during start (code ${code})\n${this.recentLogs.slice(-1500)}`
        this.setState('error')
      } else if (this.state === 'ready') {
        this.setState(code === 0 || code === null ? 'stopped' : 'error')
      }
      this.emit('exit', code)
    })

    proc.on('error', (err) => {
      if (epoch !== this.startEpoch) return
      this.lastError = err.message
      this.setState('error')
    })

    await this.waitUntilReady(600_000, epoch)
  }

  async stop(): Promise<void> {
    this.startEpoch++
    await this.killManagedProcess()
    this.setState('stopped')
    this.statusDetail = ''
  }

  private async killManagedProcess(): Promise<void> {
    const proc = this.process
    this.process = null
    if (!proc) return
    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      proc.once('exit', done)
      try {
        proc.kill()
      } catch {
        done()
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already dead */
        }
        done()
      }, 5_000).unref?.()
    })
  }

  private resolveBinary(): string {
    if (this.options.binaryPath && this.options.binaryPath.length) {
      return this.options.binaryPath
    }
    const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const candidates = [
      join(process.cwd(), 'bin', name),
      join(app.getAppPath(), 'bin', name),
      // electron-vite: getAppPath() may be out/main
      join(app.getAppPath(), '..', '..', 'bin', name),
      app.isPackaged ? join(process.resourcesPath, 'bin', name) : '',
      join(dirname(app.getPath('exe')), 'resources', 'bin', name),
      join(app.getPath('userData'), 'llama-runtime', name)
    ].filter(Boolean)

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return candidates[0] || join(process.cwd(), 'bin', name)
  }

  private setState(state: LlamaProcessState): void {
    this.state = state
    this.emit('state', state)
  }

  private async waitUntilReady(timeoutMs: number, epoch: number): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (epoch !== this.startEpoch) {
        throw new Error('start superseded')
      }
      if (this.state === 'ready') return
      if (this.state === 'error') {
        throw new Error(this.lastError || 'llama-server failed to start')
      }
      if (this.state === 'stopped') {
        throw new Error(this.lastError || 'llama-server stopped unexpectedly')
      }

      try {
        const res = await fetch(`${this.baseUrl}/health`)
        if (res.ok) {
          this.statusDetail = ''
          this.setState('ready')
          return
        }
        if (res.status === 503) {
          const body = await res.text().catch(() => '')
          if (/loading/i.test(body)) {
            this.statusDetail = 'loading model…'
          } else {
            this.statusDetail = `server warming up (${res.status})`
          }
        }
      } catch {
        if (!this.statusDetail || this.statusDetail === 'spawning llama-server…') {
          this.statusDetail = 'waiting for server…'
        }
      }
      await new Promise((r) => setTimeout(r, 800))
    }

    this.lastError = `Timed out waiting for llama-server at ${this.baseUrl}\n${this.recentLogs.slice(-1500)}`
    await this.stop()
    this.setState('error')
    throw new Error(this.lastError)
  }

  /** Kill stray listeners on our port (Windows). */
  private killOrphansOnPort(port: number): void {
    if (process.platform !== 'win32') return
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      const pids = new Set<string>()
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* nothing listening */
    }
  }
}
