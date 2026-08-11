import type { ChatMessageStats } from '../agent/runAgentTurn'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string

export function formatStatsSummary(stats: ChatMessageStats, t?: TFn): string {
  const parts: string[] = []
  const gen = stats.genMs ?? stats.elapsedMs
  if (gen != null) parts.push(formatDuration(gen))
  if (stats.tps != null) parts.push(`${stats.tps} t/s`)
  if (stats.completionTokens != null) parts.push(`${stats.completionTokens} tok`)
  else if (stats.totalTokens != null) parts.push(`${stats.totalTokens} tok`)
  if (stats.promptTps != null) {
    parts.push(
      t
        ? t('stats.promptShort', { n: stats.promptTps })
        : `prompt ${stats.promptTps} t/s`
    )
  }
  if (stats.turnElapsedMs != null) {
    const d = formatDuration(stats.turnElapsedMs)
    parts.push(t ? t('stats.totalShort', { duration: d }) : `total ${d}`)
  }
  return parts.join(' · ')
}

function statsLines(stats: ChatMessageStats, t: TFn): string[] {
  const lines: string[] = []
  const gen = stats.genMs ?? stats.elapsedMs
  if (gen != null) lines.push(t('stats.generation', { duration: formatDuration(gen) }))
  if (stats.tps != null) lines.push(t('stats.tokensPerSec', { n: stats.tps }))
  if (stats.promptTps != null) lines.push(t('stats.promptEval', { n: stats.promptTps }))
  if (stats.completionTokens != null)
    lines.push(t('stats.completion', { n: stats.completionTokens }))
  if (stats.promptTokens != null) lines.push(t('stats.prompt', { n: stats.promptTokens }))
  if (stats.totalTokens != null) lines.push(t('stats.total', { n: stats.totalTokens }))
  if (stats.turnElapsedMs != null)
    lines.push(t('stats.turn', { duration: formatDuration(stats.turnElapsedMs) }))
  return lines
}

export function hasDisplayableStats(stats?: ChatMessageStats | null): boolean {
  if (!stats) return false
  return (
    stats.tps != null ||
    stats.promptTps != null ||
    stats.promptTokens != null ||
    stats.completionTokens != null ||
    stats.totalTokens != null ||
    stats.elapsedMs != null ||
    stats.genMs != null ||
    stats.turnElapsedMs != null
  )
}

interface MessageStatsInfoProps {
  stats: ChatMessageStats
  /** Align under a right-side user bubble */
  align?: 'start' | 'end'
}

export function MessageStatsInfo({
  stats,
  align = 'start'
}: MessageStatsInfoProps): React.JSX.Element | null {
  const { t } = useI18n()
  if (!hasDisplayableStats(stats)) return null
  const summary = formatStatsSummary(stats, t)
  const lines = statsLines(stats, t)
  return (
    <details
      className={
        'group mt-0.5 text-[10px] text-ink-mute ' +
        (align === 'end' ? 'text-right' : 'text-left')
      }
    >
      <summary className="cursor-pointer list-none select-none hover:text-ink-soft [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <div
        className={
          'mt-1 space-y-0.5 font-mono leading-relaxed ' +
          (align === 'end' ? 'text-right' : 'text-left')
        }
      >
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </details>
  )
}
