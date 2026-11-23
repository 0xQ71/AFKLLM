// Starts (or reuses) a llama-server for a model profile. Profiles are tuned on the stage-0 bench
// (scripts/stage0/bench.py, RTX 5060 Ti 16 GB) and can be overridden in ~/.afkllm/cli.json:
//   { "llamaServer": "C:\\Models\\llama.cpp\\b12063\\llama-server.exe",
//     "defaultProfile": "q38",   (unset: flash with 64 GB RAM and Strata set up, else q38 — defaultProfileName)
//     "profiles": { "mine": { "model": "D:\\x.gguf", "ctx": 65536, "args": { "n-gpu-layers": "99" } } } }
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir, networkInterfaces, totalmem } from 'node:os'
import { join } from 'node:path'
import type { Sampling } from './llm'
import { strataCommand, strataMissing, strataModelName, type StrataSpec } from './strata'

export interface ModelProfile {
  label: string
  model: string
  ctx: number
  args: Record<string, string | null>
  sampling: Sampling
  thinking?: boolean
  /** set: the model runs on the Strata engine (strata.ts) instead of llama-server; `args` are then unused */
  strata?: StrataSpec
}

const MODELS = process.env.AFK_MODELS_DIR || 'C:\\Models'
const QWEN_CODE: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 }

export const BUILTIN_PROFILES: Record<string, ModelProfile> = {
  // ---- Qwen3.8 27B, the agent default (stage 0, 2026-11-03, thinking on) ----
  // baa-ai RAM-13GB weights + unsloth's MTP layer grafted in as built-in MTP + unsloth's imatrix Q5_K LM head
  // (scripts/stage0/graft-mtp.py --output-from). Coder 15/16, agent T3+T2 pass. VRAM is the limit, not the model
  // (native 262K): every 1K of context costs ~29 MiB with MTP (q4 KV + MTP KV + two flash-attn f16 buffers), and
  // the process must stay under ~15.5 GB dedicated or Windows silently spills into system RAM.
  //   q38       104K, all on GPU          ~69 t/s, needle 6/6 @90K   <- default: full speed
  //   q38-128k  128K, draft 2, 5 FFN on CPU ~46 t/s                   long tasks
  //   q38-160k  160K, no MTP              ~30 t/s (15 t/s @138K), needle 6/6 @100K   reading huge inputs
  q38: {
    label: 'Qwen3.8 27B (baa-ai + MTP) @104K',
    model: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'Qwen3.8-27B-RAM-13GB-MTP-o5.gguf'),
    ctx: 106496,
    args: {
      // vision: projector on the CPU keeps the GPU for context (measured at 104K: GPU projector spills, CPU one
      // fits; a 1280x720 screenshot = ~920 tokens, read in ~13 s, all 6/6 details correct)
      mmproj: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'mmproj-Qwen3.8-27B-BF16.gguf'),
      'no-mmproj-offload': null, 'image-max-tokens': '2048',
      'n-gpu-layers': '99', fit: 'off', 'spec-type': 'draft-mtp', 'spec-draft-n-max': '3',
      'ubatch-size': '256', 'cache-type-k': 'q4_0', 'cache-type-v': 'q4_0',
      'cache-type-k-draft': 'q4_0', 'cache-type-v-draft': 'q4_0', // the MTP layer's own KV is f16 by default
    },
    sampling: QWEN_CODE,
  },
  'q38-128k': {
    label: 'Qwen3.8 27B (baa-ai + MTP) @128K',
    model: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'Qwen3.8-27B-RAM-13GB-MTP-o5.gguf'),
    ctx: 131072,
    args: {
      // vision: projector on the CPU keeps the GPU for context (measured at 104K: GPU projector spills, CPU one
      // fits; a 1280x720 screenshot = ~920 tokens, read in ~13 s, all 6/6 details correct)
      mmproj: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'mmproj-Qwen3.8-27B-BF16.gguf'),
      'no-mmproj-offload': null, 'image-max-tokens': '2048',
      'n-gpu-layers': '99', fit: 'off', 'spec-type': 'draft-mtp', 'spec-draft-n-max': '2',
      'ubatch-size': '256', 'cache-type-k': 'q4_0', 'cache-type-v': 'q4_0',
      'cache-type-k-draft': 'q4_0', 'cache-type-v-draft': 'q4_0',
      'override-tensor': 'blk\\.([0-4])\\.ffn_(up|gate|down)\\.weight=CPU', 'load-mode': 'none',
    },
    sampling: QWEN_CODE,
  },
  'q38-160k': {
    label: 'Qwen3.8 27B (baa-ai, no MTP) @160K',
    // same file as q38; without --spec-type the grafted MTP layer is simply unused (measured: 15.25 GB, no spill)
    model: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'Qwen3.8-27B-RAM-13GB-MTP-o5.gguf'),
    ctx: 163840,
    args: {
      'n-gpu-layers': '99', fit: 'off', 'ubatch-size': '256', 'cache-type-k': 'q4_0', 'cache-type-v': 'q4_0',
      // vision: projector on the CPU keeps the GPU for context (measured at 104K: GPU projector spills, CPU one
      // fits; a 1280x720 screenshot = ~920 tokens, read in ~13 s, all 6/6 details correct)
      mmproj: join(MODELS, 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF', 'mmproj-Qwen3.8-27B-BF16.gguf'),
      'no-mmproj-offload': null, 'image-max-tokens': '2048',
    },
    sampling: QWEN_CODE,
  },
  // ---- Qwen3.8-Flash-Next on Strata (2026-11-22): 512-expert MoE, 10 active, 47 GB of weights in GPU + RAM ----
  // ISTA-DASLab GSQ-RCO IQ3_XXS (LiveCodeBench v6 86.3 vs 87.4 for BF16). Strata keeps ~8.6 GB of the most-routed
  // experts in VRAM and the other ~40 GB in pinned RAM (CPU AVX2 kernels); shard 2 (the 29 GB n-gram table) is read
  // from the NVMe row by row. DFlash2 drafter, int8 KV with 32K cells per layer in VRAM and the rest streamed from RAM.
  // Measured: decode 55-80 t/s, prefill 750-1850 t/s (llama.cpp b12063 on the same files: 18.5 / 297). Load ~55-80 s.
  // 256K check (2026-11-23): a 200K-token prompt read in 108 s, 3/3 needles at 10/50/90 % depth, decode at that
  // depth still 60-63 t/s (sparse attention), the next turn reused 200,071 tokens and answered in 4 s.
  // The preset is made once by scripts\strata-setup.cmd (`strata launch ... --save-preset afk-flash`).
  flash: {
    label: 'Qwen3.8-Flash-Next IQ3_XXS (Strata) @256K',
    model: join(MODELS, 'ISTA-DASLab__Qwen3.8-Flash-Next-GSQ-RCO-GGUF', 'IQ3_XXS', 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf'),
    // the model's native window (262,144). Only 12 of 48 layers keep K/V (2 heads x 256, int8): ~12 KB a token,
    // 3.3 GB of pinned RAM for the whole window, 32K cells of it in VRAM
    ctx: 262144,
    args: {},
    strata: {
      preset: 'afk-flash',
      engineArgs: {
        // Park the conversation in RAM when a side request (session title, sub-agent, compaction) takes the slot,
        // instead of re-reading it afterwards (measured without: an 18K prompt re-read in 19 s; ~1.2 GB per 63K tokens).
        // Strata switches it off by itself when the Windows commit limit is tight: it needs RAM + page file >= ~96 GB.
        'conversation-cache-mib': '4096',
        // tiny side requests are not parked: they would push the long conversation out of the slots
        'conversation-cache-min-tokens': '4096',
        // The hybrid model can only rewind to a checkpoint: with the default one every 16K prompt tokens, a client
        // that rewrites its history re-read up to 16K tokens (seen once: a 12K first prompt read twice, 24 s).
        // Same number of checkpoints (--prompt-cache 6, ~118 MB each), just denser.
        'prompt-cache-every': '4096',
      },
      config: {
        // GPU swap for images (swap.ts): the conversation goes to a file and comes back instead of being re-read
        slot_save_path: join(MODELS, '_kv'),
        // a ceiling against runaway thinking, twice the 27B's: the model card puts no limit on thinking and says a
        // shallower analysis costs more agent retries than it saves (~7 min at 75 t/s if a step ever uses it all;
        // agent steps measured 0.1-2.4K). The Harness model entry gives a step 40K: thinking + the answer.
        reasoning_budget_tokens: 32768,
        // screenshots: Strata's CPU reader defaults to 300 image tokens, too few to read text on a screen
        vision: { max_tokens: 1024 },
      },
    },
    // the model card's thinking-mode sampling (also what its agentic evals used): temperature 1.0, not the 27B's 0.6
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 },
  },
}

const COMMON_ARGS: Record<string, string | null> = {
  'flash-attn': 'on',
  'cache-type-k': 'q8_0',
  'cache-type-v': 'q8_0',
  parallel: '1',
  'batch-size': '2048',
  'ubatch-size': '512',
  jinja: null,
  'no-webui': null,
  // lets the GPU swap (swap.ts) save/restore the KV cache around image generation instead of re-reading the context
  'slot-save-path': join(MODELS, '_kv'),
  // Thinking is always on; a per-step ceiling only stops runaway loops — a model that
  // needs less stops earlier. Stage 0: Qwen3.6 used up to ~9K on hard coding problems and never looped, Ornith 9B
  // looped past 16K on 3 of 16. Override per profile with args: { "reasoning-budget": "-1" } (unlimited).
  'reasoning-budget': '16384',
  'reasoning-budget-message': 'I have thought about this enough. Time to act on it.',
  // Read the weights instead of mapping them. On Windows llama.cpp cannot unmap the parts already copied to the GPU, so
  // with mmap the whole file stayed resident (+12.7 GB working set for q38, 13.1 GB vs 2.1 GB idle); load time is the same.
  'load-mode': 'none',
  // Host-RAM prompt cache: when the prompt prefix changes (compaction, a sub-agent) the old slot state is parked here,
  // ~1.3 GB per 40K prompt on Qwen3.8 (KV + recurrent checkpoints), and coming back to it costs 3 s instead of ~70 s.
  // The default 8 GB grew llama-server to 23 GB in a long harness session; 4 GB keeps about three parked prompts.
  'cache-ram': '4096',
}

export interface CliConfig {
  llamaServer?: string
  defaultProfile?: string
  port?: number
  profiles?: Record<string, Partial<ModelProfile>>
}

export const CONFIG_DIR = join(homedir(), '.afkllm')

export function loadConfig(): CliConfig {
  const p = join(CONFIG_DIR, 'cli.json')
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {} } catch { return {} }
}

/** RAM the `flash` profile needs: Strata pins ~40 GB of experts + the K/V and commits ~61 GB. */
export const FLASH_MIN_RAM_GB = 60

/**
 * The profile used when none is named: `defaultProfile` from cli.json, else the best one this PC can run —
 * `flash` (Qwen3.8-Flash-Next on Strata, 256K) with 60+ GB of RAM once Strata and its preset are set up
 * (scripts\setup.cmd), otherwise `q38` (the 27B, fully on a 16 GB GPU).
 */
export function defaultProfileName(cfg: CliConfig = loadConfig()): string {
  if (cfg.defaultProfile) return cfg.defaultProfile
  const flash = profiles(cfg).flash
  const ramGb = totalmem() / 1024 ** 3
  if (flash?.strata && ramGb >= FLASH_MIN_RAM_GB - 4 && existsSync(flash.model) && !strataMissing(flash.strata)) return 'flash'
  return 'q38'
}

export function profiles(cfg: CliConfig): Record<string, ModelProfile> {
  const out: Record<string, ModelProfile> = { ...BUILTIN_PROFILES }
  for (const [k, v] of Object.entries(cfg.profiles ?? {})) {
    const base = out[k] ?? { label: k, model: '', ctx: 32768, args: { 'n-gpu-layers': '99' }, sampling: QWEN_CODE }
    out[k] = { ...base, ...v, args: { ...base.args, ...(v.args ?? {}) }, sampling: { ...base.sampling, ...(v.sampling ?? {}) } } as ModelProfile
  }
  return out
}

/** Non-loopback IPv4 addresses of this machine (LAN). Link-local 169.254.x.x is skipped. */
export function lanIPv4(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      const v4 = n.family === 'IPv4' || (n.family as unknown) === 4
      if (!v4 || n.internal) continue
      if (n.address.startsWith('169.254.')) continue
      out.push(n.address)
    }
  }
  return out
}

async function lanReachable(port: number): Promise<boolean> {
  const ips = lanIPv4()
  if (!ips.length) return false
  const checks = await Promise.all(ips.map(async (ip) => {
    try {
      const r = await fetch(`http://${ip}:${port}/health`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }))
  return checks.some(Boolean)
}

export function findLlamaServer(cfg: CliConfig): string | null {
  const candidates = [
    process.env.AFK_LLAMA_SERVER,
    cfg.llamaServer,
    join(MODELS, 'llama.cpp', 'b12063', 'llama-server.exe'),
  ].filter(Boolean) as string[]
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * The server answers (anyLoad) or answers with its model loaded. Strata's /health is ok with "loaded": false when it
 * runs unloaded (lazy / idle unload): it loads on the next request, so it counts as running, not as a free port.
 */
async function health(url: string, anyLoad = false): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    if (anyLoad) return true
    const j = (await r.json().catch(() => ({}))) as { loaded?: boolean }
    return j.loaded !== false
  } catch {
    return false
  }
}

/** What a running server serves: llama-server's model path, or "strata:<model name>". '' when unknown. */
async function servedModel(url: string): Promise<string> {
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json().catch(() => ({}))) as any
    if (h?.service === 'strata') return `strata:${h.model ?? ''}`
    const r = await fetch(`${url}/props`, { signal: AbortSignal.timeout(2000) })
    const j = (await r.json()) as any
    return String(j?.model_path ?? '')
  } catch {
    return ''
  }
}

/** servedModel's value for a profile. */
function servedId(profile: ModelProfile): string {
  return profile.strata ? `strata:${strataModelName(profile.strata)}` : profile.model
}

export interface RunningServer {
  url: string
  reused: boolean
  logPath?: string
  stop: () => void
}

/**
 * Reuses a healthy server already serving the same model on the port, otherwise spawns one.
 * onProgress gets short status lines while the model loads.
 * detached: the spawned llama-server outlives this process (afk api restarting a model that `afk llama` owned:
 * the proxy may crash or restart, the model and its KV cache stay). Its output goes straight to the log file, so
 * nothing breaks when the parent is gone; whoever owns the port stops it (`afk llama` on exit: killListener).
 */
export async function ensureServer(profile: ModelProfile, cfg: CliConfig, opts: {
  port?: number; ctx?: number; host?: string; onProgress?: (msg: string) => void; signal?: AbortSignal; detached?: boolean
} = {}): Promise<RunningServer> {
  const port = opts.port ?? cfg.port ?? 18300
  // Probe and the returned url stay on loopback. `host` is only the bind address (0.0.0.0 = LAN).
  const host = !opts.host || opts.host === 'localhost' ? '127.0.0.1' : opts.host
  const url = `http://127.0.0.1:${port}`
  if (await health(url, true)) {
    const served = await servedModel(url)
    if (served && served.toLowerCase() !== servedId(profile).toLowerCase()) {
      throw new Error(`port ${port} is busy with another model (${served}). Stop it or pass --port.`)
    }
    if (host !== '127.0.0.1' && !(await lanReachable(port))) {
      throw new Error(`port ${port} already has llama-server on localhost only. Stop it, then run \`afk api\` again so it listens on the LAN.`)
    }
    return { url, reused: true, stop: () => {} }
  }
  if (!existsSync(profile.model)) throw new Error(`model file not found: ${profile.model}`)
  const logDir = join(CONFIG_DIR, 'logs')
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(MODELS, '_kv'), { recursive: true })
  const logPath = join(logDir, `llama-server-${port}.log`)
  const name = profile.strata ? 'Strata' : 'llama-server'

  let exe: string, args: string[], cwd: string
  let env: NodeJS.ProcessEnv | undefined
  if (profile.strata) {
    const missing = strataMissing(profile.strata)
    if (missing) throw new Error(missing)
    ;({ exe, args, cwd } = strataCommand(profile.strata, { port, host, ctx: opts.ctx ?? profile.ctx, configDir: join(CONFIG_DIR, 'strata'), logDir }))
    // no daily update-feed read: nothing leaves the PC while serving
    env = { ...process.env, STRATA_UPDATE_CHECK: '0', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  } else {
    const found = findLlamaServer(cfg)
    if (!found) throw new Error('llama-server.exe not found. Set AFK_LLAMA_SERVER or "llamaServer" in ~/.afkllm/cli.json, or pass --url.')
    exe = found
    cwd = join(exe, '..')
    args = ['-m', profile.model, '--host', host, '--port', String(port)]
    const all = { ...COMMON_ARGS, ...profile.args, 'ctx-size': String(opts.ctx ?? profile.ctx) }
    for (const [k, v] of Object.entries(all)) {
      if (v === '__off__') continue
      args.push(`--${k}`)
      if (v !== null) args.push(v)
    }
  }
  // the server writes the log file itself (not through a pipe of this process): `afk llama`'s window tails it,
  // and a detached server keeps logging after its parent exits
  const fd = openSync(logPath, 'w')
  writeSync(fd, `${exe} ${args.join(' ')}\n\n`)
  const child: ChildProcess = spawn(exe, args, { windowsHide: true, cwd, env, stdio: ['ignore', fd, fd], detached: !!opts.detached })
  closeSync(fd)
  if (opts.detached) child.unref()
  let exited: number | null | undefined
  child.on('exit', (c) => { exited = c })
  const stop = () => {
    if (exited === undefined && child.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill()
    }
  }

  const t0 = Date.now()
  while (Date.now() - t0 < 600_000) {
    if (opts.signal?.aborted) { stop(); throw new Error('aborted') }
    if (exited !== undefined) throw new Error(`${name} exited with code ${exited} while loading; see ${logPath}`)
    if (await health(url)) return { url, reused: false, logPath, stop }
    opts.onProgress?.(`loading ${profile.label} · ${Math.round((Date.now() - t0) / 1000)}s`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  stop()
  throw new Error(`${name} did not become ready in 10 min; see ${logPath}`)
}

/** Qwen3.8's chat template only accepts xhigh, medium, and low. Clients often send OpenAI's "high". */
export function mapReasoningEffort(level: string): string {
  switch (level.toLowerCase()) {
    case 'medium': return 'medium'
    case 'low': case 'minimal': return 'low'
    case 'xhigh': case 'high': case 'max': return 'xhigh'
    default: return 'xhigh'
  }
}

function mapEffortField(value: unknown): { value: string; changed: boolean } | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const mapped = mapReasoningEffort(value)
  return { value: mapped, changed: mapped !== value }
}

/**
 * Rewrite an OpenAI chat body for llama-server: reasoning_effort "high" → the template's "xhigh" (it 500s on others),
 * and the profile's sampling (Qwen: temp 0.6, top_p 0.95, top_k 20, min_p 0) for every field the client did not set —
 * harness clients send none, and llama-server's own defaults (temp 0.8, top_k 40, min_p 0.05) are worse for code.
 */
export function rewriteChatBody(raw: Buffer, contentType?: string, sampling?: Sampling): Buffer {
  if (contentType && !contentType.toLowerCase().includes('json')) return raw
  if (!raw.length) return raw
  const text = raw.toString('utf8')
  const fill = Object.entries(sampling ?? {}).filter(([, v]) => typeof v === 'number')
  if (!text.includes('reasoning') && !fill.length) return raw
  let body: Record<string, unknown>
  try { body = JSON.parse(text) as Record<string, unknown> } catch { return raw }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return raw
  let changed = false
  const top = mapEffortField(body.reasoning_effort)
  if (top?.changed) { body.reasoning_effort = top.value; changed = true }
  const reasoning = body.reasoning
  if (reasoning && typeof reasoning === 'object') {
    const effort = mapEffortField((reasoning as Record<string, unknown>).effort)
    if (effort?.changed) { (reasoning as Record<string, unknown>).effort = effort.value; changed = true }
  }
  const kwargs = body.chat_template_kwargs
  if (kwargs && typeof kwargs === 'object') {
    const effort = mapEffortField((kwargs as Record<string, unknown>).reasoning_effort)
    if (effort?.changed) { (kwargs as Record<string, unknown>).reasoning_effort = effort.value; changed = true }
  }
  if (Array.isArray(body.messages)) {
    for (const [k, v] of fill) {
      if (body[k] === undefined || body[k] === null) { body[k] = v; changed = true }
    }
  }
  return changed ? Buffer.from(JSON.stringify(body)) : raw
}

/**
 * llama-server (stb_image) cannot decode WebP, but harness clients re-encode images to WebP (alpha) before sending.
 * Turn every data:image/webp URL in a chat body into PNG. Needs @napi-rs/canvas (absent in the single-file exe:
 * then the body passes unchanged). Returns the original buffer when there is nothing to convert.
 */
export async function webpToPng(raw: Buffer): Promise<Buffer> {
  if (!raw.includes('data:image/webp')) return raw
  let canvas: typeof import('@napi-rs/canvas')
  try { canvas = await import('@napi-rs/canvas') } catch { return raw }
  let body: unknown
  try { body = JSON.parse(raw.toString('utf8')) } catch { return raw }
  let changed = 0
  const convert = async (url: string): Promise<string> => {
    const m = /^data:image\/webp;base64,(.+)$/s.exec(url)
    if (!m) return url
    try {
      const img = await canvas.loadImage(Buffer.from(m[1], 'base64'))
      const c = canvas.createCanvas(img.width, img.height)
      c.getContext('2d').drawImage(img, 0, 0)
      changed++
      return 'data:image/png;base64,' + c.toBuffer('image/png').toString('base64')
    } catch { return url }
  }
  const walk = async (v: unknown): Promise<void> => {
    if (Array.isArray(v)) { for (const x of v) await walk(x); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === 'string' && (k === 'url' || k === 'image_url') && x.startsWith('data:image/webp')) o[k] = await convert(x)
      else if (x && typeof x === 'object') await walk(x)
    }
  }
  await walk((body as Record<string, unknown>)?.messages)
  return changed ? Buffer.from(JSON.stringify(body)) : raw
}

/** The `model` field of a JSON chat request, if any. */
export function chatModel(body: Buffer): string | undefined {
  try { const m = JSON.parse(body.toString('utf8'))?.model; return typeof m === 'string' && m ? m : undefined } catch { return undefined }
}

/**
 * Which profile a client's `model` names: a profile name, or a .gguf path (the first profile using that file, so the
 * plain path means the default profile of that file). Anything else (llama's own id, "gpt-4") names none.
 */
export function profileForModel(model: string | undefined, all: Record<string, ModelProfile>): string | undefined {
  if (!model) return undefined
  if (all[model]) return model
  const m = model.toLowerCase()
  return Object.keys(all).find((k) => all[k].model.toLowerCase() === m)
}

export interface LanProxy {
  port: number
  stop: () => void
}

/** A path the proxy answers itself instead of forwarding to llama-server (e.g. /mcp). Gets the whole body. */
export type ProxyRoute = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>

export interface LanProxyOptions {
  listenHost?: string
  listenPort: number
  upstreamPort: number
  /** sampling defaults filled into chat requests that do not set them (a function: read per request, after onChat) */
  sampling?: Sampling | (() => Sampling | undefined)
  /**
   * Called for each chat request with its `model` field once the gate is open, before the request is forwarded:
   * `afk api` loads the profile the client asked for here (the request waits). A throw answers 503.
   */
  onChat?: (model: string | undefined) => Promise<void>
  /** resolves when llama-server may take requests (pending while the GPU swap has it unloaded) */
  gate?: () => Promise<void>
  /** exact paths (no query) answered by the proxy */
  routes?: Record<string, ProxyRoute>
}

/**
 * LAN front for a localhost llama-server. The public port is this proxy; llama-server stays on loopback.
 * Chat requests get reasoning_effort mapped and sampling defaults filled in (rewriteChatBody); while the gate is
 * closed (image generation swapped the LLM out) requests wait instead of failing.
 */
export function startLanProxy(opts: LanProxyOptions): Promise<LanProxy> {
  const host = opts.listenHost ?? '127.0.0.1'
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = (req.url ?? '/').split('?')[0]
      const route = opts.routes?.[path]
      if (route) {
        Promise.resolve(route(req, res, body)).catch((e) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: (e as Error).message, type: 'server_error' } }))
        })
        return
      }
      const chat = /\/chat\/completions$/.test(path)
      const gate = () => (opts.gate ? opts.gate().catch(() => {}) : Promise.resolve())
      if (!chat) { gate().then(() => forwardToLlama(req, res, body, opts.upstreamPort)); return }
      ;(async () => {
        await gate()
        if (opts.onChat) await opts.onChat(chatModel(body))
        const sampling = typeof opts.sampling === 'function' ? opts.sampling() : opts.sampling
        const out = rewriteChatBody(body, req.headers['content-type'], sampling)
        forwardToLlama(req, res, await webpToPng(out).catch(() => out), opts.upstreamPort)
      })().catch((e) => {
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: (e as Error).message, type: 'server_error' } }))
      })
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.keepAliveTimeout = 120_000
  return new Promise((resolve, reject) => {
    const fail = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${opts.listenPort} is already in use. Stop the previous afk api (llama-server is still bound there) and run it again.`))
      } else reject(err)
    }
    server.once('error', fail)
    server.listen(opts.listenPort, host, () => {
      server.removeListener('error', fail)
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : opts.listenPort
      resolve({ port, stop: () => { server.closeAllConnections?.(); server.close() } })
    })
  })
}

function forwardToLlama(req: IncomingMessage, res: ServerResponse, body: Buffer, upstreamPort: number): void {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${upstreamPort}` }
  delete headers['transfer-encoding']
  headers['content-length'] = String(body.length)
  const up = httpRequest({
    hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(res)
  })
  // the client hung up (agent cancelled): stop llama-server generating for nobody
  res.on('close', () => { if (!res.writableFinished) up.destroy() })
  up.on('error', () => {
    if (res.headersSent) { res.end(); return }
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'llama-server is not reachable', type: 'server_error' } }))
  })
  up.end(body)
}
