// GPU swap: the coder LLM (+ its CPU-side vision projector, same process) and the image model do not fit in 16 GB
// together, so for an image the host saves the LLM's KV cache, unloads the LLM, runs ComfyUI, unloads it and brings
// the LLM back with its cache restored. Every step after the unload is in `finally`: whatever happens to the image,
// the LLM comes back.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComfyRunner, type ImageRequest, type ImageResult } from './imagegen'

const MODELS = process.env.AFK_MODELS_DIR || 'C:\\Models'
/** llama-server is started with --slot-save-path here (server.ts). NVMe, and Windows keeps the file in its RAM cache. */
export const KV_DIR = join(MODELS, '_kv')

export interface SwapHooks {
  /** base URL of the llama-server serving the agent */
  llmUrl: () => string
  /** unload the LLM completely (process gone, VRAM released) */
  stopLlm: () => Promise<void>
  /** load the same LLM again on the same URL */
  startLlm: () => Promise<void>
  emit?: (msg: string) => void
}

export interface SwapResult extends ImageResult {
  timings: Record<string, number>
  kvRestored: boolean
}

export function vramUsedMiB(): number {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true })
    return parseInt(out.trim().split('\n')[0], 10)
  } catch { return -1 }
}

async function waitVramBelow(mib: number, ms: number): Promise<number> {
  const t0 = Date.now()
  let used = vramUsedMiB()
  while (used > mib && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 500))
    used = vramUsedMiB()
  }
  return used
}

async function slot(url: string, action: 'save' | 'restore', filename: string): Promise<void> {
  const res = await fetch(`${url}/slots/0?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`slot ${action}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/**
 * Stop whatever model server listens on this port (for servers this process did not start, e.g. --keep-server), with
 * its child processes: Strata's port belongs to its Python server, the engine holding the GPU and RAM is its child.
 */
export function killListener(port: number): void {
  if (process.platform !== 'win32') return
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /PID $_.OwningProcess /T /F | Out-Null }`],
  { windowsHide: true })
}

export async function waitDown(url: string, ms = 30_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }) } catch { return }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`server at ${url} did not stop`)
}

export class GpuSwap {
  private busy = false

  constructor(private h: SwapHooks, readonly comfy = new ComfyRunner()) {}

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<SwapResult> {
    if (this.busy) throw new Error('an image is already being generated')
    this.busy = true
    const say = (m: string) => this.h.emit?.(m)
    const timings: Record<string, number> = {}
    const lap = (k: string, t0: number) => { timings[k] = Math.round((Date.now() - t0) / 100) / 10 }
    const kvFile = 'afk-slot0.bin'
    let saved = false
    let unloaded = false
    let kvRestored = false
    try {
      // 1. KV cache → file, so the next turn does not re-read the whole conversation
      let t = Date.now()
      try {
        mkdirSync(KV_DIR, { recursive: true })
        await slot(this.h.llmUrl(), 'save', kvFile)
        saved = true
        lap('kv_save_s', t)
      } catch (e) {
        say(`KV cache not saved (${(e as Error).message}); the next turn will re-read the context`)
      }
      // 2. unload LLM + vision projector (one process)
      t = Date.now()
      say('unloading the code model to free the GPU…')
      await this.h.stopLlm()
      unloaded = true
      const used = await waitVramBelow(2500, 30_000)
      lap('llm_unload_s', t)
      if (used > 4000) throw new Error(`the GPU is still busy after unloading the LLM (${used} MiB used by other apps)`)
      // 3. image
      t = Date.now()
      await this.comfy.start((m) => say(m), signal)
      lap('comfy_start_s', t)
      t = Date.now()
      const img = await this.comfy.generate(req, (m) => say(m), signal)
      lap('generate_s', t)
      return { ...img, timings, kvRestored: false }
    } finally {
      // 4. always: image model out, LLM back, cache back
      let t = Date.now()
      await this.comfy.stop().catch(() => {})
      if (unloaded) await waitVramBelow(2500, 30_000)
      lap('comfy_stop_s', t)
      if (unloaded) {
        t = Date.now()
        say('loading the code model back…')
        let err: unknown
        for (let attempt = 1; attempt <= 2; attempt++) {
          try { await this.h.startLlm(); err = undefined; break } catch (e) { err = e; await new Promise((r) => setTimeout(r, 2000)) }
        }
        lap('llm_reload_s', t)
        if (err) { this.busy = false; throw new Error(`the code model did not come back after image generation: ${(err as Error).message}`) }
        if (saved) {
          t = Date.now()
          try { await slot(this.h.llmUrl(), 'restore', kvFile); kvRestored = true; lap('kv_restore_s', t) } catch (e) {
            say(`KV cache not restored (${(e as Error).message}); the next turn re-reads the context`)
          }
        }
      }
      this.busy = false
      this.last = { timings, kvRestored }
    }
  }

  /** timings of the last swap, including the steps in `finally` */
  last: { timings: Record<string, number>; kvRestored: boolean } | null = null
}
