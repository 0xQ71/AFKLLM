/**
 * Classify shell output honestly: non-zero exit is a failure unless it is a
 * real user-interrupt / GUI-close code. Missing traceback must NOT flip ok:true.
 */

const CTRL_C_CODES = new Set([0xc000013a, -1073741510, 3221225786])

export function isUserInterruptExit(exitCode: number): boolean {
  return exitCode === 130 || CTRL_C_CODES.has(exitCode)
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
