import * as monaco from 'monaco-editor'
import type { DiagnosticItem, DiagnosticSeverity, DiagnosticsSnapshot } from '../../../shared/diagnostics'

/** Exported for smoke tests. */
export function severityToMonaco(s: DiagnosticSeverity): monaco.MarkerSeverity {
  if (s === 'error') return monaco.MarkerSeverity.Error
  if (s === 'warning') return monaco.MarkerSeverity.Warning
  if (s === 'info') return monaco.MarkerSeverity.Info
  return monaco.MarkerSeverity.Hint
}

/** Exported for smoke tests. */
export function groupByPath(items: DiagnosticItem[]): Map<string, DiagnosticItem[]> {
  const map = new Map<string, DiagnosticItem[]>()
  for (const d of items) {
    const key = d.path.replace(/\\/g, '/')
    const list = map.get(key) ?? []
    list.push(d)
    map.set(key, list)
  }
  return map
}

function modelRelPath(model: monaco.editor.ITextModel): string {
  const uri = model.uri
  const raw = (uri.path || uri.fsPath || uri.toString())
    .replace(/^\/([a-zA-Z]:)/, '$1')
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
  // Monaco path often looks like /src/foo.ts or in-memory:/src/foo.ts
  const stripped = raw.replace(/^inmemory:\/\//i, '').replace(/^\/+/, '')
  return stripped
}

function matchesPath(modelPath: string, diagPath: string): boolean {
  const a = modelPath.replace(/\\/g, '/')
  const b = diagPath.replace(/\\/g, '/')
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a) || a.endsWith(b)
}

function toMarker(d: DiagnosticItem): monaco.editor.IMarkerData {
  return {
    severity: severityToMonaco(d.severity),
    message: d.message,
    startLineNumber: Math.max(1, d.line),
    startColumn: Math.max(1, d.column),
    endLineNumber: Math.max(1, d.line),
    endColumn: Math.max(1, d.column) + 1,
    source: d.source
  }
}

const OWNERS = ['tsc', 'eslint'] as const

/**
 * Push repo diagnostics into Monaco gutters for currently open models.
 */
export function applyRepoMarkers(snap: DiagnosticsSnapshot | null | undefined): void {
  const byPath = groupByPath(snap?.items ?? [])
  const models = monaco.editor.getModels()

  for (const model of models) {
    const rel = modelRelPath(model)
    const items = [...byPath.entries()]
      .filter(([p]) => matchesPath(rel, p))
      .flatMap(([, list]) => list)

    for (const owner of OWNERS) {
      const markers = items.filter((d) => d.source === owner).map(toMarker)
      monaco.editor.setModelMarkers(model, owner, markers)
    }
  }
}
