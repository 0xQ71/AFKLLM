/**
 * Normalize agent shell for host (PowerShell on Windows).
 * Models often emit bash `cd x && cmd` which fails on PS5.
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
    const before = cmd
    cmd = rewriteBashOperators(cmd)
    if (cmd !== before) {
      notes.push('rewrote bash &&/|| to PowerShell ;')
    }
  }

  return {
    command: cmd,
    cwdRel: cwd,
    note: notes.length ? notes.join('; ') : undefined
  }
}
