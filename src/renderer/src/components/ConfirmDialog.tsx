import { useEffect } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="afk-confirm-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-ink-line bg-ink-900 shadow-2xl">
        <div className="border-b border-ink-line px-4 py-3">
          <h2 id="afk-confirm-title" className="font-display text-sm font-semibold text-ink-bright">
            {title}
          </h2>
        </div>
        <p className="whitespace-pre-line px-4 py-3 text-sm leading-relaxed text-ink-soft">{message}</p>
        <div className="flex justify-end gap-2 border-t border-ink-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 font-mono text-xs text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className={
              'rounded-md px-3 py-1.5 font-mono text-xs font-medium ' +
              (danger
                ? 'bg-rose-600 text-white hover:bg-rose-500'
                : 'bg-signal text-signal-on hover:bg-signal-dim')
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
