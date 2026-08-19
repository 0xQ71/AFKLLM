import * as pty from 'node-pty'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { extractLocalPreviewUrl, looksLikeLocalServerCommand } from '../../shared/localPreview'
import { stripAfkPtyChrome } from '../../shared/shellNormalize'
import {
  AGENT_SHELL_HARD_TIMEOUT_MS,
  AGENT_SHELL_IDLE_TIMEOUT_MS,
  POWERSHELL_AGENT_PTY_INIT,
  SHELL_TIMEOUT_EXIT,
  shellWatchdogFired
} from '../../shared/shellErrors'

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
  /** Blocks UI keystrokes only during inject (IME races). */
  private agentInputLocked = false
  /** When true, auto-answer CLI y/n prompts while an agent command runs. */
  private autoConfirmGetter: (() => boolean) | null = null
  private autoYesSent = false
  private autoYesAt = 0
  private previewScanBuf = ''
  private lastPreviewUrl: string | null = null
  private lastPreviewAt = 0
  private denyPreviewPorts: number[] = [8080]
  /** Dev server still occupying the PTY after Local: URL (timeoutMs=0). */
  private liveLocalServer = false

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  setDenyPreviewPorts(ports: number[]): void {
    this.denyPreviewPorts = ports.length > 0 ? ports : [8080]
  }

  setAutoConfirm(getter: (() => boolean) | null): void {
    this.autoConfirmGetter = getter
  }

  hasLiveLocalServer(): boolean {
    return this.liveLocalServer
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
    const url = extractLocalPreviewUrl(this.previewScanBuf, {
      denyPorts: this.denyPreviewPorts
    })
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
            POWERSHELL_AGENT_PTY_INIT
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

  /** Drop UI keystrokes only while agent is injecting the command line. */
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
   * @param timeoutMs 0 = wait until exit / interrupt (dev servers). Default agent hard timeout.
   */
  async runVisibleCommand(
    command: string,
    cwd: string,
    timeoutMs: number = AGENT_SHELL_HARD_TIMEOUT_MS
  ): Promise<TerminalCommandResult> {
    if (this.activeCommandCancel) {
      this.activeCommandCancel()
      await sleep(80)
    }

    this.ensureOpen()
    const session = this.ensure(cwd)
    await sleep(200)

    if (this.liveLocalServer && timeoutMs !== 0 && !looksLikeLocalServerCommand(command)) {
      this.agentInputLocked = false
      return {
        output:
          'NOTE: a local dev server is still running in this terminal. ' +
          'Command was not injected (Ctrl+C would kill Vite). Open the Local: URL instead.',
        exitCode: 0
      }
    }
    if (looksLikeLocalServerCommand(command)) {
      this.liveLocalServer = false
    }

    const marker = `__AFK_EXIT_${Date.now().toString(36)}__`
    let buf = ''

    const strip = (s: string): string =>
      s
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '')

    this.agentInputLocked = true
    this.autoYesSent = false
    this.autoYesAt = 0

    try {
      await this.flushPromptLine(session.id)
    } catch {
      this.agentInputLocked = false
      return { output: '', exitCode: 1 }
    }

    return new Promise((resolvePromise) => {
      let settled = false
      const startedAt = Date.now()
      let lastOutputAt = startedAt
      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        this.agentInputLocked = false
        if (watch) clearInterval(watch)
        if (this.activeCommandCancel === cancel) this.activeCommandCancel = null
        this.dataListeners.delete(onData)
        const plain = strip(buf)
        const cleaned = stripAfkPtyChrome(
          plain.replace(new RegExp(`${marker}\\d+\\s*$`), '')
        ).trim()
        resolvePromise({ output: cleaned, exitCode })
      }

      const interruptTree = (): void => {
        this.liveLocalServer = false
        this.write(session.id, '\x03')
        const pid = this.sessions.get(session.id)?.pid
        if (typeof pid === 'number' && pid > 0) killChildProcesses(pid)
        setTimeout(() => {
          if (!settled) this.write(session.id, '\x03')
        }, 120)
      }

      const cancel = (): void => {
        interruptTree()
        finish(130)
      }

      const onData = (id: string, data: string): void => {
        if (id !== session.id) return
        lastOutputAt = Date.now()
        buf += data
        const plain = strip(buf)
        const idx = plain.lastIndexOf(marker)
        if (idx >= 0) {
          const after = plain.slice(idx + marker.length)
          const m = after.match(/^(\d+)/)
          if (m) {
            this.liveLocalServer = false
            finish(Number(m[1]))
          }
        }
        // Dev servers never print the exit marker. Return once Local:/localhost is up
        // so the agent can conclude; leave the process running in the PTY.
        if (timeoutMs === 0 && !settled) {
          const url = extractLocalPreviewUrl(plain, {
            denyPorts: this.denyPreviewPorts
          })
          if (url) {
            this.liveLocalServer = true
            finish(0)
          }
        }
        // Auto-confirm CLI y/n when agent has full rights (agentAutoApprove).
        if (
          this.autoConfirmGetter?.() &&
          !this.autoYesSent &&
          Date.now() - this.autoYesAt > 800
        ) {
          const tail = plain.slice(-500)
          if (
            /(?:\(y\/n\)|\[Y\/n\]|\[y\/N\]|\byes\s*\/\s*no\b|\b\(yes\/no\))/i.test(tail) &&
            !/password|passphrase|pin\b/i.test(tail)
          ) {
            this.autoYesSent = true
            this.autoYesAt = Date.now()
            this.write(session.id, 'y\r')
          }
        }
      }

      this.dataListeners.add(onData)
      this.activeCommandCancel = cancel

      const hardMs = timeoutMs > 0 ? timeoutMs : 0
      const idleMs =
        timeoutMs > 0 ? Math.min(AGENT_SHELL_IDLE_TIMEOUT_MS, timeoutMs) : 0
      const watch =
        hardMs > 0 || idleMs > 0
          ? setInterval(() => {
              const hit = shellWatchdogFired({
                now: Date.now(),
                startedAt,
                lastOutputAt,
                hardMs,
                idleMs
              })
              if (!hit) return
              interruptTree()
              finish(SHELL_TIMEOUT_EXIT)
            }, 1000)
          : null

      const script = this.wrapCommand(command, marker)
      this.write(session.id, script + '\r')
      // Unlock stdin after inject so the user can answer prompts; agent wait continues.
      this.agentInputLocked = false
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

/** Kill descendants of the PTY shell — never the shell itself (that would drop the terminal). */
export function killChildProcesses(rootPid: number): void {
  if (!rootPid || rootPid < 1) return
  if (process.platform === 'win32') {
    const kids = windowsDescendantPids(rootPid)
    for (const pid of kids) {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], {
          windowsHide: true,
          timeout: 4000
        })
      } catch {
        /* already gone */
      }
    }
    return
  }
  try {
    execFileSync('pkill', ['-P', String(rootPid)], { timeout: 3000 })
  } catch {
    /* no children */
  }
}

function windowsDescendantPids(rootPid: number): number[] {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$root=${rootPid}; $all=@(); $q=[System.Collections.Queue]::new(); $q.Enqueue($root); while($q.Count){ $p=[int]$q.Dequeue(); Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$p) -ErrorAction SilentlyContinue | ForEach-Object { $id=[int]$_.ProcessId; if($id -gt 0){ $all+=$id; $q.Enqueue($id) } } }; $all -join ' '`
      ],
      { windowsHide: true, timeout: 6000, encoding: 'utf8' }
    )
    return String(out)
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== rootPid)
  } catch {
    return []
  }
}
