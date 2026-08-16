/** Official Ornith-1.0 interactive sampling (HF model card / GitHub serving notes). */
export const ORNITH_TEMPERATURE = 0.6
export const ORNITH_TOP_P = 0.95
export const ORNITH_TOP_K = 20
/** Native 256K window used in SWE / ClawEval. 1M YaRN GGUFs can go higher; 256K is the stable edit default. */
export const ORNITH_CTX_SIZE = 262_144
/** protoLabs MTP: depth 2 maximizes acceptance; 3 is throughput; 4 regresses. */
export const ORNITH_MTP_DRAFT_N = 2

export function looksLikeOrnithGguf(modelPath: string): boolean {
  const leaf = modelPath.replace(/\\/g, '/').split('/').pop() ?? modelPath
  return /ornith/i.test(leaf)
}

/** AFKLLM factory sampling — too tight for Ornith (temp 0.1 / top_p 0.1 / top_k 50). */
export function isStockAfkllmSampling(p: {
  temperature: number
  topK: number
  topP: number
}): boolean {
  return p.temperature === 0.1 && p.topK === 50 && p.topP === 0.1
}

export function ornithTuningOverlay(): {
  temperature: number
  topK: number
  topP: number
  topPEnabled: boolean
  ctxSize: number
} {
  return {
    temperature: ORNITH_TEMPERATURE,
    topK: ORNITH_TOP_K,
    topP: ORNITH_TOP_P,
    topPEnabled: true,
    ctxSize: ORNITH_CTX_SIZE
  }
}
