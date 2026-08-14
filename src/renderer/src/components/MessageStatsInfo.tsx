import type { ChatMessageStats } from '../agent/runAgentTurn'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

type TFn = (key: string, vars?: Record<string, string | number>) => string

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

/** Chat UI no longer shows per-message generation stats (multi-line dump was noise). */
export function hasDisplayableStats(_stats?: ChatMessageStats | null): boolean {
  return false
}

interface MessageStatsInfoProps {
  stats: ChatMessageStats
  /** Align under a right-side user bubble */
  align?: 'start' | 'end'
}

export function MessageStatsInfo(
  _props: MessageStatsInfoProps
): React.JSX.Element | null {
  return null
}
