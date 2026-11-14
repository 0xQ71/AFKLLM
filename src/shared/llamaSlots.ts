/** Chat / apply / vision llama-server ports relative to the chat listen port. */

export type LlamaWeightSlot = 'chat' | 'vision' | 'apply'

/**
 * Apply is always coresident on port+1.
 * Vision is coresident on port+2 when keep-loaded; otherwise it occupies the chat port (cold swap).
 */
export function llamaSlotPort(
  chatPort: number,
  slot: LlamaWeightSlot,
  visionKeepLoaded: boolean
): number {
  const port = Number.isFinite(chatPort) && chatPort > 0 ? Math.floor(chatPort) : 8080
  if (slot === 'apply') return port + 1
  if (slot === 'vision' && visionKeepLoaded) return port + 2
  return port
}

export function llamaSlotPortsToDeny(chatPort: number): number[] {
  const port = Number.isFinite(chatPort) && chatPort > 0 ? Math.floor(chatPort) : 8080
  return [...new Set([port, port + 1, port + 2, 8080])]
}
