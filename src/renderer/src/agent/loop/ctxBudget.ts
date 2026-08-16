/**
 * Completion budget from leftover context — never request max_tokens == ctx
 * when the prompt already fills most of an 8k window.
 */

export const AGENT_MAX_TOKENS = 8192
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
