import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages'
import { useI18n } from '../i18n/I18nProvider'
import {
  estimateContextUsage,
  formatTokenCount,
  type ContextUsageEstimate,
  type EstimateContextUsageInput
} from '../agent/contextUsage'

interface ContextUsageControlProps {
  estimateInput: EstimateContextUsageInput
}

function SemicircleGauge({
  pct,
  className
}: {
  pct: number
  className?: string
}): React.JSX.Element {
  const p = Math.max(0, Math.min(100, pct)) / 100
  const r = 9
  const cx = 12
  const cy = 13
  const startX = cx - r
  const startY = cy
  const endX = cx + r
  const endY = cy
  const bg = `M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}`
  const angle = Math.PI * (1 - p)
  const fx = cx + r * Math.cos(angle)
  const fy = cy - r * Math.sin(angle)
  const large = p > 0.5 ? 1 : 0
  const fg =
    p <= 0.001
      ? ''
      : `M ${startX} ${startY} A ${r} ${r} 0 ${large} 1 ${fx} ${fy}`

  const stroke =
    p >= 0.9 ? 'var(--afk-danger, #f87171)' : p >= 0.7 ? '#fbbf24' : 'var(--afk-signal, #2dd4bf)'

  return (
    <svg
      width="18"
      height="12"
      viewBox="0 0 24 16"
      className={className}
      aria-hidden
    >
      <path
        d={bg}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="text-ink-line"
      />
      {fg ? (
        <path
          d={fg}
          fill="none"
          stroke={stroke}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  )
}

export function ContextUsageControl({
  estimateInput
}: ContextUsageControlProps): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const usage: ContextUsageEstimate = useMemo(
    () => estimateContextUsage(estimateInput),
    [estimateInput]
  )

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      const el = e.target
      if (el instanceof Element && rootRef.current?.contains(el)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const limitLabel =
    usage.limit != null ? formatTokenCount(usage.limit) : '—'
  const usedLabel = formatTokenCount(usage.used)
  const hasMeasure = usage.used > 0 || usage.measured

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] ' +
          (open
            ? 'bg-ink-800 text-ink-bright'
            : 'text-ink-mute hover:bg-ink-900 hover:text-ink-soft')
        }
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <SemicircleGauge pct={usage.pct} />
        <span>{t('context.label')}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('context.title')}
          className="absolute bottom-full right-0 z-50 mb-2 w-[min(100vw-2rem,20rem)] overflow-hidden rounded-lg border border-ink-line bg-ink-900 shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-ink-line px-3 py-2">
            <h3 className="text-[13px] font-medium text-ink-bright">{t('context.title')}</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 py-0.5 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
              aria-label={t('settings.close')}
            >
              ×
            </button>
          </div>

          <div className="space-y-3 px-3 py-3">
            {!hasMeasure && usage.limit == null ? (
              <p className="text-[11px] text-ink-mute">{t('context.empty')}</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="font-medium text-ink-bright">
                    {t('context.pctFull', { n: usage.pct })}
                  </span>
                  <span className="font-mono text-[11px] text-ink-mute">
                    {usage.measured ? '~' : '≈'}
                    {usedLabel} / {limitLabel} {t('context.tokens')}
                  </span>
                </div>

                <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink-950">
                  {usage.limit != null && usage.limit > 0
                    ? usage.categories.map((c) => {
                        const width = (c.tokens / usage.limit!) * 100
                        return (
                          <div
                            key={c.id}
                            style={{
                              width: `${Math.max(width > 0 ? 0.35 : 0, width)}%`,
                              background: c.color
                            }}
                            title={`${t(c.labelKey as MessageKey)} · ${formatTokenCount(c.tokens)}`}
                          />
                        )
                      })
                    : usage.categories.map((c) => {
                        const width =
                          usage.used > 0 ? (c.tokens / usage.used) * 100 : 0
                        return (
                          <div
                            key={c.id}
                            style={{
                              width: `${Math.max(width > 0 ? 0.35 : 0, width)}%`,
                              background: c.color
                            }}
                          />
                        )
                      })}
                </div>

                <ul className="space-y-1.5">
                  {usage.categories.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-2 text-[12px] text-ink-soft"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                        style={{ background: c.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {t(c.labelKey as MessageKey)}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-mute">
                        {formatTokenCount(c.tokens)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
