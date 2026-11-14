/** OpenAI-style chat delta / message fields llama.cpp may fill. */
export type LlmTextDelta = {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
}

/**
 * Visible text from a streamed delta.
 * Qwen / Gemma-VL often put DeepThink in `reasoning_content` and leave `content` empty.
 */
export function streamDeltaText(delta?: LlmTextDelta | null): string {
  if (!delta) return ''
  const content = typeof delta.content === 'string' ? delta.content : ''
  if (content.trim()) return content
  const reasoning =
    (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
    (typeof delta.reasoning === 'string' ? delta.reasoning : '')
  return reasoning || content
}
