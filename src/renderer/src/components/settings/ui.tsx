import type { ReactNode } from 'react'

export function Well({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-line/80 bg-ink-900/80 divide-y divide-ink-line/60">
      {children}
    </div>
  )
}

export function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium text-ink-bright">{title}</div>
        {description ? (
          <p className="text-[12px] leading-snug text-ink-mute">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:max-w-[55%]">
        {children}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="block space-y-1.5 px-4 py-3">
      <span className="text-xs text-ink-mute">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-ink-mute/70">{hint}</span> : null}
    </label>
  )
}

export function Toggle({
  title,
  description,
  checked,
  onChange
}: {
  title: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <SettingRow title={title} description={description}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={
          'relative h-6 w-11 shrink-0 rounded-full transition-colors ' +
          (checked ? 'bg-signal' : 'bg-ink-800 border border-ink-line')
        }
      >
        <span
          className={
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ' +
            (checked ? 'left-5' : 'left-0.5')
          }
        />
      </button>
    </SettingRow>
  )
}

export const settingsInputClass =
  'w-full rounded-md border border-ink-line bg-ink-950 px-2.5 py-1.5 text-sm text-ink-bright outline-none focus:border-signal disabled:opacity-45'

export const settingsBtnClass =
  'rounded-md border border-ink-line px-3 py-1.5 text-xs text-ink-soft hover:bg-ink-800 disabled:opacity-50'

export const settingsPrimaryBtnClass =
  'rounded-md bg-signal px-3 py-1.5 text-xs text-signal-on hover:bg-signal-dim disabled:opacity-50'
