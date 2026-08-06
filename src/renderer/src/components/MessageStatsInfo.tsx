import type { ChatMessageStats } from '../agent/runAgentTurn'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

export function formatStatsSummary(stats: ChatMessageStats): string {
  const parts: string[] = []
  const gen = stats.genMs ?? stats.elapsedMs
  if (gen != null) parts.push(formatDuration(gen))
  if (stats.tps != null) parts.push(`${stats.tps} t/s`)
  if (stats.completionTokens != null) parts.push(`${stats.completionTokens} tok`)
  else if (stats.totalTokens != null) parts.push(`${stats.totalTokens} tok`)
  if (stats.promptTps != null) parts.push(`prompt ${stats.promptTps} t/s`)
  if (stats.turnElapsedMs != null) parts.push(`total ${formatDuration(stats.turnElapsedMs)}`)
  return parts.join(' · ')
}

function statsLines(stats: ChatMessageStats): string[] {
  const lines: string[] = []
  const gen = stats.genMs ?? stats.elapsedMs
  if (gen != null) lines.push(`Generation ${formatDuration(gen)}`)
  if (stats.tps != null) lines.push(`${stats.tps} tokens/sec`)
  if (stats.promptTps != null) lines.push(`Prompt eval ${stats.promptTps} t/s`)
  if (stats.completionTokens != null) lines.push(`Completion +${stats.completionTokens} tok`)
  if (stats.promptTokens != null) lines.push(`Prompt ${stats.promptTokens} tok`)
  if (stats.totalTokens != null) lines.push(`Total ${stats.totalTokens} tok`)
  if (stats.turnElapsedMs != null) lines.push(`Turn ${formatDuration(stats.turnElapsedMs)}`)
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
  if (!hasDisplayableStats(stats)) return null
  const lines = statsLines(stats)
  const summary = formatStatsSummary(stats)
  if (lines.length === 0) return null

  return (
    <div
      className={
        'group/stats relative mt-1 inline-flex ' +
        (align === 'end' ? 'justify-end self-end' : '')
      }
    >
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded-full text-ink-mute hover:bg-ink-800 hover:text-ink-soft"
        aria-label={summary}
        title={summary}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M12 11v5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="8" r="1" fill="currentColor" />
        </svg>
      </button>
      <div
        role="tooltip"
        className={
          'pointer-events-none absolute bottom-full z-40 mb-1.5 hidden min-w-[11rem] max-w-[18rem] ' +
          'rounded-md border border-ink-line bg-ink-900 px-2.5 py-2 shadow-xl ' +
          'group-hover/stats:block ' +
          (align === 'end' ? 'right-0' : 'left-0')
        }
      >
        <ul className="space-y-0.5 font-mono text-[10px] leading-snug text-ink-soft">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
