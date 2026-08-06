import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { WorkspaceSearchMatch } from '../../../shared/workspace'

export type PaletteMode = 'files' | 'commands' | 'search'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

interface CommandPaletteProps {
  open: boolean
  mode: PaletteMode
  onClose: () => void
  onOpenFile: (relativePath: string) => void
  commands: PaletteCommand[]
}

export function CommandPalette({
  open,
  mode,
  onClose,
  onOpenFile,
  commands
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [matches, setMatches] = useState<WorkspaceSearchMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setMatches([])
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    if (mode === 'files') {
      void window.api.workspace.list('.').then((res) => {
        if (!res.ok) {
          setFiles([])
          return
        }
        setFiles(
          res.content
            .split('\n')
            .map((l) => l.trim())
            .filter((p) => p && !p.endsWith('/'))
            .slice(0, 2000)
        )
      })
    }
    return () => clearTimeout(t)
  }, [open, mode])

  useEffect(() => {
    if (!open || mode !== 'search') return
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) {
      setMatches([])
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimer.current = setTimeout(() => {
      void window.api.workspace.search(q, { limit: 80 }).then((res) => {
        setSearching(false)
        setMatches(res.ok ? res.matches : [])
      })
    }, 250)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [query, mode, open])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (mode === 'search') {
      return matches.map((m) => ({
        id: `${m.path}:${m.line}`,
        label: `${m.path}:${m.line}`,
        hint: m.text.slice(0, 80),
        path: m.path,
        kind: 'hit' as const
      }))
    }
    if (mode === 'files') {
      const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files
      return list.slice(0, 80).map((path) => ({
        id: path,
        label: path,
        kind: 'file' as const
      }))
    }
    const list = q
      ? commands.filter(
          (c) =>
            c.label.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q) ||
            (c.hint ?? '').toLowerCase().includes(q)
        )
      : commands
    return list.map((c) => ({
      id: c.id,
      label: c.label,
      hint: c.hint,
      kind: 'cmd' as const
    }))
  }, [mode, query, files, commands, matches])

  useEffect(() => {
    setIndex(0)
  }, [query, mode, open])

  useEffect(() => {
    if (index >= items.length) setIndex(Math.max(0, items.length - 1))
  }, [items.length, index])

  if (!open) return null

  const runAt = (i: number): void => {
    const item = items[i]
    if (!item) return
    if (item.kind === 'file') {
      onOpenFile(item.id)
      onClose()
      return
    }
    if (item.kind === 'hit') {
      onOpenFile(item.path)
      onClose()
      return
    }
    const cmd = commands.find((c) => c.id === item.id)
    if (cmd) {
      void Promise.resolve(cmd.run()).finally(() => onClose())
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i + 1) % items.length : 0))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runAt(index)
    }
  }

  const title =
    mode === 'files' ? 'Open file' : mode === 'search' ? 'Find in files' : 'Commands'
  const placeholder =
    mode === 'files'
      ? 'Filter paths…'
      : mode === 'search'
        ? 'Search text in project…'
        : 'Filter commands…'

  return (
    <div
      className="absolute inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-ink-line bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-line px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {title}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink-bright outline-none placeholder:text-ink-mute"
          />
          {mode === 'search' && searching ? (
            <span className="font-mono text-[9px] text-ink-mute">…</span>
          ) : (
            <kbd className="font-mono text-[9px] text-ink-mute">Esc</kbd>
          )}
        </div>
        <ul className="max-h-[50vh] overflow-auto py-1">
          {items.length === 0 ? (
            <li className="px-3 py-4 font-mono text-xs text-ink-mute">
              {mode === 'search' && query.trim().length < 2
                ? 'Type at least 2 characters'
                : 'No matches'}
            </li>
          ) : (
            items.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => runAt(i)}
                  onMouseEnter={() => setIndex(i)}
                  className={
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs ' +
                    (i === index
                      ? 'bg-signal/15 text-ink-bright'
                      : 'text-ink-soft hover:bg-ink-800')
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {'hint' in item && item.hint ? (
                    <span className="max-w-[45%] shrink-0 truncate text-[10px] text-ink-mute">
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
