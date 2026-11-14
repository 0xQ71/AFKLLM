import { useEffect, useState } from 'react'
import type { LlamaRuntimeProgress } from '../../../shared/llamaRuntime'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'

function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

function formatSpeedMb(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  const mbps = (bytesPerSecond * 8) / 1_000_000
  return `${mbps < 10 ? mbps.toFixed(2) : mbps.toFixed(1)} Mb/s`
}

function formatEta(bytesReceived: number, bytesTotal: number, bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0 || !bytesTotal || bytesTotal <= bytesReceived) {
    return ''
  }
  const sec = Math.ceil((bytesTotal - bytesReceived) / bytesPerSecond)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function assetName(
  progress: LlamaRuntimeProgress,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  if (progress.file && /cudart/i.test(progress.file)) return t('runtime.asset.cudart')
  return t('runtime.asset.server')
}

function statusLabel(
  progress: LlamaRuntimeProgress,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  const name = assetName(progress, t)
  switch (progress.phase) {
    case 'resolving':
      return t('runtime.phase.resolving')
    case 'downloading':
      return t('runtime.phase.downloading', { name })
    case 'verifying':
      return t('runtime.phase.verifying', { name })
    case 'extracting':
      return t('runtime.phase.extracting', { name })
    case 'ready':
      if (progress.tag && progress.variant) {
        return t('runtime.phase.installed', {
          tag: progress.tag,
          variant: progress.variant
        })
      }
      return progress.label || t('runtime.working')
    case 'error':
      return progress.error || progress.label || t('runtime.working')
    default:
      return progress.label || t('runtime.working')
  }
}

export function RuntimeProgressOverlay(): React.JSX.Element | null {
  const { t } = useI18n()
  const [progress, setProgress] = useState<LlamaRuntimeProgress | null>(null)

  useEffect(() => {
    void window.api.llamaRuntime.progress().then((p) => {
      if (p.phase !== 'idle' && p.phase !== 'ready') setProgress(p)
    })
    return window.api.llamaRuntime.onProgress((p) => {
      if (p.phase === 'idle' || p.phase === 'ready') {
        setProgress(null)
        return
      }
      setProgress(p)
    })
  }, [])

  if (!progress) return null

  const pct = Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100)
  const downloading = progress.phase === 'downloading'
  const speed =
    downloading && progress.bytesPerSecond ? formatSpeedMb(progress.bytesPerSecond) : ''
  const eta =
    downloading && progress.bytesPerSecond
      ? formatEta(progress.bytesReceived, progress.bytesTotal, progress.bytesPerSecond)
      : ''
  const pack =
    progress.variant && progress.tag
      ? `${progress.variant} · ${progress.tag}`
      : progress.variant || progress.tag || ''

  return (
    <div className="pointer-events-none absolute inset-0 z-[90] flex items-end justify-center p-6">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-ink-line bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
        <div className="text-sm font-medium text-ink-bright">{t('runtime.title')}</div>
        <p className="mt-1 text-xs text-ink-mute">{statusLabel(progress, t)}</p>
        {pack ? <p className="mt-0.5 text-[11px] text-ink-mute">{pack}</p> : null}
        {progress.file && (
          <p className="mt-1 truncate font-mono text-[10px] text-ink-mute">{progress.file}</p>
        )}
        <div className="mt-3 h-1.5 overflow-hidden rounded bg-ink-950">
          <div
            className="h-full bg-signal transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between gap-2 font-mono text-[10px] text-ink-mute">
          <span>
            {formatBytes(progress.bytesReceived)}
            {progress.bytesTotal > 0 ? ` / ${formatBytes(progress.bytesTotal)}` : ''}
            {speed ? ` · ${speed}` : ''}
            {eta ? ` · ${t('runtime.eta', { time: eta })}` : ''}
          </span>
          <span>{pct}%</span>
        </div>
        {progress.phase === 'error' && progress.error && (
          <p className="mt-2 text-xs text-red-400">{progress.error}</p>
        )}
        <p className="mt-2 text-[10px] text-ink-mute">{t('runtime.source')}</p>
      </div>
    </div>
  )
}
