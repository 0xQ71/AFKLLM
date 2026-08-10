import { AGENT_TOOL_SCHEMAS } from '../../../shared/types'
import { THREAD_SUMMARY_MSG_ID } from '../../../shared/chats'
import type { ChatMessage } from './runAgentTurn'
import {
  AGENT_RULES,
  IMAGE_GEN_RULES_OFF,
  IMAGE_GEN_RULES_ON,
  SYSTEM_CONFIRM_CORE,
  SYSTEM_CORE,
  SYSTEM_PLAN,
  THINK_THROUGH
} from './runAgentTurn'

/** Same heuristic as runAgentTurn overflow checks. */
const CHARS_PER_TOKEN = 3.2

export type ContextCategoryId =
  | 'system'
  | 'tools'
  | 'rules'
  | 'mcp'
  | 'summary'
  | 'conversation'

export interface ContextCategory {
  id: ContextCategoryId
  labelKey: `context.cat.${ContextCategoryId}`
  tokens: number
  color: string
}

export interface ContextUsageEstimate {
  used: number
  limit: number | null
  pct: number
  categories: ContextCategory[]
  /** True when used came from server prompt_tokens */
  measured: boolean
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(0, Math.ceil(text.length / CHARS_PER_TOKEN))
}

const COLORS: Record<ContextCategoryId, string> = {
  system: '#8b8b8b',
  tools: '#a78bfa',
  rules: '#4ade80',
  mcp: '#f472b6',
  summary: '#f87171',
  conversation: '#fb923c'
}

const TOOLS_JSON = JSON.stringify(AGENT_TOOL_SCHEMAS)

export interface EstimateContextUsageInput {
  messages: ChatMessage[]
  ctxLimit: number | null
  promptTokens?: number | null
  agentAutoApprove?: boolean
  agentThinkThrough?: boolean
  agentImageGenEnabled?: boolean
  planMode?: boolean
  systemPromptExtra?: string
  projectRules?: string
  mcpToolsJson?: string
}

/**
 * Category shares scaled to prompt_tokens when available.
 * Gauge `used` is ONLY server prompt_tokens — never local char estimate
 * (~4–5k from tools/rules alone looks like a fake spike).
 */
export function estimateContextUsage(input: EstimateContextUsageInput): ContextUsageEstimate {
  const limit = input.ctxLimit != null && input.ctxLimit > 0 ? input.ctxLimit : null

  const measured =
    input.promptTokens != null && Number.isFinite(input.promptTokens) && input.promptTokens > 0

  // No measurement yet — empty, not an inflated local guess
  if (!measured) {
    return { used: 0, limit, pct: 0, categories: [], measured: false }
  }

  const used = Math.round(input.promptTokens!)

  const systemCore = input.planMode
    ? SYSTEM_PLAN
    : input.agentAutoApprove
      ? SYSTEM_CORE
      : SYSTEM_CONFIRM_CORE
  const systemText =
    systemCore +
    (input.systemPromptExtra?.trim() ? `\n\n${input.systemPromptExtra.trim()}` : '')

  let rulesText = input.planMode ? '' : AGENT_RULES
  if (input.projectRules?.trim()) {
    rulesText += `\n\n${input.projectRules.trim()}`
  }
  if (!input.planMode && input.agentThinkThrough !== false) {
    rulesText += THINK_THROUGH
  }
  if (!input.planMode) {
    rulesText += input.agentImageGenEnabled ? IMAGE_GEN_RULES_ON : IMAGE_GEN_RULES_OFF
  }

  const toolsText = input.agentImageGenEnabled
    ? TOOLS_JSON
    : JSON.stringify(
        AGENT_TOOL_SCHEMAS.filter((t) => t.function?.name !== 'generate_image')
      )
  const mcpText = input.mcpToolsJson?.trim() ?? ''

  let summaryText = ''
  let conversationText = ''
  for (const m of input.messages) {
    if (!m || m.id === 'welcome') continue
    const chunk = `${m.content ?? ''}\n${m.codePreview ?? ''}`
    if (m.id === THREAD_SUMMARY_MSG_ID) {
      summaryText += chunk
      continue
    }
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
      conversationText += chunk
    }
  }

  const raw: Array<{ id: ContextCategoryId; tokens: number }> = [
    { id: 'system', tokens: estimateTokens(systemText) },
    { id: 'tools', tokens: estimateTokens(toolsText) },
    { id: 'rules', tokens: estimateTokens(rulesText) },
    { id: 'mcp', tokens: estimateTokens(mcpText) },
    { id: 'summary', tokens: estimateTokens(summaryText) },
    { id: 'conversation', tokens: estimateTokens(conversationText) }
  ]

  const estimatedSum = raw.reduce((a, c) => a + c.tokens, 0)
  const scale = estimatedSum > 0 ? used / estimatedSum : 1
  const categories: ContextCategory[] = raw
    .map((c) => ({
      id: c.id,
      labelKey: `context.cat.${c.id}` as ContextCategory['labelKey'],
      tokens: Math.max(0, Math.round(c.tokens * scale)),
      color: COLORS[c.id]
    }))
    .filter((c) => c.tokens > 0)

  // Fix rounding so category sum matches `used`
  const catSum = categories.reduce((a, c) => a + c.tokens, 0)
  if (categories.length > 0 && catSum !== used) {
    const last = categories[categories.length - 1]!
    last.tokens = Math.max(0, last.tokens + (used - catSum))
  }

  const pct =
    limit != null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

  return { used, limit, pct, categories, measured: true }
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
