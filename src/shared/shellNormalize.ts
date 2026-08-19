/**
 * Normalize agent shell for host (PowerShell on Windows).
 * Models often emit bash `cd x && cmd`, `/dev/null`, `find | head` which fail on PS5.
 */

export interface NormalizedShell {
  command: string
  /** Relative cwd hint (may update from leading `cd`) */
  cwdRel: string
  note?: string
}

/** Replace && / || outside quotes with `;` for PowerShell. */
export function rewriteBashOperators(command: string): string {
  let out = ''
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]

    if (quote) {
      out += c
      if (c === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      continue
    }
    if (c === '&' && next === '&') {
      out += '; '
      i++
      continue
    }
    if (c === '|' && next === '|') {
      // PS5 has no || — approximate with `;`
      out += '; '
      i++
      continue
    }
    out += c
  }
  return out.replace(/\s*;\s*/g, '; ').trim()
}

/**
 * Rewrite common Unixisms that break PowerShell:
 * - 2>/dev/null, >/dev/null → 2>$null / >$null
 * - find . -name "x" -type f → Get-ChildItem …
 * - | head -N → | Select-Object -First N
 * - | tail -N → | Select-Object -Last N
 * - | grep → | Select-String (best-effort)
 */
export function rewriteUnixismsForPowerShell(command: string): string {
  let cmd = command.trim()

  // find . -name "pattern" [-type f] [| head -N]
  const findHead = cmd.match(
    /^find\s+(\.|\.\/|"[^"]+"|'[^']+'|\S+)\s+-name\s+("[^"]+"|'[^']+'|\S+)(?:\s+-type\s+f)?(?:\s+2?>\s*\/dev\/null)?(?:\s*\|\s*head\s+-n?\s*(\d+))?\s*$/i
  )
  if (findHead) {
    const name = findHead[2]!.replace(/^["']|["']$/g, '')
    const n = findHead[3]
    const base = `Get-ChildItem -Recurse -File -Filter ${JSON.stringify(name)} | Select-Object -ExpandProperty FullName`
    return n ? `${base} | Select-Object -First ${n}` : base
  }

  // Redirects to /dev/null or cmd `nul` (PowerShell otherwise resolves D:\dev\null)
  cmd = cmd
    .replace(/\s+2>&1\s*>\s*\/dev\/null\b/gi, ' 2>&1 >$null')
    .replace(/\s+2>\s*\/dev\/null\b/gi, ' 2>$null')
    .replace(/\s+>\s*\/dev\/null\b/gi, ' >$null')
    .replace(/\s+1>\s*\/dev\/null\b/gi, ' >$null')
    .replace(/\s+2>\s*nul\b/gi, ' 2>$null')
    .replace(/\s+>\s*nul\b/gi, ' >$null')

  // Pipes: head / tail / grep (simple cases)
  cmd = cmd.replace(/\|\s*head\s+-n?\s*(\d+)\b/gi, '| Select-Object -First $1')
  cmd = cmd.replace(/\|\s*tail\s+-n?\s*(\d+)\b/gi, '| Select-Object -Last $1')
  cmd = cmd.replace(
    /\|\s*grep\s+(?:-E\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    (_m, a, b, c) => `| Select-String -Pattern ${JSON.stringify(a || b || c || '')}`
  )

  // Bare `ls -la` → Get-ChildItem (ls alone is fine as PS alias)
  if (/^ls\s+-[laRh]+\b/i.test(cmd)) {
    cmd = cmd.replace(/^ls\s+-[laRh]+\b/i, 'Get-ChildItem')
  }

  // bash here-string: `go run wordfreq.go <<< "hello"` → stdin pipe (PowerShell has no <<<)
  const here = cmd.match(
    /^([\s\S]+?)\s+<<<\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)\s*$/
  )
  if (here) {
    const lhs = here[1]!.trim()
    const payload = here[2]!
    cmd = `Write-Output -- ${payload} | ${lhs}`
  }

  cmd = rewriteWhereAlias(cmd)
  cmd = rewriteBareWindowsExe(cmd)

  return cmd.trim()
}

/**
 * PowerShell aliases `where` → Where-Object, so `where cl.exe` is a silent
 * filter (empty stdout, exit 0) instead of locating cl.exe. Call where.exe.
 * Leave `Where-Object` and `where { … }` alone.
 */
export function rewriteWhereAlias(command: string): string {
  return command.replace(
    /(^|[\s;|&(])where(?!\.exe\b|-Object\b)(\s+)(?!\{)([A-Za-z0-9._*?-]+)/gi,
    '$1where.exe$2$3'
  )
}

/** PowerShell will not run `wordfreq.exe` from cwd; `.\wordfreq.exe` will. Skip toolchain names on PATH. */
const WINDOWS_TOOLCHAIN_EXE =
  /^(cl|link|csc|msbuild|python|pythonw|node|go|java|javac|git|npm|npx|cmd|powershell|pwsh|rustc|cargo|dotnet|cmake|ninja|gcc|g\+\+|clang|clang\+\+|nmake|dumpbin|where)\.exe$/i

export function rewriteBareWindowsExe(command: string): string {
  return command.replace(
    /(^|[\s;|&])([A-Za-z0-9][A-Za-z0-9._-]*\.exe)\b/g,
    (all, pre: string, exe: string) => {
      if (WINDOWS_TOOLCHAIN_EXE.test(exe)) return all
      return `${pre}.\\${exe}`
    }
  )
}

/** PTY echo of the temp wrapper (`& '...\afk-run-….ps1'; Remove-Item…`) or leftover exit marker. */
export function isAfkPtyChromeLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/afk-run-[a-z0-9]+\.ps1/i.test(t)) return true
  if (/__AFK_EXIT_[a-z0-9]+__/i.test(t) && !/^> /.test(t)) return true
  if (/^PROCESS_ENDED:/i.test(t)) return true
  if (/^Do NOT rewrite or relaunch/i.test(t)) return true
  if (/ErrorActionPreference/i.test(t)) return true
  if (/^(Continue|SilentlyContinue|ontinue)$/i.test(t)) return true
  return false
}

/** Drop wrapper invoke / exit-marker lines; keep `> actual command` and program stdout. */
export function stripAfkPtyChrome(output: string): string {
  if (!output) return output
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!isAfkPtyChromeLine(line)) return [line]
      const leftover = line.replace(/__AFK_EXIT_[a-z0-9]+__\d*/gi, '').trim()
      if (leftover && !isAfkPtyChromeLine(leftover)) return [leftover]
      return []
    })
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** exit_code=0 but no real program output (T07f: «Нет слов для анализа.» after Split n=0). */
export function cliStdoutLooksVacuous(resultContent: string): boolean {
  const t = stripAfkPtyChrome(resultContent ?? '')
    .replace(/^note:.*$/gim, '')
    .replace(/\n*exit_code=-?\d+\s*$/i, '')
    .replace(/TERMINAL_ERROR:[\s\S]*$/i, '')
    .replace(/ERROR_FOCUS[\s\S]*$/i, '')
    .replace(/^GO_SPLIT:.*$/gim, '')
    .replace(/^CLI_EMPTY:.*$/gim, '')
    .replace(/^>\s.*$/gm, '')
    .replace(/^PS\s+\S+>/gm, '')
    .trim()
  if (!t || t === '(no output)') return true
  if (/нет слов( для анализа)?|no words to (analyze|analyse)|empty (input|result)/i.test(t)) {
    return true
  }
  return false
}

/** Peel `cd dir && rest` into cwd + rest when cwdRel is `.` / empty. */
export function peelLeadingCd(
  command: string,
  cwdRel: string
): { command: string; cwdRel: string } {
  const cwdEmpty = !cwdRel || cwdRel === '.' || cwdRel === './'
  if (!cwdEmpty) return { command, cwdRel }

  const m = command.match(
    /^(?:cd|Set-Location)\s+(?:-LiteralPath\s+|LiteralPath\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*([\s\S]+)$/i
  )
  if (!m) return { command, cwdRel }
  const dir = (m[1] || m[2] || m[3] || '').trim().replace(/\\/g, '/')
  const rest = (m[4] || '').trim()
  if (!dir || !rest) return { command, cwdRel }
  return { command: rest, cwdRel: dir }
}

export function normalizeAgentShellCommand(
  command: string,
  cwdRel = '.',
  platform: NodeJS.Platform = process.platform
): NormalizedShell {
  let cmd = String(command ?? '').trim()
  let cwd = String(cwdRel ?? '.').trim() || '.'
  const notes: string[] = []

  if (!cmd) return { command: cmd, cwdRel: cwd }

  const peeled = peelLeadingCd(cmd, cwd)
  if (peeled.command !== cmd || peeled.cwdRel !== cwd) {
    notes.push(`peeled leading cd → cwd=${peeled.cwdRel}`)
  }
  cmd = peeled.command
  cwd = peeled.cwdRel

  if (platform === 'win32') {
    const beforeOps = cmd
    cmd = rewriteBashOperators(cmd)
    if (cmd !== beforeOps) {
      notes.push('rewrote bash &&/|| to PowerShell ;')
    }
    const beforeUnix = cmd
    cmd = rewriteUnixismsForPowerShell(cmd)
    if (cmd !== beforeUnix) {
      notes.push('rewrote Unix shell for PowerShell')
    }
  }

  return {
    command: cmd,
    cwdRel: cwd,
    note: notes.length ? notes.join('; ') : undefined
  }
}
