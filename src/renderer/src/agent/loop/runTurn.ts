import type { ChatMessage } from '../runAgentTurn'
import { runAgentTurn } from '../runAgentTurn'

export type { ChatMessage }

/**
 * Cursor-like agent loop (v2): same streaming/tool engine as runAgentTurn,
 * with language-agnostic prompts, evidence-gated plan ticks, and no landing shortcuts.
 * ChatPanel should call this when settings.agentLoopV2 is on (default).
 */
export async function runAgentTurnV2(
  params: Parameters<typeof runAgentTurn>[0]
): Promise<ChatMessage[]> {
  return runAgentTurn({ ...params, loopVersion: 2 })
}
