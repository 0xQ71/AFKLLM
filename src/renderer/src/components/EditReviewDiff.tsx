import { useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { languageIdFromPath } from '../editor/language'
import { AFK_SCROLLBAR } from '../editor/monacoSetup'

interface EditReviewDiffProps {
  path: string
  editorTheme?: string
}

export function EditReviewDiff({
  path,
  editorTheme = 'afkllm-dark'
}: EditReviewDiffProps): React.JSX.Element {
  const [previous, setPrevious] = useState('')
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setError(null)
    void window.api.agent.pendingDiff(path).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setError(res.error ?? 'No diff')
        setReady(true)
        return
      }
      setPrevious(res.previous)
      setCurrent(res.current)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!ready) {
    return (
      <div className="mt-2 font-mono text-[10px] text-ink-mute">Loading diff…</div>
    )
  }
  if (error) {
    return (
      <div className="mt-2 font-mono text-[10px] text-rose-300">{error}</div>
    )
  }

  const lang = languageIdFromPath(path)

  return (
    <div className="mt-2 overflow-hidden rounded border border-ink-line">
      <div className="border-b border-ink-line bg-ink-950 px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-ink-mute">
        Diff · {path}
      </div>
      <div className="h-48">
        <DiffEditor
          original={previous}
          modified={current}
          language={lang}
          theme={editorTheme}
          options={{
            readOnly: true,
            renderSideBySide: false,
            minimap: { enabled: false },
            scrollbar: AFK_SCROLLBAR,
            fontSize: 11,
            lineNumbers: 'off',
            folding: false,
            renderOverviewRuler: false
          }}
        />
      </div>
    </div>
  )
}
