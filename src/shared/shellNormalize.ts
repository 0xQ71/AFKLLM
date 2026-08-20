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

/** Split on bash && / || outside quotes (left-associative). */
function splitBashLogicalOps(command: string): {
  parts: string[]
  ops: Array<'&&' | '||'>
} {
  const parts: string[] = []
  const ops: Array<'&&' | '||'> = []
  let cur = ''
  let quote: '"' | "'" | '`' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (quote) {
      cur += c
      if (c === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      cur += c
      continue
    }
    if (c === '&' && next === '&') {
      parts.push(cur.trim())
      ops.push('&&')
      cur = ''
      i++
      continue
    }
    if (c === '|' && next === '|') {
      parts.push(cur.trim())
      ops.push('||')
      cur = ''
      i++
      continue
    }
    cur += c
  }
  parts.push(cur.trim())
  return { parts, ops }
}

/**
 * Replace bash && / || outside quotes with PowerShell `if ($?)` / `if (-not $?)`
 * so `test -f x && echo y || echo n` keeps short-circuit semantics.
 */
export function rewriteBashOperators(command: string): string {
  const { parts, ops } = splitBashLogicalOps(command)
  if (ops.length === 0) return command.trim()
  let out = parts[0] ?? ''
  for (let i = 0; i < ops.length; i++) {
    const next = parts[i + 1] ?? ''
    if (!next) continue
    out +=
      ops[i] === '&&' ? `; if ($?) { ${next} }` : `; if (-not $?) { ${next} }`
  }
  return out.replace(/\s+; /g, '; ').trim()
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

  cmd = rewriteBashHeredoc(cmd)
  cmd = rewriteWhichCommand(cmd)
  cmd = rewriteCompilerHelpProbe(cmd)
  cmd = rewriteWhereAlias(cmd)
  cmd = rewriteBareWindowsExe(cmd)

  return cmd.trim()
}

/**
 * bash `which foo` is not a PowerShell command. `where.exe` locates binaries
 * without expanding to `-ErrorAction SilentlyContinue` (that leaks into the chip).
 */
export function rewriteWhichCommand(command: string): string {
  return command.replace(
    /(^|[\s;|&(])which(?!\.exe\b)(\s+)(?!\{)([A-Za-z0-9._*?-]+)/gi,
    '$1where.exe$2$3'
  )
}

/**
 * `cl /?` / `csc /?` (often piped to Select-Object -First) hangs the PTY.
 * Locating the binary is the probe the model actually needs.
 */
export function rewriteCompilerHelpProbe(command: string): string {
  return command.replace(
    /(^|[\s;|&])(cl|csc|link)(\.exe)?(\s+\/\?)(\s*\|\s*Select-Object\s+-First\s+\d+)?(?=[\s;]|$)/gi,
    '$1where.exe $2'
  )
}

/**
 * `cat > file <<'EOF' … EOF` and `cmd <<TAG … TAG` → PowerShell here-string.
 */
export function rewriteBashHeredoc(command: string): string {
  const cat = command.match(
    /^cat\s+>\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+<<\s*['"]?(\w+)['"]?\s*\r?\n([\s\S]*?)\r?\n\4\s*$/
  )
  if (cat) {
    const dest = cat[1] || cat[2] || cat[3] || ''
    const body = cat[5] ?? ''
    return `@'\n${body}\n'@ | Set-Content -Encoding utf8 -LiteralPath ${JSON.stringify(dest)}`
  }
  const pipe = command.match(/^([\s\S]+?)\s+<<\s*['"]?(\w+)['"]?\s*\r?\n([\s\S]*?)\r?\n\2\s*$/)
  if (pipe) {
    const lhs = pipe[1]!.trim()
    if (/\bcat\s+>/.test(lhs)) return command
    const body = pipe[3] ?? ''
    return `@'\n${body}\n'@ | ${lhs}`
  }
  return command
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

/** PowerShell will not run a cwd `.exe` without `.\`; skip toolchain names already on PATH. */
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

/**
 * A program-run that can prove a from-scratch CLI — not a compiler, installer, or dev server.
 * Language-agnostic: go/python/dotnet/cargo/java/node, or a cwd `.exe` that is not a toolchain.
 */
export function isCliVerifyCommand(command: string): boolean {
  const c = command ?? ''
  if (!c.trim()) return false
  if (/python\s+-m\s+http\.server|npm\s+run\s+dev|\bvite\b/i.test(c)) return false
  if (
    /\bgo\s+run\b|\bpython3?\s+\S+\.py\b|\bpy\s+\S+\.py\b|\bdotnet\s+run\b|\bcargo\s+run\b/i.test(c)
  ) {
    return true
  }
  if (/\bjava\s+(?!-version\b)[A-Za-z_$]/i.test(c)) return true
  if (/\bnode\s+\S+\.(mjs|cjs|js)\b/i.test(c) && !/\s-e\b/.test(c)) return true
  const exe = c.match(/(?:^|[\s;|&])(?:\.\\|\.\/)?([A-Za-z0-9][A-Za-z0-9._-]*\.exe)\b/i)
  if (exe && !WINDOWS_TOOLCHAIN_EXE.test(exe[1]!)) return true
  return false
}

/** PTY echo of the temp wrapper (`& '...\afk-run-….ps1'; Remove-Item…`) or leftover exit marker. */
export function isAfkPtyChromeLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/afk-run-[a-z0-9]+\.ps1/i.test(t)) return true
  if (/__AFK_EXIT_[a-z0-9]+__/i.test(t) && !/^> /.test(t)) return true
  if (/^PROCESS_ENDED:/i.test(t)) return true
  if (/^Do NOT rewrite or relaunch/i.test(t)) return true
  if (/ErrorAction(?:Preference)?/i.test(t)) return true
  if (/^(Continue|SilentlyContinue|ontinue|ntinue)$/i.test(t)) return true
  if (/\bSilentlyContinue\b/i.test(t) && t.length < 120) return true
  return false
}

/** Drop wrapper invoke / exit-marker lines; keep `> actual command` and program stdout. */
export function stripAfkPtyChrome(output: string): string {
  if (!output) return output
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!isAfkPtyChromeLine(line)) return [line]
      const leftover = line
        .replace(/__AFK_EXIT_[a-z0-9]+__\d*/gi, '')
        .replace(/\s*-ErrorAction\s+\w+/gi, '')
        .replace(/\bSilentlyContinue\b/gi, '')
        .trim()
      if (leftover && !isAfkPtyChromeLine(leftover)) return [leftover]
      return []
    })
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** exit_code=0 but no real program output (empty tokenizer, "no words", blank stdout). */
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
      notes.push('rewrote bash &&/|| to PowerShell if ($?)')
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
