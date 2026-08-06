import { useEffect } from 'react'

interface TextNoticeDialogProps {
  open: boolean
  title: string
  body: string
  closeLabel?: string
  onClose: () => void
}

export function TextNoticeDialog({
  open,
  title,
  body,
  closeLabel = 'OK',
  onClose
}: TextNoticeDialogProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="afk-notice-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={
          'flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-ink-line ' +
          'bg-ink-900 shadow-2xl ' +
          'max-h-[min(70vh,520px)]'
        }
      >
        <div className="shrink-0 border-b border-ink-line px-4 py-2.5">
          <h2 id="afk-notice-title" className="font-display text-sm font-semibold text-ink-bright">
            {title}
          </h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">
            {body}
          </pre>
        </div>
        <div className="flex shrink-0 justify-end border-t border-ink-line px-4 py-2.5">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-md bg-signal px-3 py-1.5 font-mono text-xs font-medium text-signal-on hover:bg-signal-dim"
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
