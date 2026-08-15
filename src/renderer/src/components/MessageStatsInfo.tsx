import type { ChatMessageStats } from '../agent/runAgentTurn'
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

/** Compact one-liner for logs / non-chat uses — not shown in the chat UI. */
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

export function hasDisplayableStats(stats?: ChatMessageStats | null): boolean {
  if (!stats) return false
  return (
    stats.tps != null ||
    stats.promptTps != null ||
    stats.genMs != null ||
    stats.elapsedMs != null ||
    stats.completionTokens != null ||
    stats.promptTokens != null ||
    stats.totalTokens != null ||
    stats.turnElapsedMs != null
  )
}

interface MessageStatsInfoProps {
  stats: ChatMessageStats
  /** Align under a right-side user bubble */
  align?: 'start' | 'end'
  t?: TFn
}

/** One quiet line under a message: duration, speed, tokens. */
export function MessageStatsInfo({
  stats,
  align = 'start',
  t
}: MessageStatsInfoProps): React.JSX.Element | null {
  if (!hasDisplayableStats(stats)) return null
  const label = (
    key: MessageKey,
    fallback: string,
    vars?: Record<string, string | number>
  ): string => (t ? t(key, vars) : fallback)

  const chips: string[] = []
  const gen = stats.genMs ?? stats.elapsedMs
  if (gen != null) {
    chips.push(label('stats.generation', `Generation ${formatDuration(gen)}`, {
      duration: formatDuration(gen)
    }))
  }
  if (stats.tps != null) {
    chips.push(label('stats.tokensPerSec', `${stats.tps} tokens/sec`, { n: stats.tps }))
  }
  const outTokens = stats.completionTokens ?? stats.totalTokens
  if (outTokens != null) {
    chips.push(
      stats.completionTokens != null
        ? label('stats.completion', `Completion +${outTokens} tok`, { n: outTokens })
        : label('stats.total', `Total ${outTokens} tok`, { n: outTokens })
    )
  }
  if (stats.promptTokens != null) {
    chips.push(label('stats.prompt', `Prompt ${stats.promptTokens} tok`, {
      n: stats.promptTokens
    }))
  }
  if (stats.promptTps != null) {
    chips.push(label('stats.promptEval', `Prompt eval ${stats.promptTps} t/s`, {
      n: stats.promptTps
    }))
  }
  if (stats.turnElapsedMs != null) {
    chips.push(label('stats.turn', `Turn ${formatDuration(stats.turnElapsedMs)}`, {
      duration: formatDuration(stats.turnElapsedMs)
    }))
  }
  if (chips.length === 0) return null

  return (
    <div
      className={
        'mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-ink-mute/70 ' +
        (align === 'end' ? 'justify-end' : 'justify-start')
      }
    >
      {chips.map((chip, i) => (
        <span key={i} className="tabular-nums">
          {chip}
        </span>
      ))}
    </div>
  )
}
