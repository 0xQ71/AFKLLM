/** Basename looks like a GGUF with a baked-in MTP (nextn) draft head. */
export function looksLikeMtpGguf(modelPath: string): boolean {
  const leaf = modelPath.replace(/\\/g, '/').split('/').pop() ?? modelPath
  return /(?:^|[-_.])mtp(?:[-_.]|$)/i.test(leaf)
}

/** NVFP4 tensor layout — fast on Blackwell, poor/unsupported on Ampere/Ada. */
export function looksLikeNvfp4Gguf(modelPath: string): boolean {
  return /nvfp4/i.test(modelPath)
}

/** RTX 50-series GeForce / PRO 6000 / GB10 and other Blackwell names from nvidia-smi.
 *  Do not match workstation Ada "RTX 5000 Ada Generation". */
export function isBlackwellGpuName(name?: string | null): boolean {
  if (!name) return false
  if (/blackwell|\bgb10\b|\bb200\b|\brtx\s*pro\s*60\d{2}\b/i.test(name)) return true
  // GeForce RTX 5050–5090 (optional Ti). RTX 5000 Ada is 4 digits after "RTX " as 5000.
  return /\brtx\s*50[5-9]0(?:\s*ti)?\b/i.test(name)
}

/**
 * Auto: MTP flags when the GGUF name looks like MTP.
 * Vision mmproj on the same server is allowed — Ornith 1M+Vision ships that way.
 */
export function shouldEnableDraftMtp(opts: {
  modelPath: string
  mmprojPath?: string | null
}): boolean {
  void opts.mmprojPath
  return looksLikeMtpGguf(opts.modelPath)
}

/** Draft depth: 2 = acceptance/stability (Ornith code edits), 3 = throughput. */
export function mtpDraftMax(modelPath: string): number {
  return /ornith/i.test(modelPath.replace(/\\/g, '/').split('/').pop() ?? modelPath)
    ? 2
    : 3
}

/** True only when llama-server rejected MTP CLI flags (not OOM / CUDA / GGUF errors). */
export function speculativeMtpUnsupported(logs: string): boolean {
  return /(?:unknown argument|unrecognized option|invalid (?:argument|option)|error while parsing argument)[^\n]*(?:--spec-type|spec-draft)|(?:--spec-type|spec-draft)[^\n]*(?:unknown argument|unrecognized option|invalid (?:argument|option))/i.test(
    logs
  )
}
