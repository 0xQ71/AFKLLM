import { basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_MODELS_DIR, type AppSettings } from '../../shared/settings'
import { scanWeightFiles } from '../llama/ModelScanner'

const IMAGE_GEN_PATH_KEYS = [
  'imageGenModelPath',
  'imageGenVaePath',
  'imageGenClipLPath',
  'imageGenClipGPath',
  'imageGenT5Path',
  'imageGenLlmPath'
] as const

type ImageGenPathKey = (typeof IMAGE_GEN_PATH_KEYS)[number]

function baseName(p: string): string {
  return basename(p).toLowerCase()
}

function isEmptyOrMissing(path: string | undefined): boolean {
  const t = path?.trim() ?? ''
  if (!t) return true
  return !existsSync(t)
}

/** Prefer higher-quality FLUX.1-dev quants when several are present. */
function scoreFlux1Dev(path: string): number {
  const n = baseName(path)
  if (!/flux[\s._-]*1[\s._-]*dev|flux1[-_]?dev/.test(n)) return -1
  if (/vae|clip|t5|text_encoder|ae\.|mmproj/.test(n)) return -1
  if (n.endsWith('.safetensors') && !/gguf/.test(n)) return 95
  if (/q8/.test(n)) return 100
  if (/q6|q5_k|q5/.test(n)) return 80
  if (/q4_k/.test(n)) return 65
  if (/q4|q3|q2/.test(n)) return 50
  return 40
}

function scoreFlux2(path: string): number {
  const n = baseName(path)
  if (!/flux[\s._-]*2|flux2/.test(n)) return -1
  if (/vae|llm|text|mmproj|qwen|mistral/.test(n) && !/klein|dev/.test(n)) {
    // allow klein/dev in name
  }
  if (/vae|clip|t5|ae\.|mmproj/.test(n)) return -1
  if (/klein/.test(n)) return 90
  if (/q8/.test(n)) return 85
  if (/q4/.test(n)) return 70
  return 50
}

function scoreSdxl(path: string): number {
  const n = baseName(path)
  if (!/sdxl|realvis|juggernaut|epicrealism|pony|illustrious/.test(n)) return -1
  if (/vae|lora|embedding|controlnet/.test(n)) return -1
  if (/\.(safetensors|gguf|ckpt)$/.test(n)) return 60
  return -1
}

function scoreVae(path: string): number {
  const n = baseName(path)
  if (/^ae\.(safetensors|sft)$/.test(n)) return 100
  if (/flux.*vae|vae.*flux|flux-vae/.test(n)) return 80
  if (/^ae/.test(n) && /\.(safetensors|sft)$/.test(n)) return 70
  return -1
}

function scoreClipL(path: string): number {
  const n = baseName(path)
  if (/clip_l\.safetensors$/.test(n)) return 100
  if (/clip[-_]?l/.test(n) && n.endsWith('.safetensors')) return 80
  return -1
}

function scoreClipG(path: string): number {
  const n = baseName(path)
  if (/clip_g\.safetensors$/.test(n)) return 100
  if (/clip[-_]?g/.test(n) && n.endsWith('.safetensors')) return 80
  return -1
}

/** Prefer FP8 (recommended) over FP16 to save RAM. */
function scoreT5(path: string): number {
  const n = baseName(path)
  if (!/t5xxl/.test(n)) return -1
  if (!/\.(safetensors|gguf)$/.test(n)) return -1
  if (/fp8_e4m3fn\.safetensors$/.test(n) && !/scaled/.test(n)) return 100
  if (/fp8.*scaled/.test(n)) return 85
  if (/fp8/.test(n)) return 80
  if (/fp16/.test(n)) return 60
  return 40
}

function scoreLlm(path: string): number {
  const n = baseName(path)
  if (!/\.gguf$/.test(n)) return -1
  if (/qwen3[-_]?4b/.test(n)) return 100
  if (/mistral[-_]?small/.test(n)) return 70
  return -1
}

function pickBest(
  files: { path: string; sizeBytes: number }[],
  score: (path: string) => number
): string | undefined {
  let best: { path: string; score: number; size: number } | undefined
  for (const f of files) {
    const s = score(f.path)
    if (s < 0) continue
    if (
      !best ||
      s > best.score ||
      (s === best.score && f.sizeBytes > best.size)
    ) {
      best = { path: f.path, score: s, size: f.sizeBytes }
    }
  }
  return best?.path
}

function detectStackKind(modelPath: string): 'flux1' | 'flux2' | 'sdxl' | 'other' {
  const n = baseName(modelPath)
  if (/flux[\s._-]*2|flux2/.test(n)) return 'flux2'
  if (/flux[\s._-]*1|flux1/.test(n)) return 'flux1'
  if (/sdxl|realvis|juggernaut|epicrealism|pony|illustrious/.test(n)) return 'sdxl'
  return 'other'
}

/**
 * Fill empty (or missing-file) image-gen paths from files under modelsDir roots.
 * Never overwrites a path that still exists on disk.
 */
export async function autofillImageGenPaths(
  settings: AppSettings,
  roots?: string[]
): Promise<Partial<AppSettings>> {
  const dirs = (
    roots ??
    [settings.modelsDir?.trim() || '', DEFAULT_MODELS_DIR].filter(Boolean)
  ).filter((d, i, arr) => d && arr.indexOf(d) === i)

  const files: { path: string; sizeBytes: number }[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const found = await scanWeightFiles(dir)
    for (const f of found) {
      const key = f.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      files.push({ path: f.path, sizeBytes: f.sizeBytes })
    }
  }
  if (files.length === 0) return {}

  const patch: Partial<AppSettings> = {}

  const need = (key: ImageGenPathKey): boolean =>
    isEmptyOrMissing(settings[key])

  if (need('imageGenModelPath')) {
    const flux1 = pickBest(files, scoreFlux1Dev)
    const flux2 = pickBest(files, scoreFlux2)
    const sdxl = pickBest(files, scoreSdxl)
    // Prefer FLUX.1 when present (user's current stack); else FLUX.2; else SDXL.
    const model = flux1 || flux2 || sdxl
    if (model) patch.imageGenModelPath = model
  }

  const modelPath = (patch.imageGenModelPath || settings.imageGenModelPath || '').trim()
  const stack = modelPath ? detectStackKind(modelPath) : 'other'

  if (need('imageGenVaePath') && (stack === 'flux1' || stack === 'flux2' || stack === 'other')) {
    const vae = pickBest(files, scoreVae)
    if (vae) patch.imageGenVaePath = vae
  }

  if (need('imageGenClipLPath') && (stack === 'flux1' || stack === 'other')) {
    const clip = pickBest(files, scoreClipL)
    if (clip) patch.imageGenClipLPath = clip
  }

  if (need('imageGenT5Path') && (stack === 'flux1' || stack === 'other')) {
    const t5 = pickBest(files, scoreT5)
    if (t5) patch.imageGenT5Path = t5
  }

  if (need('imageGenLlmPath') && (stack === 'flux2' || stack === 'other')) {
    const llm = pickBest(files, scoreLlm)
    if (llm) patch.imageGenLlmPath = llm
  }

  // CLIP-G only when it looks like SD3 (has clip_g file and empty field); don't force for FLUX.
  if (need('imageGenClipGPath') && stack !== 'flux1' && stack !== 'flux2') {
    const clipG = pickBest(files, scoreClipG)
    if (clipG) patch.imageGenClipGPath = clipG
  }

  return patch
}

/** True when core image-gen paths for the detected stack are empty/missing. */
export function imageGenPathsNeedAutofill(settings: AppSettings): boolean {
  // Always repair broken (non-empty but missing) paths.
  for (const key of IMAGE_GEN_PATH_KEYS) {
    const v = settings[key]?.trim() ?? ''
    if (v && !existsSync(v)) return true
  }
  if (isEmptyOrMissing(settings.imageGenModelPath)) return true
  const stack = detectStackKind(settings.imageGenModelPath)
  if (stack === 'flux1' || stack === 'other') {
    if (isEmptyOrMissing(settings.imageGenVaePath)) return true
    if (isEmptyOrMissing(settings.imageGenClipLPath)) return true
    if (isEmptyOrMissing(settings.imageGenT5Path)) return true
  }
  if (stack === 'flux2') {
    if (isEmptyOrMissing(settings.imageGenVaePath)) return true
    if (isEmptyOrMissing(settings.imageGenLlmPath)) return true
  }
  return false
}

/** Drop stale paths that no longer exist so autofill can replace them. */
export function clearMissingImageGenPaths(
  settings: AppSettings
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}
  for (const key of IMAGE_GEN_PATH_KEYS) {
    const v = settings[key]?.trim() ?? ''
    if (v && !existsSync(v)) {
      patch[key] = ''
    }
  }
  return patch
}

/** Used only to keep basename helper reachable for tests via scoring edge cases. */
export function imageGenAutofillExt(path: string): string {
  return extname(path).toLowerCase()
}
