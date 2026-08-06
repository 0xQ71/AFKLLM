import { useEffect, useState } from 'react'
import type { UpdaterCheckResult } from '../../../shared/updater'
import { useI18n } from '../i18n/I18nProvider'

export function UpdateAvailableBanner(): React.JSX.Element | null {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdaterCheckResult | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.updater.getStatus().then(setStatus)
    return window.api.updater.onStatus(setStatus)
  }, [])

  if (dismissed) return null
  if (
    status?.status !== 'available' &&
    status?.status !== 'downloading' &&
    status?.status !== 'downloaded'
  ) {
    return null
  }
  if (!status.version) return null

  const downloading = status.status === 'downloading'
  const downloaded = status.status === 'downloaded'

  const onUpdate = async (): Promise<void> => {
    setBusy(true)
    try {
      if (downloaded) {
        await window.api.updater.install()
        return
      }
      await window.api.updater.download()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-signal/30 bg-signal/10 px-3 py-1.5 text-xs text-ink-bright">
      <span className="min-w-0 flex-1 truncate">
        {t('updates.banner', { version: status.version })}
      </span>
      {typeof status.progress === 'number' && downloading && (
        <span className="shrink-0 font-mono text-[10px] text-ink-mute">
          {Math.round(status.progress * 100)}%
        </span>
      )}
      <button
        type="button"
        disabled={busy || downloading}
        onClick={() => void onUpdate()}
        className="shrink-0 rounded border border-signal/40 px-2 py-0.5 text-signal hover:bg-ink-800 disabled:opacity-50"
      >
        {downloading
          ? t('settings.updates.downloading')
          : downloaded
            ? t('settings.updates.install')
            : t('settings.updates.update')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-ink-mute hover:text-ink-bright"
        aria-label={t('updates.dismiss')}
      >
        ×
      </button>
    </div>
  )
}
