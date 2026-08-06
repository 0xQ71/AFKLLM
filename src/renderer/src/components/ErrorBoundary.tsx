import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { applyDocumentTheme, migrateUiTheme } from '../../../shared/theme'
import { useI18n } from '../i18n/I18nProvider'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

function ErrorFallback({
  error,
  onReload,
  onOpenLogs,
  onDismiss
}: {
  error: Error
  onReload: () => void
  onOpenLogs: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useI18n()

  // Keep error screen on the active UI theme (sepia / solarized / …), not only light/dark.
  useEffect(() => {
    let cancelled = false
    void window.api.settings.get().then((s) => {
      if (cancelled) return
      applyDocumentTheme(migrateUiTheme(s.uiTheme))
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="flex h-full min-h-screen items-center justify-center bg-ink-950 px-6 py-10 text-ink-bright"
      style={{ background: 'var(--afk-bg)', color: 'var(--afk-bright)' }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-ink-line shadow-2xl"
        style={{
          background: 'var(--afk-bg-elevated)',
          color: 'var(--afk-bright)',
          borderColor: 'var(--afk-line)'
        }}
      >
        <div
          className="border-b px-5 py-4"
          style={{ borderColor: 'var(--afk-line)' }}
        >
          <h1 className="font-display text-base font-semibold tracking-tight text-ink-bright">
            {t('errorBoundary.title')}
          </h1>
          <p className="mt-1 text-[12px] leading-snug text-ink-mute">
            {t('errorBoundary.body')}
          </p>
        </div>
        <div className="px-5 py-4">
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-left font-mono text-[11px] leading-relaxed"
            style={{
              background: 'var(--afk-bg)',
              borderColor: 'var(--afk-line)',
              color: 'var(--afk-danger)'
            }}
          >
            {error.message}
          </pre>
        </div>
        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--afk-line)' }}
        >
          <button
            type="button"
            onClick={onOpenLogs}
            className="rounded-md border border-ink-line px-3 py-1.5 text-sm text-ink-soft hover:bg-ink-800 hover:text-ink-bright"
          >
            {t('errorBoundary.openLogs')}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-ink-line px-3 py-1.5 text-sm text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
          >
            {t('errorBoundary.continue')}
          </button>
          <button
            type="button"
            onClick={onReload}
            className="rounded-md bg-signal px-3 py-1.5 text-sm font-medium text-signal-on hover:bg-signal-dim"
          >
            {t('errorBoundary.reload')}
          </button>
        </div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.api.telemetry
      ?.report({
        kind: 'ui_boundary',
        message: error.message || String(error),
        stack: [error.stack, info.componentStack].filter(Boolean).join('\n'),
        source: 'renderer:ErrorBoundary'
      })
      .catch(() => undefined)
  }

  private reload = (): void => {
    window.location.reload()
  }

  private openLogs = (): void => {
    void window.api.telemetry?.openLogDir()
  }

  private dismiss = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <ErrorFallback
        error={error}
        onReload={this.reload}
        onOpenLogs={this.openLogs}
        onDismiss={this.dismiss}
      />
    )
  }
}
