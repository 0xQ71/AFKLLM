import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Active one-shot sd-cli — Stop / cancelAll can kill it. */
let activeSdProc: ChildProcessWithoutNullStreams | null = null

/** Kill in-flight image generation (best-effort). Returns true if a process was signaled. */
export function killActiveSdCli(): boolean {
  const proc = activeSdProc
  if (!proc) return false
  activeSdProc = null
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  return true
}

export type SdStackKind = 'single' | 'flux1' | 'flux2' | 'sd3'

export interface SdSidecarPaths {
  /** Diffusion / combined checkpoint */
  modelPath: string
  vaePath?: string
  clipLPath?: string
  clipGPath?: string
  t5Path?: string
  /** FLUX.2 text backbone (Qwen3 / Mistral GGUF or safetensors) */
  llmPath?: string
}

export interface SdStepProgress {
  step: number
  total: number
  remaining: number
  /** Seconds per step when known */
  secPerStep?: number
  phase: 'loading' | 'sampling' | 'decoding' | 'done' | 'error'
  detail: string
}

export interface SdGenerateParams extends SdSidecarPaths {
  binaryPath: string
  prompt: string
  outputPath: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  /** Prefer CPU offload for 16 GB VRAM stacks (FLUX / SD3). Default: auto by stack. */
  offloadToCpu?: boolean
  /**
   * Where to keep weights: disk (safe), ram (VRAM-safe), vram (fast).
   * Overrides offloadToCpu when set.
   */
  weightStorage?: 'disk' | 'ram' | 'vram'
  clipOnCpu?: boolean
  /** Force VAE decode on CPU. Default false — staged offload uses CUDA VAE. */
  vaeOnCpu?: boolean
  /** Distilled guidance for FLUX.1-dev (sd-cli --guidance). Default 3.5. */
  guidance?: number
  /** Flash-attn for diffusion. Default on for FLUX/SD3 (saves VRAM). */
  diffusionFa?: boolean
  /**
   * Highres fix second pass (sd-cli --hires).
   * When true, --hires-steps always equals --steps.
   */
  hires?: boolean
  /** Upscale factor for hires (default 1.25). */
  hiresScale?: number
  /** Denoising strength for hires pass (default 0.4). */
  hiresDenoising?: number
  samplingMethod?: string
  timeoutMs?: number
  onProgress?: (p: SdStepProgress) => void
}

export interface SdGenerateResult {
  ok: boolean
  outputPath: string
  error?: string
  logs?: string
  stack?: SdStackKind
}

function present(p?: string): string | undefined {
  const t = p?.trim()
  return t && existsSync(t) ? t : undefined
}

/**
 * Detect blank / near-solid outputs that sd-cli still saves as "success"
 * (typical CUDA VAE OOM / hires decode failure → pure white).
 */
export function isNearlyBlankImage(filePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeImage } = require('electron') as typeof import('electron')
    const img = nativeImage.createFromPath(filePath)
    if (!img || img.isEmpty()) return true
    const { width, height } = img.getSize()
    if (width < 8 || height < 8) return true
    const buf = img.toBitmap()
    const pixels = width * height
    const step = Math.max(1, Math.floor(pixels / 5000))
    let n = 0
    let sum = 0
    let sum2 = 0
    let nearWhite = 0
    let nearBlack = 0
    for (let i = 0; i < pixels; i += step) {
      const o = i * 4
      const b = buf[o] ?? 0
      const g = buf[o + 1] ?? 0
      const r = buf[o + 2] ?? 0
      const lum = (r + g + b) / 3
      sum += lum
      sum2 += lum * lum
      n++
      if (r > 250 && g > 250 && b > 250) nearWhite++
      if (r < 5 && g < 5 && b < 5) nearBlack++
    }
    if (n < 10) return true
    const mean = sum / n
    const variance = sum2 / n - mean * mean
    const solidFrac = Math.max(nearWhite, nearBlack) / n
    return variance < 8 || solidFrac > 0.985
  } catch {
    try {
      const st = statSync(filePath)
      // 1280² photo is usually >200KB; blank white PNG ~50KB
      return st.size > 0 && st.size < 90_000
    } catch {
      return true
    }
  }
}

/** Infer sd.cpp invocation style from which sidecar paths exist. */
export function detectSdStack(paths: SdSidecarPaths): SdStackKind {
  const model = present(paths.modelPath)
  if (!model) return 'single'
  const vae = present(paths.vaePath)
  const clipL = present(paths.clipLPath)
  const clipG = present(paths.clipGPath)
  const t5 = present(paths.t5Path)
  const llm = present(paths.llmPath)
  if (llm && vae) return 'flux2'
  if (vae && clipL && t5) return 'flux1'
  if (clipL && clipG && t5) return 'sd3'
  return 'single'
}

/** Parse sd-cli log lines for denoising progress. */
export function parseSdProgressLine(
  line: string,
  totalSteps: number
): SdStepProgress | null {
  const text = line.trim()
  if (!text) return null

  // "|====…====| 5/20 - 1.57it/s" or "5/20 - 18.34s/it"
  const bar = text.match(/(\d+)\s*\/\s*(\d+)\s*-\s*([\d.]+)\s*(s\/it|it\/s)/i)
  if (bar) {
    const step = Number(bar[1])
    const total = Number(bar[2]) || totalSteps
    const rate = Number(bar[3])
    const unit = bar[4]!.toLowerCase()
    const secPerStep = unit === 'it/s' && rate > 0 ? 1 / rate : rate
    const remaining = Math.max(0, total - step)
    return {
      step,
      total,
      remaining,
      secPerStep,
      phase: step >= total ? 'decoding' : 'sampling',
      detail:
        remaining > 0
          ? `Image gen: step ${step}/${total} · ${remaining} left` +
            (secPerStep
              ? ` · ~${Math.max(1, Math.round(remaining * secPerStep))}s`
              : '')
          : `Image gen: step ${step}/${total} · finishing…`
    }
  }

  // "step 5 sampling completed, taking 18.34s"
  const stepDone = text.match(
    /step\s+(\d+)\s+sampling completed(?:,\s*taking\s+([\d.]+)s)?/i
  )
  if (stepDone) {
    const step = Number(stepDone[1])
    const secPerStep = stepDone[2] ? Number(stepDone[2]) : undefined
    const total = totalSteps
    const remaining = Math.max(0, total - step)
    return {
      step,
      total,
      remaining,
      secPerStep,
      phase: remaining > 0 ? 'sampling' : 'decoding',
      detail:
        remaining > 0
          ? `Image gen: step ${step}/${total} · ${remaining} left` +
            (secPerStep
              ? ` · ~${Math.max(1, Math.round(remaining * secPerStep))}s`
              : '')
          : `Image gen: sampling done · decoding…`
    }
  }

  if (/start sampling/i.test(text)) {
    return {
      step: 0,
      total: totalSteps,
      remaining: totalSteps,
      phase: 'sampling',
      detail: `Image gen: sampling started · ${totalSteps} steps`
    }
  }
  if (/sampling completed/i.test(text) && !/step\s+\d+/i.test(text)) {
    return {
      step: totalSteps,
      total: totalSteps,
      remaining: 0,
      phase: 'decoding',
      detail: 'Image gen: sampling done · decoding…'
    }
  }
  if (/loading weights from ram|upload|copy.*gpu|to device/i.test(text)) {
    return {
      step: 0,
      total: totalSteps,
      remaining: totalSteps,
      phase: 'loading',
      detail: 'Image gen: loading weights from RAM → GPU…'
    }
  }
  if (/loading|load.*model|load.*weight|gguf|clip|t5|vae/i.test(text) && /load/i.test(text)) {
    return {
      step: 0,
      total: totalSteps,
      remaining: totalSteps,
      phase: 'loading',
      detail: /ram/i.test(text)
        ? 'Image gen: loading weights from RAM…'
        : 'Image gen: loading weights (disk)…'
    }
  }
  if (/saving|encode|vae|decode/i.test(text) && !/load/i.test(text)) {
    return {
      step: totalSteps,
      total: totalSteps,
      remaining: 0,
      phase: 'decoding',
      detail: 'Image gen: decoding / saving…'
    }
  }
  return null
}

export function buildSdCliArgs(params: SdGenerateParams): {
  args: string[]
  stack: SdStackKind
  steps: number
  hires: boolean
  error?: string
} {
  const model = present(params.modelPath)
  if (!model) {
    return {
      args: [],
      stack: 'single',
      steps: 20,
      hires: false,
      error: 'Image model not found'
    }
  }
  const vae = present(params.vaePath)
  const clipL = present(params.clipLPath)
  const clipG = present(params.clipGPath)
  const t5 = present(params.t5Path)
  const llm = present(params.llmPath)
  const stack = detectSdStack({
    modelPath: model,
    vaePath: vae,
    clipLPath: clipL,
    clipGPath: clipG,
    t5Path: t5,
    llmPath: llm
  })

  const width = Math.max(64, params.width ?? 512)
  const height = Math.max(64, params.height ?? 512)
  const steps = Math.max(1, params.steps ?? 20)
  const defaultCfg =
    stack === 'flux1' || stack === 'flux2' ? 1 : stack === 'sd3' ? 4.5 : 7
  let cfg =
    params.cfgScale != null && params.cfgScale > 0 ? params.cfgScale : defaultCfg
  // FLUX guidance is ~1; high CFG is wrong and often much slower.
  if ((stack === 'flux1' || stack === 'flux2') && cfg > 2) {
    cfg = 1
  }
  const sampling =
    params.samplingMethod?.trim() ||
    (stack === 'single' ? '' : 'euler')
  /**
   * Memory strategy (16 GB VRAM / 32 GB RAM):
   * - TE on CPU (official flux.md)
   * - VAE on CPU by default for FLUX/SD3 — CUDA VAE + hires has produced blank white PNGs
   *   (sd.cpp silent decode failure); CPU decode is slower but reliable
   * - Diffusion in VRAM when possible; --offload-to-cpu for hires / ram / disk
   */
  const weightStorage: 'disk' | 'ram' | 'vram' =
    params.weightStorage ??
    (params.offloadToCpu === true ? 'ram' : 'vram')
  const heavyStack = stack === 'flux1' || stack === 'flux2' || stack === 'sd3'
  const clipOnCpu = params.clipOnCpu ?? heavyStack
  // Prefer CPU VAE for reliability (blank white = known CUDA/hires decode failure mode).
  const vaeOnCpu = params.vaeOnCpu ?? heavyStack
  const isSchnell = /schnell/i.test(model)
  const guidance =
    params.guidance != null && params.guidance >= 0
      ? params.guidance
      : stack === 'flux1'
        ? isSchnell
          ? 0
          : 3.5
        : undefined

  const args: string[] = []
  if (stack === 'flux2') {
    args.push('--diffusion-model', model, '--vae', vae!, '--llm', llm!)
  } else if (stack === 'flux1') {
    args.push(
      '--diffusion-model',
      model,
      '--vae',
      vae!,
      '--clip_l',
      clipL!,
      '--t5xxl',
      t5!
    )
  } else if (stack === 'sd3') {
    args.push('-m', model, '--clip_l', clipL!, '--clip_g', clipG!, '--t5xxl', t5!)
  } else {
    args.push('-m', model)
  }

  args.push(
    '-p',
    params.prompt.trim(),
    '-o',
    params.outputPath.trim(),
    '--steps',
    String(steps),
    '-W',
    String(width),
    '-H',
    String(height),
    '--cfg-scale',
    String(cfg)
  )
  if (guidance != null) {
    args.push('--guidance', String(guidance))
  }
  if (params.negativePrompt?.trim()) {
    args.push('-n', params.negativePrompt.trim())
  }
  if (sampling) {
    args.push('--sampling-method', sampling)
  }

  const wantHires = params.hires === true
  let hiresScale = Math.max(
    1.05,
    Math.min(4, Number(params.hiresScale) || 1.25)
  )
  let diffusionFa = params.diffusionFa ?? false
  if (wantHires) {
    const maxSide = Math.max(width, height)
    const maxOutSide = heavyStack ? 1280 : 1536
    const scaleCap = Math.max(1.05, maxOutSide / maxSide)
    if (hiresScale > scaleCap) hiresScale = Math.round(scaleCap * 100) / 100
  }
  if (params.diffusionFa == null && (heavyStack || wantHires)) {
    diffusionFa = true
  }
  if (diffusionFa) args.push('--diffusion-fa')

  if (clipOnCpu) args.push('--clip-on-cpu')
  if (vaeOnCpu) args.push('--vae-on-cpu')

  if (heavyStack) {
    const parts = ['diffusion=cuda0']
    parts.push(clipOnCpu ? 'te=cpu' : 'te=cuda0')
    parts.push(vaeOnCpu ? 'vae=cpu' : 'vae=cuda0')
    args.push('--backend', parts.join(','))

    const needOffload =
      wantHires || weightStorage === 'ram' || weightStorage === 'disk'
    if (weightStorage === 'disk') {
      args.push(
        '--params-backend',
        'disk',
        '--mmap',
        '--max-vram',
        '13',
        '--stream-layers'
      )
    } else if (needOffload) {
      // Staged: park weights in RAM, upload slices for hires / tight VRAM.
      args.push('--offload-to-cpu', '--max-vram', '13', '--stream-layers')
    }
    // else vram + no hires: diffusion weights stay resident on GPU (fastest steps)
  } else if (weightStorage === 'disk') {
    args.push('--params-backend', 'disk', '--mmap')
  } else if (weightStorage === 'ram') {
    args.push('--params-backend', 'cpu', '--mmap')
  }

  const hires = wantHires
  if (hires) {
    const denoise = Math.max(
      0.05,
      Math.min(1, Number(params.hiresDenoising) || 0.4)
    )
    args.push(
      '--hires',
      '--hires-scale',
      String(hiresScale),
      '--hires-steps',
      String(steps),
      '--hires-denoising-strength',
      String(denoise)
    )
  }

  return { args, stack, steps, hires }
}

/** One-shot sd-cli text-to-image (single-file or FLUX / SD3 multi-file). */
export function runSdCli(params: SdGenerateParams): Promise<SdGenerateResult> {
  const binary = params.binaryPath.trim()
  const out = params.outputPath.trim()
  if (!binary || !existsSync(binary)) {
    return Promise.resolve({
      ok: false,
      outputPath: out,
      error: `sd-cli binary not found: ${binary || '(empty)'}`
    })
  }
  if (!params.prompt?.trim()) {
    return Promise.resolve({
      ok: false,
      outputPath: out,
      error: 'prompt is required'
    })
  }

  const built = buildSdCliArgs(params)
  if (built.error) {
    return Promise.resolve({
      ok: false,
      outputPath: out,
      error: built.error,
      stack: built.stack
    })
  }

  const redactPrompt = (a: string[]): string => {
    const copy = [...a]
    const i = copy.indexOf('-p')
    if (i >= 0 && i + 1 < copy.length) {
      const p = copy[i + 1] ?? ''
      copy[i + 1] = p.length > 80 ? `${p.slice(0, 80)}…` : p
    }
    return copy.join(' ')
  }
  console.log(
    `[sd-cli] stack=${built.stack} steps=${built.steps} hires=${built.hires} args: ${redactPrompt(built.args)}`
  )

  try {
    mkdirSync(dirname(out), { recursive: true })
  } catch (err) {
    return Promise.resolve({
      ok: false,
      outputPath: out,
      error: err instanceof Error ? err.message : String(err),
      stack: built.stack
    })
  }

  const passes = built.hires ? 2 : 1
  const baseTimeout = params.timeoutMs ?? 600_000
  const timeoutMs = built.hires ? Math.max(baseTimeout, baseTimeout * 2) : baseTimeout
  const notify = (p: SdStepProgress): void => {
    try {
      params.onProgress?.(p)
    } catch {
      /* ignore UI callback errors */
    }
  }

  notify({
    step: 0,
    total: built.steps,
    remaining: built.steps,
    phase: 'loading',
    detail: built.hires
      ? `Image gen (${built.stack}): loading · ${built.steps}+${built.steps} steps (hires)`
      : `Image gen (${built.stack}): loading from disk · ${built.steps} steps`
  })

  return new Promise((resolve) => {
    let logs = ''
    let lineBuf = ''
    let settled = false
    let pass = 1
    let lastStepSeen = 0
    let proc: ChildProcessWithoutNullStreams | null = null
    const finish = (result: SdGenerateResult): void => {
      if (settled) return
      settled = true
      if (proc && activeSdProc === proc) activeSdProc = null
      resolve({ ...result, stack: built.stack })
    }

    const emitProg = (prog: SdStepProgress): void => {
      // Second pass resets the step counter; detect that for status labels.
      if (passes > 1 && prog.step + 2 < lastStepSeen && pass < passes) {
        pass = 2
      }
      if (prog.step > 0) lastStepSeen = prog.step
      const prefix =
        passes > 1 ? `Image gen: pass ${pass}/${passes} · ` : 'Image gen: '
      notify({
        ...prog,
        detail: prog.detail.replace(/^Image gen:\s*/, prefix)
      })
    }

    proc = spawn(binary, built.args, {
      cwd: dirname(binary),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env }
    }) as unknown as ChildProcessWithoutNullStreams
    activeSdProc = proc

    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString()
      logs = (logs + text).slice(-16_000)
      lineBuf += text
      const parts = lineBuf.split(/\r?\n/)
      lineBuf = parts.pop() ?? ''
      for (const line of parts) {
        if (/highres|hires/i.test(line) && passes > 1 && pass < passes) {
          pass = 2
          lastStepSeen = 0
        }
        const prog = parseSdProgressLine(line, built.steps)
        if (prog) emitProg(prog)
      }
      // Progress bars often rewrite the same line with \r
      const lastCr = text.split(/\r/).pop()
      if (lastCr) {
        const prog = parseSdProgressLine(lastCr, built.steps)
        if (prog) emitProg(prog)
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)

    const timer = setTimeout(() => {
      try {
        proc?.kill()
      } catch {
        /* ignore */
      }
      notify({
        step: 0,
        total: built.steps,
        remaining: built.steps,
        phase: 'error',
        detail: 'Image gen: timed out'
      })
      finish({
        ok: false,
        outputPath: out,
        error: `sd-cli timed out after ${Math.round(timeoutMs / 1000)}s`,
        logs
      })
    }, timeoutMs)

    proc.on('error', (err) => {
      clearTimeout(timer)
      notify({
        step: 0,
        total: built.steps,
        remaining: built.steps,
        phase: 'error',
        detail: `Image gen: ${err.message}`
      })
      finish({
        ok: false,
        outputPath: out,
        error: err.message,
        logs
      })
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && existsSync(out)) {
        if (isNearlyBlankImage(out)) {
          const detail =
            'Image gen produced a blank image (likely VAE/hires CUDA decode failure). Try VAE on CPU / disable hires / lower resolution.'
          notify({
            step: 0,
            total: built.steps,
            remaining: built.steps,
            phase: 'error',
            detail
          })
          finish({
            ok: false,
            outputPath: out,
            error: detail,
            logs
          })
          return
        }
        notify({
          step: built.steps,
          total: built.steps,
          remaining: 0,
          phase: 'done',
          detail: 'Image gen: done'
        })
        finish({ ok: true, outputPath: out, logs })
        return
      }
      const logTail = logs.trim().slice(-1200)
      const missing =
        code === 0 && !existsSync(out)
          ? ` (exit 0 but output missing: ${out})`
          : ''
      const detail = `Image gen failed (code ${code ?? 'null'})${missing}`
      notify({
        step: 0,
        total: built.steps,
        remaining: built.steps,
        phase: 'error',
        detail
      })
      finish({
        ok: false,
        outputPath: out,
        error:
          `${detail}` +
          (logTail ? `\n--- sd-cli log (tail) ---\n${logTail}` : ''),
        logs
      })
    })
  })
}
