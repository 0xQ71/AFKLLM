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

  // Redirects to /dev/null (PowerShell otherwise resolves D:\dev\null)
  cmd = cmd
    .replace(/\s+2>&1\s*>\s*\/dev\/null\b/gi, ' 2>&1 >$null')
    .replace(/\s+2>\s*\/dev\/null\b/gi, ' 2>$null')
    .replace(/\s+>\s*\/dev\/null\b/gi, ' >$null')
    .replace(/\s+1>\s*\/dev\/null\b/gi, ' >$null')

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

  return cmd.trim()
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
