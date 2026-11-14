import { useEffect, useRef, useState } from 'react'

export interface WorkspacePlusMenuProps {
  ideOpen: boolean
  browserOpen: boolean
  terminalOpen: boolean
  scmOpen?: boolean
  debugOpen?: boolean
  onToggleIde: () => void
  onToggleBrowser: () => void
  onToggleTerminal: () => void
  onToggleScm?: () => void
  onToggleDebug?: () => void
}

export function WorkspacePlusMenu({
  ideOpen,
  browserOpen,
  terminalOpen,
  scmOpen,
  debugOpen,
  onToggleIde,
  onToggleBrowser,
  onToggleTerminal,
  onToggleScm,
  onToggleDebug
}: WorkspacePlusMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const Item = ({
    label,
    active,
    onClick
  }: {
    label: string
    active?: boolean
    onClick: () => void
  }): React.JSX.Element => (
    <button
      type="button"
      onClick={() => {
        onClick()
        setOpen(false)
      }}
      className={
        'flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[11px] hover:bg-ink-800 ' +
        (active ? 'text-signal' : 'text-ink-soft')
      }
    >
      <span>{label}</span>
      {active ? <span className="text-[10px] text-ink-mute">on</span> : null}
    </button>
  )

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        title="Open IDE, Terminal, Browser…"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex h-7 w-7 items-center justify-center rounded font-mono text-lg leading-none ' +
          (open
            ? 'bg-ink-800 text-signal'
            : 'text-ink-mute hover:bg-ink-900 hover:text-ink-bright')
        }
      >
        +
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-40 min-w-[180px] overflow-hidden rounded-md border border-ink-line bg-ink-900 py-1 shadow-xl">
          <div className="px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-mute">
            Workspace
          </div>
          <Item label="IDE" active={ideOpen} onClick={onToggleIde} />
          <Item label="Browser" active={browserOpen} onClick={onToggleBrowser} />
          <Item label="Terminal" active={terminalOpen} onClick={onToggleTerminal} />
          {onToggleDebug ? (
            <Item label="Debug" active={debugOpen} onClick={onToggleDebug} />
          ) : null}
          {onToggleScm ? (
            <Item label="Source Control" active={scmOpen} onClick={onToggleScm} />
          ) : null}
        </div>
      )}
    </div>
  )
}
