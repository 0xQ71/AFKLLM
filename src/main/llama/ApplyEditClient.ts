import {
  applyPromptCharBudget,
  applySearchReplaceBlocks,
  buildFastApplyMessages,
  parseSearchReplaceBlocks,
  type ApplyRegion
} from '../../shared/fastApply'
import { streamDeltaText } from '../../shared/llmDelta'
import type { SearchReplaceBlock } from '../../shared/types'

export interface FastApplyEditParams {
  baseUrl: string
  instruction: string
  filePath: string
  content: string
  /** Line range the edit targets — keeps the prompt small on big files. */
  region?: ApplyRegion
  /** Apply slot ctx, used to size the prompt window and max_tokens. */
  ctxSize?: number
  /** Abort after this many ms (default 60s). */
  timeoutMs?: number
  /** Attempts including first call (default 2 = one retry). Use 1 to fail fast. */
  maxAttempts?: number
  /** Live tokens for the UI — a silent 60s call looked like a freeze. */
  onToken?: (token: string) => void
}

export type FastApplyEditResult =
  | { ok: true; content: string; applied: number; via: 'apply_model' }
  | { ok: false; error: string; code: 'APPLY_UNAVAILABLE' | 'SMART_APPLY_FAIL' }

const APPLY_CHARS_PER_TOKEN = 3.2

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

/** Generation room left after the prompt, so REPLACE is never cut mid-marker. */
function applyMaxTokens(
  messages: Array<{ role: string; content: string }>,
  ctxSize?: number
): number {
  const ctx = Number.isFinite(ctxSize) && (ctxSize ?? 0) > 0 ? ctxSize! : 16_384
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0)
  const promptTokens = Math.ceil(promptChars / APPLY_CHARS_PER_TOKEN)
  return Math.max(1024, Math.min(8192, ctx - promptTokens - 512))
}

async function callApplyModel(
  base: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
  opts?: { ctxSize?: number; onToken?: (token: string) => void }
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
        stream: true,
        max_tokens: applyMaxTokens(messages, opts?.ctxSize),
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
    if (!response.body) {
      return { ok: false, error: 'apply server returned no body' }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string; reasoning?: string }
              message?: { content?: string }
            }>
          }
          const delta = json.choices?.[0]?.delta
          const piece = streamDeltaText(delta)
          if (piece) {
            text += piece
            opts?.onToken?.(piece)
          }
        } catch {
          /* partial JSON chunk — wait for more */
        }
      }
    }
    return { ok: true, text: text.trim() }
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

type BlockAttempt =
  | { kind: 'none' }
  | { kind: 'ok'; content: string; applied: number }
  | { kind: 'nomatch'; blocks: SearchReplaceBlock[]; reasons: string }

function tryApplyBlocks(fileContent: string, rawText: string): BlockAttempt {
  const blocks = parseSearchReplaceBlocks(rawText, { allowEmptySearch: false }).filter(
    (b) => b.search.trim().length > 0
  )
  if (blocks.length === 0) return { kind: 'none' }

  const applied = applySearchReplaceBlocks(fileContent, blocks)
  if (applied.applied === 0) {
    return {
      kind: 'nomatch',
      blocks,
      reasons: applied.failed.map((f) => `#${f.index}: ${f.reason}`).join('; ')
    }
  }
  return { kind: 'ok', content: applied.content, applied: applied.applied }
}

/** Actual file lines around the closest anchor of a failed SEARCH. */
function nearbyContext(fileContent: string, search: string): string {
  const lines = fileContent.replace(/\r\n/g, '\n').split('\n')
  const anchor = search
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 8)
  if (!anchor) return ''
  const needle = anchor.toLowerCase()
  let best = -1
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(needle)) {
      best = i
      break
    }
  }
  if (best === -1) return ''
  const from = Math.max(0, best - 10)
  const to = Math.min(lines.length, best + 11)
  return lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}| ${l.slice(0, 200)}`)
    .join('\n')
}

function noMatchRetryNote(fileContent: string, attempt: BlockAttempt): string {
  if (attempt.kind !== 'nomatch') return ''
  const first = attempt.blocks[0]
  const ctx = first ? nearbyContext(fileContent, first.search) : ''
  return (
    `RETRY: your SEARCH blocks did not match the file (${attempt.reasons}).\n` +
    (first
      ? `Your first SEARCH was:\n${first.search.slice(0, 600)}\n`
      : '') +
    (ctx
      ? `The file actually contains (line| text):\n${ctx}\n`
      : '') +
    'Copy SEARCH byte-for-byte from the content shown above, keep the original indentation, ' +
    'and keep it short (5-15 lines). Reply with ONLY SEARCH/REPLACE blocks.'
  )
}

/**
 * Call coresident apply llama-server (Morph-style SEARCH/REPLACE) and merge into file text.
 * Does not touch the chat LLM queue. Retries once with feedback on the real failure.
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
  const promptOpts = {
    instruction: params.instruction,
    filePath: params.filePath,
    fileContent: params.content,
    region: params.region,
    ctxSize: params.ctxSize
  }
  const messages = buildFastApplyMessages(promptOpts)
  const callOpts = { ctxSize: params.ctxSize, onToken: params.onToken }

  let first = await callApplyModel(base, messages, timeoutMs, callOpts)
  // Transport hiccups and timeouts used to fail instantly — one retry is cheap.
  if (!first.ok && maxAttempts >= 2) {
    first = await callApplyModel(base, messages, timeoutMs, callOpts)
  }
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

  const attempt = tryApplyBlocks(params.content, first.text)
  if (attempt.kind === 'ok') {
    return {
      ok: true,
      content: attempt.content,
      applied: attempt.applied,
      via: 'apply_model'
    }
  }

  const failNow = (detail: string): FastApplyEditResult => ({
    ok: false,
    code: 'SMART_APPLY_FAIL',
    error: `SMART_APPLY_FAIL: ${detail} Do NOT rewrite the file; try one apply_diff with a short exact search_block or summarize honestly.`
  })

  if (maxAttempts < 2) {
    return failNow(
      attempt.kind === 'none'
        ? 'apply model returned no SEARCH/REPLACE blocks.'
        : `SEARCH blocks did not match file (${attempt.reasons}).`
    )
  }

  // The common failure is "blocks parsed but nothing matched" — retry with the
  // real file lines instead of giving up after a single shot.
  const retryMessages =
    attempt.kind === 'nomatch'
      ? buildFastApplyMessages({
          ...promptOpts,
          retryNote: noMatchRetryNote(params.content, attempt)
        })
      : [
          ...messages,
          { role: 'assistant' as const, content: first.text.slice(0, 4000) },
          {
            role: 'user' as const,
            content:
              'INVALID: no usable <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks. ' +
              'Reply again with ONLY those markers and exact snippets from the file. No prose. No thinking.'
          }
        ]

  const second = await callApplyModel(base, retryMessages, timeoutMs, callOpts)
  if (!second.ok) {
    return failNow(`apply retry failed (${second.error}).`)
  }
  const retryAttempt = tryApplyBlocks(params.content, second.text)
  if (retryAttempt.kind === 'ok') {
    return {
      ok: true,
      content: retryAttempt.content,
      applied: retryAttempt.applied,
      via: 'apply_model'
    }
  }

  return failNow(
    retryAttempt.kind === 'none'
      ? 'apply model returned no SEARCH/REPLACE blocks after retry.'
      : `SEARCH blocks did not match file after retry (${retryAttempt.reasons}).`
  )
}
