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
  extractErrorFocus,
  isUserInterruptExit,
  looksLikeGuiLaunchCommand,
  looksLikeShellFileMutation,
  powershellOperatorMisuse,
  productReadmeCloneRefusal,
  recursiveListingRefusal
} from '../../shared/shellErrors'
import {
  allowsFullOverwrite,
  isWholeFileSearchBlock,
  SMALL_FILE_OVERWRITE_CHARS,
  truncationGuardMessage
} from '../../shared/writeThresholds'
import {
  commandForMode,
  DEFAULT_IGNORE_DIRS,
  type VerifyMode
} from '../../shared/projectStack'
import { probeProjectStack } from '../context/StackProbe'
import type { DiagnosticsSnapshot } from '../../shared/diagnostics'
import {
  classifyBrowserOpenCommand,
  extractLocalPreviewUrl,
  extractOpenHtmlRelativePath,
  htmlDocumentComplete,
  isAfkllmInternalHtmlPath,
  looksLikeLocalServerCommand,
  pathToFileUrl
} from '../../shared/localPreview'
import { contentLooksStructurallyComplete } from '../../shared/completeness'
import { fastApplyEdit } from '../llama/ApplyEditClient'
import { locateApplyRegion, type ApplyRegion } from '../../shared/fastApply'

const IGNORED_DIRS = new Set<string>([...DEFAULT_IGNORE_DIRS])

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
  /**
   * Coresident apply llama-server base URL (port+1) when ready; null if unloaded.
   */
  getApplyBaseUrl?: () => string | null
  /** Apply slot ctx — sizes the apply prompt window and max_tokens. */
  getApplyCtxSize?: () => number | null
  /** Live apply-model tokens for the UI (a silent 60s call looked like a freeze). */
  onApplyToken?: (relativePath: string, token: string) => void
  /** Latest IDE diagnostics snapshot (tsc/eslint). */
  getDiagnostics?: () => DiagnosticsSnapshot
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
  private getApplyBaseUrl?: () => string | null
  private getApplyCtxSize?: () => number | null
  private onApplyToken?: AgentToolRegistryOptions['onApplyToken']
  private getDiagnostics?: () => DiagnosticsSnapshot
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
    this.getApplyBaseUrl = options.getApplyBaseUrl
    this.getApplyCtxSize = options.getApplyCtxSize
    this.onApplyToken = options.onApplyToken
    this.getDiagnostics = options.getDiagnostics
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
      ['generate_image', (a) => this.generateImage(a)],
      ['verify_project', (a) => this.verifyProject(a)],
      ['get_diagnostics', (a) => this.getDiagnosticsTool(a)]
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
          'MISSING_PATH: relative_path is required (e.g. "src/main.py", "index.html"). ' +
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
      const htmlDone = /\.html?$/i.test(relativePath) && htmlDocumentComplete(existing)
      const sourceDone =
        contentLooksStructurallyComplete(existing, relativePath) &&
        existing.length >= SMALL_FILE_OVERWRITE_CHARS
      if (htmlDone || sourceDone) {
        return {
          id: '',
          name: 'write_file',
          ok: false,
          content:
            `FILE_COMPLETE: "${relativePath}" already looks finished (${existing.length} bytes).\n` +
            'Do NOT rewrite the whole file. Use apply_diff / apply_patch for a small fix. File currently ends with:\n<<<\n' +
            tail +
            '\n>>>',
          error: `FILE_COMPLETE: ${relativePath} — do not overwrite; patch instead`
        }
      }
      const small = allowsFullOverwrite(relativePath, existing.length)
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content:
          `FILE_EXISTS: "${relativePath}" already has ${existing.length} bytes.\n` +
          (small
            ? `This is a small file. Call write_file again with overwrite=true and the FULL corrected content.\n`
            : `Do NOT rewrite from scratch. Use apply_patch / apply_diff to edit, or append=true to continue.\n`) +
          `File currently ends with:\n<<<\n${tail}\n>>>`,
        error: small
          ? `FILE_EXISTS: ${relativePath} — use overwrite=true for this small file`
          : `FILE_EXISTS: ${relativePath} — use append=true or apply_diff`
      }
    }

    const existingComplete =
      (/\.html?$/i.test(relativePath) && htmlDocumentComplete(existing)) ||
      contentLooksStructurallyComplete(existing, relativePath)
    const incomingComplete = contentLooksStructurallyComplete(content, relativePath)

    // Never clobber a finished file with a truncated rewrite.
    if (
      overwrite &&
      !append &&
      existed &&
      existingComplete &&
      !incomingComplete &&
      !Boolean(args.allow_full_rewrite)
    ) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content: '',
        error:
          `FILE_COMPLETE: "${relativePath}" already looks finished. ` +
          'Refusing to overwrite it with incomplete content. Use apply_diff or send a complete file.'
      }
    }

    if (overwrite && !append && existed) {
      const complete = existingComplete || existing.length >= 800
      const guard = truncationGuardMessage({
        relativePath,
        existingBytes: existing.length,
        newBytes: content.length,
        allowFullRewrite: Boolean(args.allow_full_rewrite),
        existingComplete: complete
      })
      if (guard) {
        return {
          id: '',
          name: 'write_file',
          ok: false,
          content: guard,
          error: guard
        }
      }
    }

    // A finished large file is edited, never regenerated.
    if (
      overwrite &&
      !append &&
      existed &&
      existingComplete &&
      existing.length >= SMALL_FILE_OVERWRITE_CHARS &&
      incomingComplete &&
      !Boolean(args.allow_full_rewrite)
    ) {
      return {
        id: '',
        name: 'write_file',
        ok: false,
        content:
          `FILE_COMPLETE: "${relativePath}" already looks finished (${existing.length} bytes).\n` +
          'Do NOT regenerate the file. Make the requested change with apply_diff ' +
          '(replace_all=true for a global rename), one edit per distinct snippet.',
        error: `FILE_COMPLETE: ${relativePath} — use apply_diff; full rewrite blocked`
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
    const sourceComplete = contentLooksStructurallyComplete(writtenBody, relativePath)
    const closesHtml = /<\/html\s*>/i.test(writtenBody)
    const closesBody = /<\/body\s*>/i.test(writtenBody)
    const htmlHint =
      /\.html?$/i.test(relativePath) || /<!DOCTYPE\s+html|<html[\s>]/i.test(writtenBody)
        ? ` lines=${lineCount} closes_with_</body>=${closesBody ? 'yes' : 'no'} closes_with_</html>=${closesHtml ? 'yes' : 'no'}.` +
          (closesHtml
            ? ' FILE_COMPLETE — do not rewrite just to "finish the tail".'
            : ' If incomplete, append=true on the SAME path (do not invent a new file).')
        : ` lines=${lineCount}.` +
          (sourceComplete
            ? ' FILE_COMPLETE — do not rewrite just to "finish the tail".'
            : ' If incomplete, append=true on the SAME path (do not invent a new file).')
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
    const relativePath = String(args.relative_path ?? '').trim()
    const searchBlock = String(args.search_block ?? '')
    const replaceBlock = String(args.replace_block ?? '')
    const replaceAll = Boolean(args.replace_all)
    const instructionArg = String(args.instruction ?? '').trim()

    if (!relativePath) {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error:
          'MISSING_PATH: relative_path is required for apply_diff (e.g. "js/main.js"). ' +
          'Do not call apply_diff without a path.'
      }
    }

    if (!searchBlock && !instructionArg) {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error: 'search_block is empty (or pass instruction for apply-model edit)'
      }
    }

    // "Replace entire HTML / complete single-page landing" via instruction is a full
    // rewrite in disguise — hangs apply model and fights FILE_COMPLETE.
    const fullRewriteIntent =
      /replace\s+entire|entire\s+html|whole\s+(html|file|landing|module)|полный\s+(html|файл|лендинг|модул)|перепис\w*\s+(весь|целиком|полностью)|rewrite\s+(the\s+)?(whole|entire|full)|complete\s+single[- ]?page\s+landing|replace\s+.*\s+with\s+a\s+complete/i.test(
        instructionArg
      )

    let effectivePath = relativePath
    let abs = this.safeResolve(relativePath)
    let original: string
    try {
      original = await fs.readFile(abs, 'utf8')
    } catch {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error: `${relativePath}: file not found. list_directory / read_file the real path, then apply_diff on that file.`
      }
    }

    const fileComplete =
      original.length >= 1500 &&
      ((/\.html?$/i.test(effectivePath) && /<\/html\s*>/i.test(original)) ||
        contentLooksStructurallyComplete(original, effectivePath))

    if (fileComplete && fullRewriteIntent && !searchBlock.trim()) {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error:
          'SURGICAL_EDIT: instruction asks to replace the entire file. Forbidden on a complete file. ' +
          'Use a SHORT surgical instruction or search_block+replace_block. ' +
          'Then verify / summarize — do NOT rewrite the whole file.'
      }
    }

    if (fileComplete && isWholeFileSearchBlock(searchBlock.length, original.length)) {
      return {
        id: '',
        name: 'apply_diff',
        ok: false,
        content: '',
        error:
          'SURGICAL_EDIT: search_block covers most of this complete file. Forbidden. ' +
          'Pass a SHORT unique snippet (typically < 80 lines), not the whole file. ' +
          'Do NOT rewrite this file.'
      }
    }

    if (searchBlock) {
      const applied = applySearchReplaceFuzzy(
        original,
        searchBlock,
        replaceBlock,
        replaceAll
      )
      if (applied.ok) {
        this.rememberEdit(effectivePath, true, original)
        await fs.writeFile(abs, applied.content, 'utf8')
        this.notifyChange(effectivePath)
        const pathKey = effectivePath.replace(/\\/g, '/')
        const redirNote =
          effectivePath !== relativePath
            ? ` (retargeted from ${relativePath} — single-file page, CSS/JS is inline)`
            : ''
        const countNote =
          applied.replacements > 1
            ? ` (${applied.replacements} replacements)`
            : ''
        return {
          id: '',
          name: 'apply_diff',
          ok: true,
          content: `Applied diff to ${effectivePath}${applied.normalized ? ' (normalized newlines)' : ''}${countNote}${redirNote}`,
          editReview: { path: pathKey, status: 'pending' }
        }
      }
      if (/replace_all=true|matched \d+ times/i.test(applied.error)) {
        return {
          id: '',
          name: 'apply_diff',
          ok: false,
          content: '',
          error: applied.error
        }
      }
    }

    const instruction =
      instructionArg ||
      (searchBlock
        ? `Replace the following exact snippet with the replacement.\n\nSEARCH:\n${searchBlock}\n\nREPLACE:\n${replaceBlock}`
        : '')

    return this.smartApplyToFile({
      toolName: 'apply_diff',
      relativePath: effectivePath,
      abs,
      original,
      instruction,
      region: locateApplyRegion(original, searchBlock, instructionArg),
      timeoutMs:
        typeof args.timeout_ms === 'number' && args.timeout_ms > 0
          ? Math.min(90_000, Math.floor(args.timeout_ms))
          : undefined,
      maxAttempts:
        typeof args.max_attempts === 'number' && args.max_attempts >= 1
          ? Math.min(2, Math.floor(args.max_attempts))
          : undefined,
      retargetNote:
        effectivePath !== relativePath
          ? ` (retargeted from ${relativePath})`
          : ''
    })
  }

  /**
   * Morph-style edit via coresident apply model when fuzzy/search fails.
   */
  private async smartApplyToFile(opts: {
    toolName: 'apply_diff' | 'apply_patch'
    relativePath: string
    abs: string
    original: string
    instruction: string
    retargetNote?: string
    /** Line range the edit targets — the prompt window centers on it. */
    region?: ApplyRegion
    /** Cap apply wait (default 60s). Keep short for parse-fail fallbacks. */
    timeoutMs?: number
    /** 1 = no retry (fail fast). Default 2. */
    maxAttempts?: number
  }): Promise<AgentToolResult> {
    const baseUrl = this.getApplyBaseUrl?.() ?? null
    if (!baseUrl) {
      return {
        id: '',
        name: opts.toolName,
        ok: false,
        content: '',
        error:
          'APPLY_UNAVAILABLE: apply model is not loaded (Settings → Apply model → Load). ' +
          'Do NOT re-read or full-rewrite; ask the user to Load chat+apply, or summarize failure.'
      }
    }
    if (!opts.instruction.trim()) {
      return {
        id: '',
        name: opts.toolName,
        ok: false,
        content: '',
        error: 'SMART_APPLY_FAIL: empty instruction'
      }
    }

    const result = await fastApplyEdit({
      baseUrl,
      instruction: opts.instruction,
      filePath: opts.relativePath,
      content: opts.original,
      region: opts.region,
      ctxSize: this.getApplyCtxSize?.() ?? undefined,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxAttempts: opts.maxAttempts ?? 2,
      onToken: (token) => this.onApplyToken?.(opts.relativePath, token)
    })

    if (!result.ok) {
      return {
        id: '',
        name: opts.toolName,
        ok: false,
        content: result.error,
        error: result.error
      }
    }

    this.rememberEdit(opts.relativePath, true, opts.original)
    await fs.writeFile(opts.abs, result.content, 'utf8')
    this.notifyChange(opts.relativePath)
    const pathKey = opts.relativePath.replace(/\\/g, '/')
    return {
      id: '',
      name: opts.toolName,
      ok: true,
      content: `Applied via apply model (${result.applied} block(s)) to ${opts.relativePath}${opts.retargetNote ?? ''}`,
      editReview: { path: pathKey, status: 'pending' }
    }
  }

  private async applyPatch(args: Record<string, unknown>): Promise<AgentToolResult> {
    const patchText = String(args.patch ?? '')
    const parsed = parseApplyPatch(patchText)
    if (!parsed.ok) {
      const guessed =
        patchText.match(/\*\*\*\s*(?:Update|Add)\s+File:\s*([^\n*]+)/i)?.[1]?.trim() ||
        ''
      // Do NOT dump the whole malformed patch into the apply model — that often
      // hangs 1–2 minutes after "*** End Patch" with no UI progress. Prefer a
      // short +line intent, else fail fast to apply_diff.
      const plusIntent = [...patchText.matchAll(/^\+(?!\+\+)(.*)$/gm)]
        .map((m) => m[1] ?? '')
        .join('\n')
        .trim()
        .slice(0, 2_500)
      if (plusIntent.length >= 24 && guessed) {
        try {
          const abs = this.safeResolve(guessed)
          const original = await fs.readFile(abs, 'utf8')
          return this.smartApplyToFile({
            toolName: 'apply_patch',
            relativePath: guessed.replace(/\\/g, '/'),
            abs,
            original,
            instruction:
              `Apply ONLY this intended addition/change (malformed apply_patch):\n${plusIntent}`,
            region: locateApplyRegion(original, '', plusIntent),
            timeoutMs: 45_000
          })
        } catch {
          /* fall through to fast fail */
        }
      }
      return {
        id: '',
        name: 'apply_patch',
        ok: false,
        content: '',
        error:
          `apply_patch parse error: ${parsed.error ?? 'invalid'}. ` +
          'Prefer apply_diff (relative_path + short search_block or instruction); do not re-send the same malformed patch.'
      }
    }

    const changed: Array<{ path: string; action: string }> = []
    const errors: string[] = []
    let firstReviewPath: string | null = null
    let lastFailedUpdate: {
      path: string
      abs: string
      original: string
      /** Context/removed lines of the failed hunk — anchors the apply window. */
      failedContext: string
    } | null = null

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
        let updateAbs = abs
        let updatePath = pathKey
        try {
          original = await fs.readFile(abs, 'utf8')
        } catch {
          errors.push(`${pathKey}: file not found`)
          continue
        }
        const applied = applyHunksToText(original, op.hunks ?? [])
        if (!applied.ok || applied.content == null) {
          errors.push(`${updatePath}: ${applied.error ?? 'hunk apply failed'}`)
          lastFailedUpdate = {
            path: updatePath,
            abs: updateAbs,
            original,
            failedContext: (op.hunks ?? [])
              .flatMap((h) => h.lines)
              .filter((l) => l.kind !== '+')
              .map((l) => l.text)
              .join('\n')
              .slice(0, 2_000)
          }
          continue
        }
        this.rememberEdit(updatePath, true, original)
        await fs.writeFile(updateAbs, applied.content, 'utf8')
        this.notifyChange(updatePath)
        changed.push({ path: updatePath, action: 'update' })
        if (!firstReviewPath) firstReviewPath = updatePath
      } catch (err) {
        errors.push(
          `${op.path}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (changed.length === 0 && lastFailedUpdate) {
      const plusIntent = [...patchText.matchAll(/^\+(?!\+\+)(.*)$/gm)]
        .map((m) => m[1] ?? '')
        .join('\n')
        .trim()
        .slice(0, 2_500)
      return this.smartApplyToFile({
        toolName: 'apply_patch',
        relativePath: lastFailedUpdate.path,
        abs: lastFailedUpdate.abs,
        original: lastFailedUpdate.original,
        instruction:
          plusIntent.length >= 24
            ? `Apply ONLY this intended change (hunks failed):\n${plusIntent}`
            : `Apply this patch intent (deterministic hunks failed).\n\n${patchText.slice(0, 4_000)}`,
        region: locateApplyRegion(
          lastFailedUpdate.original,
          lastFailedUpdate.failedContext,
          plusIntent
        ),
        timeoutMs: 45_000
      })
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
    // BM25 drops punctuation, so "<style>" / ".hero {" / "-->" only work as a
    // literal grep. Sending those to the index returned a confident "0 hits".
    const literalQuery = /[<>{}()[\];:="'`*+\\|@#$&!?]/.test(query)
    // BM25 when ready; glob and literal queries use walk-grep
    if (!glob && !literalQuery && this.contextIndex?.isReady()) {
      const hit = this.contextIndex.query(query)
      // hits>0, not text.trim(): an empty result still carries a "hits=0" header
      // and used to short-circuit the grep fallback entirely.
      if (hit && hit.hits > 0) {
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
      content: matches.length
        ? matches.join('\n')
        : `No matches found for ${query}. Try a shorter literal fragment (one selector, tag or identifier).`
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

    if (looksLikeShellFileMutation(command) || looksLikeShellFileMutation(rawCommand)) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error:
          'SHELL_EDIT_FORBIDDEN: shell text substitution cannot edit workspace files — ' +
          'it bypasses the diff review, the file tree refresh and rewind (the change cannot be undone). ' +
          'Global rename: apply_diff with replace_all=true. New file: write_file. Delete: delete_file.'
      }
    }

    const operatorMisuse =
      powershellOperatorMisuse(command) ?? powershellOperatorMisuse(rawCommand)
    if (operatorMisuse) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error: operatorMisuse
      }
    }

    const recurseRefuse =
      recursiveListingRefusal(command) ?? recursiveListingRefusal(rawCommand)
    if (recurseRefuse) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error: recurseRefuse
      }
    }

    const cloneRefuse =
      productReadmeCloneRefusal(command) ?? productReadmeCloneRefusal(rawCommand)
    if (cloneRefuse) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: false,
        content: '',
        error: cloneRefuse
      }
    }

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
    if (isAfkllmInternalHtmlPath(rel) || /(?:^|\/)browser\.html$/i.test(rel)) {
      rel = 'index.html'
    }
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
      if (rel && /\.[a-z0-9]+$/i.test(rel) && !/\.html?$/i.test(rel)) {
        try {
          const snap = await probeProjectStack(this.projectRoot)
          const htmlOnly =
            snap.stacks.length > 0 && snap.stacks.every((s) => s.id === 'html')
          if (!htmlOnly) {
            return {
              id: '',
              name: 'execute_terminal_command',
              ok: false,
              content: '',
              error:
                `Not an HTML preview (${rel}). Use the stack run/test command or pass an .html path — ` +
                'do not retarget to index.html on a compiler project.'
            }
          }
        } catch {
          /* fall through to html fallback */
        }
      }
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

  private async verifyProject(args: Record<string, unknown>): Promise<AgentToolResult> {
    const modeRaw = String(args.mode ?? 'build').toLowerCase()
    const mode: VerifyMode =
      modeRaw === 'test' || modeRaw === 'lint' || modeRaw === 'run' || modeRaw === 'build'
        ? modeRaw
        : 'build'
    const override = String(args.command ?? '').trim()
    let command = override
    let snap: Awaited<ReturnType<typeof probeProjectStack>> | null = null
    if (!command) {
      snap = await probeProjectStack(this.projectRoot)
      for (const stack of snap.stacks) {
        const cmd = commandForMode(stack, mode)
        if (cmd) {
          command = cmd
          break
        }
      }
    }
    if (!command) {
      if (!snap) snap = await probeProjectStack(this.projectRoot)
      if (snap.stacks.some((s) => s.id === 'html')) {
        return this.verifyStaticHtmlOnce(mode)
      }
      return {
        id: '',
        name: 'verify_project',
        ok: false,
        content: '',
        error:
          `No ${mode} command for the detected stack. Pass command=… explicitly, or add a stack marker ` +
          `(package.json, pom.xml, go.mod, Cargo.toml, CMakeLists.txt, *.csproj, requirements.txt).`
      }
    }
    const result = await this.executeTerminal({
      command,
      cwd: typeof args.cwd === 'string' ? args.cwd : '.'
    })
    return {
      ...result,
      name: 'verify_project',
      content: `verify_project mode=${mode}\ncommand: ${command}\n\n${result.content}`
    }
  }

  /**
   * Static HTML has no compiler. One shallow existence check of known entry
   * files — never a recursive tree walk or Test-Path spam.
   */
  private async verifyStaticHtmlOnce(mode: VerifyMode): Promise<AgentToolResult> {
    const candidates = ['index.html', 'styles.css', 'css/styles.css', 'js/main.js', 'main.js']
    const lines: string[] = []
    let indexOk = false
    for (const rel of candidates) {
      try {
        await fs.access(this.safeResolve(rel))
        lines.push(`OK  ${rel}`)
        if (rel === 'index.html') indexOk = true
      } catch {
        if (rel === 'index.html') lines.push(`MISS ${rel}`)
      }
    }
    const hint =
      'Static HTML: no build/test/lint. This one-shot check is enough. ' +
      'Preview once with: Start-Process (Resolve-Path .\\index.html). ' +
      'Do NOT Get-ChildItem -Recurse or spam Test-Path.'
    return {
      id: '',
      name: 'verify_project',
      ok: indexOk,
      content: `verify_project mode=${mode} (static HTML, one-shot)\n${lines.join('\n')}\n\n${hint}`,
      error: indexOk ? undefined : 'index.html missing at project root'
    }
  }

  private async getDiagnosticsTool(_args: Record<string, unknown>): Promise<AgentToolResult> {
    const snap = this.getDiagnostics?.()
    if (!snap) {
      return {
        id: '',
        name: 'get_diagnostics',
        ok: true,
        content: 'No diagnostics snapshot yet (workspace not indexed / not run).'
      }
    }
    const items = snap.items ?? []
    if (items.length === 0) {
      return {
        id: '',
        name: 'get_diagnostics',
        ok: true,
        content: `No diagnostics.${snap.note ? ` (${snap.note})` : ''}`
      }
    }
    const lines = items.slice(0, 80).map((d) => {
      return `${d.severity} ${d.path}:${d.line}:${d.column} [${d.source}] ${d.message}`
    })
    const extra = items.length > 80 ? `\n…and ${items.length - 80} more` : ''
    return {
      id: '',
      name: 'get_diagnostics',
      ok: true,
      content: `${lines.join('\n')}${extra}`
    }
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
    if (isUserInterruptExit(exitCode)) {
      const stopped = exitCode === 130
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: !stopped,
        content: stopped
          ? `USER_STOPPED: command interrupted (exit_code=130)\ncommand: ${command}\n${noteLine}\n${body}`
          : `PROCESS_ENDED: interrupted by Ctrl+C / console close (exit_code=${exitCode})\n` +
            `command: ${command}\n` +
            `Do NOT rewrite or relaunch unless the user asks.\n` +
            noteLine +
            `\n${body}`,
        error: stopped ? 'Interrupted by Stop' : undefined
      }
    }

    const focus = extractErrorFocus(body)
    // GUI launch closed by the user (no compiler markers) — not a build failure.
    if (!focus && looksLikeGuiLaunchCommand(command)) {
      return {
        id: '',
        name: 'execute_terminal_command',
        ok: true,
        content:
          `PROCESS_ENDED: GUI/process closed (exit_code=${exitCode}) with no compiler/runtime traceback.\n` +
          `command: ${command}\n` +
          `Do NOT rewrite or relaunch unless the user asks.\n` +
          noteLine +
          `\n${body}`
      }
    }

    const focusOrTail =
      focus ||
      body
        .split(/\n/)
        .slice(-40)
        .join('\n')
        .trim()
        .slice(-4000) ||
      '(no output)'
    const content =
      `TERMINAL_ERROR: command failed (exit_code=${exitCode})\n` +
      `command: ${command}\n` +
      noteLine +
      `\n` +
      `ERROR_FOCUS (read and fix THIS — do not guess):\n${focusOrTail}\n\n` +
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
    '.cc',
    '.cxx',
    '.c',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.m',
    '.mm',
    '.swift',
    '.rb',
    '.php',
    '.lua',
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
    '.cmake',
    '.gradle',
    '.proto',
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
