import {
  applySearchReplaceBlocks,
  buildFastApplyMessages,
  parseSearchReplaceBlocks
} from '../../shared/fastApply'

export interface FastApplyEditParams {
  baseUrl: string
  instruction: string
  filePath: string
  content: string
  /** Abort after this many ms (default 60s). */
  timeoutMs?: number
  /** Attempts including first call (default 2 = one retry). Use 1 to fail fast. */
  maxAttempts?: number
}

export type FastApplyEditResult =
  | { ok: true; content: string; applied: number; via: 'apply_model' }
  | { ok: false; error: string; code: 'APPLY_UNAVAILABLE' | 'SMART_APPLY_FAIL' }

function extractAssistantText(message: {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
} | null | undefined): string {
  if (!message) return ''
  const content = String(message.content ?? '').trim()
  if (content) return content
  // Qwen3.5 often fills reasoning_content when thinking is on — salvage SEARCH blocks.
  const reasoning = String(
    message.reasoning_content ?? message.reasoning ?? ''
  ).trim()
  return reasoning
}

async function callApplyModel(
  base: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model: 'apply',
        messages,
        temperature: 0.0,
        stream: false,
        max_tokens: 8192,
        // Qwen3.5: without this, all tokens go to reasoning_content and content stays empty.
        chat_template_kwargs: { enable_thinking: false }
      })
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        error: `apply server HTTP ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`
      }
    }
    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: string
          reasoning?: string
        }
        finish_reason?: string
      }>
    }
    const choice = json.choices?.[0]
    const text = extractAssistantText(choice?.message)
    return { ok: true, text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: /abort/i.test(msg)
        ? `apply model timed out after ${timeoutMs}ms`
        : msg
    }
  } finally {
    clearTimeout(timer)
  }
}

function tryApplyBlocks(
  fileContent: string,
  rawText: string
): FastApplyEditResult | null {
  const blocks = parseSearchReplaceBlocks(rawText, { allowEmptySearch: false }).filter(
    (b) => b.search.trim().length > 0
  )
  if (blocks.length === 0) return null

  const applied = applySearchReplaceBlocks(fileContent, blocks)
  if (applied.applied === 0) {
    const reasons = applied.failed.map((f) => `#${f.index}: ${f.reason}`).join('; ')
    return {
      ok: false,
      code: 'SMART_APPLY_FAIL',
      error: `SMART_APPLY_FAIL: SEARCH blocks did not match file${reasons ? ` (${reasons})` : ''}. Summarize and stop — do not re-read or full-rewrite.`
    }
  }
  return {
    ok: true,
    content: applied.content,
    applied: applied.applied,
    via: 'apply_model'
  }
}

/**
 * Call coresident apply llama-server (Morph-style SEARCH/REPLACE) and merge into file text.
 * Does not touch the chat LLM queue. Retries once with a stricter prompt if markers missing.
 */
export async function fastApplyEdit(
  params: FastApplyEditParams
): Promise<FastApplyEditResult> {
  const base = params.baseUrl.replace(/\/$/, '').trim()
  if (!base) {
    return {
      ok: false,
      code: 'APPLY_UNAVAILABLE',
      error: 'APPLY_UNAVAILABLE: apply model baseUrl is empty'
    }
  }

  const timeoutMs = params.timeoutMs ?? 60_000
  const maxAttempts = Math.max(1, Math.min(2, params.maxAttempts ?? 2))
  const messages = buildFastApplyMessages({
    instruction: params.instruction,
    filePath: params.filePath,
    fileContent: params.content
  })

  const first = await callApplyModel(base, messages, timeoutMs)
  if (!first.ok) {
    return {
      ok: false,
      code: 'SMART_APPLY_FAIL',
      error: `SMART_APPLY_FAIL: ${first.error}`
    }
  }
  if (!first.text) {
    return {
      ok: false,
      code: 'SMART_APPLY_FAIL',
      error:
        'SMART_APPLY_FAIL: apply model returned empty content (thinking not disabled?). Reload Apply after update.'
    }
  }

  let hit = tryApplyBlocks(params.content, first.text)
  if (hit) return hit

  if (maxAttempts < 2) {
    return {
      ok: false,
      code: 'SMART_APPLY_FAIL',
      error:
        'SMART_APPLY_FAIL: apply model returned no SEARCH/REPLACE blocks. Do NOT rewrite the file; summarize and stop.'
    }
  }

  const retryMessages = [
    ...messages,
    {
      role: 'assistant' as const,
      content: first.text.slice(0, 4000)
    },
    {
      role: 'user' as const,
      content:
        'INVALID: no usable <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks. ' +
        'Reply again with ONLY those markers and exact snippets from the file. No prose. No thinking.'
    }
  ]
  const second = await callApplyModel(base, retryMessages, timeoutMs)
  if (!second.ok) {
    return {
      ok: false,
      code: 'SMART_APPLY_FAIL',
      error: `SMART_APPLY_FAIL: apply model returned no SEARCH/REPLACE blocks (retry: ${second.error})`
    }
  }
  hit = tryApplyBlocks(params.content, second.text)
  if (hit) return hit

  return {
    ok: false,
    code: 'SMART_APPLY_FAIL',
    error:
      'SMART_APPLY_FAIL: apply model returned no SEARCH/REPLACE blocks after retry. Do NOT rewrite the file; summarize and stop.'
  }
}
