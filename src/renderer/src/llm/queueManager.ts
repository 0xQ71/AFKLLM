import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMStreamChunk,
  QueuePriority
} from '../../../shared/types'
import { samplingFromSettings, type AppSettings } from '../../../shared/settings'

export type EnqueueFn = (
  request: Omit<LLMCompletionRequest, 'id'> & { id?: string; stream?: boolean }
) => Promise<LLMCompletionResult>

export interface QueueClientOptions {
  enqueue: EnqueueFn
  onStream?: (cb: (chunk: LLMStreamChunk) => void) => () => void
  cancelAll?: () => Promise<void>
}

export class QueueManager {
  private readonly enqueueFn: EnqueueFn
  private readonly onStreamFn?: (cb: (chunk: LLMStreamChunk) => void) => () => void
  private readonly cancelAllFn?: () => Promise<void>
  private fimController: AbortController | null = null
  private sampling: Record<string, unknown> = {}
  private defaultMaxTokens = 4096

  constructor(options: QueueClientOptions) {
    this.enqueueFn = options.enqueue
    this.onStreamFn = options.onStream
    this.cancelAllFn = options.cancelAll
  }

  applySettings(settings: AppSettings): void {
    this.sampling = samplingFromSettings(settings)
    this.defaultMaxTokens = settings.limitResponseLength
      ? settings.maxTokens
      : Math.max(settings.maxTokens, 4096)
  }

  private mergeBody(extra: Record<string, unknown>): Record<string, unknown> {
    const body = { ...this.sampling, ...extra }
    if (extra.max_tokens == null && body.max_tokens == null) {
      body.max_tokens = this.defaultMaxTokens
    }
    return body
  }

  async fim(params: {
    prompt: string
    stop?: string[]
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): Promise<LLMCompletionResult> {
    return this.fimStream({ ...params })
  }

  async fimStream(params: {
    prompt: string
    stop?: string[]
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
    onToken?: (token: string) => void
  }): Promise<LLMCompletionResult> {
    this.fimController?.abort('superseded')
    this.fimController = new AbortController()

    if (params.signal) {
      if (params.signal.aborted) {
        return { id: '', text: '', aborted: true, error: 'aborted' }
      }
      params.signal.addEventListener(
        'abort',
        () => this.fimController?.abort(params.signal?.reason ?? 'aborted'),
        { once: true }
      )
    }

    const local = this.fimController
    const id = crypto.randomUUID()
    const unsub = this.onStreamFn?.((chunk) => {
      if (chunk.id !== id) return
      if (chunk.token) params.onToken?.(chunk.token)
    })

    try {
      const result = await this.enqueueFn({
        id,
        stream: true,
        priority: 'HIGH',
        endpoint: '/v1/chat/completions',
        timeoutMs: 0,
        body: this.mergeBody({
          messages: [
            {
              role: 'system',
              content:
                'You are a code completion engine. Continue the code at the cursor. ' +
                'Output ONLY the missing middle code — no markdown, no explanation.'
            },
            {
              role: 'user',
              content: params.prompt
            }
          ],
          max_tokens: params.maxTokens ?? 128,
          temperature: params.temperature ?? 0.2,
          stop: params.stop ?? ['<EOT>', '<PRE>', '<SUF>', '<MID>', '\n\n\n']
        })
      })

      if (local.signal.aborted) {
        return { ...result, aborted: true, text: '', error: 'aborted' }
      }
      return result
    } catch (err) {
      if (local.signal.aborted) {
        return { id: '', text: '', aborted: true, error: 'aborted' }
      }
      throw err
    } finally {
      unsub?.()
    }
  }

  chat(params: {
    messages: Array<{
      role: string
      content: string | null
      tool_call_id?: string
      tool_calls?: unknown
      name?: string
    }>
    tools?: unknown[]
    maxTokens?: number
    temperature?: number
    priority?: Extract<QueuePriority, 'NORMAL' | 'LOW'>
  }): Promise<LLMCompletionResult> {
    return this.enqueueFn({
      priority: params.priority ?? 'NORMAL',
      endpoint: '/v1/chat/completions',
      timeoutMs: 120_000,
      body: this.mergeBody({
        messages: params.messages,
        tools: params.tools,
        max_tokens: params.maxTokens ?? this.defaultMaxTokens,
        ...(params.temperature != null ? { temperature: params.temperature } : {})
      })
    })
  }

  async chatStream(params: {
    messages: Array<{
      role: string
      content: string | null
      tool_call_id?: string
      tool_calls?: unknown
      name?: string
    }>
    tools?: unknown[]
    maxTokens?: number
    temperature?: number
    priority?: Extract<QueuePriority, 'NORMAL' | 'LOW'>
    signal?: AbortSignal
    onToken?: (token: string) => void
    onToolDelta?: (delta: NonNullable<LLMStreamChunk['toolCallDelta']>) => void
  }): Promise<LLMCompletionResult> {
    if (params.signal?.aborted) {
      return {
        id: '',
        text: '',
        aborted: true,
        error: String(params.signal.reason ?? 'aborted')
      }
    }

    const id = crypto.randomUUID()
    const unsub = this.onStreamFn?.((chunk) => {
      if (chunk.id !== id) return
      if (params.signal?.aborted) return
      if (chunk.token) params.onToken?.(chunk.token)
      if (chunk.toolCallDelta) params.onToolDelta?.(chunk.toolCallDelta)
    })

    const onAbort = (): void => {
      void this.cancelAllFn?.()
    }
    params.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const maxTok = params.maxTokens ?? this.defaultMaxTokens
      const result = await this.enqueueFn({
        id,
        stream: true,
        priority: params.priority ?? 'NORMAL',
        endpoint: '/v1/chat/completions',
        timeoutMs: 0, // Stop / cancelAll still abort
        body: this.mergeBody({
          messages: params.messages,
          tools: params.tools,
          max_tokens: maxTok,
          ...(params.temperature != null ? { temperature: params.temperature } : {})
        })
      })
      if (params.signal?.aborted) {
        return {
          ...result,
          text: '',
          toolCalls: undefined,
          aborted: true,
          error: String(params.signal.reason ?? result.error ?? 'aborted')
        }
      }
      return result
    } finally {
      params.signal?.removeEventListener('abort', onAbort)
      unsub?.()
    }
  }

  compact(params: {
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<LLMCompletionResult> {
    return this.enqueueFn({
      priority: 'LOW',
      endpoint: '/v1/chat/completions',
      timeoutMs: 60_000,
      body: {
        messages: params.messages,
        max_tokens: params.maxTokens ?? 1024,
        temperature: 0.1
      }
    })
  }

  abortFim(): void {
    this.fimController?.abort('user_abort')
    this.fimController = null
  }

  async cancelAll(): Promise<void> {
    this.abortFim()
    await this.cancelAllFn?.()
  }
}

let client: QueueManager | null = null

export function getQueueManager(options?: QueueClientOptions): QueueManager {
  if (!client) {
    if (!options) {
      throw new Error('QueueManager not initialized — pass QueueClientOptions on first call')
    }
    client = new QueueManager(options)
  }
  return client
}

export function initQueueManager(options: QueueClientOptions): QueueManager {
  client = new QueueManager(options)
  return client
}
