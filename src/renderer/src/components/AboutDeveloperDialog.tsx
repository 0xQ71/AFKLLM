import { useEffect } from 'react'
import { useI18n } from '../i18n/I18nProvider'

interface AboutDeveloperDialogProps {
  open: boolean
  onClose: () => void
  appVersion?: string
}

const GITHUB_URL = 'https://github.com/0xQ71'
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/90406934?v=4'

export function AboutDeveloperDialog({
  open,
  onClose,
  appVersion = ''
}: AboutDeveloperDialogProps): React.JSX.Element | null {
  const { t } = useI18n()

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
      aria-labelledby="afk-dev-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[min(80vh,480px)] w-full max-w-md flex-col overflow-hidden rounded-lg border border-ink-line bg-ink-900 shadow-2xl">
        <div className="flex items-start gap-3 border-b border-ink-line px-4 py-3">
          <img
            src={AVATAR_URL}
            alt=""
            width={48}
            height={48}
            className="h-12 w-12 shrink-0 rounded-full border border-ink-line bg-ink-950"
          />
          <div className="min-w-0 flex-1">
            <h2 id="afk-dev-title" className="text-sm font-semibold text-ink-bright">
              {t('menu.help.developerTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-ink-mute">{t('menu.help.developerRole')}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-sm text-ink-soft">
          {appVersion ? (
            <p className="font-mono text-xs text-ink-mute">
              {t('menu.help.versionTitle', { version: appVersion })}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap leading-relaxed">{t('menu.help.developerBody')}</p>
          <p className="text-xs leading-relaxed text-ink-mute">{t('menu.help.developerBio')}</p>
          <button
            type="button"
            onClick={() => void window.api.app.openExternal(GITHUB_URL)}
            className="inline-flex items-center gap-1.5 rounded border border-signal/40 px-2.5 py-1.5 font-mono text-xs text-signal hover:bg-ink-800"
          >
            {t('menu.help.developerGithub')}
          </button>
        </div>
        <div className="flex shrink-0 justify-end border-t border-ink-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-signal px-3 py-1.5 text-sm text-signal-on hover:bg-signal-dim"
          >
            {t('menu.help.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
