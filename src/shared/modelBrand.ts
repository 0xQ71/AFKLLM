/** Detect LLM brand/family from a Hugging Face repo id (or title). */

export type ModelBrand =
  | 'mistral'
  | 'gemma'
  | 'qwen'
  | 'openai'
  | 'llama'
  | 'deepseek'
  | 'phi'
  | 'generic'

export function detectModelBrand(
  repoId: string,
  extra?: string | null
): ModelBrand {
  const s = `${repoId} ${extra ?? ''}`.toLowerCase()
  if (/mistral|devstral|mixtral|ministral/.test(s)) return 'mistral'
  if (/gemma/.test(s)) return 'gemma'
  if (/qwen|qwq/.test(s)) return 'qwen'
  if (/gpt-oss|openai\//.test(s)) return 'openai'
  if (/llama|meta-llama|codellama/.test(s)) return 'llama'
  if (/deepseek/.test(s)) return 'deepseek'
  if (/\bphi-?\d|\bphi\b/.test(s)) return 'phi'
  return 'generic'
}
