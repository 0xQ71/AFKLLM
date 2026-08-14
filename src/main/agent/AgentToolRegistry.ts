import { promises as fs } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { AgentToolCall, AgentToolName, AgentToolResult } from '../../shared/types'
import type { CodebaseQueryResult } from '../../shared/context'
import { AGENT_TOOL_SCHEMAS as schemas } from '../../shared/types'
import {
  formatWebSearchHits,
  formatWebSearchSkipped,
  webSearch
} from './WebSearch'
import {
  applyHunksToText,
  applySearchReplaceFuzzy,
  formatApplyPatchResult,
  parseApplyPatch
} from '../../shared/applyPatch'
import { normalizeAgentShellCommand } from '../../shared/shellNormalize'
import {
  classifyBrowserOpenCommand,
  extractLocalPreviewUrl,
  extractOpenHtmlRelativePath,
  looksLikeLocalServerCommand,
  pathToFileUrl
} from '../../shared/localPreview'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'coverage',
  '.cache'
])

type ToolHandler = (args: Record<string, unknown>) => Promise<AgentToolResult>

export interface AgentToolRegistryOptions {
  /** Absolute path to the opened workspace / project root */
  projectRoot: string
  /**
   * Called when execute_terminal_command needs UI confirmation.
   * Resolve `true` to allow, `false` to deny.
   * When auto-approve is on, this should return true immediately.
   */
  confirmTerminal?: (command: string, cwd: string) => Promise<boolean>
  /** Called for destructive file ops (delete) unless auto-approve is on */
  confirmDelete?: (relativePath: string) => Promise<boolean>
  /** Fired after write / delete / apply_diff so UI can refresh the tree */
  onFilesystemChange?: (paths: string[]) => void
  /** Fired after a successful file delete so the IDE can close the tab */
  onFileDeleted?: (relativePath: string) => void
  /**
   * Run a shell command in the visible IDE terminal (PTY).
   * Preferred over hidden spawn so the user can watch output.
   */
  runVisibleCommand?: (
    command: string,
    cwd: string
  ) => Promise<{ output: string; exitCode: number }>
  /** Read recent output from the visible IDE terminal scrollback */
  readTerminalScrollback?: (maxChars?: number) => string
  /** Open in-app browser when a local preview URL is known */
  onOpenPreview?: (url: string) => void
  /** Ports that must never auto-open as site preview (LLM server, default 8080) */
  getDenyPreviewPorts?: () => number[]
  /** Optional BM25 context index for search_codebase */
  contextIndex?: {
    isReady(): boolean
    query(q: string): CodebaseQueryResult | null
  }
  /**
   * Local image generation (sd-cli). Unloads LLM, generates, restores chat.
   * Provided by main process (slot orchestrator + SdRuntimeManager).
   */
  generateImage?: (args: Record<string, unknown>) => Promise<AgentToolResult>
}

/**
 * Main-process registry of agent tools with JSON-Schema descriptors
 * suitable for OpenAI-compatible function calling.
 */
type PendingEdit = { existed: boolean; previous: string }

export class AgentToolRegistry {
  private projectRoot: string
  private readonly handlers: Map<AgentToolName, ToolHandler>
  private confirmTerminal: AgentToolRegistryOptions['confirmTerminal']
  private confirmDelete: AgentToolRegistryOptions['confirmDelete']
  private onFilesystemChange?: (paths: string[]) => void
  private onFileDeleted?: (relativePath: string) => void
  private runVisibleCommand?: AgentToolRegistryOptions['runVisibleCommand']
  private readTerminalScrollback?: AgentToolRegistryOptions['readTerminalScrollback']
  private onOpenPreview?: AgentToolRegistryOptions['onOpenPreview']
  private getDenyPreviewPorts?: () => number[]
  private contextIndex?: AgentToolRegistryOptions['contextIndex']
  private generateImageFn?: AgentToolRegistryOptions['generateImage']
  /** First-edit-per-path snapshot for Accept/Reject undo */
  private pendingEdits = new Map<string, PendingEdit>()

  constructor(options: AgentToolRegistryOptions) {
    this.projectRoot = resolve(options.projectRoot)
    this.confirmTerminal = options.confirmTerminal
    this.confirmDelete = options.confirmDelete
    this.onFilesystemChange = options.onFilesystemChange
    this.onFileDeleted = options.onFileDeleted
    this.runVisibleCommand = options.runVisibleCommand
    this.readTerminalScrollback = options.readTerminalScrollback
    this.onOpenPreview = options.onOpenPreview
    this.getDenyPreviewPorts = options.getDenyPreviewPorts
    this.contextIndex = options.contextIndex
    this.generateImageFn = options.generateImage
    this.handlers = new Map([
      ['read_file', (a) => this.readFile(a)],
      ['write_file', (a) => this.writeFile(a)],
      ['apply_diff', (a) => this.applyDiff(a)],
      ['apply_patch', (a) => this.applyPatch(a)],
      ['list_directory', (a) => this.listDirectory(a)],
      ['search_codebase', (a) => this.searchCodebase(a)],
      ['web_search', (a) => this.webSearch(a)],
      ['delete_file', (a) => this.deleteFileTool(a)],
      ['create_directory', (a) => this.createDirectory(a)],
      ['execute_terminal_command', (a) => this.executeTerminal(a)],
      ['read_terminal', (a) => this.readTerminal(a)],
      ['generate_image', (a) => this.generateImage(a)]
    ])
  }

  setProjectRoot(root: string): void {
    this.projectRoot = resolve(root)
    this.pendingEdits.clear()
  }

  /** Snapshot before first mutate of this path in the review window. */
  private rememberEdit(relativePath: string, existed: boolean, previous: string): void {
    const key = relativePath.replace(/\\/g, '/')
    if (!this.pendingEdits.has(key)) {
      this.pendingEdits.set(key, { existed, previous })
    }
  }

  acceptEdit(relativePath: string): { ok: boolean; path: string } {
    const key = relativePath.replace(/\\/g, '/')
    this.pendingEdits.delete(key)
    return { ok: true, path: key }
  }

  acceptAllEdits(): { ok: boolean; cleared: number } {
    const cleared = this.pendingEdits.size
    this.pendingEdits.clear()
    return { ok: true, cleared }
  }

  async rejectEdit(relativePath: string): Promise<AgentToolResult> {
    const key = relativePath.replace(/\\/g, '/')
    const snap = this.pendingEdits.get(key)
    if (!snap) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: `No pending edit for ${key}`
      }
    }
    const abs = this.safeResolve(key)
    try {
      if (!snap.existed) {
        try {
          await fs.unlink(abs)
        } catch {
          /* already gone */
        }
      } else {
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, snap.previous, 'utf8')
      }
      this.pendingEdits.delete(key)
      this.notifyChange(key)
      return {
        id: '',
        name: 'write_file',
        ok: true,
        content: snap.existed ? `Reverted ${key}` : `Removed new file ${key}`,
        editReview: { path: key, status: 'rejected' }
      }
    } catch (err) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  listPendingEdits(): string[] {
    return [...this.pendingEdits.keys()]
  }

  /** Snapshot pending edits for checkpoint commit (does not clear). */
  exportPendingEdits(): Array<{
    path: string
    existed: boolean
    previous: string
  }> {
    return [...this.pendingEdits.entries()].map(([path, snap]) => ({
      path,
      existed: snap.existed,
      previous: snap.previous
    }))
  }

  /** Clear pending review state for paths (e.g. after rewind). */
  clearPendingPaths(paths: string[]): void {
    for (const p of paths) {
      this.pendingEdits.delete(p.replace(/\\/g, '/'))
    }
  }

  /** Restore a single file from a checkpoint snap. */
  async restoreCheckpointFile(snap: {
    path: string
    existed: boolean
    previous: string | null
  }): Promise<void> {
    const key = snap.path.replace(/\\/g, '/')
    const abs = this.safeResolve(key)
    if (!snap.existed) {
      try {
        await fs.unlink(abs)
      } catch {
        /* already gone */
      }
    } else if (snap.previous != null) {
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, snap.previous, 'utf8')
    }
    this.pendingEdits.delete(key)
    this.notifyChange(key)
  }

  /** Before/after for DiffEditor review in chat. */
  async getPendingDiff(relativePath: string): Promise<{
    ok: boolean
    path: string
    previous: string
    current: string
    existed: boolean
    error?: string
  }> {
    const key = relativePath.replace(/\\/g, '/')
    const snap = this.pendingEdits.get(key)
    if (!snap) {
      return {
        ok: false,
        path: key,
        previous: '',
        current: '',
        existed: false,
        error: `No pending edit for ${key}`
      }
    }
    try {
      const abs = this.safeResolve(key)
      let current = ''
      try {
        current = await fs.readFile(abs, 'utf8')
      } catch {
        current = ''
      }
      return {
        ok: true,
        path: key,
        previous: snap.previous,
        current,
        existed: snap.existed
      }
    } catch (err) {
      return {
        ok: false,
        path: key,
        previous: '',
        current: '',
        existed: snap.existed,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** Create empty file (or write content) for Explorer UI. */
  async createFile(relativePath: string, content = ''): Promise<AgentToolResult> {
    return this.writeFile({ relative_path: relativePath, content, overwrite: false })
  }

  async createDir(relativePath: string): Promise<AgentToolResult> {
    return this.createDirectory({ relative_path: relativePath })
  }

  async renamePath(fromRel: string, toRel: string): Promise<AgentToolResult> {
    const from = String(fromRel ?? '').replace(/\\/g, '/')
    const to = String(toRel ?? '').replace(/\\/g, '/')
    if (!from || !to) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: 'from and to paths are required'
      }
    }
    if (from === to) {
      return { id: '', name: 'write_file', ok: true, content: `Unchanged ${from}` }
    }
    try {
      const absFrom = this.safeResolve(from)
      const absTo = this.safeResolve(to)
      await fs.mkdir(dirname(absTo), { recursive: true })
      await fs.rename(absFrom, absTo)
      this.pendingEdits.delete(from)
      this.pendingEdits.delete(to)
      this.notifyChange(from, to)
      return {
        id: '',
        name: 'write_file',
        ok: true,
        content: `Renamed ${from} → ${to}`
      }
    } catch (err) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async searchFiles(
    query: string,
    opts?: { glob?: string; limit?: number }
  ): Promise<{
    ok: boolean
    matches: Array<{ path: string; line: number; text: string }>
    error?: string
  }> {
    const q = String(query ?? '').trim()
    if (!q) return { ok: false, matches: [], error: 'query is required' }
    try {
      const limit = Math.max(1, Math.min(opts?.limit ?? 200, 500))
      const raw = await this.grep(this.projectRoot, q, opts?.glob, limit)
      const matches = raw.map((line) => {
        const m = line.match(/^([^:]+):(\d+):\s?(.*)$/)
        if (!m) return { path: line, line: 1, text: line }
        return { path: m[1]!, line: Number(m[2]) || 1, text: m[3] ?? '' }
      })
      return { ok: true, matches }
    } catch (err) {
      return {
        ok: false,
        matches: [],
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  setConfirmTerminal(fn: AgentToolRegistryOptions['confirmTerminal']): void {
    this.confirmTerminal = fn
  }

  setOnFilesystemChange(fn: AgentToolRegistryOptions['onFilesystemChange']): void {
    this.onFilesystemChange = fn
  }

  private notifyChange(...paths: string[]): void {
    this.onFilesystemChange?.(paths)
  }

  /** OpenAI tools array for chat completions */
  get schemas(): typeof schemas {
    return schemas
  }

  listTools(): AgentToolName[] {
    return [...this.handlers.keys()]
  }

  async invoke(call: AgentToolCall): Promise<AgentToolResult> {
    const handler = this.handlers.get(call.name as AgentToolName)
    if (!handler) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        content: '',
        error: `Unknown tool: ${call.name}`
      }
    }

    try {
      const result = await handler(call.arguments)
      return { ...result, id: call.id, name: call.name }
    } catch (err) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async readFile(args: Record<string, unknown>): Promise<AgentToolResult> {
    const relativePath = String(args.relative_path ?? '')
    const abs = this.safeResolve(relativePath)
    const lower = relativePath.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|7z|rar|exe|dll|so|dylib|wasm|gguf|safetensors|bin|mp[34]|wav|ogg)$/i.test(lower)) {
      return {
        id: '',
        name: 'read_file',
        ok: false,
        content: '',
        error:
          `BINARY_FILE: "${relativePath}" is not text. Do not read images/binaries with read_file. ` +
          'For generated images, refer to the path only (already on disk).'
      }
    }
    const buf = await fs.readFile(abs)
    // Reject obvious binary even with a text-looking extension
    if (buf.includes(0)) {
      return {
        id: '',
        name: 'read_file',
        ok: false,
        content: '',
        error: `BINARY_FILE: "${relativePath}" contains null bytes — not readable as text.`
      }
    }
    const raw = buf.toString('utf8')
    const startRaw = Number(args.start_line)
    const endRaw = Number(args.end_line)
    const hasStart = Number.isFinite(startRaw) && startRaw >= 1
    const hasEnd = Number.isFinite(endRaw) && endRaw >= 1
    if (!hasStart && !hasEnd) {
      return { id: '', name: 'read_file', ok: true, content: raw }
    }
    const lines = raw.split(/\r?\n/)
    const total = lines.length || 1
    const start = hasStart ? Math.min(Math.floor(startRaw), total) : 1
    const end = hasEnd ? Math.min(Math.floor(endRaw), total) : total
    const from = Math.max(1, Math.min(start, end))
    const to = Math.max(from, Math.max(start, end))
    const slice = lines.slice(from - 1, to).join('\n')
    const meta =
      `showing lines ${from}–${to} of ${total}` +
      (to < total ? ` (NOT EOF — file continues after line ${to})` : ' (through EOF)')
    return {
      id: '',
      name: 'read_file',
      ok: true,
      content: `[read_file range] ${meta}\n---\n${slice}`
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<AgentToolResult> {
    const relativePath = String(
      args.relative_path ??
        args.path ??
        args.file ??
        args.filename ??
        args.file_path ??
        args.filepath ??
        ''
    ).trim()
    const content = String(args.content ?? '')
    const append = Boolean(args.append)
    const overwrite = Boolean(args.overwrite)
    if (!relativePath || relativePath === '.' || relativePath === './') {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error:
          'MISSING_PATH: relative_path is required (e.g. "index.html" or "src/app.js"). ' +
          'Put the path in relative_path BEFORE content. Do not write to the project root.'
      }
    }
    if (/\.(png|jpe?g|gif|webp|bmp|ico|gguf|safetensors)$/i.test(relativePath)) {
      const isFavicon = /favicon\.(ico|png)$/i.test(relativePath)
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error: isFavicon
          ? `FAVICON: do not write favicon.ico/png via write_file or generate_image. ` +
            `Skip the favicon, or add a tiny inline SVG favicon in HTML (<link> + data-URI / .svg text file).`
          : `BINARY_FILE: do not write/edit image or model binaries via write_file ("${relativePath}"). ` +
            'Use generate_image only for real PNGs the user asked for (not favicons).'
      }
    }
    const abs = this.safeResolve(relativePath)
    // Refuse writing the workspace directory itself
    if (normalize(abs).toLowerCase() === normalize(this.projectRoot).toLowerCase()) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error:
          'MISSING_PATH: resolved to the project folder, not a file. Pass a file path like "index.html".'
      }
    }
    await fs.mkdir(dirname(abs), { recursive: true })

    let existing = ''
    let existed = false
    try {
      existing = await fs.readFile(abs, 'utf8')
      existed = true
    } catch {
      /* new file */
    }

    // Block silent full rewrites of large files — the #1 cause of "rewrites everything after compact"
    if (!append && !overwrite && existing.trim().length > 40) {
      const tail = existing.slice(-350)
      // Landing HTML often exceeds 6KB — still tell the model to overwrite=true, not apply_diff.
      const small =
        existing.length < 6000 ||
        (/\.html?$/i.test(relativePath) && existing.length < 40_000)
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content:
          `FILE_EXISTS: "${relativePath}" already has ${existing.length} bytes.\n` +
          (small
            ? `This is a small/landing file. Call write_file again with overwrite=true and the FULL corrected content.\n`
            : `Do NOT rewrite from scratch. Use apply_patch / apply_diff to edit, or append=true to continue.\n`) +
          `File currently ends with:\n<<<\n${tail}\n>>>`,
        error: small
          ? `FILE_EXISTS: ${relativePath} — use overwrite=true for this small file`
          : `FILE_EXISTS: ${relativePath} — use append=true or apply_diff`
      }
    }

    this.rememberEdit(relativePath, existed, existing)

    if (append) {
      await fs.appendFile(abs, content, 'utf8')
    } else {
      await fs.writeFile(abs, content, 'utf8')
    }
    this.notifyChange(relativePath)
    const total = append ? existing.length + content.length : content.length
    const pathKey = relativePath.replace(/\\/g, '/')
    const writtenBody = append ? existing + content : content
    const lineCount = writtenBody.split(/\r?\n/).length
    const closesHtml = /<\/html\s*>/i.test(writtenBody)
    const closesBody = /<\/body\s*>/i.test(writtenBody)
    const htmlHint =
      /\.html?$/i.test(relativePath) || /<!DOCTYPE\s+html|<html[\s>]/i.test(writtenBody)
        ? ` lines=${lineCount} closes_with_</body>=${closesBody ? 'yes' : 'no'} closes_with_</html>=${closesHtml ? 'yes' : 'no'}.` +
          (closesHtml
            ? ' FILE_COMPLETE — do not rewrite just to "finish the tail".'
            : ' If incomplete, append=true on the SAME path (do not invent a new file).')
        : ` lines=${lineCount}.`
    return {
      id: '',
      name: 'write_file',
      ok: true,
      content:
        `${append ? 'Appended' : 'Wrote'} ${content.length} bytes to ${relativePath} (file now ${total} bytes).` +
        htmlHint +
        ' Finish this file before starting another.',
      editReview: { path: pathKey, status: 'pending' }
    }
  }

  async deleteFile(relativePath: string): Promise<AgentToolResult> {
    const abs = this.safeResolve(relativePath)
    let previous = ''
    let existed = false
    try {
      previous = await fs.readFile(abs, 'utf8')
      existed = true
    } catch {
      /* missing */
    }
    if (existed) this.rememberEdit(relativePath.replace(/\\/g, '/'), true, previous)
    await fs.unlink(abs)
    const rel = relativePath.replace(/\\/g, '/')
    this.onFileDeleted?.(rel)
    this.notifyChange(rel)
    return {
      id: '',
      name: 'delete_file',
      ok: true,
      content: `Deleted ${relativePath}`
    }
  }

  private async deleteFileTool(args: Record<string, unknown>): Promise<AgentToolResult> {
    const relativePath = String(args.relative_path ?? '')
    if (this.confirmDelete) {
      const allowed = await this.confirmDelete(relativePath)
      if (!allowed) {
        return {
          id: '',
          name: 'delete_file',
          ok: false,
          content: '',
          error: 'User rejected delete',
          needsConfirmation: true
        }
      }
    }
    return this.deleteFile(relativePath)
  }

  private async createDirectory(args: Record<string, unknown>): Promise<AgentToolResult> {
    const relativePath = String(
      args.relative_path ?? args.path ?? args.dir_path ?? args.filename ?? ''
    ).trim()
    if (!relativePath || relativePath === '.' || relativePath === './') {
      return {
        id: '',
        name: 'create_directory',
        ok: false,
        content: '',
        error:
          'MISSING_PATH: relative_path is required for create_directory (e.g. "assets" or "src/components").'
      }
    }
    const abs = this.safeResolve(relativePath)
    let existed = false
    try {
      const st = await fs.stat(abs)
      existed = st.isDirectory()
    } catch {
      /* new */
    }
    await fs.mkdir(abs, { recursive: true })
    this.notifyChange(relativePath)
    return {
      id: '',
      name: 'create_directory',
      ok: true,
      content: existed
        ? `Directory already exists: ${relativePath}. Do NOT call create_directory again on this path — write files inside it.`
        : `Created directory ${relativePath}`
    }
  }

  private async applyDiff(args: Record<string, unknown>): Promise<AgentToolResult> {
    const relativePath = String(args.relative_path ?? '')
    const searchBlock = String(args.search_block ?? '')
    const replaceBlock = String(args.replace_block ?? '')

    if (!searchBlock) {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error: 'search_block is empty'
      }
    }

    const abs = this.safeResolve(relativePath)
    const original = await fs.readFile(abs, 'utf8')
    const applied = applySearchReplaceFuzzy(original, searchBlock, replaceBlock)

    if (!applied.ok) {
      const preview = original.replace(/\r\n/g, '\n').slice(0, 1200)
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content:
          `${applied.error}\n\n` +
          `NEXT: call read_file on "${relativePath}", then apply_diff again with a SHORT unique exact substring copied from the file.\n` +
          `If this file is small (HTML/CSS/short script), use write_file overwrite=true with the full corrected content instead of retrying a long hunk.\n` +
          `Do not claim the environment forbids shell operators — use cwd=… or PowerShell ";".\n\n` +
          `--- file preview (first ~1200 chars) ---\n${preview}`,
        error: applied.error
      }
    }

    this.rememberEdit(relativePath, true, original)
    await fs.writeFile(abs, applied.content, 'utf8')
    this.notifyChange(relativePath)
    const pathKey = relativePath.replace(/\\/g, '/')
    return {
      id: '',
      name: 'apply_diff',
      ok: true,
      content: `Applied diff to ${relativePath}${applied.normalized ? ' (normalized newlines)' : ''}`,
      editReview: { path: pathKey, status: 'pending' }
    }
  }

  private async applyPatch(args: Record<string, unknown>): Promise<AgentToolResult> {
    const patchText = String(args.patch ?? '')
    const parsed = parseApplyPatch(patchText)
    if (!parsed.ok) {
      return {
        id: '',
        name: 'apply_patch',
        ok: false,
        content: '',
        error: parsed.error ?? 'Invalid patch'
      }
    }

    const changed: Array<{ path: string; action: string }> = []
    const errors: string[] = []
    let firstReviewPath: string | null = null

    for (const op of parsed.ops) {
      try {
        const pathKey = op.path.replace(/\\/g, '/')
        const abs = this.safeResolve(pathKey)

        if (op.type === 'add') {
          let existed = false
          let previous = ''
          try {
            previous = await fs.readFile(abs, 'utf8')
            existed = true
          } catch {
            /* new */
          }
          if (existed && previous.length > 0) {
            errors.push(
              `${pathKey}: file already exists — use Update File hunks or apply_diff, not Add File`
            )
            continue
          }
          this.rememberEdit(pathKey, existed, previous)
          const body = (op.addLines ?? []).join('\n')
          const content =
            body.length === 0 || body.endsWith('\n') ? body : body + '\n'
          await fs.mkdir(dirname(abs), { recursive: true })
          await fs.writeFile(abs, content, 'utf8')
          this.notifyChange(pathKey)
          changed.push({ path: pathKey, action: 'add' })
          if (!firstReviewPath) firstReviewPath = pathKey
          continue
        }

        if (op.type === 'delete') {
          let previous = ''
          let existed = false
          try {
            previous = await fs.readFile(abs, 'utf8')
            existed = true
          } catch {
            errors.push(`${pathKey}: file not found for delete`)
            continue
          }
          this.rememberEdit(pathKey, true, previous)
          await fs.unlink(abs)
          this.notifyChange(pathKey)
          changed.push({ path: pathKey, action: 'delete' })
          if (!firstReviewPath) firstReviewPath = pathKey
          continue
        }

        let original: string
        try {
          original = await fs.readFile(abs, 'utf8')
        } catch {
          errors.push(`${pathKey}: file not found for update`)
          continue
        }
        const applied = applyHunksToText(original, op.hunks ?? [])
        if (!applied.ok || applied.content == null) {
          errors.push(`${pathKey}: ${applied.error ?? 'hunk apply failed'}`)
          continue
        }
        this.rememberEdit(pathKey, true, original)
        await fs.writeFile(abs, applied.content, 'utf8')
        this.notifyChange(pathKey)
        changed.push({ path: pathKey, action: 'update' })
        if (!firstReviewPath) firstReviewPath = pathKey
      } catch (err) {
        errors.push(
          `${op.path}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const content = formatApplyPatchResult(changed, errors)
    if (changed.length === 0) {
      return {
        id: '',
        name: 'apply_patch',
        ok: false,
        content,
        error: errors[0] ?? 'apply_patch made no changes'
      }
    }

    return {
      id: '',
      name: 'apply_patch',
      ok: errors.length === 0,
      content:
        errors.length > 0
          ? `${content}\n\nPARTIAL: some ops failed — fix with read_file + smaller hunks.`
          : content,
      error: errors.length > 0 ? errors[0] : undefined,
      editReview: firstReviewPath
        ? { path: firstReviewPath, status: 'pending' }
        : undefined
    }
  }

  private async listDirectory(args: Record<string, unknown>): Promise<AgentToolResult> {
    const dirPath = String(args.dir_path ?? '.')
    const abs = this.safeResolve(dirPath)
    const entries = await this.walk(abs, abs, 6)
    return {
      id: '',
      name: 'list_directory',
      ok: true,
      content: entries.join('\n')
    }
  }

  private async searchCodebase(args: Record<string, unknown>): Promise<AgentToolResult> {
    const query = String(args.query ?? '')
    if (!query) {
      return {
        id: '',
        name: 'search_codebase',
        ok: false,
        content: '',
        error: 'query is required'
      }
    }

    const glob = typeof args.glob === 'string' ? args.glob : undefined
    // BM25 when ready; glob still uses walk-grep
    if (!glob && this.contextIndex?.isReady()) {
      const hit = this.contextIndex.query(query)
      if (hit && hit.text.trim()) {
        return {
          id: '',
          name: 'search_codebase',
          ok: true,
          content: hit.text
        }
      }
    }

    const matches = await this.grep(this.projectRoot, query, glob, 200)
    return {
      id: '',
      name: 'search_codebase',
      ok: true,
      content: matches.length ? matches.join('\n') : 'No matches found'
    }
  }

  private async webSearch(args: Record<string, unknown>): Promise<AgentToolResult> {
    const query = String(args.query ?? '').trim()
    if (!query) {
      return {
        id: '',
        name: 'web_search',
        ok: false,
        content: '',
        error: 'query is required'
      }
    }
    const rawMax = Number(args.max_results)
    const limit = Number.isFinite(rawMax)
      ? Math.min(12, Math.max(1, Math.floor(rawMax)))
      : 8

    const result = await webSearch(query, limit)
    if (result.skipped) {
      return {
        id: '',
        name: 'web_search',
        ok: true,
        content: formatWebSearchSkipped(result.query || query, result.error)
      }
    }
    if (!result.ok && result.hits.length === 0) {
      return {
        id: '',
        name: 'web_search',
        ok: false,
        content: '',
        error: result.error ?? 'Web search failed'
      }
    }
    return {
      id: '',
      name: 'web_search',
      ok: true,
      content: formatWebSearchHits(result.query, result.hits, result.sources)
    }
  }

  private async executeTerminal(args: Record<string, unknown>): Promise<AgentToolResult> {
    const rawCommand = String(args.command ?? '').trim()
    if (!rawCommand) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error: 'command is required'
      }
    }

    const rawCwd = typeof args.cwd === 'string' ? args.cwd : '.'
    const normalized = normalizeAgentShellCommand(rawCommand, rawCwd)
    const command = normalized.command
    const cwdRel = normalized.cwdRel

    // Intercept preview opens: workspace .html → file://; Vite localhost → that URL;
    // LLM API port (e.g. :8080) → never open llama UI, use workspace HTML instead.
    const openKind =
      classifyBrowserOpenCommand(command, this.getDenyPreviewPorts?.() ?? [8080]) ||
      classifyBrowserOpenCommand(rawCommand, this.getDenyPreviewPorts?.() ?? [8080])
    if (openKind?.kind === 'local_http') {
      this.onOpenPreview?.(openKind.url)
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: true,
        content:
          `Opened local preview in AFKLLM Browser:\nPREVIEW_URL: ${openKind.url}\n` +
          'Dev server URL (Vite etc.) — not the LLM API port.'
      }
    }
    if (openKind?.kind === 'llm_mistake' || openKind?.kind === 'workspace_html') {
      return this.openWorkspaceHtmlPreview(command, cwdRel, openKind.kind === 'llm_mistake')
    }

    const cwd =
      !cwdRel || cwdRel === '.' || cwdRel === './'
        ? this.projectRoot
        : this.safeResolve(cwdRel)

    if (this.confirmTerminal) {
      const allowed = await this.confirmTerminal(command, cwd)
      if (!allowed) {
        return {
          id: '',
          name: 'execute_terminal_command',
          ok: false,
          content: '',
          error: 'User rejected terminal command',
          needsConfirmation: true
        }
      }
    } else {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error: 'Terminal execution requires UI confirmation hook',
        needsConfirmation: true
      }
    }

    if (this.runVisibleCommand) {
      const result = await this.runVisibleCommand(command, cwd)
      return this.formatShellResult(command, result.output, result.exitCode, normalized.note)
    }

    const output = await this.runShell(command, cwd)
    const merged = [output.stdout, output.stderr].filter((s) => s.trim()).join('\n')
    return this.formatShellResult(command, merged, output.exitCode, normalized.note)
  }

  /** Resolve a repo HTML file and open it via file:// in the in-app Browser (no temp/shell). */
  private async openWorkspaceHtmlPreview(
    command: string,
    cwdRel: string,
    llmMistake = false
  ): Promise<AgentToolResult> {
    let rel = extractOpenHtmlRelativePath(command, cwdRel)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
    // Absolute paths outside the repo → force root index.html
    if (/^[a-zA-Z]:\//.test(rel) || rel.startsWith('/')) {
      const normRoot = normalize(this.projectRoot).toLowerCase()
      const normAbs = normalize(rel).toLowerCase()
      if (normAbs.startsWith(normRoot + sep.toLowerCase()) || normAbs.startsWith(normRoot + '/')) {
        rel = normalize(rel)
          .slice(normalize(this.projectRoot).length)
          .replace(/^[/\\]+/, '')
          .replace(/\\/g, '/')
      } else {
        rel = 'index.html'
      }
    }
    if (!rel || rel === '.' || !/\.html?$/i.test(rel)) {
      rel = rel && !/\.[a-z0-9]+$/i.test(rel) ? `${rel.replace(/\/$/, '')}/index.html` : 'index.html'
    }

    let abs: string
    try {
      abs = this.safeResolve(rel)
    } catch {
      rel = 'index.html'
      abs = this.safeResolve(rel)
    }

    try {
      await fs.access(abs)
    } catch {
      const fallback = this.safeResolve('index.html')
      try {
        await fs.access(fallback)
        rel = 'index.html'
        abs = fallback
      } catch {
        return {
          id: '',
          name: 'execute_terminal_command',
          ok: false,
          content: '',
          error:
            `PREVIEW_MISSING: "${rel}" is not in the workspace. Write the file first (write_file), then open preview. ` +
            'Do NOT Start-Process Chrome or http://127.0.0.1:8080 (LLM server).'
        }
      }
    }

    const fileUrl = pathToFileUrl(abs)
    this.onOpenPreview?.(fileUrl)
    const note = llmMistake
      ? 'Note: that localhost port is the AFKLLM LLM API — opened workspace HTML instead. For Vite use the Local: URL from npm run dev (e.g. :5173).'
      : 'Static HTML preview (file://). For Vite/dev servers, open the Local: URL from the serve command instead.'
    return {
      id: '',
      name: 'execute_terminal_command',
      ok: true,
      content:
        `Opened workspace file in AFKLLM Browser: ${rel.replace(/\\/g, '/')}\n` +
        `PREVIEW_URL: ${fileUrl}\n` +
        note
    }
  }

  private async readTerminal(args: Record<string, unknown>): Promise<AgentToolResult> {
    const maxChars =
      typeof args.max_chars === 'number' && args.max_chars > 0
        ? Math.min(args.max_chars, 40_000)
        : 8_000
    if (!this.readTerminalScrollback) {
      return {
        id: '',
        name: 'read_terminal',
        ok: false,
        content: '',
        error: 'Terminal scrollback is not available'
      }
    }
    const raw = this.readTerminalScrollback(maxChars)
    const text = stripAnsi(raw).trim()
    if (!text) {
      return {
        id: '',
        name: 'read_terminal',
        ok: true,
        content:
          '(terminal is empty — run execute_terminal_command first, or open the Terminal panel)'
      }
    }
    const focus = extractErrorFocus(text)
    return {
      id: '',
      name: 'read_terminal',
      ok: true,
      content:
        (focus
          ? `TERMINAL_ERROR_FOCUS (fix this first):\n${focus}\n\n--- full recent scrollback ---\n`
          : '') + text.slice(-maxChars)
    }
  }

  private async generateImage(args: Record<string, unknown>): Promise<AgentToolResult> {
    if (!this.generateImageFn) {
      return {
        id: '',
        name: 'generate_image',
        ok: false,
        content: '',
        error:
          'Image generation is not configured. Set imageGenModelPath (and FLUX sidecars if needed) in Settings → Multimodal.'
      }
    }
    return this.generateImageFn(args)
  }

  private formatShellResult(
    command: string,
    output: string,
    exitCode: number,
    normalizeNote?: string
  ): AgentToolResult {
    const noteLine = normalizeNote ? `note: ${normalizeNote}\n` : ''
    const body = stripAnsi(output).trim() || '(no output)'
    const denyPorts = this.getDenyPreviewPorts?.() ?? [8080]
    const preview = extractLocalPreviewUrl(body, { denyPorts })
    if (preview) {
      this.onOpenPreview?.(preview)
    } else if (looksLikeLocalServerCommand(command) && exitCode === 0) {
      // Preview URL arrives later via PTY stream → browser:open-url
    }
    if (exitCode === 0) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: true,
        content:
          `${noteLine}${body}\n\nexit_code=0` +
          (preview
            ? `\nPREVIEW_URL: ${preview} (opened in AFKLLM Browser)`
            : looksLikeLocalServerCommand(command)
              ? `\nNOTE: local server command — AFKLLM Browser opens when a Local/localhost URL appears in the terminal.`
              : '')
      }
    }
    if (exitCode === 130) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: `USER_STOPPED: command interrupted (exit_code=130)\ncommand: ${command}\n${noteLine}\n${body}`,
        error: 'Interrupted by Stop'
      }
    }
    // Windows Ctrl+C / console close (STATUS_CONTROL_C_EXIT)
    if (
      exitCode === 0xc000013a ||
      exitCode === -1073741510 ||
      exitCode === 3221225786
    ) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: true,
        content:
          `PROCESS_ENDED: interrupted by Ctrl+C / console close (exit_code=${exitCode})\n` +
          `command: ${command}\n` +
          `Do NOT rewrite or relaunch unless the user asks.\n` +
          noteLine +
          `\n${body}`
      }
    }

    const focus = extractErrorFocus(body)
    // No error markers → user closed GUI / process finished; don't label TERMINAL_ERROR
    // (that triggers rewrite/restart loops).
    if (!focus) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: true,
        content:
          `PROCESS_ENDED: process exited (exit_code=${exitCode}) with no compiler/runtime error traceback.\n` +
          `command: ${command}\n` +
          `This usually means the user closed the window or the program finished. ` +
          `Do NOT rewrite the program, do NOT relaunch it, and do NOT treat this as a bug — wait for the user's next instruction.\n` +
          noteLine +
          `\n${body}`
      }
    }

    const content =
      `TERMINAL_ERROR: command failed (exit_code=${exitCode})\n` +
      `command: ${command}\n` +
      noteLine +
      `\n` +
      `ERROR_FOCUS (read and fix THIS — do not guess):\n${focus}\n\n` +
      `FULL_OUTPUT:\n${body}\n\n` +
      `REQUIRED: open the file/line named in the traceback (read_file), apply_diff to fix the stated cause, then re-run the SAME command (use cwd=… instead of bash &&). Do not rewrite the whole project or drop the tech stack.`
    return {
      id: '',
      name: 'execute_terminal_command',
      ok: false,
      content,
      error: `Exit code ${exitCode}`
    }
  }

  /** Resolve a relative path and reject traversal outside the project root. */
  private safeResolve(relativePath: string): string {
    const raw = String(relativePath ?? '').trim()
    // "." / empty = project root (Explorer list_directory)
    if (!raw || raw === '.' || raw === './' || raw === '/' || raw === '\\') {
      return normalize(this.projectRoot)
    }

    // Models emit absolute Windows paths (D:\foo) → drive-root mkdir EPERM; rebase when possible
    let cleaned = raw.replace(/^[/\\]+/, '')
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
      const normRoot = normalize(this.projectRoot).toLowerCase()
      const normAbs = normalize(raw).toLowerCase()
      if (normAbs === normalize(this.projectRoot).toLowerCase()) {
        return normalize(this.projectRoot)
      }
      if (normAbs.startsWith(normRoot + sep.toLowerCase()) || normAbs.startsWith(normRoot + '/')) {
        cleaned = normalize(raw).slice(normalize(this.projectRoot).length).replace(/^[/\\]+/, '')
      } else {
        cleaned = raw.replace(/^[a-zA-Z]:[\\/]/, '').replace(/^[/\\]+/, '')
        if (!cleaned) {
          throw new Error(`Absolute path outside project root: ${raw}`)
        }
      }
    }

    if (!cleaned) {
      return normalize(this.projectRoot)
    }

    const abs = resolve(this.projectRoot, cleaned)
    const normRoot = normalize(this.projectRoot + sep)
    const normAbs = normalize(abs)

    if (normAbs !== normalize(this.projectRoot) && !normAbs.toLowerCase().startsWith(normRoot.toLowerCase())) {
      throw new Error(`Path escapes project root: ${relativePath}`)
    }

    // Refuse drive-root parents (D:\) for create/write
    const parent = dirname(abs)
    if (/^[a-zA-Z]:[\\/]?$/.test(parent) && normAbs !== normalize(this.projectRoot)) {
      throw new Error(
        `Refusing path under drive root (${parent}). Use a path relative to the project, e.g. src/file.ts`
      )
    }

    return abs
  }

  private async walk(
    root: string,
    current: string,
    maxDepth: number,
    depth = 0
  ): Promise<string[]> {
    if (depth > maxDepth) return []
    const out: string[] = []
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return out
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        out.push(rel + '/')
        out.push(...(await this.walk(root, full, maxDepth, depth + 1)))
      } else {
        out.push(rel)
      }
    }
    return out
  }

  /** Lightweight recursive grep (no ripgrep binary required). */
  private async grep(
    root: string,
    query: string,
    globFilter: string | undefined,
    limit: number
  ): Promise<string[]> {
    const results: string[] = []
    const needle = query.toLowerCase()
    const globRe = globFilter ? globToRegExp(globFilter) : null

    const visit = async (dir: string): Promise<void> => {
      if (results.length >= limit) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (results.length >= limit) return
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await visit(full)
          continue
        }
        const rel = relative(root, full).split(sep).join('/')
        if (globRe && !globRe.test(rel)) continue
        if (!isTextLike(entry.name)) continue

        let text: string
        try {
          text = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }

        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) return
          if (lines[i].toLowerCase().includes(needle)) {
            results.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`)
          }
        }
      }
    }

    await visit(root)
    return results
  }

  private runShell(
    command: string,
    cwd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise) => {
      const isWin = process.platform === 'win32'
      // Surface python/pip stderr; PS otherwise wraps exit codes
      const wrapped = isWin
        ? `$ErrorActionPreference='Continue'; ${command}; exit $LASTEXITCODE`
        : command
      const child = spawn(
        isWin ? 'powershell.exe' : 'bash',
        isWin ? ['-NoProfile', '-Command', wrapped] : ['-lc', command],
        {
          cwd,
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        }
      )

      let stdout = ''
      let stderr = ''
      const max = 200_000

      child.stdout?.on('data', (c: Buffer) => {
        if (stdout.length < max) stdout += c.toString()
      })
      child.stderr?.on('data', (c: Buffer) => {
        if (stderr.length < max) stderr += c.toString()
      })
      child.on('close', (code) => {
        resolvePromise({ stdout, stderr, exitCode: code ?? 1 })
      })
      child.on('error', (err) => {
        resolvePromise({ stdout: '', stderr: err.message, exitCode: 1 })
      })
    })
  }
}

/** Strip common ANSI / CSI sequences for cleaner agent-facing terminal text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')
}

/**
 * Pull the most actionable error slice (Python traceback, Error:, FAILED, etc.)
 * so the model fixes the real cause instead of guessing.
 * Returns null when there is no real error marker — do NOT fall back to "last N lines"
 * (that turns a user-closed GUI into a fake ERROR_FOCUS and triggers rewrite loops).
 */
function extractErrorFocus(text: string): string | null {
  const lines = text.split(/\n/)
  const markers: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (
      /Traceback \(most recent call last\)/i.test(l) ||
      /^[A-Za-z_][\w.]*Error:/i.test(l) ||
      /^Error:/i.test(l) ||
      /Exception in thread/i.test(l) ||
      /ModuleNotFoundError|ImportError|SyntaxError|NameError|TypeError|AttributeError|FileNotFoundError|IndentationError/i.test(
        l
      ) ||
      /\berror:|cannot find symbol|package .+ does not exist|\bjavac\b.*error/i.test(l) ||
      /\bFAILED\b|\bFAILURES!\b|AssertionError|Invoke-Expression|ParserError|not recognized/i.test(
        l
      )
    ) {
      markers.push(i)
    }
  }
  if (markers.length === 0) return null
  const start = markers[Math.max(0, markers.length - 3)]!
  return lines.slice(start).join('\n').trim().slice(-4000)
}

function isTextLike(filename: string): boolean {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const textExts = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
    '.md',
    '.txt',
    '.css',
    '.scss',
    '.html',
    '.htm',
    '.vue',
    '.svelte',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.cs',
    '.cpp',
    '.c',
    '.h',
    '.hpp',
    '.yml',
    '.yaml',
    '.toml',
    '.xml',
    '.svg',
    '.sh',
    '.ps1',
    '.bat',
    '.sql',
    '.graphql',
    '.env'
  ])
  return textExts.has(ext.toLowerCase()) || !ext
}

/** Minimal glob → RegExp (`**`, `*`, `?`, `{a,b}`). */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i += 2
      if (glob[i] === '/') i++
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end !== -1) {
        const opts = glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        re += `(?:${opts.join('|')})`
        i = end + 1
        continue
      }
    }
    if ('\\.[]()+^$|'.includes(c)) re += '\\' + c
    else re += c
    i++
  }
  re += '$'
  return new RegExp(re)
}

export { schemas as AGENT_TOOL_SCHEMAS }
