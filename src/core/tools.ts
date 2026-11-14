// Agent tool set: Read, Write, Edit, Glob, Grep, Shell, TodoWrite, Task.
// Each tool validates and prepares in plan() (so a permission prompt can show the exact diff),
// then execute() does the side effect.
import { existsSync, promises as fs, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep, extname } from 'node:path'
import fg from 'fast-glob'
import { lineDiff } from './diff'
import { BackgroundJobs, SHELL_NAME, runShell } from './shell'
import type { PermissionRequest, TodoItem, ToolKind, ToolOutcome, ToolSchema } from './types'

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  /** abs path → mtimeMs at the time the model last saw the file */
  readState: Map<string, number>
  /** abs path → "mtime|offset|limit" of the last Read still in context (loop guard: no identical re-reads) */
  readSeen?: Map<string, string>
  todos: TodoItem[]
  bg: BackgroundJobs
  onTodos?: (t: TodoItem[]) => void
  onShellOutput?: (chunk: string) => void
  runSubagent?: (description: string, prompt: string, signal?: AbortSignal) => Promise<string>
  /** The model can see images (llama-server started with --mmproj). */
  vision?: boolean
  /** Host-provided image generation (swaps the GPU from the LLM to the image model and back). */
  generateImage?: (req: GenerateImageRequest, signal?: AbortSignal) => Promise<GenerateImageResult>
}

/** quiet: the prompt is not echoed in progress lines (the `afk api` console); set by the private `/image` command. */
export interface GenerateImageRequest { prompt: string; negative?: string; width?: number; height?: number; seed?: number; out: string; quiet?: boolean }
export interface GenerateImageResult {
  path: string; width: number; height: number; seconds: number; seed: number
  timings?: Record<string, number>; kvRestored?: boolean
}

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface PlannedCall {
  /** Present when the call needs a permission decision (edit/exec). */
  request?: Omit<PermissionRequest, 'tool' | 'kind'>
  execute: () => Promise<ToolOutcome>
}

export interface Tool {
  name: string
  kind: ToolKind
  schema: ToolSchema
  label: (args: any, cwd: string) => string
  plan: (args: any, ctx: ToolContext) => Promise<PlannedCall | ToolOutcome>
}

const fail = (output: string, summary = output.split('\n')[0].slice(0, 120)): ToolOutcome => ({ ok: false, output, summary })

export function resolvePath(p: string, cwd: string): string {
  return resolve(cwd, String(p ?? '').replace(/^["']|["']$/g, ''))
}

export function isInside(abs: string, root: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function shortPath(abs: string, cwd: string): string {
  const rel = relative(cwd, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
}

function schema(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/.afkllm/**']


/** A permission request for looking outside the project folder (null when the path is inside it). */
function outsideRead(abs: string, ctx: ToolContext, what: string): PlannedCall['request'] | undefined {
  if (isInside(abs, ctx.cwd)) return undefined
  return { title: `${what} outside the project: ${abs}`, detail: abs, ruleKey: 'read-outside' }
}

// ---------------------------------------------------------------- Read

const MAX_READ_LINES = 2000

const Read: Tool = {
  name: 'Read',
  kind: 'read',
  schema: schema('Read',
    'Read a file. Text: lines prefixed with line numbers (cat -n), up to 2000 lines; use offset/limit for larger ' +
    'files. Images (.png .jpg .jpeg .webp .gif .bmp — screenshots, photos, mockups): the picture itself is shown to ' +
    'you. Always Read a file before editing or overwriting it.',
    {
      file_path: { type: 'string', description: 'Path, absolute or relative to the project root' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    }, ['file_path']),
  label: (a, cwd) => `Read(${shortPath(resolvePath(a.file_path, cwd), cwd)}${a.offset ? `:${a.offset}` : ''})`,
  async plan(a, ctx) {
    const abs = resolvePath(a.file_path, ctx.cwd)
    let st
    try { st = statSync(abs) } catch { return fail(`File does not exist: ${abs}`) }
    if (st.isDirectory()) return fail(`${abs} is a directory. Use Glob to list files.`)
    if (st.size > 10 * 1024 * 1024) return fail(`File is ${(st.size / 1048576).toFixed(1)} MB; too large to Read.`)
    const mime = IMAGE_MIME[extname(abs).toLowerCase()]
    if (mime) {
      if (!ctx.vision) return fail(`${abs} is an image, and the current model has no vision (start it with an mmproj).`)
      if (st.size > MAX_IMAGE_BYTES) return fail(`Image is ${(st.size / 1048576).toFixed(1)} MB; the limit is 8 MB.`)
      return {
        request: outsideRead(abs, ctx, 'Read image'),
        execute: async () => {
          const data = (await fs.readFile(abs)).toString('base64')
          const kb = Math.round(st.size / 1024)
          return {
            ok: true, output: `Image ${abs} (${kb} KB) is attached right after the tool results. Look at it.`,
            summary: `Read image (${kb} KB)`, images: [{ path: abs, mime, data }],
          }
        },
      }
    }
    return {
      request: outsideRead(abs, ctx, 'Read'),
      execute: async () => {
        const start = Math.max(1, Number(a.offset) || 1)
        const limit = Math.max(1, Math.min(Number(a.limit) || MAX_READ_LINES, MAX_READ_LINES))
        const seenKey = `${st.mtimeMs}|${start}|${limit}`
        if (ctx.readSeen?.get(abs) === seenKey && ctx.readState.get(abs) === st.mtimeMs) {
          return {
            ok: true, summary: 'unchanged (already in context)',
            output: `${abs} has not changed since you last read these lines; that output is still earlier in this ` +
              'conversation. Use it instead of reading again, then act on it (Edit/Write/next step).',
          }
        }
        const buf = await fs.readFile(abs)
        if (!buf.length || !buf.toString('utf8').trim()) {
          ctx.readState.set(abs, st.mtimeMs)
          ctx.readSeen?.set(abs, seenKey)
          return { ok: true, output: `${abs} is empty (${buf.length} bytes).`, summary: 'Read 0 lines (empty file)' }
        }
        if (buf.subarray(0, 8000).includes(0)) return fail(`${abs} looks binary; not shown.`)
        const all = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n')
        const slice = all.slice(start - 1, start - 1 + limit)
        ctx.readState.set(abs, st.mtimeMs)
        ctx.readSeen?.set(abs, seenKey)
        if (!slice.length) return { ok: true, output: `(file has ${all.length} lines; nothing at offset ${start})`, summary: 'Read 0 lines' }
        const w = String(start + slice.length).length
        const body = slice.map((l, i) => `${String(start + i).padStart(w)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n')
        const more = start - 1 + slice.length < all.length ? `\n(… ${all.length - (start - 1 + slice.length)} more lines; use offset)` : ''
        return { ok: true, output: body + more, summary: `Read ${slice.length} lines` }
      },
    }
  },
}

// ---------------------------------------------------------------- Write / Edit

function staleCheck(abs: string, ctx: ToolContext, verb: string): ToolOutcome | null {
  if (!existsSync(abs)) return null
  const seen = ctx.readState.get(abs)
  if (seen === undefined) return fail(`${verb} refused: ${abs} exists but you have not Read it in this session. Read it first.`)
  if (statSync(abs).mtimeMs !== seen) return fail(`${verb} refused: ${abs} changed on disk since you read it. Read it again.`)
  return null
}

async function writeKeepingEol(abs: string, text: string, eol: '\n' | '\r\n'): Promise<number> {
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
  return statSync(abs).mtimeMs
}

const Write: Tool = {
  name: 'Write',
  kind: 'edit',
  schema: schema('Write',
    'Create a file or overwrite it with the full content. Prefer Edit for changes to existing files. ' +
    'Overwriting an existing file requires reading it first.',
    {
      file_path: { type: 'string' },
      content: { type: 'string', description: 'The complete file content' },
    }, ['file_path', 'content']),
  label: (a, cwd) => `Write(${shortPath(resolvePath(a.file_path, cwd), cwd)})`,
  async plan(a, ctx) {
    if (typeof a.content !== 'string') return fail('Write needs a string "content".')
    const abs = resolvePath(a.file_path, ctx.cwd)
    const stale = staleCheck(abs, ctx, 'Write')
    if (stale) return stale
    const exists = existsSync(abs)
    const before = exists ? (await fs.readFile(abs, 'utf8')) : ''
    const eol: '\n' | '\r\n' = before.includes('\r\n') ? '\r\n' : '\n'
    const after = a.content.replace(/\r\n/g, '\n')
    const d = lineDiff(before, after)
    const rel = shortPath(abs, ctx.cwd)
    const diff = { path: rel, ...d }
    return {
      request: { title: exists ? `Overwrite ${rel}` : `Create ${rel}`, detail: abs, diff, ruleKey: 'edit' },
      execute: async () => {
        ctx.readState.set(abs, await writeKeepingEol(abs, after, eol))
        const n = after.split('\n').length
        return {
          ok: true, diff,
          output: exists ? `Overwrote ${abs} (${n} lines).` : `Created ${abs} (${n} lines).`,
          summary: exists ? `Wrote ${n} lines (+${d.added} -${d.removed})` : `Created, ${n} lines`,
        }
      },
    }
  },
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** Whitespace-tolerant fallback: match old_string line by line ignoring trailing spaces and indentation drift. */
function looseFind(text: string, old: string): { start: number; end: number } | null {
  const lines = text.split('\n')
  const want = old.split('\n').map((l) => l.trim())
  while (want.length && !want[want.length - 1]) want.pop()
  if (!want.length) return null
  const hits: number[] = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true
    for (let k = 0; k < want.length && ok; k++) ok = lines[i + k].trim() === want[k]
    if (ok) hits.push(i)
  }
  if (hits.length !== 1) return null
  const offs = (row: number) => lines.slice(0, row).reduce((s, l) => s + l.length + 1, 0)
  const start = offs(hits[0])
  const endRow = hits[0] + want.length
  return { start, end: offs(endRow) - 1 }
}

const Edit: Tool = {
  name: 'Edit',
  kind: 'edit',
  schema: schema('Edit',
    'Replace an exact string in a file. old_string must match the file exactly (copy it from Read output ' +
    'without the line-number prefix) and be unique unless replace_all is true. Include enough surrounding ' +
    'lines to make it unique. Read the file first.',
    {
      file_path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text (must differ)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    }, ['file_path', 'old_string', 'new_string']),
  label: (a, cwd) => `Edit(${shortPath(resolvePath(a.file_path, cwd), cwd)})`,
  async plan(a, ctx) {
    const abs = resolvePath(a.file_path, ctx.cwd)
    if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return fail('Edit needs old_string and new_string.')
    if (!existsSync(abs)) {
      if (a.old_string === '') return Write.plan({ file_path: abs, content: a.new_string }, ctx)
      return fail(`File does not exist: ${abs}. Use Write to create it.`)
    }
    const stale = staleCheck(abs, ctx, 'Edit')
    if (stale) return stale
    if (a.old_string === a.new_string) return fail('old_string and new_string are identical; nothing to change.')
    const raw = await fs.readFile(abs, 'utf8')
    const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n'
    const text = raw.replace(/\r\n/g, '\n')
    const old = a.old_string.replace(/\r\n/g, '\n')
    const neu = a.new_string.replace(/\r\n/g, '\n')
    let after: string
    const n = countOccurrences(text, old)
    if (n > 1 && !a.replace_all) {
      return fail(`old_string occurs ${n} times in ${shortPath(abs, ctx.cwd)}. Add more surrounding context to make it unique, or set replace_all.`)
    }
    if (n >= 1) {
      after = a.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu)
    } else {
      const loose = old ? looseFind(text, old) : null
      if (!loose) {
        return fail(`old_string not found in ${shortPath(abs, ctx.cwd)}. It must match exactly, including indentation. Read the file again and copy the exact text.`)
      }
      after = text.slice(0, loose.start) + neu + text.slice(loose.end)
    }
    const rel = shortPath(abs, ctx.cwd)
    const diff = { path: rel, ...lineDiff(text, after) }
    return {
      request: { title: `Edit ${rel}`, detail: abs, diff, ruleKey: 'edit' },
      execute: async () => {
        ctx.readState.set(abs, await writeKeepingEol(abs, after, eol))
        const firstChanged = diff.lines.find((l) => l.kind !== ' ')?.line ?? 1
        // Echo the edited region so the model sees the result without another Read.
        const rows = after.split('\n')
        const from = Math.max(1, firstChanged - 3)
        const to = Math.min(rows.length, firstChanged + neu.split('\n').length + 3)
        const snippet = rows.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n')
        return {
          ok: true, diff,
          output: `Edited ${abs}${a.replace_all && n > 1 ? ` (${n} replacements)` : ''}. Result around the change:\n${snippet}`,
          summary: `Added ${diff.added} lines, removed ${diff.removed} lines`,
        }
      },
    }
  },
}

// ---------------------------------------------------------------- Glob / Grep

const Glob: Tool = {
  name: 'Glob',
  kind: 'read',
  schema: schema('Glob',
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/package.json"). Returns paths sorted by modification time, newest first. ' +
    'node_modules and .git are skipped.',
    {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search in (default: project root)' },
    }, ['pattern']),
  label: (a) => `Glob(${a.pattern})`,
  async plan(a, ctx) {
    const base = resolvePath(a.path || '.', ctx.cwd)
    return {
      request: outsideRead(base, ctx, 'Search files'),
      execute: async () => {
        const entries = await fg(String(a.pattern), { cwd: base, ignore: IGNORE, dot: true, stats: true, onlyFiles: true, suppressErrors: true })
        entries.sort((x, y) => (y.stats?.mtimeMs ?? 0) - (x.stats?.mtimeMs ?? 0))
        const list = entries.slice(0, 200).map((e) => shortPath(resolve(base, e.path), ctx.cwd))
        const more = entries.length > 200 ? `\n(… ${entries.length - 200} more; narrow the pattern)` : ''
        return { ok: true, output: list.length ? list.join('\n') + more : 'No files found.', summary: `Found ${entries.length} files` }
      },
    }
  },
}

const Grep: Tool = {
  name: 'Grep',
  kind: 'read',
  schema: schema('Grep',
    'Search file contents with a JavaScript regular expression. output_mode: "files_with_matches" (default), "content" (matching lines with line numbers), "count".',
    {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory (default: project root)' },
      glob: { type: 'string', description: 'Filter files, e.g. "*.ts" or "src/**/*.{ts,tsx}"' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around matches (content mode)' },
      head_limit: { type: 'integer', description: 'Max result lines (default 150)' },
    }, ['pattern']),
  label: (a) => `Grep(${JSON.stringify(a.pattern)}${a.glob ? ` in ${a.glob}` : a.path ? ` in ${a.path}` : ''})`,
  async plan(a, ctx) {
    let re: RegExp
    try { re = new RegExp(String(a.pattern), a.case_insensitive ? 'i' : '') } catch (e) { return fail(`Bad regex: ${(e as Error).message}`) }
    const target = resolvePath(a.path || '.', ctx.cwd)
    return {
      request: outsideRead(target, ctx, 'Search text'),
      execute: async () => {
        let files: string[]
        let st
        try { st = statSync(target) } catch { return fail(`Path does not exist: ${target}`) }
        if (st.isFile()) files = [target]
        else {
          const pat = a.glob ? (String(a.glob).includes('/') ? String(a.glob) : `**/${a.glob}`) : '**/*'
          files = (await fg(pat, { cwd: target, ignore: IGNORE, dot: false, onlyFiles: true, absolute: true, suppressErrors: true })).sort()
        }
        const mode = a.output_mode || 'files_with_matches'
        const limit = Math.max(1, Number(a.head_limit) || 150)
        const C = Math.max(0, Math.min(Number(a.context) || 0, 10))
        const out: string[] = []
        let total = 0
        let filesHit = 0
        for (const f of files) {
          if (ctx.signal?.aborted) break
          let buf: Buffer
          try {
            if (statSync(f).size > 2 * 1024 * 1024) continue
            buf = await fs.readFile(f)
          } catch { continue }
          if (buf.subarray(0, 4000).includes(0)) continue
          const lines = buf.toString('utf8').split(/\r?\n/)
          const hits: number[] = []
          lines.forEach((l, i) => { if (re.test(l)) hits.push(i) })
          if (!hits.length) continue
          filesHit++
          total += hits.length
          const rel = shortPath(f, ctx.cwd)
          if (mode === 'files_with_matches') out.push(rel)
          else if (mode === 'count') out.push(`${rel}:${hits.length}`)
          else {
            const shown = new Set<number>()
            for (const h of hits) for (let k = Math.max(0, h - C); k <= Math.min(lines.length - 1, h + C); k++) shown.add(k)
            let prev = -2
            for (const k of [...shown].sort((x, y) => x - y)) {
              if (C && prev >= 0 && k !== prev + 1) out.push('--')
              out.push(`${rel}:${k + 1}${hits.includes(k) ? ':' : '-'}${lines[k].slice(0, 400)}`)
              prev = k
            }
          }
          if (out.length >= limit) break
        }
        const cut = out.length > limit ? out.slice(0, limit) : out
        return {
          ok: true,
          output: cut.length ? cut.join('\n') + (out.length >= limit ? `\n(… limited to ${limit} lines)` : '') : 'No matches.',
          summary: mode === 'files_with_matches' ? `Found ${filesHit} files` : `Found ${total} matches in ${filesHit} files`,
        }
      },
    }
  },
}

// ---------------------------------------------------------------- Shell

const Shell: Tool = {
  name: 'Shell',
  kind: 'exec',
  schema: schema('Shell',
    `Run a ${SHELL_NAME} command in the project root and return its combined output and exit code. ` +
    (process.platform === 'win32'
      ? 'This is Windows PowerShell 5.1: use `;` (not `&&`) to chain, `$env:VAR`, Get-ChildItem etc. ' +
        'Every call is a NEW PowerShell process: variables, functions, Add-Type types and cd do not carry over to the ' +
        'next call, so put steps that depend on each other into one command. GUI apps: start them with ' +
        'run_in_background, then check the result with the Screenshot tool. '
      : '') +
    'Default timeout 120 s (max 600 s). For dev servers and watchers set run_in_background; output then goes to a log file you can Read. ' +
    'Do not use Shell to read, search or edit files: use Read, Grep, Glob, Edit, Write.',
    {
      command: { type: 'string' },
      description: { type: 'string', description: '5-10 words: what this does' },
      timeout: { type: 'integer', description: 'Milliseconds, max 600000' },
      run_in_background: { type: 'boolean' },
    }, ['command']),
  label: (a) => `Shell(${String(a.command ?? '').split('\n')[0].slice(0, 100)})`,
  async plan(a, ctx) {
    const command = String(a.command ?? '').trim()
    if (!command) return fail('Empty command.')
    const first = command.split(/\s+/)[0]
    return {
      request: { title: a.description ? String(a.description) : 'Run command', detail: command, ruleKey: `shell:${first}` },
      execute: async () => {
        if (a.run_in_background) {
          const job = ctx.bg.start(command, ctx.cwd)
          return {
            ok: true,
            output: `Started in background as ${job.id} (pid ${job.pid}). Output is written to ${job.logPath} — Read it to check progress.`,
            summary: `Background ${job.id} · log ${shortPath(job.logPath, ctx.cwd)}`,
          }
        }
        const timeout = Math.min(600_000, Math.max(1000, Number(a.timeout) || 120_000))
        const r = await runShell(command, ctx.cwd, timeout, ctx.signal, ctx.onShellOutput)
        const status = r.aborted ? 'interrupted by user' : r.timedOut ? `timed out after ${timeout / 1000}s` : `exit code ${r.code}`
        const ok = !r.aborted && !r.timedOut && r.code === 0
        const lines = r.output.trimEnd().split('\n').filter(Boolean).length
        return {
          ok,
          output: `${r.output.trimEnd() || '(no output)'}\n[${status}]`,
          summary: ok ? (lines ? `${lines} lines of output` : 'Done, no output') : `${status}${lines ? ` · ${lines} lines` : ''}`,
        }
      },
    }
  },
}

// ---------------------------------------------------------------- TodoWrite / Task

const TodoWrite: Tool = {
  name: 'TodoWrite',
  kind: 'meta',
  schema: schema('TodoWrite',
    'Create or update the task list for the current work. Send the FULL list every time. Use it for any task with 3+ steps: ' +
    'mark exactly one item in_progress while working on it, mark items completed as soon as they are done.',
    {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative, e.g. "Add tests for parser"' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present continuous, e.g. "Adding tests for parser"' },
          },
          required: ['content', 'status'],
        },
      },
    }, ['todos']),
  label: () => 'Update Todos',
  async plan(a, ctx) {
    let todos = a.todos
    if (typeof todos === 'string') { try { todos = JSON.parse(todos) } catch { /* below */ } }
    if (!Array.isArray(todos)) return fail('todos must be an array of {content, status}.')
    const clean: TodoItem[] = todos
      .filter((t: any) => t && typeof t.content === 'string' && t.content.trim())
      .map((t: any) => ({
        content: t.content.trim(),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      }))
    return {
      execute: async () => {
        ctx.todos.splice(0, ctx.todos.length, ...clean)
        ctx.onTodos?.(ctx.todos)
        const left = clean.filter((t) => t.status !== 'completed').length
        return {
          ok: true,
          output: `Todo list saved (${clean.length} items, ${left} not completed). Continue with the next item.`,
          summary: `${clean.length - left}/${clean.length} done`,
        }
      },
    }
  },
}

const Task: Tool = {
  name: 'Task',
  kind: 'meta',
  schema: schema('Task',
    'Delegate a read-only research task (find code, understand a subsystem, answer a question about the repo) to a sub-agent ' +
    'with a fresh context. It can Read/Glob/Grep but not edit or run commands. Give it a complete, self-contained prompt; ' +
    'you get back only its final report. Use it to keep your own context small.',
    {
      description: { type: 'string', description: '3-5 words' },
      prompt: { type: 'string' },
    }, ['description', 'prompt']),
  label: (a) => `Task(${a.description ?? 'sub-agent'})`,
  async plan(a, ctx) {
    if (!ctx.runSubagent) return fail('Sub-agents are not available here.')
    return {
      execute: async () => {
        const report = await ctx.runSubagent!(String(a.description ?? ''), String(a.prompt ?? ''), ctx.signal)
        return { ok: true, output: report, summary: `Report: ${report.split('\n').length} lines` }
      },
    }
  },
}

// ---------------------------------------------------------------- Screenshot

// PowerShell + Win32: capture a window with PrintWindow (works even when it is covered, no focus change) or the
// whole screen; with no match, list the visible windows so the agent learns what is (not) on screen.
const SHOT_PS = String.raw`
param([string]$Title, [string]$Proc, [string]$Out)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class AfkWin {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct R { public int L, T, Ri, B; }
  public static List<object[]> List() { var l = new List<object[]>(); EnumWindows((h, x) => {
    if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    if (sb.Length == 0) return true; uint pid; GetWindowThreadProcessId(h, out pid); R r; GetWindowRect(h, out r);
    if (r.Ri - r.L < 50 || r.B - r.T < 30) return true; l.Add(new object[] { h, sb.ToString(), pid, r }); return true; }, IntPtr.Zero); return l; }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$wins = [AfkWin]::List()
if (-not $Title -and -not $Proc) {
  $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  [Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save($Out)
  "SCREEN $($b.Width)x$($b.Height)"; exit 0
}
$pids = @(); if ($Proc) { $pids = @(Get-Process -Name ($Proc -replace '\.exe$','') -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id }) }
$hit = $wins | Where-Object { ($Title -and $_[1] -like "*$Title*") -or ($pids -contains $_[2]) } | Select-Object -First 1
if (-not $hit) {
  "NOMATCH"
  $wins | ForEach-Object { $p = Get-Process -Id $_[2] -ErrorAction SilentlyContinue; "$($_[1]) | $($p.ProcessName) pid $($_[2])" } | Select-Object -First 40
  exit 0
}
$h = $hit[0]; $r = $hit[3]; $w = $r.Ri - $r.L; $hh = $r.B - $r.T
$bmp = New-Object Drawing.Bitmap $w, $hh; $g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[void][AfkWin]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $bmp.Save($Out)
"WINDOW $($hit[1]) | " + $w + "x" + $hh + " | minimized=$([AfkWin]::IsIconic($h))"
`

const Screenshot: Tool = {
  name: 'Screenshot',
  kind: 'read',
  schema: schema('Screenshot',
    'Look at the screen: capture one window (by title text or process name) or the whole screen, and see the ' +
    'picture. Use it to check GUI apps, games and web pages you started, and whenever the user says something is ' +
    'not visible or looks wrong. If no window matches, you get the list of visible windows instead — a missing ' +
    'window usually means your program never showed it (check your code), not that it is hidden behind others.',
    {
      window_title: { type: 'string', description: 'Part of the window title, e.g. "Calculator"' },
      process_name: { type: 'string', description: 'Process name, e.g. "java" or "chrome"' },
    }, []),
  label: (a) => `Screenshot(${a.window_title ?? a.process_name ?? 'screen'})`,
  async plan(a, ctx) {
    if (process.platform !== 'win32') return fail('Screenshot is only implemented on Windows.')
    return {
      execute: async () => {
        const dir = resolve(ctx.cwd, '.afkllm', 'screens')
        await fs.mkdir(dir, { recursive: true })
        const out = resolve(dir, `shot-${Date.now()}.png`)
        const ps1 = resolve(dir, 'capture.ps1')
        await fs.writeFile(ps1, '\ufeff' + SHOT_PS, 'utf8')
        const q = (s: unknown) => `'${String(s ?? '').replace(/'/g, "''")}'`
        const r = await runShell(`& ${q(ps1)} -Title ${q(a.window_title)} -Proc ${q(a.process_name)} -Out ${q(out)}`, ctx.cwd, 30_000, ctx.signal)
        const text = r.output.trim()
        if (text.startsWith('NOMATCH')) {
          return {
            ok: true, summary: 'no such window',
            output: `No visible window matches ${a.window_title ? `title "${a.window_title}"` : `process "${a.process_name}"`}. ` +
              `Visible windows (title | process):\n${text.split('\n').slice(1).join('\n')}`,
          }
        }
        if (!existsSync(out)) return fail(`Screenshot failed:\n${text.slice(0, 2000)}`)
        const kb = Math.round(statSync(out).size / 1024)
        const images = ctx.vision ? [{ path: out, mime: 'image/png', data: (await fs.readFile(out)).toString('base64') }] : undefined
        return {
          ok: true, images,
          output: `${text} → saved ${out} (${kb} KB).` + (images ? ' The picture is attached after the tool results.' : ' (this model cannot see images; only the path is available)'),
          summary: text.split('|')[0].trim(),
        }
      },
    }
  },
}

// ---------------------------------------------------------------- GenerateImage

const GenerateImage: Tool = {
  name: 'GenerateImage',
  kind: 'edit',
  schema: schema('GenerateImage',
    'Generate a picture with the local image model (Qwen-Image 2.1) and save it as a PNG: game sprites and ' +
    'backgrounds, illustrations, icons, UI art, mockups, posters. Write the prompt in English as a detailed description ' +
    'of the finished image (subject, style, composition, lighting, colors; text to render goes in quotes). It takes ' +
    'about 1-2 minutes because the code model is paused meanwhile, so batch your needs and do not call it in a loop. ' +
    'The result is shown to you when you can see images: check it and regenerate with a better prompt if it is wrong.',
    {
      prompt: { type: 'string', description: 'Detailed English description of the image' },
      file_path: { type: 'string', description: 'Where to save the .png (project-relative or absolute)' },
      width: { type: 'integer', description: 'Pixels, 256-2048, multiple of 16 (default 1024)' },
      height: { type: 'integer', description: 'Pixels, 256-2048, multiple of 16 (default 1024)' },
      negative_prompt: { type: 'string', description: 'What to avoid (optional)' },
      seed: { type: 'integer', description: 'Fix for reproducible results (optional)' },
    }, ['prompt', 'file_path']),
  label: (a, cwd) => `GenerateImage(${shortPath(resolvePath(a.file_path, cwd), cwd)})`,
  async plan(a, ctx) {
    if (!ctx.generateImage) return fail('Image generation is not available in this session.')
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) return fail('GenerateImage needs a non-empty "prompt".')
    let abs = resolvePath(a.file_path, ctx.cwd)
    if (!/\.png$/i.test(abs)) abs += '.png'
    const rel = shortPath(abs, ctx.cwd)
    return {
      request: { title: `Generate image ${rel}`, detail: `${abs}\n${String(a.prompt).slice(0, 300)}`, ruleKey: 'edit' },
      execute: async () => {
        const r = await ctx.generateImage!({
          prompt: a.prompt, negative: a.negative_prompt, out: abs,
          width: Number(a.width) || undefined, height: Number(a.height) || undefined,
          seed: Number.isFinite(Number(a.seed)) && a.seed !== undefined ? Number(a.seed) : undefined,
          // not in the schema: only the Harness `/image` command sends it (MCP), the model does not see it
          quiet: a.private === true,
        }, ctx.signal)
        const kb = Math.round(statSync(r.path).size / 1024)
        const steps = r.timings ? ' · ' + Object.entries(r.timings).map(([k, v]) => `${k} ${v}`).join(', ') : ''
        const images = ctx.vision ? [{ path: r.path, mime: 'image/png', data: (await fs.readFile(r.path)).toString('base64') }] : undefined
        return {
          ok: true, images,
          output: `Saved ${r.width}x${r.height} image to ${r.path} (${kb} KB, seed ${r.seed}, ${r.seconds.toFixed(0)} s).` +
            (images ? ' It is attached after the tool results: check that it matches what you asked for.' : ''),
          summary: `Generated ${r.width}x${r.height} in ${r.seconds.toFixed(0)}s${steps}`,
        }
      },
    }
  },
}

export const ALL_TOOLS: Tool[] = [Read, Write, Edit, Glob, Grep, Shell, TodoWrite, Task, Screenshot]
/** Added by the host when image generation is set up (keeps the tool list, and so the prompt prefix, stable per session). */
export const IMAGE_TOOLS: Tool[] = [GenerateImage]
export const READ_ONLY_TOOLS: Tool[] = [Read, Glob, Grep]
export const toolByName = (name: string, set: Tool[] = ALL_TOOLS) =>
  set.find((t) => t.name === name) ?? set.find((t) => t.name.toLowerCase() === name.toLowerCase())
