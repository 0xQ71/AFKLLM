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

/** Gauge fill: teal → amber → rose (never theme blue/signal). */
function gaugeStroke(pct: number): string {
  if (pct >= 90) return '#f87171'
  if (pct >= 70) return '#fbbf24'
  return '#2dd4bf'
}

/**
 * Top semicircle speedometer. Uses pathLength + dasharray so fill always
 * tracks left→right along the upper arc (no SVG large-arc / sweep traps).
 */
function SemicircleGauge({
  pct,
  size = 'sm'
}: {
  pct: number
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  const p = Math.max(0, Math.min(100, pct))
  const stroke = gaugeStroke(p)
  // Clockwise upper arc: left → top → right (y grows downward).
  const d = size === 'lg' ? 'M 8 52 A 44 44 0 0 1 104 52' : 'M 3 16 A 13 13 0 0 1 29 16'
  const vb = size === 'lg' ? '0 0 112 60' : '0 0 32 18'
  const w = size === 'lg' ? 168 : 20
  const h = size === 'lg' ? 90 : 12
  const sw = size === 'lg' ? 8 : 2.6

  return (
    <svg width={w} height={h} viewBox={vb} className="shrink-0 overflow-visible" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        pathLength={100}
        className="text-ink-line"
      />
      {p > 0.4 ? (
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${p} ${100 - p}`}
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

  const limitLabel = usage.limit != null ? formatTokenCount(usage.limit) : '—'
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
        <SemicircleGauge pct={usage.pct} size="sm" />
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
                <div className="flex flex-col items-center gap-1 pt-1">
                  <SemicircleGauge pct={usage.pct} size="lg" />
                  <div className="-mt-3 flex flex-col items-center">
                    <span className="text-[18px] font-semibold tabular-nums text-ink-bright">
                      {t('context.pctFull', { n: usage.pct })}
                    </span>
                    <span className="font-mono text-[11px] text-ink-mute">
                      {usage.measured ? '~' : '≈'}
                      {usedLabel} / {limitLabel} {t('context.tokens')}
                    </span>
                  </div>
                </div>

                <ul className="space-y-1.5 border-t border-ink-line/60 pt-2">
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
