import { useCallback, useEffect, useState } from 'react'
import * as monaco from 'monaco-editor'
import type { DiagnosticItem, DiagnosticsSnapshot } from '../../../shared/diagnostics'

export interface ProblemItem {
  id: string
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
}

interface ProblemsPanelProps {
  open: boolean
  onClose: () => void
  onOpenAt: (path: string, line: number, column: number) => void
}

function severityOf(s: monaco.MarkerSeverity): ProblemItem['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error'
  if (s === monaco.MarkerSeverity.Warning) return 'warning'
  if (s === monaco.MarkerSeverity.Info) return 'info'
  return 'hint'
}

function uriToPath(uri: monaco.Uri): string {
  const raw = uri.path || uri.fsPath || uri.toString()
  return raw
    .replace(/^\/([a-zA-Z]:)/, '$1')
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
}

function collectMonacoProblems(): ProblemItem[] {
  const markers = monaco.editor.getModelMarkers({})
  const out: ProblemItem[] = []
  for (const m of markers) {
    const path = uriToPath(m.resource)
    const rel = path.replace(/^\/+/, '')
    out.push({
      id: `monaco:${rel}:${m.startLineNumber}:${m.startColumn}:${m.code ?? ''}:${m.message.slice(0, 80)}`,
      path: rel,
      line: m.startLineNumber,
      column: m.startColumn,
      severity: severityOf(m.severity),
      message: m.message,
      source: m.source || 'monaco'
    })
  }
  return out
}

function fromDiag(d: DiagnosticItem): ProblemItem {
  return {
    id: d.id,
    path: d.path,
    line: d.line,
    column: d.column,
    severity: d.severity,
    message: d.message,
    source: d.source
  }
}

function dedupeKey(p: ProblemItem): string {
  return `${p.path}|${p.line}|${p.column}|${p.message.slice(0, 120)}`
}

function mergeProblems(
  monacoItems: ProblemItem[],
  repoItems: ProblemItem[]
): ProblemItem[] {
  const seen = new Set<string>()
  const out: ProblemItem[] = []
  for (const p of [...repoItems, ...monacoItems]) {
    const k = dedupeKey(p)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  out.sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity)
    if (sev !== 0) return sev
    return a.path.localeCompare(b.path) || a.line - b.line
  })
  return out
}

function severityRank(s: ProblemItem['severity']): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : s === 'info' ? 2 : 3
}

let repoCache: ProblemItem[] = []
let repoNote: string | undefined

export function setRepoDiagnostics(snap: DiagnosticsSnapshot): void {
  repoCache = (snap.items ?? []).map(fromDiag)
  repoNote = snap.note
}

export function countProblems(): { errors: number; warnings: number; total: number } {
  const list = mergeProblems(collectMonacoProblems(), repoCache)
  let errors = 0
  let warnings = 0
  for (const p of list) {
    if (p.severity === 'error') errors++
    else if (p.severity === 'warning') warnings++
  }
  return { errors, warnings, total: list.length }
}

export function ProblemsPanel({
  open,
  onClose,
  onOpenAt
}: ProblemsPanelProps): React.JSX.Element | null {
  const [items, setItems] = useState<ProblemItem[]>([])
  const [note, setNote] = useState<string | undefined>()
  const [running, setRunning] = useState(false)

  const refresh = useCallback(() => {
    setItems(mergeProblems(collectMonacoProblems(), repoCache))
    setNote(repoNote)
  }, [])

  useEffect(() => {
    void window.api.diagnostics.get().then((snap) => {
      setRepoDiagnostics(snap)
      setRunning(!!snap.running)
      refresh()
    })
    return window.api.diagnostics.onChanged((snap) => {
      setRepoDiagnostics(snap)
      setRunning(!!snap.running)
      refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (!open) return
    refresh()
    const sub = monaco.editor.onDidChangeMarkers(() => refresh())
    return () => sub.dispose()
  }, [open, refresh])

  const runRepo = async (): Promise<void> => {
    setRunning(true)
    try {
      const snap = await window.api.diagnostics.run()
      setRepoDiagnostics(snap)
      refresh()
    } finally {
      setRunning(false)
    }
  }

  if (!open) return null

  const errors = items.filter((i) => i.severity === 'error').length
  const warnings = items.filter((i) => i.severity === 'warning').length

  return (
    <div className="flex h-40 shrink-0 flex-col border-t border-ink-line bg-ink-950">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-ink-line px-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          Problems
        </span>
        <span className="font-mono text-[10px] text-ink-mute">
          {errors} err · {warnings} warn
        </span>
        <button
          type="button"
          onClick={() => void runRepo()}
          disabled={running}
          className="rounded border border-ink-line px-1.5 font-mono text-[10px] text-ink-mute hover:text-ink-bright disabled:opacity-50"
          title="Re-run tsc / eslint on workspace"
        >
          {running ? '…' : '↻'}
        </button>
        <span className="ml-auto truncate font-mono text-[9px] text-ink-mute" title={note}>
          {note || 'monaco + repo tsc/eslint'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="px-1.5 font-mono text-[10px] text-ink-mute hover:text-ink-bright"
        >
          ×
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto py-1">
        {items.length === 0 ? (
          <li className="px-3 py-3 font-mono text-[11px] text-ink-mute">
            {note || 'No problems'}
          </li>
        ) : (
          items.slice(0, 200).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onOpenAt(p.path, p.line, p.column)}
                className="flex w-full items-start gap-2 px-2 py-1 text-left font-mono text-[11px] hover:bg-ink-900"
              >
                <span
                  className={
                    'shrink-0 uppercase ' +
                    (p.severity === 'error'
                      ? 'text-rose-400'
                      : p.severity === 'warning'
                        ? 'text-amber-400'
                        : 'text-ink-mute')
                  }
                >
                  {p.severity === 'error' ? 'E' : p.severity === 'warning' ? 'W' : 'I'}
                </span>
                <span className="shrink-0 text-[9px] uppercase text-ink-mute">
                  {p.source || '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-bright">{p.message}</span>
                <span className="shrink-0 text-[10px] text-ink-mute">
                  {p.path.split('/').pop()}:{p.line}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
