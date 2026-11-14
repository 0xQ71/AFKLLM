import type { MessageKey } from '../i18n/messages'

export type QueuedFollowUp = {
  id: string
  text: string
}

type ComposerQueueProps = {
  items: QueuedFollowUp[]
  editingId: string | null
  busy: boolean
  onEditStart: (id: string) => void
  onEditChange: (id: string, text: string) => void
  onEditDone: () => void
  onSendNow: (id: string) => void
  onDelete: (id: string) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

export function ComposerQueue({
  items,
  editingId,
  busy,
  onEditStart,
  onEditChange,
  onEditDone,
  onSendNow,
  onDelete,
  t
}: ComposerQueueProps): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-ink-line/70 bg-ink-950/80">
      <div className="flex items-center justify-between gap-2 border-b border-ink-line/50 px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wide text-ink-soft">
          {t('chat.queue.title', { n: items.length })}
        </span>
        <span className="text-[10px] text-ink-mute">
          {busy ? t('chat.queue.hintBusy') : t('chat.queue.hintIdle')}
        </span>
      </div>
      <ul className="max-h-40 divide-y divide-ink-line/40 overflow-y-auto">
        {items.map((item) => {
          const editing = editingId === item.id
          return (
            <li key={item.id} className="flex items-start gap-2 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                {editing ? (
                  <textarea
                    autoFocus
                    value={item.text}
                    rows={2}
                    onChange={(e) => onEditChange(item.id, e.target.value)}
                    onBlur={onEditDone}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        onEditDone()
                      }
                      if (e.key === 'Escape') onEditDone()
                    }}
                    className="w-full resize-none rounded-md border border-ink-line bg-ink-900 px-2 py-1.5 text-[12px] text-ink-bright outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onEditStart(item.id)}
                    className="w-full text-left text-[12px] leading-snug text-ink-soft hover:text-ink-bright"
                    title={t('chat.queue.edit')}
                  >
                    <span className="line-clamp-2 whitespace-pre-wrap break-words">{item.text}</span>
                  </button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                <button
                  type="button"
                  title={t('chat.queue.edit')}
                  onClick={() => onEditStart(item.id)}
                  className="rounded px-1.5 py-1 text-[10px] text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                >
                  {t('chat.queue.edit')}
                </button>
                <button
                  type="button"
                  title={t('chat.queue.sendNow')}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onSendNow(item.id)
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-mute hover:bg-ink-800 hover:text-signal"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M12 19V5M12 5l-6 6M12 5l6 6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  title={t('chat.queue.delete')}
                  onClick={() => onDelete(item.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
