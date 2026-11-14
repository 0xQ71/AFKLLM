import type { DebugSessionStatus, DebugStackFrame } from '../../../shared/debug'

interface DebugPanelProps {
  open: boolean
  onClose: () => void
  status: DebugSessionStatus
  output: string
  activePath: string | null
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onContinue: () => void
  onStepOver: () => void
  onStepInto: () => void
  onOpenFrame: (frame: DebugStackFrame) => void
}

export function DebugPanel({
  open,
  onClose,
  status,
  output,
  activePath,
  canStart,
  onStart,
  onStop,
  onContinue,
  onStepInto,
  onStepOver,
  onOpenFrame
}: DebugPanelProps): React.JSX.Element | null {
  if (!open) return null

  const active =
    status.state === 'running' ||
    status.state === 'paused' ||
    status.state === 'starting'
  const paused = status.state === 'paused'
  const vars = status.variables ?? []

  return (
    <div className="flex h-52 shrink-0 flex-col border-t border-ink-line bg-ink-950">
      <div className="flex h-8 items-center gap-2 border-b border-ink-line px-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          Debug
        </span>
        <span className="truncate font-mono text-[10px] text-ink-mute" title={status.message}>
          {status.state}
          {status.entry ? ` · ${status.entry}` : ''}
          {status.message ? ` — ${status.message}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!active ? (
            <button
              type="button"
              disabled={!canStart}
              onClick={onStart}
              title={
                canStart
                  ? `Start debugging ${activePath}`
                  : 'Open a .js / .ts file to debug'
              }
              className="rounded bg-signal/20 px-2 py-0.5 font-mono text-[10px] text-signal disabled:opacity-40"
            >
              Start
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!paused}
                onClick={onContinue}
                className="rounded px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:bg-ink-800 disabled:opacity-40"
              >
                Continue
              </button>
              <button
                type="button"
                disabled={!paused}
                onClick={onStepOver}
                className="rounded px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:bg-ink-800 disabled:opacity-40"
              >
                Over
              </button>
              <button
                type="button"
                disabled={!paused}
                onClick={onStepInto}
                className="rounded px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:bg-ink-800 disabled:opacity-40"
              >
                Into
              </button>
              <button
                type="button"
                onClick={onStop}
                className="rounded px-2 py-0.5 font-mono text-[10px] text-rose-400 hover:bg-ink-800"
              >
                Stop
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 font-mono text-[10px] text-ink-mute hover:text-ink-bright"
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[28%] overflow-auto border-r border-ink-line p-1">
          <div className="mb-1 px-1 font-mono text-[9px] uppercase text-ink-mute">
            Call stack
          </div>
          {(status.stack ?? []).length === 0 ? (
            <div className="px-1 font-mono text-[10px] text-ink-mute">—</div>
          ) : (
            (status.stack ?? []).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onOpenFrame(f)}
                className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-ink-soft hover:bg-ink-800"
                title={f.path ? `${f.path}:${f.line}` : f.name}
              >
                {f.name}
                {f.path ? ` · ${f.path}:${f.line}` : ''}
              </button>
            ))
          )}
        </div>
        <div className="w-[32%] overflow-auto border-r border-ink-line p-1">
          <div className="mb-1 px-1 font-mono text-[9px] uppercase text-ink-mute">
            Variables
          </div>
          {vars.length === 0 ? (
            <div className="px-1 font-mono text-[10px] text-ink-mute">
              {paused ? '—' : 'Pause to inspect'}
            </div>
          ) : (
            vars.map((v, i) => (
              <div
                key={`${v.scope}-${v.name}-${i}`}
                className="truncate px-1 py-0.5 font-mono text-[10px] text-ink-soft"
                title={`${v.scope ? v.scope + ' · ' : ''}${v.name} = ${v.value}`}
              >
                <span className="text-signal">{v.name}</span>
                <span className="text-ink-mute"> = </span>
                <span>{v.value}</span>
              </div>
            ))
          )}
        </div>
        <pre className="min-w-0 flex-1 overflow-auto p-2 font-mono text-[10px] text-ink-mute whitespace-pre-wrap">
          {output || 'Console output…'}
        </pre>
      </div>
    </div>
  )
}

export function isDebuggablePath(path: string | null | undefined): boolean {
  if (!path) return false
  return /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(path)
}
