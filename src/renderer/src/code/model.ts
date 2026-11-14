// Transcript model for the desktop shell: core events and saved sessions both become Blocks.
import type {
  AgentEvent, ChatMessage, DiffLine, PermissionDecision, PermissionMode, PermissionRequest, TodoItem, ToolOutcome, Usage,
} from '../../../core/types'

export type { AgentEvent, PermissionDecision, PermissionMode, PermissionRequest, TodoItem, ToolOutcome, Usage, DiffLine }

export interface CoreStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  profile: string
  model?: string
  ctx?: number
  vision: boolean
  imagegen: boolean
}

export type CoreEvent =
  | { kind: 'agent'; sessionId: string; event: AgentEvent }
  | { kind: 'permission'; sessionId: string; requestId: number; request: PermissionRequest }
  | { kind: 'status'; status: CoreStatus }
  | { kind: 'activity'; sessionId: string | null; message: string }
  | { kind: 'run_state'; sessionId: string; running: boolean }

export type Block =
  | { kind: 'user'; id: string; text: string; images: number }
  | { kind: 'thinking'; id: string; text: string; start: number; end?: number }
  | { kind: 'text'; id: string; text: string; open: boolean }
  | { kind: 'tool'; id: string; name: string; label: string; args: Record<string, unknown>; outcome?: ToolOutcome; ms?: number; log: string[] }
  | { kind: 'todos'; id: string; todos: TodoItem[] }
  | { kind: 'notice'; id: string; text: string; tone?: 'info' | 'warn' | 'error' }
  | { kind: 'compact'; id: string; before: number; after: number }
  | { kind: 'permission'; id: string; requestId: number; request: PermissionRequest; decided?: 'allowed' | 'denied' }

export interface FileChange { path: string; added: number; removed: number; lines: DiffLine[] }

export interface SessionView {
  id: string
  cwd: string
  title: string
  blocks: Block[]
  todos: TodoItem[]
  usage: Usage | null
  mode: PermissionMode
  running: boolean
  runStart: number
  activity: string
  changes: Record<string, FileChange>
}

let seq = 0
export const uid = (p: string) => `${p}${++seq}`

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g

export function textOf(content: ChatMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

export function toolLabel(name: string, args: Record<string, unknown>): string {
  const a = (args.file_path ?? args.command ?? args.pattern ?? args.description ?? args.prompt ?? '') as string
  const short = typeof a === 'string' ? a.replace(/\s+/g, ' ').slice(0, 90) : ''
  return short ? `${name}(${short})` : name
}

function addChange(changes: Record<string, FileChange>, o: ToolOutcome | undefined) {
  if (!o?.diff) return
  const prev = changes[o.diff.path]
  changes[o.diff.path] = {
    path: o.diff.path,
    added: (prev?.added ?? 0) + o.diff.added,
    removed: (prev?.removed ?? 0) + o.diff.removed,
    lines: o.diff.lines,
  }
}

/** Rebuild blocks from a saved session's messages (resume). Tool outcomes are approximated from the tool text. */
export function blocksFromMessages(messages: ChatMessage[]): { blocks: Block[]; changes: Record<string, FileChange> } {
  const blocks: Block[] = []
  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>()
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      const text = textOf(m.content).replace(REMINDER, '').trim()
      const images = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0
      if (text || images) blocks.push({ kind: 'user', id: uid('u'), text, images })
      else if (/compacted/.test(textOf(m.content))) blocks.push({ kind: 'notice', id: uid('n'), text: 'Conversation compacted' })
      continue
    }
    if (m.role === 'assistant') {
      if (m.reasoning_content?.trim()) blocks.push({ kind: 'thinking', id: uid('k'), text: m.reasoning_content, start: 0, end: 0 })
      const t = textOf(m.content).trim()
      if (t) blocks.push({ kind: 'text', id: uid('t'), text: t, open: false })
      for (const c of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(c.function.arguments || '{}') } catch { /* keep {} */ }
        const b: Extract<Block, { kind: 'tool' }> = { kind: 'tool', id: c.id, name: c.function.name, label: toolLabel(c.function.name, args), args, log: [] }
        tools.set(c.id, b)
        blocks.push(b)
      }
      continue
    }
    if (m.role === 'tool' && m.tool_call_id) {
      const b = tools.get(m.tool_call_id)
      const out = textOf(m.content)
      if (b) b.outcome = { ok: !out.startsWith('Error:'), output: out, summary: out.split('\n')[0].slice(0, 120) }
    }
  }
  return { blocks, changes: {} }
}

/** Apply one live core event to a session view (returns a new object for React). */
export function applyEvent(s: SessionView, e: AgentEvent): SessionView {
  const blocks = [...s.blocks]
  const last = blocks[blocks.length - 1]
  const next: SessionView = { ...s, blocks }
  switch (e.type) {
    case 'turn_start':
      break
    case 'reasoning': {
      if (last?.kind === 'thinking' && last.end === undefined) blocks[blocks.length - 1] = { ...last, text: last.text + e.delta }
      else blocks.push({ kind: 'thinking', id: uid('k'), text: e.delta, start: Date.now() })
      break
    }
    case 'text': {
      closeThinking(blocks)
      const l = blocks[blocks.length - 1]
      if (l?.kind === 'text' && l.open) blocks[blocks.length - 1] = { ...l, text: l.text + e.delta }
      else blocks.push({ kind: 'text', id: uid('t'), text: e.delta, open: true })
      break
    }
    case 'text_end': {
      const i = blocks.findLastIndex((b) => b.kind === 'text' && b.open)
      if (i >= 0) blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'text' }>), open: false }
      break
    }
    case 'tool_call':
      closeThinking(blocks)
      blocks.push({ kind: 'tool', id: e.id, name: e.name, label: e.label, args: e.args, log: [] })
      next.activity = e.label
      break
    case 'tool_result': {
      const i = blocks.findLastIndex((b) => b.kind === 'tool' && b.id === e.id)
      if (i >= 0) blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'tool' }>), outcome: e.outcome, ms: e.ms }
      if (e.outcome.diff) {
        next.changes = { ...s.changes }
        addChange(next.changes, e.outcome)
      }
      next.activity = ''
      break
    }
    case 'todos':
      next.todos = e.todos
      blocks.push({ kind: 'todos', id: uid('d'), todos: e.todos })
      break
    case 'usage':
      next.usage = e.usage
      break
    case 'notice':
      blocks.push({ kind: 'notice', id: uid('n'), text: e.message, tone: /loop guard|failed/.test(e.message) ? 'warn' : 'info' })
      break
    case 'compact':
      blocks.push({ kind: 'compact', id: uid('c'), before: e.beforeTokens, after: e.afterTokens })
      break
    case 'mode':
      next.mode = e.mode
      break
    case 'done':
      closeThinking(blocks)
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]
        if (b.kind === 'text' && b.open) blocks[i] = { ...b, open: false }
      }
      if (e.reason === 'aborted') blocks.push({ kind: 'notice', id: uid('n'), text: 'Interrupted · what should the agent do instead?', tone: 'warn' })
      if (e.reason === 'error') blocks.push({ kind: 'notice', id: uid('n'), text: e.message ?? 'error', tone: 'error' })
      if (e.reason === 'max_turns') blocks.push({ kind: 'notice', id: uid('n'), text: e.message ?? 'stopped', tone: 'warn' })
      next.activity = ''
      break
  }
  return next
}

function closeThinking(blocks: Block[]) {
  const i = blocks.findLastIndex((b) => b.kind === 'thinking' && b.end === undefined)
  if (i >= 0) blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'thinking' }>), end: Date.now() }
}

export function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Manual', hint: 'Asks before edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Edits go through, commands still ask' },
  { id: 'plan', label: 'Plan', hint: 'Explores and proposes a plan, no edits' },
  { id: 'auto', label: 'Auto', hint: 'Works on its own; asks only for risky actions' },
]
