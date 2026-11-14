/** Shared types for repo diagnostics (tsc / eslint). */

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export type DiagnosticSource = 'tsc' | 'eslint' | 'monaco' | string

export interface DiagnosticItem {
  id: string
  /** Workspace-relative path with forward slashes */
  path: string
  line: number
  column: number
  severity: DiagnosticSeverity
  message: string
  source: DiagnosticSource
}

export interface DiagnosticsSnapshot {
  items: DiagnosticItem[]
  note?: string
  running?: boolean
  updatedAt: number
}

/** Parse `tsc --pretty false` stderr/stdout lines into diagnostics. */
export function parseTscOutput(
  text: string,
  projectRoot: string
): DiagnosticItem[] {
  const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const out: DiagnosticItem[] = []
  // e.g. src/foo.ts(10,5): error TS2304: Cannot find name 'x'.
  const re =
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info|hint)\s+(TS\d+:\s*.+)$/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let file = m[1]!.replace(/\\/g, '/')
    if (/^[a-zA-Z]:/.test(file) || file.startsWith('/')) {
      const abs = file
      if (abs.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
        file = abs.slice(rootNorm.length + 1)
      } else if (abs.toLowerCase().startsWith(rootNorm.toLowerCase())) {
        file = abs.slice(rootNorm.length).replace(/^\//, '')
      }
    }
    file = file.replace(/^\.\//, '')
    const severity = (m[4]!.toLowerCase() as DiagnosticSeverity) || 'error'
    const message = m[5]!.trim()
    const line = Number(m[2]) || 1
    const column = Number(m[3]) || 1
    out.push({
      id: `tsc:${file}:${line}:${column}:${message.slice(0, 80)}`,
      path: file,
      line,
      column,
      severity,
      message,
      source: 'tsc'
    })
  }
  return out
}

/** Parse `eslint -f json` stdout into diagnostics. */
export function parseEslintJson(
  text: string,
  projectRoot: string
): DiagnosticItem[] {
  const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DiagnosticItem[] = []
  for (const file of parsed as Array<{
    filePath?: string
    messages?: Array<{
      line?: number
      column?: number
      severity?: number
      message?: string
      ruleId?: string | null
    }>
  }>) {
    let rel = (file.filePath ?? '').replace(/\\/g, '/')
    if (rel.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
      rel = rel.slice(rootNorm.length + 1)
    } else if (rel.toLowerCase().startsWith(rootNorm.toLowerCase())) {
      rel = rel.slice(rootNorm.length).replace(/^\//, '')
    }
    for (const msg of file.messages ?? []) {
      const severity: DiagnosticSeverity =
        msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info'
      const message = [msg.message, msg.ruleId ? `(${msg.ruleId})` : '']
        .filter(Boolean)
        .join(' ')
      const line = msg.line || 1
      const column = msg.column || 1
      out.push({
        id: `eslint:${rel}:${line}:${column}:${message.slice(0, 80)}`,
        path: rel,
        line,
        column,
        severity,
        message,
        source: 'eslint'
      })
    }
  }
  return out
}
