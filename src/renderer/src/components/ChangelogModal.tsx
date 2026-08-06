import { useEffect, useState } from 'react'
import { MarkdownBody } from './MarkdownBody'
import { useI18n } from '../i18n/I18nProvider'

interface ChangelogModalProps {
  open: boolean
  version: string
  body: string
  onClose: () => void
}

export function ChangelogModal({
  open,
  version,
  body,
  onClose
}: ChangelogModalProps): React.JSX.Element | null {
  const { t, lang } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const localized = t('changelog.releaseNotes').trim()
  const remote = body.trim()
  // Russian UI prefers localized notes; English prefers GitHub Release body when present
  const content =
    lang === 'ru'
      ? localized || remote || t('changelog.fallback', { version })
      : remote || localized || t('changelog.fallback', { version })

  return (
    <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        className="flex max-h-[min(80vh,560px)] w-full max-w-lg flex-col rounded-lg border border-ink-line bg-ink-900 shadow-2xl"
      >
        <div className="shrink-0 border-b border-ink-line px-4 py-3">
          <h2 id="changelog-title" className="text-sm font-semibold text-ink-bright">
            {t('changelog.title', { version })}
          </h2>
          <p className="mt-1 text-xs text-ink-mute">{t('changelog.subtitle')}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm text-ink-soft">
          <MarkdownBody content={content} />
        </div>
        <div className="flex shrink-0 justify-end border-t border-ink-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-signal px-3 py-1.5 text-sm text-signal-on hover:bg-signal-dim"
          >
            {t('changelog.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function usePostUpdateChangelog(): {
  open: boolean
  version: string
  body: string
  dismiss: () => void
} {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [appVersion, settings] = await Promise.all([
          window.api.getVersion(),
          window.api.settings.get()
        ])
        const current = String(appVersion || '').trim()
        if (!current) return
        const last = (settings.lastSeenVersion ?? '').trim()

        if (!last) {
          // First install / legacy settings: mark seen, no modal
          await window.api.settings.save({ lastSeenVersion: current })
          return
        }
        if (last === current) return

        const notes = await window.api.updater.releaseNotes(current)
        if (cancelled) return
        setVersion(current)
        setBody(notes.body || '')
        setOpen(true)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = (): void => {
    setOpen(false)
    if (version) {
      void window.api.settings.save({ lastSeenVersion: version })
    }
  }

  return { open, version, body, dismiss }
}
