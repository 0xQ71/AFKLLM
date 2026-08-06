/** Shared DTOs for Node debug MVP (Inspector / CDP). */

export interface DebugBreakpoint {
  /** Workspace-relative path */
  path: string
  /** 1-based line */
  line: number
}

export interface DebugStackFrame {
  id: number
  name: string
  path?: string
  line?: number
  column?: number
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  /** Scope label: local / closure / … */
  scope?: string
}

export type DebugSessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'error'

export interface DebugSessionStatus {
  state: DebugSessionState
  entry?: string
  message?: string
  stack?: DebugStackFrame[]
  variables?: DebugVariable[]
  reason?: string
}

export type DebugEventType =
  | 'paused'
  | 'resumed'
  | 'exited'
  | 'output'
  | 'error'
  | 'status'

export interface DebugEvent {
  type: DebugEventType
  status: DebugSessionStatus
  output?: string
  error?: string
}

export interface DebugStartRequest {
  entry: string
  breakpoints?: DebugBreakpoint[]
  args?: string[]
}

export interface DebugStartResult {
  ok: boolean
  error?: string
  status: DebugSessionStatus
}

/** Normalize path → unique sorted breakpoint lines. Exported for smoke. */
export function normalizeBreakpoints(
  bps: DebugBreakpoint[]
): DebugBreakpoint[] {
  const map = new Map<string, Set<number>>()
  for (const bp of bps) {
    const path = bp.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || !Number.isFinite(bp.line) || bp.line < 1) continue
    const set = map.get(path) ?? new Set<number>()
    set.add(Math.floor(bp.line))
    map.set(path, set)
  }
  const out: DebugBreakpoint[] = []
  for (const [path, lines] of [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    for (const line of [...lines].sort((a, b) => a - b)) {
      out.push({ path, line })
    }
  }
  return out
}

/** Parse Node --inspect banner for WebSocket URL. Exported for smoke. */
export function parseInspectorWsUrl(text: string): string | null {
  const m = text.match(/Debugger listening on (ws:\/\/\S+)/i)
  return m?.[1] ?? null
}
