import { randomUUID } from 'node:crypto'
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMStreamChunk,
  QueuePriority
} from '../../shared/types'

interface QueuedJob {
  request: LLMCompletionRequest
  resolve: (result: LLMCompletionResult) => void
  reject: (err: Error) => void
  controller: AbortController
  enqueuedAt: number
  stream?: boolean
  onChunk?: (chunk: LLMStreamChunk) => void
}

const PRIORITY_RANK: Record<QueuePriority, number> = {
  HIGH: 0,
  NORMAL: 1,
  LOW: 2
}

/**
 * Priority queue for llama-server.
 * HIGH (FIM) preempts in-flight LOW/NORMAL; NORMAL = chat/agent; LOW = compact.
 */
export class LLMQueueManager {
  private queue: QueuedJob[] = []
  private active: QueuedJob | null = null
  private draining = false
  private baseUrl: string
  private defaultModel: string | null = null

  constructor(baseUrl: string, defaultModel?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.defaultModel = defaultModel ?? null
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '')
  }

  setDefaultModel(model: string | null): void {
    this.defaultModel = model
  }

  enqueue(
    partial: Omit<LLMCompletionRequest, 'id'> & {
      id?: string
      stream?: boolean
      onChunk?: (chunk: LLMStreamChunk) => void
    }
  ): Promise<LLMCompletionResult> {
    const request: LLMCompletionRequest = {
      id: partial.id ?? randomUUID(),
      priority: partial.priority,
      endpoint: partial.endpoint,
      body: partial.body,
      // 0 = unlimited (don't use ?? — 0 is valid)
      timeoutMs: partial.timeoutMs === undefined ? 30_000 : partial.timeoutMs
    }

    return new Promise<LLMCompletionResult>((resolve, reject) => {
      const controller = new AbortController()
      const job: QueuedJob = {
        request,
        resolve,
        reject,
        controller,
        enqueuedAt: Date.now(),
        stream: partial.stream,
        onChunk: partial.onChunk
      }

      if (
        request.priority === 'HIGH' &&
        this.active &&
        this.active.request.priority !== 'HIGH'
      ) {
        this.active.controller.abort('preempted_by_fim')
      }

      if (request.priority === 'HIGH') {
        this.queue = this.queue.filter((j) => {
          if (j.request.priority === 'HIGH') {
            j.resolve({
              id: j.request.id,
              text: '',
              aborted: true,
              error: 'superseded_by_newer_fim'
            })
            return false
          }
          return true
        })
      }

      this.queue.push(job)
      this.sortQueue()
      void this.drain()
    })
  }

  cancelAll(reason = 'cancelled'): void {
    if (this.active) {
      this.active.controller.abort(reason)
    }
    for (const job of this.queue) {
      job.resolve({
        id: job.request.id,
        text: '',
        aborted: true,
        error: reason
      })
    }
    this.queue = []
  }

  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const pr = PRIORITY_RANK[a.request.priority] - PRIORITY_RANK[b.request.priority]
      if (pr !== 0) return pr
      return a.enqueuedAt - b.enqueuedAt
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        this.active = job

        try {
          const result = await this.execute(job)
          job.resolve(result)
        } catch (err) {
          const aborted =
            job.controller.signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')

          if (aborted) {
            job.resolve({
              id: job.request.id,
              text: '',
              aborted: true,
              error: String(job.controller.signal.reason ?? 'aborted')
            })
          } else {
            job.resolve({
              id: job.request.id,
              text: '',
              error: err instanceof Error ? err.message : String(err)
            })
          }
        } finally {
          this.active = null
        }
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0) {
        void this.drain()
      }
    }
  }

  private async execute(job: QueuedJob): Promise<LLMCompletionResult> {
    const { request, controller, stream, onChunk } = job
    const timeoutMs = request.timeoutMs ?? 30_000
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => controller.abort('timeout'), timeoutMs)
        : null

    const isTransientNet = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err)
      return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|UND_ERR/i.test(
        msg
      )
    }

    try {
      const useStream = Boolean(stream && onChunk)
      const body = {
        ...request.body,
        stream: useStream,
        ...(this.defaultModel && !request.body.model
          ? { model: this.defaultModel }
          : {})
      }

      const maxAttempts = 3
      let lastErr: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (controller.signal.aborted) {
          throw new DOMException('aborted', 'AbortError')
        }
        try {
          const response = await fetch(`${this.baseUrl}${request.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
          })

          if (!response.ok) {
            const errBody = await response.text().catch(() => '')
            throw new Error(
              `llama-server ${response.status}: ${errBody.slice(0, 400)}`
            )
          }

          if (useStream && response.body) {
            return await this.consumeSse(
              request.id,
              response.body,
              controller.signal,
              onChunk!
            )
          }

          const data = (await response.json()) as {
            choices?: Array<{
              text?: string
              message?: {
                content?: string | null
                tool_calls?: LLMCompletionResult['toolCalls']
              }
              finish_reason?: string
            }>
            usage?: LLMCompletionResult['usage']
            timings?: LLMCompletionResult['timings']
          }

          const choice = data.choices?.[0]
          return {
            id: request.id,
            text: choice?.text ?? choice?.message?.content ?? '',
            usage: data.usage ?? usageFromTimings(data.timings),
            timings: data.timings,
            toolCalls: choice?.message?.tool_calls,
            finishReason: choice?.finish_reason
          }
        } catch (err) {
          lastErr = err
          if (
            attempt < maxAttempts &&
            !controller.signal.aborted &&
            isTransientNet(err)
          ) {
            console.warn(
              `[LLMQueue] transient fetch (attempt ${attempt}/${maxAttempts}):`,
              err instanceof Error ? err.message : err
            )
            await new Promise((r) => setTimeout(r, 400 * attempt))
            continue
          }
          throw err
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async consumeSse(
    id: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<LLMCompletionResult> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let finishReason: string | undefined
    let usage: LLMCompletionResult['usage']
    let timings: LLMCompletionResult['timings']
    const toolAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >()

    try {
      while (true) {
        if (signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue

          let json: {
            choices?: Array<{
              delta?: {
                content?: string | null
                tool_calls?: Array<{
                  index: number
                  id?: string
                  type?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string | null
            }>
            usage?: LLMCompletionResult['usage']
            timings?: LLMCompletionResult['timings']
          }
          try {
            json = JSON.parse(payload) as typeof json
          } catch {
            continue
          }

          if (json.usage) usage = json.usage
          if (json.timings) timings = json.timings

          const choice = json.choices?.[0]
          if (!choice) continue // timings-only trailer on some builds

          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta = choice.delta
          if (delta?.content) {
            text += delta.content
            onChunk({ id, token: delta.content })
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const prev = toolAcc.get(tc.index) ?? {
                id: '',
                name: '',
                arguments: ''
              }
              if (tc.id) prev.id = tc.id
              if (tc.function?.name) prev.name += tc.function.name
              if (tc.function?.arguments) prev.arguments += tc.function.arguments
              toolAcc.set(tc.index, prev)
              onChunk({
                id,
                toolCallDelta: {
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments
                }
              })
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }

    if (signal.aborted) {
      onChunk({ id, done: true })
      return {
        id,
        text: '',
        aborted: true,
        error: String(signal.reason ?? 'aborted'),
        finishReason: 'abort'
      }
    }

    const toolCalls =
      toolAcc.size > 0
        ? [...toolAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, t]) => ({
              id: t.id || randomUUID(),
              type: 'function' as const,
              function: { name: t.name, arguments: t.arguments }
            }))
        : undefined

    const resolvedUsage = usage ?? usageFromTimings(timings)
    onChunk({ id, done: true, usage: resolvedUsage, timings })

    return {
      id,
      text,
      usage: resolvedUsage,
      timings,
      toolCalls,
      finishReason: finishReason ?? (toolCalls?.length ? 'tool_calls' : 'stop')
    }
  }
}

function usageFromTimings(
  timings: LLMCompletionResult['timings'] | undefined
): LLMCompletionResult['usage'] | undefined {
  if (!timings) return undefined
  const prompt = timings.prompt_n
  const completion = timings.predicted_n
  if (prompt == null && completion == null) return undefined
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: (prompt ?? 0) + (completion ?? 0)
  }
}

let singleton: LLMQueueManager | null = null

export function getLLMQueue(baseUrl?: string, defaultModel?: string): LLMQueueManager {
  if (!singleton) {
    singleton = new LLMQueueManager(baseUrl ?? 'http://127.0.0.1:8080', defaultModel)
  } else {
    if (baseUrl) singleton.setBaseUrl(baseUrl)
    if (defaultModel !== undefined) singleton.setDefaultModel(defaultModel)
  }
  return singleton
}
