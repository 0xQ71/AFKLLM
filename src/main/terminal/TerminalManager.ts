import * as pty from 'node-pty'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow } from 'electron'
import { extractLocalPreviewUrl } from '../../shared/localPreview'

export interface TerminalSession {
  id: string
  cwd: string
}

export interface TerminalCommandResult {
  output: string
  exitCode: number
}

/** IDE PTY sessions; agent shell shares the visible primary so users can watch. */
export class TerminalManager {
  private sessions = new Map<string, pty.IPty>()
  private sessionCwd = new Map<string, string>()
  private scrollback = new Map<string, string>()
  private primaryId: string | null = null
  private window: BrowserWindow | null = null
  private dataListeners = new Set<(id: string, data: string) => void>()
  /** Stop button cancels in-flight runVisibleCommand. */
  private activeCommandCancel: (() => void) | null = null
  /** Blocks UI keystrokes during inject (IME races → сWrite-Host). */
  private agentInputLocked = false
  private previewScanBuf = ''
  private lastPreviewUrl: string | null = null
  private lastPreviewAt = 0

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  ensureOpen(): void {
    this.window?.webContents.send('terminal:ensure-open')
  }

  /** Open in-app browser when localhost / Local: URLs appear in PTY output. */
  private scanLocalPreview(chunk: string): void {
    const stripped = chunk
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\r/g, '')
    this.previewScanBuf = (this.previewScanBuf + stripped).slice(-6_000)
    const url = extractLocalPreviewUrl(this.previewScanBuf)
    if (!url) return
    const now = Date.now()
    if (url === this.lastPreviewUrl && now - this.lastPreviewAt < 12_000) return
    this.lastPreviewUrl = url
    this.lastPreviewAt = now
    this.window?.webContents.send('browser:open-url', { url })
  }

  isAgentInputLocked(): boolean {
    return this.agentInputLocked
  }

  private strippedPsReadLine = new Set<string>()

  /** Reuse primary session (create if missing) for UI + agent shell. */
  ensure(cwd: string): TerminalSession {
    if (this.primaryId && this.sessions.has(this.primaryId)) {
      const id = this.primaryId
      if (!this.strippedPsReadLine.has(id)) {
        this.write(
          id,
          'Remove-Module PSReadLine -ErrorAction SilentlyContinue\r'
        )
        this.strippedPsReadLine.add(id)
      }
      const current = this.sessionCwd.get(id) ?? cwd
      if (normalizePath(current) !== normalizePath(cwd)) {
        this.write(id, this.cdCommand(cwd) + '\r')
        this.sessionCwd.set(id, cwd)
      }
      return { id, cwd }
    }
    return this.create(cwd, true)
  }

  create(cwd: string, asPrimary = false): TerminalSession {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    // -NoProfile; drop PSReadLine so predictions can't corrupt agent injects
    const winShell = 'powershell.exe'
    const args =
      process.platform === 'win32'
        ? [
            '-NoLogo',
            '-NoProfile',
            '-NoExit',
            '-Command',
            "Remove-Module PSReadLine -ErrorAction SilentlyContinue; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"
          ]
        : []

    const shell =
      process.platform === 'win32' ? winShell : process.env.SHELL || '/bin/bash'

    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 28,
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        TERM: 'xterm-256color'
      }
    })

    this.scrollback.set(id, '')
    term.onData((data) => {
      const prev = this.scrollback.get(id) ?? ''
      const next = (prev + data).slice(-80_000)
      this.scrollback.set(id, next)
      this.window?.webContents.send('terminal:data', { id, data })
      for (const listener of this.dataListeners) listener(id, data)
      this.scanLocalPreview(data)
    })

    term.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      this.sessionCwd.delete(id)
      this.scrollback.delete(id)
      this.strippedPsReadLine.delete(id)
      if (this.primaryId === id) this.primaryId = null
      this.window?.webContents.send('terminal:exit', { id, exitCode })
    })

    this.sessions.set(id, term)
    this.sessionCwd.set(id, cwd)
    this.strippedPsReadLine.add(id) // already stripped at spawn on Windows
    if (asPrimary || !this.primaryId) this.primaryId = id
    return { id, cwd }
  }

  getScrollback(id: string): string {
    return this.scrollback.get(id) ?? ''
  }

  getPrimaryScrollback(maxChars = 8_000): string {
    const id = this.getPrimaryId()
    if (!id) return ''
    const full = this.scrollback.get(id) ?? ''
    return full.slice(-Math.max(500, maxChars))
  }

  getPrimaryId(): string | null {
    return this.primaryId && this.sessions.has(this.primaryId) ? this.primaryId : null
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  /** Drop UI keystrokes while agent command is injecting/running. */
  writeFromUi(id: string, data: string): void {
    if (this.agentInputLocked) return
    this.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.resize(cols, rows)
    } catch {
      /* ignore */
    }
  }

  kill(id: string): void {
    const term = this.sessions.get(id)
    if (!term) return
    try {
      term.kill()
    } catch {
      /* ignore */
    }
    this.sessions.delete(id)
    this.sessionCwd.delete(id)
    this.scrollback.delete(id)
    this.strippedPsReadLine.delete(id)
    if (this.primaryId === id) this.primaryId = null
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id)
    }
  }

  /** Ctrl+C active agent shell and unblock waiters (Stop button). */
  interruptActiveCommand(): boolean {
    if (!this.activeCommandCancel) {
      if (this.primaryId && this.sessions.has(this.primaryId)) {
        this.write(this.primaryId, '\x03')
      }
      return false
    }
    this.activeCommandCancel()
    return true
  }

  /**
   * Run in visible primary PTY until exit marker.
   * @param timeoutMs 0 = wait until exit / interrupt (no soft timeout)
   */
  async runVisibleCommand(
    command: string,
    cwd: string,
    timeoutMs = 0
  ): Promise<TerminalCommandResult> {
    if (this.activeCommandCancel) {
      this.activeCommandCancel()
      await sleep(80)
    }

    this.ensureOpen()
    const session = this.ensure(cwd)
    await sleep(200)

    const marker = `__AFK_EXIT_${Date.now().toString(36)}__`
    let buf = ''

    const strip = (s: string): string =>
      s
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '')

    this.agentInputLocked = true

    try {
      await this.flushPromptLine(session.id)
    } catch {
      this.agentInputLocked = false
      return { output: '', exitCode: 1 }
    }

    return new Promise((resolvePromise) => {
      let settled = false
      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        this.agentInputLocked = false
        if (timer) clearTimeout(timer)
        if (this.activeCommandCancel === cancel) this.activeCommandCancel = null
        this.dataListeners.delete(onData)
        const plain = strip(buf)
        const cleaned = plain
          .replace(new RegExp(`${marker}\\d+\\s*$`), '')
          .trim()
        resolvePromise({ output: cleaned, exitCode })
      }

      const cancel = (): void => {
        this.write(session.id, '\x03')
        setTimeout(() => {
          if (!settled) this.write(session.id, '\x03')
        }, 120)
        finish(130)
      }

      const onData = (id: string, data: string): void => {
        if (id !== session.id) return
        buf += data
        const plain = strip(buf)
        const idx = plain.lastIndexOf(marker)
        if (idx >= 0) {
          const after = plain.slice(idx + marker.length)
          const m = after.match(/^(\d+)/)
          if (m) finish(Number(m[1]))
        }
      }

      this.dataListeners.add(onData)
      this.activeCommandCancel = cancel

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.write(session.id, '\x03')
              finish(124)
            }, timeoutMs)
          : null

      const script = this.wrapCommand(command, marker)
      this.write(session.id, script + '\r')
    })
  }

  /** Clear prompt before inject; Enter flushes leaked IME chars as a no-op. */
  private async flushPromptLine(id: string): Promise<void> {
    this.write(id, '\x03') // Ctrl+C
    await sleep(60)
    this.write(id, '\x15') // Ctrl+U
    this.write(id, '\x7f'.repeat(32))
    this.write(id, '\b'.repeat(32))
    await sleep(40)
    this.write(id, '\r')
    await sleep(120)
  }

  /** Temp .ps1 holds real logic — host line stays ASCII to avoid IME glue. */
  private wrapCommand(command: string, marker: string): string {
    const safe = command.replace(/\r?\n/g, '; ')
    if (process.platform === 'win32') {
      const cmdB64 = Buffer.from(safe, 'utf16le').toString('base64')
      const inner = [
        `$ErrorActionPreference = 'Continue'`,
        `$__afk = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${cmdB64}'))`,
        `Write-Host ('> ' + $__afk)`,
        `$__afk_ec = 0; $global:LASTEXITCODE = 0`,
        `try { Invoke-Expression -Command $__afk } catch { Write-Host $_; $__afk_ec = 1 }`,
        `if ($__afk_ec -eq 0) { if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__afk_ec = [int]$LASTEXITCODE } elseif (-not $?) { $__afk_ec = 1 } }`,
        `Write-Host ('${marker}' + $__afk_ec)`
      ].join('\r\n')

      const ps1 = join(tmpdir(), `afk-run-${Date.now().toString(36)}.ps1`)
      writeFileSync(ps1, '\uFEFF' + inner, 'utf8') // BOM for Windows PowerShell 5.1
      const lit = ps1.replace(/'/g, "''")
      return `& '${lit}'; Remove-Item -LiteralPath '${lit}' -Force -ErrorAction SilentlyContinue`
    }
    const b64 = Buffer.from(safe, 'utf8').toString('base64')
    return (
      `echo; _afk=$(echo '${b64}' | base64 -d); echo "> $_afk"; ` +
      `eval "$_afk"; echo ${marker}$?`
    )
  }

  private cdCommand(cwd: string): string {
    if (process.platform === 'win32') {
      return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`
    }
    return `cd ${JSON.stringify(cwd)}`
  }
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
