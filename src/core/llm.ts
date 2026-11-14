// Minimal streaming client for llama-server's OpenAI-compatible /v1/chat/completions.
import type { ChatMessage, ToolCall, ToolSchema, Usage } from './types'

export interface Sampling {
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  presence_penalty?: number
  repeat_penalty?: number
}

export interface CompletionRequest {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  thinking?: boolean
  sampling?: Sampling
  signal?: AbortSignal
}

export interface StreamHandlers {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  /** Fired when the model starts a tool call (name known), before arguments finish streaming. */
  onToolStart?: (name: string) => void
}

export interface CompletionResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: Usage
}

export class LlmClient {
  ctxSize = 0
  modelName = ''

  constructor(public baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** Reads n_ctx and the model alias from llama-server /props. */
  async probe(signal?: AbortSignal): Promise<void> {
    const r = await fetch(`${this.baseUrl}/props`, { signal })
    if (!r.ok) throw new Error(`GET /props → HTTP ${r.status}`)
    const j = (await r.json()) as any
    this.ctxSize = Number(j?.default_generation_settings?.n_ctx ?? j?.n_ctx ?? 0)
    const path = String(j?.model_path ?? j?.model_alias ?? '')
    this.modelName = path.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? ''
  }

  async countTokens(text: string, signal?: AbortSignal): Promise<number> {
    try {
      const r = await fetch(`${this.baseUrl}/tokenize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }), signal,
      })
      const j = (await r.json()) as any
      return Array.isArray(j?.tokens) ? j.tokens.length : Math.ceil(text.length / 3.5)
    } catch {
      return Math.ceil(text.length / 3.5)
    }
  }

  async complete(req: CompletionRequest, h: StreamHandlers = {}): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      cache_prompt: true,
      max_tokens: req.maxTokens ?? 8192,
      chat_template_kwargs: { enable_thinking: req.thinking ?? true },
      ...(req.sampling ?? {}),
    }
    if (req.tools?.length) {
      body.tools = req.tools
      body.parallel_tool_calls = true
    }
    const r = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '')
      throw new Error(`llama-server HTTP ${r.status}: ${text.slice(0, 500)}`)
    }

    let content = ''
    let reasoning = ''
    let finishReason = ''
    const calls: { id: string; name: string; args: string }[] = []
    const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, ctxSize: this.ctxSize }

    const decoder = new TextDecoder()
    let buf = ''
    const handle = (data: string) => {
      if (data === '[DONE]') return
      let j: any
      try { j = JSON.parse(data) } catch { return }
      if (j.error) throw new Error(`llama-server: ${j.error.message ?? JSON.stringify(j.error)}`)
      const ch = j.choices?.[0]
      const d = ch?.delta
      if (d) {
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
          reasoning += d.reasoning_content
          h.onReasoning?.(d.reasoning_content)
        }
        if (typeof d.content === 'string' && d.content) {
          content += d.content
          h.onText?.(d.content)
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length
          if (!calls[i]) {
            calls[i] = { id: tc.id || `call_${Date.now().toString(36)}_${i}`, name: '', args: '' }
          }
          if (tc.id) calls[i].id = tc.id
          if (tc.function?.name) {
            const first = !calls[i].name
            calls[i].name += tc.function.name
            if (first) h.onToolStart?.(calls[i].name)
          }
          if (tc.function?.arguments) calls[i].args += tc.function.arguments
        }
      }
      if (ch?.finish_reason) finishReason = ch.finish_reason
      if (j.usage) {
        usage.promptTokens = j.usage.prompt_tokens ?? usage.promptTokens
        usage.completionTokens = j.usage.completion_tokens ?? usage.completionTokens
      }
      if (j.timings) {
        const t = j.timings
        usage.cachedTokens = t.cache_n ?? usage.cachedTokens
        usage.promptPerSecond = t.prompt_per_second
        usage.genPerSecond = t.predicted_per_second
        if (t.draft_n) usage.draftAcceptRate = (t.draft_n_accepted ?? 0) / t.draft_n
        if (!j.usage) {
          usage.promptTokens = (t.prompt_n ?? 0) + (t.cache_n ?? 0)
          usage.completionTokens = t.predicted_n ?? usage.completionTokens
        }
      }
    }

    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.startsWith('data:')) handle(line.slice(5).trim())
      }
    }
    if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim())

    // Some templates leave a <think> block in content when the server did not split it out.
    const m = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(content)
    if (m) {
      reasoning += m[1]
      content = content.slice(m[0].length)
    }

    return {
      content,
      reasoning,
      toolCalls: calls.filter(Boolean).filter((c) => c.name).map((c) => ({
        id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' },
      })),
      finishReason,
      usage,
    }
  }
}
