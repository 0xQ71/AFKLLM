// Headless agent core: shared types. No Electron / DOM imports anywhere under src/core.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI-style content parts; images are data: URLs (llama-server with --mmproj reads them). */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: Role
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
  /** The model's thinking for this assistant turn, sent back so it keeps reasoning across tool calls. */
  reasoning_content?: string
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** What a tool may touch; drives permission decisions. */
export type ToolKind = 'read' | 'edit' | 'exec' | 'meta'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto']

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface DiffLine {
  kind: ' ' | '+' | '-'
  text: string
  /** 1-based line number in the old (for ' ' and '-') or new (for '+') file */
  line: number
}

export interface ToolOutcome {
  ok: boolean
  /** Text sent back to the model. */
  output: string
  /** One short line for the UI, e.g. "Read 120 lines". */
  summary: string
  diff?: { path: string; lines: DiffLine[]; added: number; removed: number }
  /** Pictures for the model to look at (Read of a .png/.jpg …); sent as a follow-up user message. */
  images?: { path: string; mime: string; data: string }[]
}

/** Plain text of a message (image parts become a short marker). */
export function textOf(content: ChatMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}

/** Rough prompt cost of an image for a Qwen-VL style encoder at our --image-max-tokens cap. */
export const IMAGE_TOKENS_ESTIMATE = 1200

export interface PermissionRequest {
  tool: string
  kind: ToolKind
  title: string
  /** Shell command, file path, etc. */
  detail: string
  diff?: ToolOutcome['diff']
  /** Why auto mode refused to decide alone (dangerous command, outside project, …). */
  reason?: string
  /** Key that "don't ask again" would remember, e.g. "edit" or "shell:npm test". */
  ruleKey: string
}

export type PermissionDecision =
  | { allow: true; remember?: boolean }
  | { allow: false; feedback?: string }

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  ctxSize: number
  promptPerSecond?: number
  genPerSecond?: number
  draftAcceptRate?: number
}

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'text_end' }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; label: string }
  | { type: 'tool_result'; id: string; name: string; outcome: ToolOutcome; ms: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'compact'; beforeTokens: number; afterTokens: number }
  | { type: 'notice'; message: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'done'; reason: 'end' | 'aborted' | 'max_turns' | 'error'; message?: string }
