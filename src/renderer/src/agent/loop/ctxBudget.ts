/**
 * Completion budget from leftover context — never request max_tokens == ctx
 * when the prompt already fills most of an 8k window.
 */

export const AGENT_MAX_TOKENS = 8192
/** Compact history only when the prompt estimate fills this fraction of ctx. */
export const CTX_COMPACT_RATIO = 0.99
const COMPLETION_CAP = 4096
const COMPLETION_FLOOR = 256
const COMPLETION_RESERVE = 256

/**
 * Honest completion budget: min(4096, ctx - promptEst - 256).
 * At ctx=8192 / prompt≈5500 this is ~2.4k, not another 8192 that llama will
 * clip mid-tool-JSON.
 */
export function maxTokensForAgent(ctxSize: number, promptEst: number): number {
  const ctx = ctxSize > 0 ? ctxSize : AGENT_MAX_TOKENS
  const prompt = Math.max(0, Math.floor(promptEst))
  const room = ctx - prompt - COMPLETION_RESERVE
  if (room < COMPLETION_FLOOR) return COMPLETION_FLOOR
  return Math.min(COMPLETION_CAP, AGENT_MAX_TOKENS, room)
}

export function compactTokenThreshold(ctxSize: number): number {
  const ctx = ctxSize > 0 ? ctxSize : AGENT_MAX_TOKENS
  return Math.max(COMPLETION_FLOOR, Math.floor(ctx * CTX_COMPACT_RATIO))
}

/** True only when estimated prompt tokens occupy ≥99% of the model ctx. */
export function shouldCompactForOverflow(estTokens: number, ctxSize: number): boolean {
  return estTokens >= compactTokenThreshold(ctxSize)
}
