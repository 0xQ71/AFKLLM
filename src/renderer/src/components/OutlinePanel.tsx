import { useEffect, useState } from 'react'
import type { LspDocumentSymbol } from '../../../shared/lsp'

interface OutlinePanelProps {
  path: string | null
  onOpenAt: (path: string, line: number, column: number) => void
}

export function OutlinePanel({
  path,
  onOpenAt
}: OutlinePanelProps): React.JSX.Element {
  const [symbols, setSymbols] = useState<LspDocumentSymbol[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!path || !/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(path)) {
      setSymbols([])
      setError(null)
      return
    }
    void (async () => {
      try {
        const res = await window.api.lsp.documentSymbols(path)
        if (cancelled) return
        if (!res.ok) {
          setSymbols([])
          setError(res.error ?? 'Failed')
          return
        }
        setSymbols(res.symbols)
        setError(null)
      } catch (e) {
        if (!cancelled) {
          setSymbols([])
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="flex max-h-[40%] min-h-[96px] shrink-0 flex-col border-t border-ink-line bg-ink-950">
      <div className="flex h-7 items-center px-2 font-mono text-[9px] uppercase tracking-wider text-ink-mute">
        Outline
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {!path ? (
          <div className="px-1 font-mono text-[10px] text-ink-mute">No file</div>
        ) : error ? (
          <div className="px-1 font-mono text-[10px] text-ink-mute">{error}</div>
        ) : symbols.length === 0 ? (
          <div className="px-1 font-mono text-[10px] text-ink-mute">—</div>
        ) : (
          symbols.map((s, i) => (
            <button
              key={`${s.name}-${s.line}-${i}`}
              type="button"
              onClick={() => onOpenAt(path, s.line, s.column)}
              className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-ink-soft hover:bg-ink-800"
              style={{ paddingLeft: 4 + Math.min(s.depth, 6) * 8 }}
              title={`${s.kind} ${s.name}`}
            >
              <span className="text-ink-mute">{s.kind.slice(0, 3)} </span>
              {s.name}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
