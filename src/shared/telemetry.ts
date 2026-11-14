/** Local crash / diagnostics event types (no network in P19). */

export type TelemetryKind = 'crash' | 'error' | 'ui_boundary' | 'info'

export interface TelemetryEvent {
  kind: TelemetryKind
  message: string
  stack?: string
  source?: string
  /** ISO timestamp; filled by reporter if omitted */
  at?: string
  extra?: Record<string, string | number | boolean | null>
}

export interface TelemetryReportResult {
  ok: boolean
  logged: boolean
  path?: string
  error?: string
}

/** Normalize / clamp incoming IPC payloads. Exported for smoke. */
export function normalizeTelemetryEvent(raw: unknown): TelemetryEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind = o.kind
  if (kind !== 'crash' && kind !== 'error' && kind !== 'ui_boundary' && kind !== 'info') {
    return null
  }
  const message = String(o.message ?? '').trim().slice(0, 4_000)
  if (!message) return null
  const ev: TelemetryEvent = {
    kind,
    message,
    at: typeof o.at === 'string' ? o.at : new Date().toISOString()
  }
  if (typeof o.stack === 'string' && o.stack.trim()) {
    ev.stack = o.stack.slice(0, 16_000)
  }
  if (typeof o.source === 'string' && o.source.trim()) {
    ev.source = o.source.slice(0, 200)
  }
  if (o.extra && typeof o.extra === 'object') {
    const extra: Record<string, string | number | boolean | null> = {}
    for (const [k, v] of Object.entries(o.extra as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        extra[k.slice(0, 64)] = v
      }
    }
    if (Object.keys(extra).length) ev.extra = extra
  }
  return ev
}

/** Format one log line. Exported for smoke. */
export function formatTelemetryLogLine(ev: TelemetryEvent): string {
  const parts = [
    ev.at ?? new Date().toISOString(),
    ev.kind.toUpperCase(),
    ev.source ? `[${ev.source}]` : '',
    ev.message.replace(/\s+/g, ' ')
  ].filter(Boolean)
  let line = parts.join(' ')
  if (ev.extra && Object.keys(ev.extra).length) {
    try {
      line += ` ${JSON.stringify(ev.extra)}`
    } catch {
      /* ignore */
    }
  }
  if (ev.stack) line += `\n  ${ev.stack.split('\n').slice(0, 12).join('\n  ')}`
  return line + '\n'
}

/** Soft-rotate: keep last keepBytes if over maxBytes. Exported for smoke. */
export function rotateLogContent(content: string, maxBytes = 1_000_000, keepBytes = 600_000): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content
  const buf = Buffer.from(content, 'utf8')
  const slice = buf.subarray(Math.max(0, buf.length - keepBytes)).toString('utf8')
  const nl = slice.indexOf('\n')
  const trimmed = nl >= 0 ? slice.slice(nl + 1) : slice
  return `--- log rotated ---\n${trimmed}`
}

export interface ParsedLogEntry {
  /** Wall-clock HH:MM:SS for the feed */
  time: string
  /** Uppercase level label (INFO, ERROR, …) */
  level: string
  message: string
}

const ENTRY_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(\S+)\s+(.*)$/

function formatLogClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    const m = iso.match(/T(\d{2}:\d{2}:\d{2})/)
    return m?.[1] ?? iso
  }
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function displayLevel(raw: string): string {
  const u = raw.toUpperCase()
  if (u === 'UI_BOUNDARY') return 'ERROR'
  if (u === 'CRASH') return 'ERROR'
  return u
}

/** Parse AFKLLM error log text into LM Studio–style feed entries. */
export function parseTelemetryLogText(text: string): ParsedLogEntry[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ParsedLogEntry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (line.startsWith('  ') && out.length) {
      const prev = out[out.length - 1]!
      prev.message = `${prev.message}\n${line.trimEnd()}`
      continue
    }
    const m = ENTRY_RE.exec(line)
    if (m) {
      out.push({
        time: formatLogClock(m[1]!),
        level: displayLevel(m[2]!),
        message: m[3]!.trim()
      })
      continue
    }
    if (line.startsWith('---')) {
      out.push({ time: '', level: 'INFO', message: line.trim() })
      continue
    }
    out.push({ time: '', level: 'INFO', message: line })
  }
  return out
}
