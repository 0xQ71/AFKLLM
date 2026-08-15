import type * as Monaco from 'monaco-editor'
import type { QueueManager } from '../llm/queueManager'
import type { FimContext } from '../../../shared/types'
import { isAgentGenerationBusy, onAgentGenerationBusy } from '../agent/agentBusyGate'

export interface FimProviderOptions {
  queue: QueueManager
  /** Code ≈ 3.5 chars/token */
  charsPerToken?: number
  maxPrefixTokens?: number
  maxSuffixTokens?: number
  debounceMs?: number
  /** Default: `<PRE> … <SUF> … <MID>` */
  formatPrompt?: (ctx: FimContext) => string
  getFilePath?: () => string | undefined
  /** Re-trigger inline suggest as stream grows */
  getEditor?: () => Monaco.editor.IStandaloneCodeEditor | null
}

const DEFAULT_STOP = ['<EOT>', '<PRE>', '<SUF>', '<MID>', '```', '\n\n\n']
/** Eager ghost text once we have this much (or a full first line). */
const EAGER_MIN_CHARS = 16

interface CacheEntry {
  text: string
  uri: string
  line: number
  column: number
  generation: number
}

export function formatFimPrompt(ctx: FimContext): string {
  return `<PRE>${ctx.prefix}<SUF>${ctx.suffix}<MID>`
}

/**
 * Inline completions for all languages; streams partial ghost text early.
 */
export function registerMonacoFimProvider(
  monaco: typeof Monaco,
  options: FimProviderOptions
): Monaco.IDisposable {
  const charsPerToken = options.charsPerToken ?? 3.5
  const maxPrefixChars = Math.floor((options.maxPrefixTokens ?? 2000) * charsPerToken)
  const maxSuffixChars = Math.floor((options.maxSuffixTokens ?? 1000) * charsPerToken)
  const debounceMs = options.debounceMs ?? 250
  const formatPrompt = options.formatPrompt ?? formatFimPrompt

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let activeAbort: AbortController | null = null
  let cache: CacheEntry | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleRefresh = (): void => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      const ed = options.getEditor?.()
      ed?.trigger('afkllm-fim', 'editor.action.inlineSuggest.trigger', null)
    }, 40)
  }

  const provider: Monaco.languages.InlineCompletionsProvider = {
    freeInlineCompletions(): void {
      /* no-op — completions are ephemeral strings */
    },

    async provideInlineCompletions(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _context: Monaco.languages.InlineCompletionContext,
      token: Monaco.CancellationToken
    ): Promise<Monaco.languages.InlineCompletions | null> {
      // Never steal the LLM queue while an agent turn is running.
      if (isAgentGenerationBusy()) {
        activeAbort?.abort('agent_busy')
        return null
      }

      const uri = model.uri.toString()

      // Cached stream for same caret (eager / refresh)
      if (
        cache &&
        cache.uri === uri &&
        cache.line === position.lineNumber &&
        cache.column === position.column &&
        cache.generation === generation &&
        cache.text
      ) {
        return itemsFor(monaco, position, cache.text)
      }

      const gen = ++generation
      activeAbort?.abort('debounce')
      activeAbort = new AbortController()
      const abort = activeAbort
      cache = null

      if (debounceTimer) clearTimeout(debounceTimer)

      const settled = await new Promise<boolean>((resolve) => {
        debounceTimer = setTimeout(() => resolve(true), debounceMs)
        token.onCancellationRequested(() => {
          if (debounceTimer) clearTimeout(debounceTimer)
          abort.abort('cancelled')
          resolve(false)
        })
      })

      if (!settled || gen !== generation || token.isCancellationRequested || abort.signal.aborted) {
        return null
      }

      const offset = model.getOffsetAt(position)
      const full = model.getValue()
      const prefix = truncateStart(full.slice(0, offset), maxPrefixChars)
      const suffix = truncateEnd(full.slice(offset), maxSuffixChars)

      if (!prefix.trim() && !suffix.trim()) return null

      const ctx: FimContext = {
        prefix,
        suffix,
        languageId: model.getLanguageId(),
        filePath: options.getFilePath?.()
      }

      const prompt = formatPrompt(ctx)
      let accumulated = ''
      let resolvedEarly = false
      let earlyResolve: ((v: Monaco.languages.InlineCompletions | null) => void) | null = null

      const earlyPromise = new Promise<Monaco.languages.InlineCompletions | null>((resolve) => {
        earlyResolve = resolve
      })

      const tryEager = (): void => {
        if (resolvedEarly || gen !== generation) return
        const clean = sanitizeCompletion(accumulated)
        if (!clean) return
        const firstLineDone = clean.includes('\n')
        if (clean.length < EAGER_MIN_CHARS && !firstLineDone) return
        resolvedEarly = true
        cache = {
          text: clean,
          uri,
          line: position.lineNumber,
          column: position.column,
          generation: gen
        }
        earlyResolve?.(itemsFor(monaco, position, clean))
        earlyResolve = null
      }

      const streamDone = options.queue
        .fimStream({
          prompt,
          stop: DEFAULT_STOP,
          maxTokens: 96,
          temperature: 0.15,
          signal: abort.signal,
          onToken: (tok) => {
            if (gen !== generation || abort.signal.aborted) return
            accumulated += tok
            const clean = sanitizeCompletion(accumulated)
            if (!clean) return
            cache = {
              text: clean,
              uri,
              line: position.lineNumber,
              column: position.column,
              generation: gen
            }
            tryEager()
            if (resolvedEarly) scheduleRefresh()
          }
        })
        .then((result) => {
          if (
            gen !== generation ||
            token.isCancellationRequested ||
            abort.signal.aborted ||
            result.aborted ||
            result.error
          ) {
            if (!resolvedEarly) {
              earlyResolve?.(null)
              earlyResolve = null
            }
            return null
          }
          const finalText = sanitizeCompletion(result.text || accumulated)
          if (!finalText) {
            if (!resolvedEarly) {
              earlyResolve?.(null)
              earlyResolve = null
            }
            return null
          }
          cache = {
            text: finalText,
            uri,
            line: position.lineNumber,
            column: position.column,
            generation: gen
          }
          if (!resolvedEarly) {
            resolvedEarly = true
            earlyResolve?.(itemsFor(monaco, position, finalText))
            earlyResolve = null
          } else {
            scheduleRefresh()
          }
          return itemsFor(monaco, position, finalText)
        })
        .catch(() => {
          if (!resolvedEarly) {
            earlyResolve?.(null)
            earlyResolve = null
          }
          return null
        })

      // Eager first; else full stream
      const eager = await earlyPromise
      if (eager) return eager
      return streamDone
    }
  }

  const disposable = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, provider)
  const unsubBusy = onAgentGenerationBusy((next) => {
    if (!next) return
    generation++
    activeAbort?.abort('agent_busy')
    activeAbort = null
    cache = null
    options.queue.abortFim()
  })

  return {
    dispose(): void {
      unsubBusy()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (refreshTimer) clearTimeout(refreshTimer)
      activeAbort?.abort('disposed')
      cache = null
      disposable.dispose()
    }
  }
}

function itemsFor(
  monaco: typeof Monaco,
  position: Monaco.Position,
  insertText: string
): Monaco.languages.InlineCompletions {
  return {
    items: [
      {
        insertText,
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column
        )
      }
    ]
  }
}

function truncateStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const sliced = text.slice(text.length - maxChars)
  const nl = sliced.indexOf('\n')
  return nl === -1 ? sliced : sliced.slice(nl + 1)
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const sliced = text.slice(0, maxChars)
  const nl = sliced.lastIndexOf('\n')
  return nl === -1 ? sliced : sliced.slice(0, nl)
}

/** Drop FIM tags / chatter from completion. */
function sanitizeCompletion(raw: string): string {
  let text = raw
  for (const tag of ['<EOT>', '<PRE>', '<SUF>', '<MID>', '<|endoftext|>']) {
    const idx = text.indexOf(tag)
    if (idx !== -1) text = text.slice(0, idx)
  }
  if (!text.replace(/\s/g, '').length) return ''
  return text
}
