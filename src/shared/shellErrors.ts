/**
 * Classify shell output honestly: non-zero exit is a failure unless it is a
 * real user-interrupt / GUI-close code. Missing traceback must NOT flip ok:true.
 */

const CTRL_C_CODES = new Set([0xc000013a, -1073741510, 3221225786])

/** GNU timeout / agent watchdog (stdin hang, stuck compile). */
export const SHELL_TIMEOUT_EXIT = 124
export const AGENT_SHELL_HARD_TIMEOUT_MS = 90_000
export const AGENT_SHELL_IDLE_TIMEOUT_MS = 55_000

export function isUserInterruptExit(exitCode: number): boolean {
  return exitCode === 130 || CTRL_C_CODES.has(exitCode)
}

export function isShellTimeoutExit(exitCode: number): boolean {
  return exitCode === SHELL_TIMEOUT_EXIT
}

/** Hard wall, or silence after last PTY output (typical stdin block). */
export function shellWatchdogFired(opts: {
  now: number
  startedAt: number
  lastOutputAt: number
  hardMs: number
  idleMs: number
}): 'hard' | 'idle' | null {
  if (opts.hardMs > 0 && opts.now - opts.startedAt >= opts.hardMs) return 'hard'
  if (opts.idleMs > 0 && opts.now - opts.lastOutputAt >= opts.idleMs) return 'idle'
  return null
}

/** Launchers that often end because the user closed a window, not a compile error. */
export function looksLikeGuiLaunchCommand(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  if (/^Start-Process\b/i.test(c)) return true
  if (/\b(javaw|pythonw|wish|electron)\b/i.test(c)) return true
  if (/\.(exe|app|msi)\b/i.test(c) && !/\b(csc|msbuild|dotnet|cl\.exe|link\.exe)\b/i.test(c)) {
    return true
  }
  return false
}

/**
 * `-and` / `-or` are PowerShell operators, not cmdlet parameters. Written as
 * `Test-Path x -And (...)` the shell only reports "cannot find parameter -And",
 * which tells the model nothing about the fix.
 */
export function powershellOperatorMisuse(command: string): string | null {
  const c = command.trim()
  if (!c) return null
  const m = c.match(/([A-Za-z]+-[A-Za-z]+)\s+[^|;]*?\s(-(?:and|or|not))\b/i)
  if (!m) return null
  const cmdlet = m[1]!
  const op = m[2]!.toLowerCase()
  return (
    `SHELL_SYNTAX: "${op}" is a PowerShell operator, not a parameter of ${cmdlet}, ` +
    'so the command cannot run. Wrap each side in parentheses: ' +
    `(${cmdlet} "file") ${op} (Test-Path "other"). ` +
    'Simpler: run one check per command, or just read the file with read_file.'
  )
}

/**
 * Unbounded recursive listing as "verification" hangs on large trees.
 * Shallow list_directory / verify_project / one Start-Process is enough.
 */
export function recursiveListingRefusal(command: string): string | null {
  const c = command.trim()
  if (!c) return null
  if (!/Get-ChildItem\b/i.test(c) || !/-Recurse\b/i.test(c)) return null
  if (/-Depth\s+\d+/i.test(c)) return null
  return (
    'SHELL_REFUSED: Get-ChildItem -Recurse without -Depth is forbidden here ' +
    '(can hang on huge trees). Use verify_project once, list_directory on a folder, ' +
    'or Start-Process (Resolve-Path .\\index.html) to preview — do not scan the whole project.'
  )
}

/**
 * PowerShell aliases `curl` → Invoke-WebRequest, which breaks Unix pipelines
 * (`curl | jq` prompts for Uri). Drop the alias so `curl` is curl.exe.
 */
export const POWERSHELL_UNALIAS_CURL =
  'Remove-Item alias:curl -Force -ErrorAction SilentlyContinue'

/** Init for the visible agent PTY (`powershell.exe -NoProfile -Command`). */
export const POWERSHELL_AGENT_PTY_INIT =
  'Remove-Module PSReadLine -ErrorAction SilentlyContinue; ' +
  `${POWERSHELL_UNALIAS_CURL}; ` +
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'

/**
 * `node -e` with regex character classes breaks in PowerShell (`[` = type literal).
 * i18n audits belong in read_file, not a one-liner or tmp/check.js.
 */
export function powershellNodeEvalRefusal(command: string): string | null {
  const c = command.trim()
  if (!c || !/\bnode(?:\.exe)?\s+(-e|--eval)\b/i.test(c)) return null
  if (!/\[/.test(c) && !/data-i18n|i18n/i.test(c)) return null
  return (
    'SHELL_REFUSED: do not audit HTML/JS i18n with node -e. PowerShell treats `[` as a type ' +
    'and breaks quoted regex. Call read_file on index.html and js/main.js. Do NOT write tmp/check.js.'
  )
}

export function extractErrorFocus(text: string): string | null {
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
      /\bjavac\b.*error|cannot find symbol|package .+ does not exist/i.test(l) ||
      /\berror CS\d+|error MSB\d+|\bMSB\d+:/i.test(l) ||
      /^\S+\.go:\d+:\d+:/i.test(l) ||
      /^error(\[E\d+\])?:/i.test(l) ||
      /^warning: unused/i.test(l) ||
      /CMake Error/i.test(l) ||
      /={3,}\s*FAILURES/i.test(l) ||
      /^E\s+\w+Error/i.test(l) ||
      /\[\s*FAILED\s*\]/i.test(l) ||
      /FAILURE: Build failed/i.test(l) ||
      /^\S+:\d+:\d+:\s+(fatal\s+)?error:/i.test(l) ||
      /\berror:|FAILED|FAILURES!|AssertionError|Invoke-Expression|ParserError|not recognized/i.test(
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

/**
 * Shell text substitution / file copies that bypass apply_diff review, notifyChange
 * and rememberEdit — the change cannot be undone from the UI.
 */
export function looksLikeShellFileMutation(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  if (/\bsed\s+(?:-[A-Za-z]*i[A-Za-z]*\b|-i\b)/i.test(c)) return true
  if (/\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bClear-Content\b/i.test(c)) return true
  if (/\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\bRename-Item\b/i.test(c)) return true
  if (/\b-replace\b/i.test(c) && /\b(Set-Content|Add-Content|Out-File|Set-Item)\b/i.test(c)) {
    return true
  }
  // `echo x > file` / `cmd >> log.txt`, but not `2>&1` / `>&2`
  if (/(^|[\s;|&])>{1,2}\s*(?!&)[^\s;&|]+/.test(c)) return true
  return false
}

/** Agent must not taskkill svchost / random PIDs from netstat. */
export function processKillRefusal(command: string): string | null {
  const c = command.trim()
  if (!c) return null
  if (
    /\btaskkill\b/i.test(c) ||
    /\bStop-Process\b/i.test(c) ||
    /\bkillall\b/i.test(c) ||
    /\bpkill\b/i.test(c) ||
    /(?:^|[\s;|&])kill\s+(?:-\w+\s+)*\d+/i.test(c)
  ) {
    return (
      'SHELL_REFUSED: do not kill processes by PID (taskkill / Stop-Process / kill). ' +
      `If a port is busy, start the dev server on another port (vite --port ${4173}). ` +
      'Do not target svchost or system PIDs.'
    )
  }
  return null
}
