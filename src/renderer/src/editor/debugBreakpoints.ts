import type * as Monaco from 'monaco-editor'
import type { DebugBreakpoint } from '../../../shared/debug'

const BP_CLASS = 'afkllm-breakpoint'
const CURRENT_CLASS = 'afkllm-debug-current'

/** Inject CSS once for breakpoint / current-line glyphs. */
export function ensureDebugDecorationStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('afkllm-debug-styles')) return
  const style = document.createElement('style')
  style.id = 'afkllm-debug-styles'
  style.textContent = `
    .${BP_CLASS} { background: #e06c75; width: 8px !important; height: 8px !important;
      left: 6px !important; top: 50%; transform: translateY(-50%); border-radius: 50%; margin-left: 0 !important; }
    .${CURRENT_CLASS} { background: rgba(97, 175, 239, 0.18); }
  `
  document.head.appendChild(style)
}

export function breakpointsToArray(
  map: Map<string, Set<number>>
): DebugBreakpoint[] {
  const out: DebugBreakpoint[] = []
  for (const [path, lines] of map) {
    for (const line of lines) out.push({ path, line })
  }
  return out
}

/**
 * Toggle breakpoint on glyph-margin click; returns updated decoration ids.
 */
export function wireBreakpointGutter(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  opts: {
    getPath: () => string | null
    getBreakpoints: () => Map<string, Set<number>>
    setBreakpoints: (next: Map<string, Set<number>>) => void
    onChanged: () => void
  }
): Monaco.IDisposable {
  ensureDebugDecorationStyles()
  let decorationIds: string[] = []

  const refresh = (): void => {
    const path = opts.getPath()
    const model = editor.getModel()
    if (!path || !model) {
      decorationIds = editor.deltaDecorations(decorationIds, [])
      return
    }
    const lines = opts.getBreakpoints().get(path) ?? new Set<number>()
    const decs: Monaco.editor.IModelDeltaDecoration[] = [...lines].map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: BP_CLASS,
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }))
    decorationIds = editor.deltaDecorations(decorationIds, decs)
  }

  const mouse = editor.onMouseDown((e) => {
    if (
      e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
      e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      return
    }
    const path = opts.getPath()
    const line = e.target.position?.lineNumber
    if (!path || !line) return
    const next = new Map(opts.getBreakpoints())
    const set = new Set(next.get(path) ?? [])
    if (set.has(line)) set.delete(line)
    else set.add(line)
    if (set.size === 0) next.delete(path)
    else next.set(path, set)
    opts.setBreakpoints(next)
    refresh()
    opts.onChanged()
  })

  const modelChange = editor.onDidChangeModel(() => refresh())
  refresh()

  return {
    dispose: () => {
      mouse.dispose()
      modelChange.dispose()
      decorationIds = editor.deltaDecorations(decorationIds, [])
    }
  }
}

export function applyCurrentLineDecoration(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  monaco: typeof Monaco | null,
  line: number | null,
  prevIds: string[]
): string[] {
  if (!editor || !monaco) return []
  if (!line || line < 1) {
    return editor.deltaDecorations(prevIds, [])
  }
  return editor.deltaDecorations(prevIds, [
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: CURRENT_CLASS,
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }
  ])
}
