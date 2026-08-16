/** Shared VL GGUF heuristics (renderer + main). */

export function scoreVisionGguf(pathOrName: string): number {
  const n = pathOrName.replace(/^.*[/\\]/, '').toLowerCase()
  if (/mmproj|flux|sdxl|stable.?diffusion|vae|clip_l|clip_g|t5xxl|t5-xxl/.test(n)) {
    return -1
  }
  if (/qwen3?[-_.]?vl|qwen[-_.]?vl/.test(n)) {
    if (/8b/.test(n)) return /q4_k/.test(n) ? 100 : 95
    if (/4b|2b/.test(n)) return 85
    return 90
  }
  if (/minicpm[-_.]?v|minicpm.v/.test(n)) return 88
  if (/llava|moondream|internvl|pixtral|idefics/.test(n)) return 70
  if (/gemma[-_.]?[34]|gemma[34]/.test(n)) return 55
  if (/ornith/.test(n) && /vision|vl/.test(n)) return 60
  if (/\bvl\b|vision/.test(n)) return 60
  return -1
}

export function isLikelyVisionGguf(pathOrName: string): boolean {
  return scoreVisionGguf(pathOrName) >= 0
}

export function normGgufPath(path: string | undefined | null): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase()
}

/**
 * Stored in visionModelPath when the user picks “Same as chat” in the Vision
 * selector. Not a filesystem path — mmproj attaches to the chat llama-server.
 */
export const VISION_SAME_AS_CHAT = '__same_as_chat__'

export function isVisionSameAsChat(path?: string | null): boolean {
  return (path ?? '').trim() === VISION_SAME_AS_CHAT
}

/** Family token for VL weights / mmproj (null = unknown). */
export function vlWeightFamily(pathOrName: string): string | null {
  const n = pathOrName.replace(/^.*[/\\]/, '').toLowerCase()
  if (/qwen3?[-_.]?vl|qwen[-_.]?vl/.test(n)) return 'qwen-vl'
  if (/minicpm/.test(n)) return 'minicpm'
  if (/gemma/.test(n)) return 'gemma'
  if (/ornith/.test(n)) return 'ornith'
  if (/llava/.test(n)) return 'llava'
  if (/moondream/.test(n)) return 'moondream'
  if (/pixtral/.test(n)) return 'pixtral'
  if (/internvl/.test(n)) return 'internvl'
  return null
}

export function looksLikeMmprojMismatch(log: string): boolean {
  return /mismatch between text model[\s\S]{0,80}mmproj|wrong mmproj|failed to load multimodal/i.test(
    log
  )
}

/**
 * Vision selector is “Same as chat”, or Vision path equals Chat.
 * Load mmproj on the chat server — do not start a second copy.
 */
export function visionReusesChatModel(opts: {
  chatPath?: string
  visionPath?: string
  mmprojPath?: string
}): boolean {
  const chat = normGgufPath(opts.chatPath)
  if (!chat) return false
  if (isVisionSameAsChat(opts.visionPath)) return true
  const vis = normGgufPath(opts.visionPath)
  if (!vis) return false
  return vis === chat
}

/** Score a *mmproj*.gguf against a vision GGUF. -1 = incompatible family. */
export function scoreMmprojForVision(mmprojPath: string, visionPath: string): number {
  const m = mmprojPath.replace(/^.*[/\\]/, '').toLowerCase()
  const v = visionPath.replace(/^.*[/\\]/, '').toLowerCase()
  if (!/mmproj/.test(m)) return -1
  const fm = vlWeightFamily(m)
  const fv = vlWeightFamily(v)
  if (fm && fv && fm !== fv) return -1
  let score = 10
  if (fm && fv && fm === fv) score += 80
  if (/f16|fp16/.test(m)) score += 5
  return score
}
