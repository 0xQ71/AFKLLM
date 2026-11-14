// Interactive CLI: scrollback transcript + a live bottom area (spinner, prompt box, dialogs).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '../core/agent'
import type { LlmClient } from '../core/llm'
import { listSessions, loadSession, newSessionId, saveSession } from '../core/session'
import { CONFIG_DIR } from '../core/server'
import { textOf } from '../core/types'
import { applyTheme, OSC, type CliTheme } from './ansi'
import {
  PERMISSION_MODES, type AgentEvent, type DiffLine, type PermissionDecision, type PermissionMode,
  type PermissionRequest, type TodoItem, type ToolOutcome,
} from '../core/types'
import { c, cols, strWidth, stripAnsi, wordWrap } from './ansi'
import { MarkdownLines, inline } from './markdown'
import { KeyParser, LineEditor, Screen, setupTerminal, type Key } from './tui'

export interface AppOptions {
  cwd: string
  llm: LlmClient
  modelLabel: string
  mode: PermissionMode
  sampling: Record<string, number>
  /** model sees images (mmproj loaded) */
  vision?: boolean
  generateImage?: import('../core/agent').AgentOptions['generateImage']
  /** 'black' (black background, white text, turquoise accents) or 'default' (terminal's own colors) */
  theme?: CliTheme
  resume?: string | true
  initialPrompt?: string
  /** the model is still loading in the background: resolves when it is ready (rejects on failure) */
  ready?: Promise<void>
  onExit: () => void
}

// Windows Terminal / VS Code / modern terminals have these glyphs; the classic Windows console's fonts
// (Consolas, Lucida) do not and draw empty boxes, so fall back to safe characters there.
const RICH = !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.platform !== 'win32')
const G = RICH
  ? { star: '✻', fwd: '⏵⏵', pause: '⏸', spin: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
      elbow: '⎿', thought: '∴', box: '☐', boxDone: '☒', pick: '❯', warn: '⚠' }
  : { star: '*', fwd: '»', pause: '‖', spin: ['·', '+', '*', '×', '*', '+'],
      elbow: '└', thought: '·', box: '[ ]', boxDone: '[x]', pick: '>', warn: '!' }
const SPIN = G.spin
const VERBS = ['Thinking', 'Working', 'Pondering', 'Crafting', 'Reasoning', 'Cooking', 'Computing', 'Brewing']

type Phase = 'idle' | 'running' | 'permission' | 'feedback'

interface Dialog {
  req: PermissionRequest
  choice: number
  options: string[]
  resolve: (d: PermissionDecision) => void
  feedback: LineEditor
}

const HELP = `
${c.bold('Commands')}
  /help              this help
  /mode [name]       permission mode: default · acceptEdits · plan · auto
  /auto              toggle AUTO MODE (agent works without asking; risky actions still ask)
  /plan              toggle plan mode (read-only investigation + plan)
  /todos             show the agent's todo list
  /compact [focus]   summarize the conversation to free context
  /clear             start a fresh conversation
  /clear-history     forget the ↑ input history (kept only while this window is open)
  /resume [id]       resume a saved session (/sessions lists them)
  /status            model, context, session
  /theme [name]      black (default: black + turquoise) · default (your terminal's colors)
  /exit              quit

${c.bold('Keys')}
  shift+tab          cycle modes        esc        interrupt the agent
  \\ + enter / alt+enter  new line      ctrl+o     show the model's thinking
  ctrl+t             show todos         ctrl+c     interrupt · twice to exit
  ctrl+v             paste text or a screenshot from the clipboard (images are attached for the model)
  ↑ ↓                history            enter while working queues the message
`

export class App {
  private screen = new Screen()
  private keys = new KeyParser()
  private editor: LineEditor
  private agent: Agent
  private phase: Phase = 'idle'
  private abort: AbortController | null = null
  private dialog: Dialog | null = null
  private queue: string[] = []
  private md = new MarkdownLines()
  private partial = ''
  private textOpen = false
  private reasoningLine = ''
  private showThinking = false
  private spinI = 0
  private verb = VERBS[0]
  private runStart = 0
  private turnTokens = 0
  private toolLabel = ''
  private timer: NodeJS.Timeout | null = null
  private ctrlCAt = 0
  private sessionId = newSessionId()
  private sessionCreated = new Date().toISOString()
  private restoreTerm: (() => void) | null = null
  private lastTps = 0
  private shownDiffs = new Set<string>()
  /** tool calls whose header line was already printed (by the permission prompt) */
  private announced = new Set<string>()
  private thinkStart = 0
  private modelState: 'loading' | 'ready' | 'error' = 'ready'
  private modelMsg = ''
  private theme: CliTheme = 'black'
  private pendingCalls = new Map<string, string>()

  constructor(private o: AppOptions) {
    // ↑/↓ history lives only as long as this window: nothing typed is kept on disk (the chats themselves are the
    // record, in <project>/.afkllm/sessions). /clear-history forgets it without closing.
    this.editor = new LineEditor()
    forgetLegacyHistory()
    this.agent = new Agent({
      cwd: o.cwd, llm: o.llm, mode: o.mode, sampling: o.sampling, vision: o.vision, generateImage: o.generateImage,
      emit: (e) => this.onEvent(e),
      ask: (req) => this.askPermission(req),
    })
  }

  async start() {
    this.theme = this.o.theme ?? 'black'
    applyTheme(this.theme)
    process.on('exit', () => { if (this.theme === 'black') process.stdout.write(OSC.reset) })
    if (this.o.ready) {
      this.modelState = 'loading'
      this.modelMsg = 'loading model…'
      this.o.ready.then(() => {
        this.modelState = 'ready'
        this.modelMsg = ''
        this.print(c.dim(`  ${G.elbow}  model ready: ${this.o.modelLabel} · ${Math.round(this.o.llm.ctxSize / 1024)}K context`))
        this.redraw()
      }, (e: Error) => {
        this.modelState = 'error'
        this.modelMsg = e.message
        this.print(c.red(`  ${G.elbow}  model failed to load: ${e.message}`))
        this.redraw()
      })
    }
    this.restoreTerm = setupTerminal((d) => this.onData(d))
    process.stdout.on('resize', () => this.redraw())
    this.banner()
    if (this.o.resume) this.resume(this.o.resume === true ? undefined : this.o.resume)
    this.redraw()
    if (this.o.initialPrompt) this.submit(this.o.initialPrompt)
  }

  // ------------------------------------------------------------ rendering

  private banner() {
    const w = Math.min(cols() - 2, 76)
    const row = (raw = '') => {
      const s = strWidth(raw) > w - 4 ? '…' + stripAnsi(raw).slice(-(w - 5)) : raw
      return c.brand('│') + ' ' + s + ' '.repeat(Math.max(0, w - 3 - strWidth(s))) + c.brand('│')
    }
    const ctx = this.o.llm.ctxSize ? `${Math.round(this.o.llm.ctxSize / 1024)}K ctx` : ''
    this.screen.print([
      c.brand('╭' + '─'.repeat(w - 2) + '╮'),
      row(`${c.brand(G.star)} ${c.bold('Welcome to AFKLLM')} ${c.dim('— local coding agent')}`),
      row(),
      row(c.dim('/help for help · shift+tab cycles modes · /auto for AUTO MODE')),
      row(),
      row(c.dim('cwd: ') + this.o.cwd),
      row(c.dim('model: ') + `${this.o.modelLabel}${ctx ? c.dim(` · ${ctx}`) : ''}`),
      c.brand('╰' + '─'.repeat(w - 2) + '╯'),
      '',
    ].join('\n'))
  }

  private modeBadge(): string {
    switch (this.agent.mode) {
      case 'auto': return c.yellow(`${G.fwd} auto mode on`) + c.dim(' (shift+tab to cycle)')
      case 'acceptEdits': return c.purple(`${G.fwd} accept edits on`) + c.dim(' (shift+tab to cycle)')
      case 'plan': return c.teal(`${G.pause} plan mode on`) + c.dim(' (shift+tab to cycle)')
      default: return c.dim('? /help for shortcuts')
    }
  }

  private footer(): string {
    const u = this.agent.lastUsage
    const parts: string[] = []
    if (u && this.o.llm.ctxSize) {
      const pct = Math.round(((u.promptTokens + u.completionTokens) / this.o.llm.ctxSize) * 100)
      parts.push(pct >= 70 ? c.yellow(`ctx ${pct}%`) : `ctx ${pct}%`)
    }
    if (this.modelState === 'loading') parts.push(c.yellow(this.modelMsg || 'loading model…'))
    if (this.modelState === 'error') parts.push(c.red('model failed'))
    if (this.lastTps) parts.push(`${this.lastTps.toFixed(0)} t/s`)
    if (this.queue.length) parts.push(c.blue(`${this.queue.length} queued`))
    const right = c.dim(parts.join(' · '))
    const left = '  ' + this.modeBadge()
    const gap = Math.max(1, cols() - 2 - strWidth(left) - strWidth(right))
    return left + ' '.repeat(gap) + right
  }

  private redraw() {
    const w = cols() - 1
    const rule = c.dim('─'.repeat(w))
    if (this.phase === 'permission' || this.phase === 'feedback') return this.drawDialog()
    const rows: string[] = []
    if (this.phase === 'running') {
      const secs = Math.round((Date.now() - this.runStart) / 1000)
      const what = this.toolLabel ? `${this.toolLabel}` : `${this.verb}…`
      const stats = [`${secs}s`, this.turnTokens ? `↓ ${fmtTokens(this.turnTokens)} tokens` : '', 'esc to interrupt'].filter(Boolean).join(' · ')
      rows.push(c.brand(SPIN[this.spinI % SPIN.length]) + ' ' + c.brand(what) + ' ' + c.dim(`(${stats})`))
      if (this.reasoningLine && !this.showThinking) {
        // live preview of the model's thinking: the last few lines, word-wrapped to the window
        const wrapped = wordWrap(this.reasoningLine.trim(), w - 4)
        for (const l of wrapped.slice(-3)) rows.push(c.dim(c.italic('  ' + l)))
      }
      rows.push('')
    }
    // prompt box: rounded border, "> " prompt inside
    const inner = w - 4
    const ed = this.editor.render(inner, this.phase === 'idle' ? 'Try "find and fix a bug in …" — /help for commands' : 'queue a message…')
    const border = this.phase === 'running' ? c.gray : (s: string) => c.gray(s)
    const top = rows.length + 1
    rows.push(border('╭' + '─'.repeat(w - 2) + '╮'))
    for (const r of ed.rows) rows.push(border('│') + ' ' + r + ' '.repeat(Math.max(0, inner - strWidth(r))) + ' ' + border('│'))
    rows.push(border('╰' + '─'.repeat(w - 2) + '╯'), this.footer())
    void rule
    this.screen.setLive(rows, { row: top + ed.cursor.row, col: ed.cursor.col + 2 })
  }

  private drawDialog() {
    const d = this.dialog!
    const w = cols() - 1
    const color = d.req.kind === 'exec' ? c.orange : c.purple
    const rows: string[] = [color('╭' + '─'.repeat(w - 2))]
    const add = (s: string) => rows.push(color('│ ') + s)
    add(c.bold(d.req.kind === 'exec' ? 'Run command' : d.req.title))
    if (d.req.kind === 'exec') {
      for (const l of d.req.detail.split('\n').slice(0, 6)) add('  ' + c.bold(l))
      if (d.req.title && d.req.title !== 'Run command') add('  ' + c.dim(d.req.title))
    }
    if (d.req.reason) add(c.yellow(`${G.warn} needs your approval: ${d.req.reason}`))
    add('')
    add(d.req.kind === 'exec' ? 'Do you want to proceed?' : `Do you want to make this edit to ${c.bold(d.req.diff?.path ?? d.req.detail)}?`)
    d.options.forEach((opt, i) => {
      const sel = i === d.choice
      add((sel ? c.blue(`${G.pick} `) : '  ') + (sel ? c.blue(`${i + 1}. ${opt}`) : `${i + 1}. ${opt}`))
    })
    let cursor: { row: number; col: number } | null = null
    if (this.phase === 'feedback') {
      const ed = d.feedback.render(w - 4, 'tell the agent what to do instead, enter to send')
      ed.rows.forEach((r, i) => {
        if (i === ed.cursor.row) cursor = { row: rows.length, col: ed.cursor.col + 2 }
        add(r)
      })
    }
    rows.push(color('╰' + '─'.repeat(w - 2)))
    this.screen.setLive(rows, cursor)
  }

  private print(s: string) { this.screen.print(s) }

  private printWrapped(text: string, first: string, rest: string) {
    const w = cols() - 1 - strWidth(rest)
    const lines: string[] = []
    text.split('\n').forEach((line, i) => {
      wordWrap(line, w, '').forEach((piece, k) => lines.push((i === 0 && k === 0 ? first : rest) + piece))
    })
    this.print(lines.join('\n'))
  }

  // ------------------------------------------------------------ agent events

  private onEvent(e: AgentEvent) {
    switch (e.type) {
      case 'turn_start':
        this.thinkStart = 0
        this.turnTokens = 0
        this.toolLabel = ''
        this.verb = VERBS[Math.floor(Math.random() * VERBS.length)]
        this.md.reset()
        break
      case 'reasoning':
        if (!this.thinkStart) this.thinkStart = Date.now()
        this.turnTokens++
        if (this.showThinking) {
          this.reasoningLine += e.delta
          let nl
          while ((nl = this.reasoningLine.indexOf('\n')) >= 0) {
            const line = this.reasoningLine.slice(0, nl)
            this.reasoningLine = this.reasoningLine.slice(nl + 1)
            if (line.trim()) this.printWrapped(c.dim(c.italic(line)), c.dim(`  ${G.thought} `), '    ')
          }
        } else {
          this.reasoningLine = (this.reasoningLine + e.delta).replace(/\s+/g, ' ').slice(-900)
        }
        break
      case 'text': {
        this.flushThought()
        this.turnTokens++
        this.reasoningLine = ''
        this.partial += e.delta
        let nl
        while ((nl = this.partial.indexOf('\n')) >= 0) {
          this.emitTextLine(this.partial.slice(0, nl))
          this.partial = this.partial.slice(nl + 1)
        }
        break
      }
      case 'text_end':
        if (this.partial) this.emitTextLine(this.partial)
        this.partial = ''
        if (this.textOpen) this.print('')
        this.textOpen = false
        break
      case 'tool_call':
        this.flushThought()
        this.reasoningLine = ''
        this.toolLabel = e.label
        this.pendingCalls.set(e.id, e.label)
        break
      case 'tool_result':
        this.printToolResult(e.id, e.name, e.outcome)
        this.toolLabel = ''
        break
      case 'todos':
        this.printTodos(e.todos)
        break
      case 'usage':
        if (e.usage.genPerSecond) this.lastTps = e.usage.genPerSecond
        this.save()
        break
      case 'notice':
        this.print(c.dim(`  ${G.elbow}  ${e.message}`))
        break
      case 'compact':
        this.print(c.dim(`${G.star} Conversation compacted (${fmtTokens(e.beforeTokens)} → ${fmtTokens(e.afterTokens)} tokens)`) + '\n')
        break
      case 'mode':
        break
      case 'done':
        this.flushThought()
        if (this.partial) { this.emitTextLine(this.partial); this.partial = '' }
        this.textOpen = false
        if (e.reason === 'aborted') this.print(c.red(`  ${G.elbow}  Interrupted`) + c.dim(' · what should the agent do instead?') + '\n')
        else if (e.reason === 'error') this.print(c.red(`  ${G.elbow}  Error: ${e.message}`) + '\n')
        else if (e.reason === 'max_turns') this.print(c.yellow(`  ${G.elbow}  ${e.message}`) + '\n')
        break
    }
    if (this.phase === 'running') this.redraw()
  }

  /** "∴ Thought for 12s" once the model is done thinking (when thinking is hidden). */
  private flushThought() {
    if (!this.thinkStart) return
    const secs = Math.max(1, Math.round((Date.now() - this.thinkStart) / 1000))
    this.thinkStart = 0
    if (!this.showThinking) this.print(c.dim(`${G.thought} Thought for ${secs}s`) + c.dim(' (ctrl+o to show thinking)'))
  }

  /**
   * Progress from outside the agent loop (the GPU swap for image generation): new steps go to the scrollback,
   * a ticking step ("sampling · step 7/25") only updates the spinner line.
   */
  /** load progress of the model while it starts in the background */
  modelProgress(msg: string) {
    if (this.modelState !== 'loading') return
    this.modelMsg = msg
    this.redraw()
  }

  activity(msg: string) {
    const ticking = /·\s*(step \d+\/\d+|\d+s)$/.test(msg)
    if (!ticking) this.print(c.dim(`  ${G.elbow}  ${msg}`))
    if (this.phase === 'running') {
      this.toolLabel = `Generating image · ${msg.replace(/^image .*?· prompt: .*/, 'starting')}`
      this.redraw()
    }
  }

  private emitTextLine(line: string) {
    const rendered = this.md.render(line)
    if (!this.textOpen) {
      if (!line.trim()) return // skip leading blank lines
      this.textOpen = true
      this.printWrapped(rendered, '● ', '  ')
    } else {
      this.printWrapped(rendered, '  ', '  ')
    }
  }

  private printToolResult(id: string, name: string, o: ToolOutcome) {
    const label = this.pendingCalls.get(id) ?? name
    this.pendingCalls.delete(id)
    if (name === 'TodoWrite' && o.ok) return // the todo list itself was printed
    const dot = o.ok ? c.green('●') : c.red('●')
    const [tool, ...rest] = label.split('(')
    const head = rest.length ? `${c.bold(tool)}(${rest.join('(')}` : c.bold(label)
    // the permission prompt already printed this call's header: add only the result under it
    const lines = this.announced.delete(id) ? [] : [`${dot} ${head}`]
    lines.push(`  ${c.dim(G.elbow)}  ${o.ok ? c.dim(o.summary) : c.red(o.summary)}`)
    if (o.diff && !this.shownDiffs.has(id)) lines.push(...renderDiff(o.diff.lines, 30))
    if (name === 'Shell' && !o.ok) {
      const tail = o.output.trimEnd().split('\n').slice(-8)
      lines.push(...tail.map((l) => c.dim('     ' + l.slice(0, cols() - 8))))
    }
    this.print(lines.join('\n') + '\n')
  }

  private printTodos(todos: TodoItem[]) {
    if (!todos.length) return this.print(c.dim(`  ${G.elbow}  todo list cleared`) + '\n')
    const lines = [`${c.green('●')} ${c.bold('Update Todos')}`]
    todos.forEach((t, i) => {
      const pre = i === 0 ? `  ${c.dim(G.elbow)}  ` : '     '
      if (t.status === 'completed') lines.push(pre + c.dim(c.strike(`${G.boxDone} ${t.content}`)))
      else if (t.status === 'in_progress') lines.push(pre + c.bold(`${G.box} ${t.content}`))
      else lines.push(pre + `${G.box} ${t.content}`)
    })
    this.print(lines.join('\n') + '\n')
  }

  // ------------------------------------------------------------ permissions

  private askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    // show what is about to happen in the scrollback first (diffs can be long)
    const lines: string[] = []
    const label = [...this.pendingCalls.entries()].pop()
    if (label) {
      lines.push(`${c.yellow('●')} ${c.bold(label[1])}`)
      this.announced.add(label[0])
    }
    if (req.diff) {
      lines.push(...renderDiff(req.diff.lines, 60))
      if (label) this.shownDiffs.add(label[0])
    }
    if (lines.length) this.print(lines.join('\n'))
    const allowAll = req.kind === 'exec'
      ? `Yes, and don't ask again for ${c.bold(req.ruleKey.replace(/^shell:/, ''))} commands this session`
      : 'Yes, allow all edits during this session'
    const options = req.reason ? ['Yes', 'No, and tell the agent what to do differently (esc)']
      : ['Yes', allowAll, 'No, and tell the agent what to do differently (esc)']
    return new Promise((resolve) => {
      this.dialog = { req, choice: 0, options, resolve, feedback: new LineEditor() }
      this.phase = 'permission'
      this.redraw()
    })
  }

  private finishDialog(d: PermissionDecision) {
    const dlg = this.dialog!
    this.dialog = null
    this.phase = 'running'
    if (!d.allow) this.print(c.red(`  ${G.elbow}  `) + c.dim(d.feedback ? `Rejected: ${d.feedback}` : 'Rejected') + '\n')
    dlg.resolve(d)
    this.redraw()
  }

  private onDialogKey(k: Key) {
    const d = this.dialog!
    if (this.phase === 'feedback') {
      if (k.name === 'escape') { this.phase = 'permission'; return this.redraw() }
      const r = d.feedback.handle(k)
      if (r === 'submit') return this.finishDialog({ allow: false, feedback: d.feedback.value.trim() || undefined })
      return this.redraw()
    }
    const last = d.options.length - 1
    const pick = (i: number) => {
      if (i === last) { this.phase = 'feedback'; return this.redraw() }
      if (i === 0) return this.finishDialog({ allow: true })
      return this.finishDialog({ allow: true, remember: true })
    }
    if (k.name === 'up') d.choice = (d.choice + last) % (last + 1)
    else if (k.name === 'down' || k.name === 'tab') d.choice = (d.choice + 1) % (last + 1)
    else if (k.name === 'enter') return pick(d.choice)
    else if (k.name === 'char' && /^[1-9]$/.test(k.text!) && Number(k.text) <= d.options.length) return pick(Number(k.text) - 1)
    else if (k.name === 'char' && /^[yY]$/.test(k.text!)) return pick(0)
    else if (k.name === 'char' && /^[nN]$/.test(k.text!)) return pick(last)
    else if (k.name === 'escape' || k.name === 'ctrl-c') {
      // reject and stop the run: the user wants to say something
      this.finishDialog({ allow: false })
      this.abort?.abort()
      return
    } else if (k.name === 'shift-tab' && d.req.kind === 'edit' && !d.req.reason) {
      this.agent.mode = 'acceptEdits'
      return this.finishDialog({ allow: true })
    }
    this.redraw()
  }

  // ------------------------------------------------------------ input

  private onData(data: string) {
    for (const k of this.keys.parse(data)) this.onKey(k)
  }

  private onKey(k: Key) {
    if (this.phase === 'permission' || this.phase === 'feedback') return this.onDialogKey(k)

    if (k.name === 'ctrl-c') {
      if (this.phase === 'running') { this.abort?.abort(); return }
      if (this.editor.value) { this.editor.set(''); return this.redraw() }
      if (Date.now() - this.ctrlCAt < 1500) return this.exit()
      this.ctrlCAt = Date.now()
      this.print(c.dim('  Press Ctrl-C again to exit'))
      return this.redraw()
    }
    if (k.name === 'ctrl-d' && !this.editor.value && this.phase === 'idle') return this.exit()
    if (k.name === 'escape') {
      if (this.phase === 'running') { this.abort?.abort(); return }
      if (this.editor.value) { this.editor.set(''); return this.redraw() }
      return
    }
    if (k.name === 'shift-tab') {
      const i = PERMISSION_MODES.indexOf(this.agent.mode)
      this.agent.mode = PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
      return this.redraw()
    }
    if (k.name === 'ctrl-o') {
      this.showThinking = !this.showThinking
      this.print(c.dim(`  thinking display ${this.showThinking ? 'on' : 'off'}`))
      return this.redraw()
    }
    if (k.name === 'ctrl-t') { this.printTodos(this.agent.todos); return this.redraw() }
    if (k.name === 'ctrl-v') {
      // the classic Windows console does not paste on Ctrl+V in raw mode: read the clipboard ourselves.
      // An image (e.g. a Win+Shift+S screenshot) is saved to a temp .png and attached as @path.
      const clip = readClipboard()
      if (clip?.image) {
        this.editor.handle({ name: 'paste', text: (this.editor.value && !this.editor.value.endsWith(' ') ? ' ' : '') + `@"${clip.image}" ` })
        this.print(c.dim(`  ${G.elbow}  image pasted from the clipboard (${clip.image})`))
      } else if (clip?.text) {
        this.editor.handle({ name: 'paste', text: clip.text.replace(/\r\n/g, '\n') })
      }
      return this.redraw()
    }

    const r = this.editor.handle(k)
    if (r === 'submit') {
      const text = this.editor.commit()
      if (this.phase === 'running') {
        if (text.trim()) this.queue.push(text)
        return this.redraw()
      }
      return this.submit(text)
    }
    if (r) this.redraw()
  }

  private submit(raw: string) {
    const text = raw.trim()
    if (!text) return this.redraw()
    this.print(c.dim('> ') + text.split('\n').join('\n  ') + '\n')
    if (text.startsWith('/')) return this.command(text)
    void this.runAgent(text)
  }

  private async runAgent(text: string) {
    this.phase = 'running'
    this.abort = new AbortController()
    this.runStart = Date.now()
    this.turnTokens = 0
    this.reasoningLine = ''
    this.timer = setInterval(() => { this.spinI++; if (this.phase === 'running') this.redraw() }, 120)
    this.redraw()
    try {
      if (this.o.ready && this.modelState !== 'ready') {
        this.toolLabel = 'Loading the model…'
        this.redraw()
        await this.o.ready // rejects → caught below
        this.toolLabel = ''
      }
      await this.agent.run(text, this.abort.signal)
    } catch (e) {
      this.print(c.red(`  ${G.elbow}  ${(e as Error).message}`))
    } finally {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.abort = null
      this.phase = 'idle'
      this.toolLabel = ''
      this.reasoningLine = ''
      this.save()
      const secs = Math.round((Date.now() - this.runStart) / 1000)
      if (secs >= 20) this.print(c.dim(`${G.star} Worked for ${fmtDuration(secs)}`) + '\n')
      this.redraw()
      const next = this.queue.shift()
      if (next) this.submit(next)
    }
  }

  // ------------------------------------------------------------ slash commands

  private command(line: string) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (cmd.toLowerCase()) {
      case 'theme': {
        if (!arg) { // just show it: a bare /theme used to flip and save the theme by surprise
          this.print(c.dim(`  ${G.elbow}  theme: ${this.theme} · change with /theme black or /theme default`) + '\n')
          break
        }
        const t = arg as CliTheme
        if (t !== 'black' && t !== 'default') { this.print(c.red(`  ${G.elbow}  /theme black | default`) + '\n'); break }
        this.theme = t
        applyTheme(t)
        saveCliTheme(t)
        this.banner()
        this.print(c.dim(`  ${G.elbow}  theme: ${t} (saved to ~/.afkllm/cli.json)`) + '\n')
        break
      }
      case 'help': case '?':
        this.print(HELP)
        break
      case 'exit': case 'quit': case 'q':
        return this.exit()
      case 'clear-history': case 'clearhistory':
        this.editor.clearHistory()
        this.print(c.dim(`  ${G.elbow}  Input history cleared (↑ starts empty). It is never written to disk.`) + '\n')
        break
      case 'clear': case 'new':
        this.agent.clear()
        this.sessionId = newSessionId()
        this.sessionCreated = new Date().toISOString()
        this.print(c.dim(`  ${G.elbow}  Started a new conversation`) + '\n')
        break
      case 'mode': {
        const m = PERMISSION_MODES.find((x) => x.toLowerCase() === arg.toLowerCase())
        if (m) this.agent.mode = m
        this.print(c.dim(`  ${G.elbow}  mode: ${this.agent.mode}${m || !arg ? '' : ` (unknown "${arg}"; use ${PERMISSION_MODES.join(', ')})`}`) + '\n')
        break
      }
      case 'auto':
        this.agent.mode = this.agent.mode === 'auto' ? 'default' : 'auto'
        this.print(c.dim(`  ${G.elbow}  AUTO MODE ${this.agent.mode === 'auto' ? 'on: the agent works without asking (risky commands and writes outside the project still ask)' : 'off'}`) + '\n')
        break
      case 'plan':
        this.agent.mode = this.agent.mode === 'plan' ? 'default' : 'plan'
        this.print(c.dim(`  ${G.elbow}  plan mode ${this.agent.mode === 'plan' ? 'on' : 'off'}`) + '\n')
        break
      case 'todos':
        this.printTodos(this.agent.todos)
        break
      case 'status': {
        const u = this.agent.lastUsage
        this.print([
          `  model     ${this.o.modelLabel}  ${c.dim(this.o.llm.baseUrl)}`,
          `  context   ${u ? fmtTokens(u.promptTokens + u.completionTokens) : '0'} / ${fmtTokens(this.o.llm.ctxSize)} tokens`,
          `  speed     ${u?.genPerSecond ? `${u.genPerSecond.toFixed(1)} t/s gen` : '—'}${u?.promptPerSecond ? ` · ${u.promptPerSecond.toFixed(0)} t/s prefill` : ''}${u?.draftAcceptRate ? ` · MTP accept ${(u.draftAcceptRate * 100).toFixed(0)}%` : ''}`,
          `  mode      ${this.agent.mode} · thinking always on`,
          `  session   ${this.sessionId} ${c.dim(join(this.o.cwd, '.afkllm', 'sessions'))}`,
          '',
        ].join('\n'))
        break
      }
      case 'compact':
        this.phase = 'running'
        this.runStart = Date.now()
        this.toolLabel = 'Compacting conversation…'
        this.abort = new AbortController()
        this.redraw()
        void this.agent.compact(this.abort.signal, arg).finally(() => {
          this.phase = 'idle'
          this.toolLabel = ''
          this.abort = null
          this.save()
          this.redraw()
        })
        return
      case 'sessions': {
        const all = listSessions(this.o.cwd).slice(0, 15)
        this.print(all.length
          ? all.map((s) => `  ${c.bold(s.id)}  ${c.dim(s.updated.slice(0, 16).replace('T', ' '))}  ${s.title}`).join('\n') + '\n'
          : c.dim(`  ${G.elbow}  no saved sessions`) + '\n')
        break
      }
      case 'resume': case 'continue':
        this.resume(arg || undefined)
        break
      default:
        this.print(c.dim(`  ${G.elbow}  unknown command /${cmd} — /help`) + '\n')
    }
    this.redraw()
  }

  private resume(id?: string) {
    const s = loadSession(this.o.cwd, id)
    if (!s) return this.print(c.dim(`  ${G.elbow}  no session to resume`) + '\n')
    this.agent.restore(s)
    this.sessionId = s.id
    this.sessionCreated = s.created
    const shown = s.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).slice(-6)
    const lines = [c.dim(`  ${G.elbow}  resumed session ${s.id} (${s.messages.length} messages)`)]
    for (const m of shown) {
      const t = textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()
      if (!t) continue
      lines.push(m.role === 'user' ? c.dim('> ' + t.split('\n')[0].slice(0, 200)) : '● ' + inline(t.split('\n')[0].slice(0, 200)))
    }
    this.print(lines.join('\n') + '\n')
    if (s.todos?.length) this.printTodos(s.todos)
  }

  private save() {
    try { saveSession(this.o.cwd, this.sessionId, this.agent.snapshot(), this.sessionCreated) } catch { /* best effort */ }
  }

  private exit() {
    this.abort?.abort()
    this.save()
    this.screen.clearLive()
    this.restoreTerm?.()
    if (this.theme === 'black') process.stdout.write(OSC.reset)
    this.agent.dispose()
    process.stdout.write(c.dim(`Session saved: ${this.sessionId} — resume with: afk --resume ${this.sessionId}`) + '\n')
    this.o.onExit()
  }
}

// ---------------------------------------------------------------- helpers

export function renderDiff(lines: DiffLine[], max: number): string[] {
  const w = cols() - 1
  const numW = Math.max(3, String(Math.max(0, ...lines.map((l) => l.line))).length)
  const out: string[] = []
  for (const l of lines.slice(0, max)) {
    if (l.line < 0) { out.push(c.dim(`     ${' '.repeat(numW)} …`)); continue }
    const num = String(l.line).padStart(numW)
    const body = `${num} ${l.kind} ${l.text}`.replace(/\t/g, '  ')
    const padded = body.length < w - 6 ? body + ' '.repeat(w - 6 - strWidth(body)) : body.slice(0, w - 6)
    if (l.kind === '+') out.push('     ' + c.diffAddBg(padded))
    else if (l.kind === '-') out.push('     ' + c.diffDelBg(padded))
    else out.push('     ' + c.dim(padded))
  }
  if (lines.length > max) out.push(c.dim(`     … ${lines.length - max} more diff lines`))
  return out
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

function fmtDuration(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** Earlier versions kept the ↑/↓ history in ~/.afkllm/history.json across windows: remove it. */
function forgetLegacyHistory() {
  try { rmSync(join(CONFIG_DIR, 'history.json'), { force: true }) } catch { /* ignore */ }
}

/** Persist the CLI theme in ~/.afkllm/cli.json (keeps the other keys). */
function saveCliTheme(t: CliTheme): void {
  try {
    const p = join(CONFIG_DIR, 'cli.json')
    const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
    cfg.theme = t
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(p, JSON.stringify(cfg, null, 2))
  } catch { /* not fatal */ }
}

/** Clipboard text or image (Windows, via PowerShell/WinForms). Images are saved as a temp .png. */
export function readClipboard(): { text?: string; image?: string } | null {
  if (process.platform !== 'win32') return null
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    'if ([Windows.Forms.Clipboard]::ContainsImage()) {',
    '  $p = Join-Path $env:TEMP ("afk-paste-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".png")',
    '  [Windows.Forms.Clipboard]::GetImage().Save($p, [Drawing.Imaging.ImageFormat]::Png); "IMG:" + $p',
    '} else { "TXT:" + [Windows.Forms.Clipboard]::GetText() }',
  ].join('\n')
  const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  const out = (r.stdout || '').replace(/\r?\n$/, '')
  if (out.startsWith('IMG:')) return { image: out.slice(4).trim() }
  if (out.startsWith('TXT:')) return { text: out.slice(4) }
  return null
}
