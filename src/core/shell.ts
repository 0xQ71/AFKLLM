import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const IS_WIN = process.platform === 'win32'
export const SHELL_NAME = IS_WIN ? 'PowerShell' : 'bash'

const PRELUDE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";'

/**
 * PowerShell parses the whole -Command string before running any of it, so a syntax error in the model's command
 * is reported BEFORE the UTF-8 prelude runs — in the console's OEM code page (cp866). decode() below recognises
 * that and turns it back into readable text (it used to arrive as mojibake like "��ப�:26").
 * (Running the command from an env var through [scriptblock]::Create would avoid it, but AMSI/Defender blocks that
 * pattern as malicious.)
 */
function shellArgs(command: string): { exe: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (IS_WIN) {
    return { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + command], env: {} }
  }
  return { exe: 'bash', args: ['-lc', command], env: {} }
}

/** PowerShell echoes the failing source line in errors; drop our UTF-8 prelude from it so the model sees only its code. */
function hidePrelude(s: string): string {
  return s.replace(/^\+ (\.\.\. )?[^\n]*?Preference="SilentlyContinue";/gm, '+ ')
}

const OEM = (() => { try { return new TextDecoder('ibm866') } catch { return null } })()

/** UTF-8, or — for native tools that still write in the console's OEM code page — cp866 when UTF-8 fails. */
function decode(b: Buffer): string {
  const s = b.toString('utf8')
  if (!IS_WIN || !OEM || !s.includes('\uFFFD')) return s
  return OEM.decode(b)
}

export interface ShellResult {
  code: number | null
  output: string
  timedOut: boolean
  aborted: boolean
}

const MAX_OUT = 30_000

function clip(s: string): string {
  if (s.length <= MAX_OUT) return s
  const head = s.slice(0, MAX_OUT * 0.4)
  const tail = s.slice(-MAX_OUT * 0.6)
  return `${head}\n… [${s.length - head.length - tail.length} chars cut] …\n${tail}`
}

export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal,
  onChunk?: (s: string) => void): Promise<ShellResult> {
  return new Promise((resolve) => {
    const { exe, args, env } = shellArgs(command)
    const child = spawn(exe, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env }, windowsHide: true })
    let out = ''
    let timedOut = false
    let aborted = false
    const add = (b: Buffer) => {
      const s = decode(b)
      out += s
      if (out.length > MAX_OUT * 4) out = out.slice(0, MAX_OUT) + out.slice(-MAX_OUT * 2)
      onChunk?.(s)
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const kill = () => {
      if (IS_WIN && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    const onAbort = () => { aborted = true; kill() }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { out += `\n${e.message}` })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, output: clip(hidePrelude(out.replace(/\r\n/g, '\n'))), timedOut, aborted })
    })
  })
}

export interface BackgroundJob {
  id: string
  command: string
  logPath: string
  pid?: number
  exitCode?: number | null
}

/** Long-running processes (dev servers, watchers): output goes to a log file the model can Read. */
export class BackgroundJobs {
  jobs = new Map<string, BackgroundJob>()
  private n = 0

  constructor(private logDir: string) {}

  start(command: string, cwd: string): BackgroundJob {
    mkdirSync(this.logDir, { recursive: true })
    const id = `bg${++this.n}`
    const logPath = join(this.logDir, `${id}.log`)
    const log = createWriteStream(logPath)
    const { exe, args, env } = shellArgs(command)
    const child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', ...env } })
    child.stdout.on('data', (b: Buffer) => log.write(decode(b)))
    child.stderr.on('data', (b: Buffer) => log.write(decode(b)))
    const job: BackgroundJob = { id, command, logPath, pid: child.pid }
    child.on('close', (code) => { job.exitCode = code })
    this.jobs.set(id, job)
    return job
  }

  stopAll(): void {
    for (const j of this.jobs.values()) {
      if (j.exitCode === undefined && j.pid) {
        if (IS_WIN) spawn('taskkill', ['/PID', String(j.pid), '/T', '/F'], { windowsHide: true })
        else try { process.kill(j.pid, 'SIGKILL') } catch { /* gone */ }
      }
    }
  }
}
