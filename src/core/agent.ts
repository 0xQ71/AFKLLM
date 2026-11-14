// The agent loop: ask the model, run the tool calls it makes, feed results back, repeat until it stops.
// Deliberately simple. The model is trusted to drive; the host only enforces
// permissions, keeps the prompt prefix stable, compacts near the context limit, and in AUTO MODE
// nudges the model onward while its own todo list still has open items.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { LlmClient, type Sampling } from './llm'
import { PermissionPolicy } from './permissions'
import { CallRepeats, codeInThinking, repetitionLoop } from './guards'
import { MODE_NOTES, buildSystemPrompt } from './prompt'
import { BackgroundJobs } from './shell'
import {
  ALL_TOOLS, IMAGE_MIME, IMAGE_TOOLS, READ_ONLY_TOOLS, resolvePath, toolByName,
  type GenerateImageRequest, type GenerateImageResult, type PlannedCall, type Tool, type ToolContext,
} from './tools'
import {
  IMAGE_TOKENS_ESTIMATE, textOf,
  type AgentEvent, type ChatMessage, type ContentPart, type PermissionDecision, type PermissionMode, type PermissionRequest,
  type TodoItem, type ToolCall, type ToolOutcome, type Usage,
} from './types'

export interface AgentOptions {
  cwd: string
  llm: LlmClient
  mode?: PermissionMode
  /** Model thinking (reasoning). On by default: the agent thinks before every step. */
  thinking?: boolean
  sampling?: Sampling
  maxTurns?: number
  /** Fraction of n_ctx at which history is compacted. */
  compactAt?: number
  /** Fraction of n_ctx of the most recent messages kept verbatim on auto-compaction (default 0.25). */
  keepRecent?: number
  /** AUTO MODE: how many times the host may push the model onward when it stops with open todos. */
  maxAutoNudges?: number
  tools?: Tool[]
  subagent?: boolean
  emit?: (e: AgentEvent) => void
  /** Interactive approval. Without it, anything that needs approval is refused. */
  ask?: (req: PermissionRequest) => Promise<PermissionDecision>
  /** The model can see images (server started with an mmproj): Read shows pictures, `@shot.png` attaches one. */
  vision?: boolean
  /** Host-provided image generation; when set, the GenerateImage tool is offered. */
  generateImage?: (req: GenerateImageRequest, signal?: AbortSignal) => Promise<GenerateImageResult>
}

/** `@path/to/shot.png` or `@"C:\dir with spaces\shot.png"` in a user message → that image is attached. */
const IMAGE_REF = /@"([^"]+)"|@(\S+)/g

function attachImages(text: string, cwd: string): { parts: ContentPart[]; names: string[] } {
  const parts: ContentPart[] = []
  const names: string[] = []
  for (const m of text.matchAll(IMAGE_REF)) {
    const raw = (m[1] ?? m[2]).replace(/[.,;:!?)]+$/, '')
    const mime = IMAGE_MIME[extname(raw).toLowerCase()]
    if (!mime) continue
    const abs = resolvePath(raw, cwd)
    try {
      if (!existsSync(abs) || statSync(abs).size > 8 * 1024 * 1024) continue
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(abs).toString('base64')}` } })
      names.push(abs)
    } catch { /* unreadable: leave the reference as text */ }
  }
  return { parts, names }
}

/** Absolute paths that Read/Write/Edit calls in these messages pointed at, in first-seen order. */
function filesTouched(msgs: ChatMessage[], cwd: string, only?: string): string[] {
  const seen = new Set<string>()
  for (const m of msgs) {
    for (const c of m.tool_calls ?? []) {
      const name = c.function.name
      if (only ? name !== only : !['Read', 'Write', 'Edit'].includes(name)) continue
      try {
        const p = JSON.parse(c.function.arguments || '{}').file_path
        if (typeof p === 'string' && p) seen.add(resolvePath(p, cwd))
      } catch { /* malformed args: skip */ }
    }
  }
  return [...seen]
}

/** Token estimate for messages not yet counted by the server. */
function approxTokens(m: ChatMessage): number {
  const imgs = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0
  return Math.ceil(textOf(m.content).length / 3) + imgs * IMAGE_TOKENS_ESTIMATE
}

const MAX_TOOL_OUTPUT = 48_000

export interface AgentState {
  messages: ChatMessage[]
  todos: TodoItem[]
  mode: PermissionMode
}

export class Agent {
  messages: ChatMessage[] = []
  todos: TodoItem[] = []
  policy: PermissionPolicy
  lastUsage: Usage | null = null
  totalCompletionTokens = 0
  private readState = new Map<string, number>()
  private readSeen = new Map<string, string>()
  private repeats = new CallRepeats()
  private bg: BackgroundJobs
  private tools: Tool[]
  private announcedMode: PermissionMode | null = null
  private running = false

  constructor(private o: AgentOptions) {
    this.policy = new PermissionPolicy(o.mode ?? 'default', o.cwd)
    this.tools = o.tools ?? (o.generateImage ? [...ALL_TOOLS, ...IMAGE_TOOLS] : ALL_TOOLS)
    this.bg = new BackgroundJobs(join(o.cwd, '.afkllm', 'bg'))
    this.messages = [{ role: 'system', content: buildSystemPrompt(o.cwd, { subagent: o.subagent }) }]
    this.announcedMode = o.subagent ? this.policy.mode : null
  }

  get mode(): PermissionMode { return this.policy.mode }
  set mode(m: PermissionMode) {
    this.policy.mode = m
    this.emit({ type: 'mode', mode: m })
  }
  get busy(): boolean { return this.running }
  get thinking(): boolean { return this.o.thinking !== false }

  private emit(e: AgentEvent) { this.o.emit?.(e) }

  snapshot(): AgentState {
    return { messages: this.messages, todos: this.todos, mode: this.mode }
  }

  restore(s: AgentState) {
    // Keep the freshly built system prompt (cwd/date may differ), restore the rest.
    this.messages = [this.messages[0], ...s.messages.filter((m) => m.role !== 'system')]
    this.todos.splice(0, this.todos.length, ...(s.todos ?? []))
    this.policy.mode = s.mode ?? this.policy.mode
    this.announcedMode = null
  }

  clear() {
    this.messages = [this.messages[0]]
    this.todos.splice(0)
    this.readState.clear()
    this.readSeen.clear()
    this.lastUsage = null
    this.announcedMode = null
  }

  dispose() { this.bg.stopAll() }

  /** Run one user request to completion (or interruption). */
  async run(userText: string, signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error('agent is busy')
    this.running = true
    try {
      await this.loop(userText, signal)
    } finally {
      this.running = false
    }
  }

  private toolContext(signal?: AbortSignal): ToolContext {
    return {
      cwd: this.o.cwd,
      signal,
      readState: this.readState,
      readSeen: this.readSeen,
      todos: this.todos,
      bg: this.bg,
      onTodos: (t) => this.emit({ type: 'todos', todos: [...t] }),
      runSubagent: this.o.subagent ? undefined : (d, p, s) => this.runSubagent(d, p, s),
      vision: !!this.o.vision,
      generateImage: this.o.subagent ? undefined : this.o.generateImage,
    }
  }

  private async loop(userText: string, signal?: AbortSignal) {
    let text = userText
    if (this.announcedMode !== this.mode) {
      // Mode notes ride on the user message instead of editing the system prompt (keeps the KV prefix).
      text = `<system-reminder>${MODE_NOTES[this.mode]}</system-reminder>\n${text}`
      this.announcedMode = this.mode
    }
    const att = this.o.vision ? attachImages(userText, this.o.cwd) : { parts: [], names: [] }
    if (att.parts.length) {
      this.emit({ type: 'notice', message: `attached ${att.names.length} image(s): ${att.names.join(', ')}` })
      this.messages.push({ role: 'user', content: [{ type: 'text', text }, ...att.parts] })
    } else {
      this.messages.push({ role: 'user', content: text })
    }

    const maxTurns = this.o.maxTurns ?? (this.mode === 'auto' ? 400 : 120)
    let nudges = 0
    let emptyRetries = 0
    let loopStops = 0
    let thinkingNudges = 0
    this.repeats.reset()
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal?.aborted) return this.emit({ type: 'done', reason: 'aborted' })
      await this.maybeCompact(signal)
      this.emit({ type: 'turn_start', turn })

      let res
      // loop guard: watch the stream and cut it when the model starts repeating itself
      const turnAc = new AbortController()
      const onOuterAbort = () => turnAc.abort()
      signal?.addEventListener('abort', onOuterAbort)
      let looped: string | null = null
      let textBuf = ''
      let thinkBuf = ''
      let checkedAt = 0
      const watch = () => {
        const total = textBuf.length + thinkBuf.length
        if (total - checkedAt < 1500) return
        checkedAt = total
        looped = repetitionLoop(thinkBuf) ?? repetitionLoop(textBuf)
        if (looped) turnAc.abort()
      }
      let streamed = false
      try {
        res = await this.o.llm.complete({
          messages: this.messages,
          tools: this.tools.map((t) => t.schema),
          thinking: this.thinking,
          sampling: this.o.sampling,
          maxTokens: 32768,
          signal: turnAc.signal,
        }, {
          onText: (d) => { streamed = true; textBuf += d; this.emit({ type: 'text', delta: d }); watch() },
          onReasoning: (d) => { thinkBuf += d; this.emit({ type: 'reasoning', delta: d }); watch() },
        })
        if (streamed) this.emit({ type: 'text_end' })
      } catch (e) {
        if (streamed) this.emit({ type: 'text_end' })
        if (signal?.aborted) return this.emit({ type: 'done', reason: 'aborted' })
        if (looped) {
          if (++loopStops > 3) return this.emit({ type: 'done', reason: 'error', message: `the model keeps looping (${looped})` })
          this.emit({ type: 'notice', message: `loop guard: stopped a repeating reply (${looped})` })
          this.messages.push({
            role: 'user',
            content: '<system-reminder>Your last reply started repeating itself and was stopped. Do not repeat it. ' +
              'Re-read the task and your todo list, choose the next concrete step, and do it now with a tool call.</system-reminder>',
          })
          continue
        }
        return this.emit({ type: 'done', reason: 'error', message: (e as Error).message })
      } finally {
        signal?.removeEventListener('abort', onOuterAbort)
      }

      this.lastUsage = res.usage
      this.totalCompletionTokens += res.usage.completionTokens
      this.emit({ type: 'usage', usage: res.usage })

      let calls = res.toolCalls
      let content = res.content
      if (!calls.length) {
        const recovered = recoverTextToolCalls(content)
        if (recovered.calls.length) {
          calls = recovered.calls
          content = recovered.rest
        }
      }

      this.messages.push({
        role: 'assistant',
        content: content || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        // Interleaved thinking: the chat template keeps reasoning for the current request's steps and drops it
        // for older turns, so the prefix stays cache-friendly.
        ...(res.reasoning.trim() ? { reasoning_content: res.reasoning } : {}),
      })

      if (calls.length) {
        const aborted = await this.runCalls(calls, signal)
        if (aborted) return this.emit({ type: 'done', reason: 'aborted' })
        continue
      }

      // the model drafted whole files in its thinking and then stopped without writing them
      if (this.mode !== 'plan' && codeInThinking(res.reasoning) && thinkingNudges < 2) {
        thinkingNudges++
        this.emit({ type: 'notice', message: 'loop guard: code was written in thinking, not in files — asking for tool calls' })
        this.messages.push({
          role: 'user',
          content: '<system-reminder>You wrote code inside your thinking but did not save it. Thinking is not saved anywhere. ' +
            'Put the code into files with Write/Edit now (one file per call), then continue.</system-reminder>',
        })
        continue
      }

      if (res.finishReason === 'length') {
        this.messages.push({ role: 'user', content: '<system-reminder>Your output hit the token limit. Continue exactly where you stopped.</system-reminder>' })
        continue
      }
      if (!content.trim()) {
        if (emptyRetries++ < 2) {
          this.messages.push({ role: 'user', content: '<system-reminder>Your last reply was empty. Continue the task: call a tool or give your final answer.</system-reminder>' })
          continue
        }
        return this.emit({ type: 'done', reason: 'error', message: 'model returned empty replies' })
      }

      const open = this.todos.filter((t) => t.status !== 'completed')
      if (this.mode === 'auto' && !this.o.subagent && open.length && nudges < (this.o.maxAutoNudges ?? 12)) {
        nudges++
        this.emit({ type: 'notice', message: `auto mode: ${open.length} todo item(s) still open — continuing` })
        this.messages.push({
          role: 'user',
          content: '<system-reminder>Auto mode: your todo list still has open items:\n' +
            open.map((t) => `- [${t.status}] ${t.content}`).join('\n') +
            '\nKeep working through them now. If an item is already done, verify it and mark it completed; if it is truly ' +
            'blocked, mark it completed with a note in your final answer and explain why.</system-reminder>',
        })
        continue
      }
      return this.emit({ type: 'done', reason: 'end' })
    }
    this.emit({ type: 'done', reason: 'max_turns', message: `stopped after ${maxTurns} model turns` })
  }

  /** Returns true when interrupted. Every tool_call always gets a tool message (keeps the transcript valid). */
  private async runCalls(calls: ToolCall[], signal?: AbortSignal): Promise<boolean> {
    const ctx = this.toolContext(signal)
    let interrupted = false
    const images: NonNullable<ToolOutcome['images']> = []
    for (const call of calls) {
      if (interrupted || signal?.aborted) {
        interrupted = true
        this.pushToolResult(call, { ok: false, output: 'Interrupted by the user before this ran.', summary: 'interrupted' })
        continue
      }
      const t0 = Date.now()
      const tool = toolByName(call.function.name, this.tools)
      const args = parseArgs(call.function.arguments)
      let outcome: ToolOutcome
      if (!tool) {
        outcome = fail(`Unknown tool "${call.function.name}". Available: ${this.tools.map((t) => t.name).join(', ')}.`)
        this.emit({ type: 'tool_call', id: call.id, name: call.function.name, args: {}, label: call.function.name })
      } else if (args === null) {
        outcome = fail(`Arguments for ${tool.name} were not valid JSON. Send a JSON object matching the schema.`)
        this.emit({ type: 'tool_call', id: call.id, name: tool.name, args: {}, label: tool.name })
      } else {
        call.function.name = tool.name
        this.emit({ type: 'tool_call', id: call.id, name: tool.name, args, label: safeLabel(tool, args, this.o.cwd) })
        try {
          outcome = await this.planAndRun(tool, args, ctx)
        } catch (e) {
          outcome = fail(`${tool.name} failed: ${(e as Error).message}`)
        }
      }
      if (signal?.aborted && !outcome.ok) interrupted = true
      if (outcome.images?.length) images.push(...outcome.images)
      this.pushToolResult(call, outcome)
      this.emit({ type: 'tool_result', id: call.id, name: call.function.name, outcome, ms: Date.now() - t0 })
    }
    // Chat templates only take images in user turns, and every tool_call needs its tool message first:
    // so pictures from this round go in one user message right after all the tool results.
    if (images.length && !interrupted) {
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `<system-reminder>Image(s) from your tool calls, in order: ${images.map((i) => i.path).join(', ')}</system-reminder>` },
          ...images.map((i): ContentPart => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        ],
      })
    }
    return interrupted
  }

  private async planAndRun(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const planned = await tool.plan(args, ctx)
    if (!('execute' in planned)) return planned
    const p = planned as PlannedCall
    if (p.request) {
      const verdict = this.policy.decide(tool.kind, p.request)
      if (verdict.action === 'deny') return fail(verdict.message, 'refused (plan mode)')
      if (verdict.action === 'ask') {
        const req: PermissionRequest = { tool: tool.name, kind: tool.kind, ...p.request, reason: verdict.reason }
        if (!this.o.ask) {
          return fail(`Not allowed without user approval${verdict.reason ? ` (${verdict.reason})` : ''}. Find another way or explain what you need.`, 'refused: needs approval')
        }
        const d = await this.o.ask(req)
        if (!d.allow) {
          return fail(
            'The user rejected this action.' + (d.feedback ? ` Their instructions: ${d.feedback}` : ' Ask what to do differently or take another approach.'),
            d.feedback ? `rejected: ${d.feedback}` : 'rejected by user',
          )
        }
        if (d.remember && !verdict.reason) this.policy.remembered.add(p.request.ruleKey)
      }
    }
    return p.execute()
  }

  private pushToolResult(call: ToolCall, o: ToolOutcome) {
    let out = o.output
    const seen = this.repeats.record(call.function.name, call.function.arguments, out)
    if (seen >= 3) {
      this.emit({ type: 'notice', message: `loop guard: ${call.function.name} repeated ${seen}x with the same result` })
      out += `\n\n<system-reminder>You made this exact call ${seen} times and got the same result each time. Repeating ` +
        'it will not change anything: use what you already have, or try a different approach.</system-reminder>'
    }
    if (out.length > MAX_TOOL_OUTPUT) {
      out = out.slice(0, MAX_TOOL_OUTPUT) + `\n… [output truncated: ${out.length - MAX_TOOL_OUTPUT} more chars; narrow the request, e.g. Read with offset/limit]`
    }
    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: (o.ok ? '' : 'Error: ') + out })
  }

  // ------------------------------------------------------------ compaction

  private async maybeCompact(signal?: AbortSignal, force = false) {
    const ctx = this.o.llm.ctxSize
    let used = this.lastUsage ? this.lastUsage.promptTokens + this.lastUsage.completionTokens : 0
    // Tool results appended since the last reply are not in lastUsage yet: estimate them (~3 chars/token).
    let k = this.messages.length - 1
    while (k > 0 && this.messages[k].role !== 'assistant') used += approxTokens(this.messages[k--])
    if (!force && (!ctx || used < ctx * (this.o.compactAt ?? 0.8))) return
    await this.compact(signal)
  }

  /**
   * Compaction with little loss: the most recent work (up to `keepRecent` of the window) stays
   * verbatim — current task, latest tool results, the model's reasoning — and only the older part is summarized.
   * The summary also gets the exact list of files touched, so nothing is lost to the summarizer's memory.
   * `full` (or `/compact` with a focus) summarizes everything.
   */
  async compact(signal?: AbortSignal, focus = '', full = false): Promise<void> {
    if (this.messages.length < 4) return
    const before = this.lastUsage ? this.lastUsage.promptTokens + this.lastUsage.completionTokens : 0
    this.emit({ type: 'notice', message: 'compacting conversation…' })

    let split = this.messages.length
    if (!full && !focus) {
      const keepBudget = Math.floor((this.o.llm.ctxSize || 65536) * (this.o.keepRecent ?? 0.25))
      let tail = 0
      for (let i = this.messages.length - 1; i > 1; i--) {
        tail += approxTokens(this.messages[i])
        if (tail > keepBudget) break
        // a kept part may start at a user or assistant message, never in the middle of tool results
        if (this.messages[i].role === 'user' || this.messages[i].role === 'assistant') split = i
      }
      if (split >= this.messages.length - 1) split = this.messages.length // nothing worth keeping: summarize all
    }
    const head = this.messages.slice(0, split)
    const keep = this.messages.slice(split)
    if (head.length < 3) return

    const request: ChatMessage = {
      role: 'user',
      content:
        (keep.length
          ? 'Summarize the session UP TO THIS POINT (the most recent messages after it are kept verbatim, do not repeat ' +
            'them). '
          : 'Summarize this whole session so that work can continue from the summary alone. ') +
        'Include: the user\'s goal and explicit requests (quote them), decisions made and why, every file created or ' +
        'changed and what changed, commands that were run and their results, errors still open, what was tried and ' +
        'failed, and the exact next steps. Be complete but compact. Plain text.' +
        (focus ? `\nFocus especially on: ${focus}` : ''),
    }
    let summary = ''
    try {
      // images are not re-encoded for the summary (slow on CPU, and the summary is text anyway)
      const textOnly = head.map((m): ChatMessage => (Array.isArray(m.content) ? { ...m, content: textOf(m.content) } : m))
      const res = await this.o.llm.complete({ messages: [...textOnly, request], maxTokens: 12000, thinking: this.thinking, sampling: this.o.sampling, signal })
      summary = res.content.trim()
    } catch (e) {
      this.emit({ type: 'notice', message: `compaction failed: ${(e as Error).message}` })
      return
    }
    if (!summary) {
      this.emit({ type: 'notice', message: 'compaction failed: empty summary; keeping the conversation as is' })
      return
    }
    const touched = filesTouched(head, this.o.cwd)
    const files = touched.length ? '\n\nFiles touched before this point (exact paths):\n' + touched.map((f) => `- ${f}`).join('\n') : ''
    const todos = this.todos.length
      ? '\n\nCurrent todo list:\n' + this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')
      : ''
    const readInKept = new Set(filesTouched(keep, this.o.cwd, 'Read'))
    this.messages = [
      this.messages[0],
      {
        role: 'user',
        content: `<system-reminder>This session was compacted to save context. Summary of the earlier part:\n\n${summary}${files}${todos}\n\n` +
          (keep.length ? 'The most recent messages follow verbatim. ' : '') +
          'Files read only in the summarized part are no longer in context: Read them again before editing. Continue the task.</system-reminder>',
      },
      ...keep,
    ]
    for (const p of [...this.readState.keys()]) if (!readInKept.has(p)) this.readState.delete(p)
    for (const p of [...this.readSeen.keys()]) if (!readInKept.has(p)) this.readSeen.delete(p)
    this.announcedMode = null
    const after = await this.o.llm.countTokens(this.messages.map((m) => textOf(m.content)).join('\n'), signal)
    this.lastUsage = this.lastUsage ? { ...this.lastUsage, promptTokens: after, completionTokens: 0 } : null
    this.emit({ type: 'compact', beforeTokens: before, afterTokens: after })
  }

  // ------------------------------------------------------------ sub-agents

  private async runSubagent(description: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const sub = new Agent({
      cwd: this.o.cwd, llm: this.o.llm, mode: 'default', tools: READ_ONLY_TOOLS, subagent: true, vision: this.o.vision,
      thinking: this.thinking, sampling: this.o.sampling, maxTurns: 40,
      emit: (e) => {
        if (e.type === 'tool_call') this.emit({ type: 'notice', message: `  ${description}: ${e.label}` })
      },
    })
    let final = ''
    const origEmit = sub.o.emit
    sub.o.emit = (e) => {
      origEmit?.(e)
      if (e.type === 'done' && e.reason !== 'end') final = `(sub-agent stopped: ${e.reason}${e.message ? ` — ${e.message}` : ''})`
    }
    await sub.run(prompt, signal)
    const last = [...sub.messages].reverse().find((m) => m.role === 'assistant' && m.content)
    return textOf(last?.content ?? '').trim() || final || '(sub-agent returned nothing)'
  }
}

// ---------------------------------------------------------------- helpers

function fail(output: string, summary = output.split('\n')[0].slice(0, 120)): ToolOutcome {
  return { ok: false, output, summary }
}

function safeLabel(tool: Tool, args: any, cwd: string): string {
  try { return tool.label(args, cwd) } catch { return tool.name }
}

export function parseArgs(raw: string): Record<string, unknown> | null {
  const s = (raw ?? '').trim() || '{}'
  const attempts = [s, s.replace(/^```(?:json)?\s*|\s*```$/g, ''), s.replace(/,\s*([}\]])/g, '$1')]
  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
      if (typeof v === 'string') { const w = JSON.parse(v); if (w && typeof w === 'object') return w }
    } catch { /* next */ }
  }
  return null
}

/** Some templates leak tool calls as text: <tool_call>{"name":..,"arguments":..}</tool_call>. */
export function recoverTextToolCalls(content: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = []
  const rest = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, body: string) => {
    const j = parseArgs(body)
    if (j && typeof j.name === 'string') {
      const args = typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments ?? j.parameters ?? {})
      calls.push({ id: `call_txt_${calls.length}_${Date.now().toString(36)}`, type: 'function', function: { name: j.name, arguments: args } })
      return ''
    }
    return _m
  })
  return { calls, rest: rest.trim() }
}
