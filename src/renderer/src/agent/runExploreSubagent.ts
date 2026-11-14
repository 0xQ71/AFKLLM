import { AGENT_TOOL_SCHEMAS } from '../../../shared/types'
import { filterExploreToolSchemas } from '../../../shared/applyPatch'
import type { QueueManager } from '../llm/queueManager'
import {
  normalizeApiMessages,
  packReadFileForAgent,
  type ApiMessage
} from './agentPure'

const MAX_EXPLORE_ROUNDS = 6
const REPORT_MAX_CHARS = 8_000
const TOOL_RESULT_CHARS = 6_000

export interface ExploreSubagentResult {
  ok: boolean
  content: string
  error?: string
  fileCount?: number
  toolsUsed?: number
}

export interface ExploreProgressStats {
  fileCount: number
  toolsUsed: number
}

/**
 * Nested read-only research turn. No explore_subagent recursion; no writes.
 */
export async function runExploreSubagent(params: {
  queue: QueueManager
  goal: string
  focusPaths?: string[]
  signal?: AbortSignal
  onProgress?: (label: string, stats?: ExploreProgressStats) => void
}): Promise<ExploreSubagentResult> {
  const goal = params.goal.trim()
  if (!goal) {
    return { ok: false, content: '', error: 'goal is required' }
  }

  const tools = filterExploreToolSchemas(AGENT_TOOL_SCHEMAS)
  const focus =
    params.focusPaths && params.focusPaths.length > 0
      ? `\nPrioritize these paths: ${params.focusPaths.join(', ')}`
      : ''

  const apiMessages: ApiMessage[] = normalizeApiMessages([
    {
      role: 'system',
      content:
        'You are an explore subagent inside AFKLLM. Gather facts only with read-only tools ' +
        '(read_file, list_directory, search_codebase, web_search). Do NOT edit files or run shell. ' +
        'When done, reply with a concise bullet report (paths, findings, open questions). No fluff.'
    },
    {
      role: 'user',
      content: `Research goal:\n${goal}${focus}\n\nUse tools as needed, then end with a short bullet report.`
    }
  ])

  let lastText = ''
  let toolsUsed = 0
  const seenFiles = new Set<string>()

  const stats = (): ExploreProgressStats => ({
    fileCount: seenFiles.size,
    toolsUsed
  })

  for (let round = 0; round < MAX_EXPLORE_ROUNDS; round++) {
    if (params.signal?.aborted) {
      return {
        ok: false,
        content: lastText,
        error: 'Interrupted by Stop',
        fileCount: seenFiles.size,
        toolsUsed
      }
    }

    params.onProgress?.(
      `explore round ${round + 1}/${MAX_EXPLORE_ROUNDS}`,
      stats()
    )

    const result = await params.queue.chatStream({
      messages: normalizeApiMessages(apiMessages),
      tools: [...tools],
      maxTokens: 2048,
      priority: 'NORMAL',
      onToken: () => {
        /* parent bubble already shows explore label */
      }
    })

    if (result.aborted || params.signal?.aborted) {
      return {
        ok: false,
        content: lastText || result.text || '',
        error: 'Interrupted by Stop',
        fileCount: seenFiles.size,
        toolsUsed
      }
    }
    if (result.error) {
      return {
        ok: false,
        content: lastText,
        error: result.error,
        fileCount: seenFiles.size,
        toolsUsed
      }
    }

    if (result.text?.trim()) lastText = result.text.trim()

    const toolCalls = result.toolCalls
    if (!toolCalls?.length) {
      const report = (lastText || '(no report)').slice(0, REPORT_MAX_CHARS)
      return {
        ok: true,
        content: `Explore report (${toolsUsed} tool call(s), ${seenFiles.size} file(s)):\n\n${report}`,
        fileCount: seenFiles.size,
        toolsUsed
      }
    }

    apiMessages.push({
      role: 'assistant',
      content: result.text?.trim() ? result.text : null,
      tool_calls: toolCalls
    })

    for (const call of toolCalls) {
      if (params.signal?.aborted) {
        return {
          ok: false,
          content: lastText,
          error: 'Interrupted by Stop',
          fileCount: seenFiles.size,
          toolsUsed
        }
      }
      const name = call.function.name
      if (name === 'explore_subagent') {
        apiMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'ERROR: nested explore_subagent is not allowed'
        })
        continue
      }
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        args = {}
      }
      const pathHint =
        typeof args.relative_path === 'string'
          ? args.relative_path
          : typeof args.dir_path === 'string'
            ? args.dir_path
            : undefined
      if (pathHint) seenFiles.add(pathHint.replace(/\\/g, '/'))
      if (name === 'search_codebase' && typeof args.query === 'string') {
        // count as exploring the codebase even without a path
        seenFiles.add(`search:${args.query.slice(0, 40)}`)
      }

      params.onProgress?.(`explore · ${name}`, stats())
      const toolResult = await window.api.agent.invoke({
        id: call.id,
        name,
        arguments: args
      })
      toolsUsed++
      if (name === 'search_codebase' && toolResult.ok) {
        for (const line of toolResult.content.split(/\r?\n/)) {
          const m = line.match(/^([^:]+):\d+:/)
          if (m?.[1]) seenFiles.add(m[1].replace(/\\/g, '/'))
        }
      }
      // A raw head slice let the subagent mistake char 6000 for EOF.
      const content = !toolResult.ok
        ? `ERROR: ${toolResult.error ?? 'failed'}\n${toolResult.content}`.slice(
            0,
            TOOL_RESULT_CHARS
          )
        : name === 'read_file' &&
            !/^\[read_file (?:meta|range)\]/i.test(toolResult.content.trim())
          ? packReadFileForAgent(toolResult.content, {
              maxChars: TOOL_RESULT_CHARS,
              relativePath:
                typeof args.relative_path === 'string' ? args.relative_path : ''
            })
          : toolResult.content.slice(0, TOOL_RESULT_CHARS)
      apiMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content
      })
      params.onProgress?.(`explore · ${name}`, stats())
    }
  }

  return {
    ok: true,
    content: (
      lastText ||
      `Explore paused after ${MAX_EXPLORE_ROUNDS} rounds (${toolsUsed} tools). Partial notes above.`
    ).slice(0, REPORT_MAX_CHARS),
    fileCount: seenFiles.size,
    toolsUsed
  }
}
