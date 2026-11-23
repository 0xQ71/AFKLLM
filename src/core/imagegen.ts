// Image generation with Qwen-Image 2.1 through a headless ComfyUI that runs only while it is needed.
// User's pick (2026-11-03): abenzerps uncensored DiT Q8_0 GGUF (ComfyUI-GGUF node) + Comfy-Org Qwen3-VL 8B W4A8
// text encoder + official VAE bf16; the official non-turbo template: 25 steps, cfg 1, euler/simple.
// The GPU (16 GB) cannot hold the 27B coder and the image model at once, so the host swaps them: see swap.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CONFIG_DIR } from './server'

const MODELS = process.env.AFK_MODELS_DIR || 'C:\\Models'

export interface ImageGenConfig {
  /** ComfyUI portable root (has python_embeded\ and ComfyUI\) */
  comfyDir: string
  /** folder with diffusion_models\, text_encoders\, vae\ */
  modelsDir: string
  port: number
  unet: string
  textEncoder: string
  vae: string
  steps: number
}

export const DEFAULT_IMAGEGEN: ImageGenConfig = {
  comfyDir: process.env.AFK_COMFY_DIR || 'C:\\ComfyUI\\ComfyUI_windows_portable',
  modelsDir: join(MODELS, 'Qwen-Image-2.1'),
  port: 8190,
  unet: 'qwen-image-2.1-UC-Q8_0.gguf',
  textEncoder: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  steps: 25,
}

/** What is missing for image generation on this machine (empty = ready). */
export function imageGenMissing(cfg: ImageGenConfig = DEFAULT_IMAGEGEN): string[] {
  const need = [
    join(cfg.comfyDir, 'python_embeded', 'python.exe'),
    join(cfg.comfyDir, 'ComfyUI', 'main.py'),
    join(cfg.comfyDir, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF', 'nodes.py'),
    join(cfg.modelsDir, 'diffusion_models', cfg.unet),
    join(cfg.modelsDir, 'text_encoders', cfg.textEncoder),
    join(cfg.modelsDir, 'vae', cfg.vae),
  ]
  return need.filter((p) => !existsSync(p))
}

export interface ImageRequest {
  prompt: string
  negative?: string
  width?: number
  height?: number
  seed?: number
  /** absolute output path (.png) */
  out: string
  /** do not echo the prompt in progress lines (private `/image` command) */
  quiet?: boolean
}

/**
 * The PNG without its text chunks: ComfyUI's SaveImage writes the whole workflow, prompt included, into tEXt chunks.
 * The picture data (IHDR/IDAT/...) is untouched; only tEXt/iTXt/zTXt are dropped.
 */
export function stripPngText(png: Buffer): Buffer {
  const SIG = 8
  if (png.length < SIG || png.readUInt32BE(0) !== 0x89504e47) return png
  const parts: Buffer[] = [png.subarray(0, SIG)]
  let i = SIG
  while (i + 12 <= png.length) {
    const len = png.readUInt32BE(i)
    const type = png.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (end > png.length) return png // malformed: keep the original bytes
    if (type !== 'tEXt' && type !== 'iTXt' && type !== 'zTXt') parts.push(png.subarray(i, end))
    i = end
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

export interface ImageResult { path: string; width: number; height: number; seconds: number; seed: number }

/** ComfyUI filename_prefix for an output path: `afk_<parent folder>_<file name>` (filesystem-safe, bounded). */
export function comfyPrefix(out: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, '_')
  const file = basename(out).replace(/\.png$/i, '')
  const parent = basename(dirname(out))
  return `afk_${safe(parent).slice(0, 90)}_${safe(file).slice(0, 60)}`
}

const round16 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 16) * 16))

/** API-format graph of ComfyUI's image_qwen_image_2_1_t2i template (no prompt enhancer), DiT loaded from GGUF. */
export function t2iGraph(cfg: ImageGenConfig, r: Required<Pick<ImageRequest, 'prompt' | 'negative' | 'width' | 'height' | 'seed'>>, prefix: string) {
  const unet = cfg.unet.toLowerCase().endsWith('.gguf')
    ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: cfg.unet } }
    : { class_type: 'UNETLoader', inputs: { unet_name: cfg.unet, weight_dtype: 'default' } }
  return {
    '1': unet,
    '2': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.textEncoder, type: 'qwen_image', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } },
    '5': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['3', 0], prompt: r.prompt, negative_prompt: r.negative, resolution: 1024 } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: r.width, height: r.height, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: {
      model: ['2', 0], seed: r.seed, steps: cfg.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0], denoise: 1,
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['4', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefix } },
  }
}

/** A ComfyUI process started on demand and killed afterwards (that is what frees the VRAM). */
export class ComfyRunner {
  private child: ChildProcess | null = null
  private exited: number | null | undefined
  readonly url: string
  logPath = ''

  constructor(readonly cfg: ImageGenConfig = DEFAULT_IMAGEGEN) {
    this.url = `http://127.0.0.1:${cfg.port}`
  }

  private async alive(): Promise<boolean> {
    try { return (await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
  }

  async start(onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<void> {
    if (await this.alive()) return
    const missing = imageGenMissing(this.cfg)
    if (missing.length) throw new Error(`image generation is not installed: missing ${missing.join(', ')}`)
    mkdirSync(join(CONFIG_DIR, 'logs'), { recursive: true })
    const yaml = join(CONFIG_DIR, 'comfy-extra-model-paths.yaml')
    writeFileSync(yaml, [
      'afkllm:',
      `  base_path: ${JSON.stringify(this.cfg.modelsDir)}`,
      '  diffusion_models: diffusion_models',
      '  text_encoders: text_encoders',
      '  vae: vae',
      '',
    ].join('\n'))
    this.logPath = join(CONFIG_DIR, 'logs', `comfyui-${this.cfg.port}.log`)
    const log = createWriteStream(this.logPath)
    const py = join(this.cfg.comfyDir, 'python_embeded', 'python.exe')
    const args = ['-s', join(this.cfg.comfyDir, 'ComfyUI', 'main.py'), '--windows-standalone-build', '--listen', '127.0.0.1',
      '--port', String(this.cfg.port), '--disable-auto-launch', '--extra-model-paths-config', yaml,
      '--output-directory', join(CONFIG_DIR, 'comfy-output')]
    log.write(`${py} ${args.join(' ')}\n\n`)
    this.exited = undefined
    this.child = spawn(py, args, { cwd: this.cfg.comfyDir, windowsHide: true })
    this.child.stdout?.pipe(log)
    this.child.stderr?.pipe(log)
    this.child.on('exit', (c) => { this.exited = c })
    const t0 = Date.now()
    while (Date.now() - t0 < 300_000) {
      if (signal?.aborted) { await this.stop(); throw new Error('aborted') }
      if (this.exited !== undefined) throw new Error(`ComfyUI exited with code ${this.exited} while starting; see ${this.logPath}`)
      if (await this.alive()) return
      onProgress?.(`starting ComfyUI · ${Math.round((Date.now() - t0) / 1000)}s`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    await this.stop()
    throw new Error(`ComfyUI did not start in 5 min; see ${this.logPath}`)
  }

  async generate(req: ImageRequest, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<ImageResult> {
    const t0 = Date.now()
    const r = {
      prompt: req.prompt, negative: req.negative ?? '',
      width: round16(req.width ?? 1024), height: round16(req.height ?? 1024),
      seed: req.seed ?? Math.floor(Math.random() * 2 ** 48),
    }
    // ComfyUI's own copy is named after the output (<chat folder>_<file>), so a copy left by a crash can be cleaned
    // with the chat it belongs to (/image-clean); it is deleted right after a normal run anyway
    const prefix = comfyPrefix(req.out)
    onProgress?.(`image ${r.width}x${r.height} · seed ${r.seed}` +
      (req.quiet ? '' : ` · prompt: ${r.prompt.length > 240 ? r.prompt.slice(0, 240) + '…' : r.prompt}`))
    // live stages and sampler steps from ComfyUI's websocket (falls back to plain polling if it cannot connect)
    const stage: Record<string, string> = {
      '1': 'loading image model', '3': 'loading text encoder', '4': 'loading VAE', '5': 'encoding the prompt',
      '7': 'sampling', '8': 'decoding (VAE)', '9': 'saving',
    }
    let current = 'queued'
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/ws?clientId=afkllm`)
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return // binary = latent preview frames
        try {
          const m = JSON.parse(ev.data)
          if (m.type === 'executing' && m.data?.node && stage[m.data.node]) {
            current = stage[m.data.node]
            onProgress?.(`${current} · ${Math.round((Date.now() - t0) / 1000)}s`)
          } else if (m.type === 'progress' && m.data?.max) {
            onProgress?.(`sampling · step ${m.data.value}/${m.data.max}`)
          }
        } catch { /* ignore */ }
      }
      await new Promise<void>((ok) => { ws!.onopen = () => ok(); ws!.onerror = () => ok(); setTimeout(ok, 3000) })
    } catch { ws = null }
    try {
    const res = await fetch(`${this.url}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: t2iGraph(this.cfg, r, prefix), client_id: 'afkllm' }), signal,
    })
    const body = await res.json() as { prompt_id?: string; error?: unknown; node_errors?: unknown }
    if (!res.ok || !body.prompt_id) throw new Error(`ComfyUI refused the workflow: ${JSON.stringify(body.error ?? body.node_errors ?? body).slice(0, 600)}`)
    const id = body.prompt_id
    while (Date.now() - t0 < 900_000) {
      if (signal?.aborted) {
        await fetch(`${this.url}/interrupt`, { method: 'POST' }).catch(() => {})
        throw new Error('aborted')
      }
      const h = await (await fetch(`${this.url}/history/${id}`)).json() as Record<string, any>
      const entry = h[id]
      if (entry) {
        const st = entry.status ?? {}
        if (st.status_str === 'error') {
          const msg = (st.messages ?? []).find((m: any) => m[0] === 'execution_error')?.[1]
          throw new Error(`image generation failed: ${msg?.exception_message ?? 'see ' + this.logPath}`)
        }
        const img = Object.values(entry.outputs ?? {}).flatMap((o: any) => o.images ?? [])[0] as any
        if (img) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })
          const bin = Buffer.from(await (await fetch(`${this.url}/view?${q}`)).arrayBuffer())
          mkdirSync(dirname(req.out), { recursive: true })
          // no workflow / prompt inside the saved file, and no second copy left in ComfyUI's output folder
          writeFileSync(req.out, stripPngText(bin))
          if ((img.type ?? 'output') === 'output') {
            try { rmSync(join(CONFIG_DIR, 'comfy-output', img.subfolder ?? '', img.filename), { force: true }) } catch { /* the copy is only a leftover */ }
          }
          return { path: req.out, width: r.width, height: r.height, seconds: (Date.now() - t0) / 1000, seed: r.seed }
        }
      }
      if (!ws) onProgress?.(`generating image · ${Math.round((Date.now() - t0) / 1000)}s`)
      await new Promise((rs) => setTimeout(rs, 1000))
    }
    throw new Error('image generation timed out after 15 min')
    } finally {
      try { ws?.close() } catch { /* ignore */ }
    }
  }

  /** Kill the whole process tree and wait until it is gone (the VRAM is only free after that). */
  async stop(): Promise<void> {
    const c = this.child
    this.child = null
    if (c?.pid && this.exited === undefined) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
      else c.kill()
      const t0 = Date.now()
      while (this.exited === undefined && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 300))
    }
  }
}
