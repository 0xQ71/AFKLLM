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
  if (/gemma[-_.]?3|gemma3/.test(n)) return 55
  if (/\bvl\b|vision/.test(n)) return 60
  return -1
}

export function isLikelyVisionGguf(pathOrName: string): boolean {
  return scoreVisionGguf(pathOrName) >= 0
}
