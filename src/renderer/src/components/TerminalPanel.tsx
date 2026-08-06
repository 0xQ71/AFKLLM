import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_THEMES, resolveUiTheme, type UiTheme } from '../../../shared/theme'

interface TerminalPanelProps {
  open: boolean
  cwd: string | null
  uiTheme: UiTheme
  onClose: () => void
  fill?: boolean
}

export function TerminalPanel({
  open,
  cwd,
  uiTheme,
  onClose,
  fill = false
}: TerminalPanelProps): React.JSX.Element | null {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [copyFlash, setCopyFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = (msg: string): void => {
    setCopyFlash(msg)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setCopyFlash(null), 1200)
  }

  const writeClipboard = async (text: string, label: string): Promise<void> => {
    const t = text.replace(/\r/g, '').trimEnd()
    if (!t) {
      flash('Nothing to copy')
      return
    }
    try {
      await navigator.clipboard.writeText(t)
      flash(label)
    } catch {
      flash('Copy failed')
    }
  }

  const copySelectionOrRecent = async (): Promise<void> => {
    const term = termRef.current
    if (term?.hasSelection()) {
      await writeClipboard(term.getSelection(), 'Copied selection')
      return
    }
    const id = idRef.current
    if (id) {
      try {
        const sb = await window.api.terminal.scrollback(id)
        await writeClipboard(sb.data.slice(-12_000), 'Copied terminal output')
        return
      } catch {
        /* ignore */
      }
    }
    flash('Nothing to copy')
  }

  const copyAll = async (): Promise<void> => {
    const id = idRef.current
    if (!id) {
      flash('No session')
      return
    }
    try {
      const sb = await window.api.terminal.scrollback(id)
      await writeClipboard(sb.data, 'Copied all')
    } catch {
      flash('Copy failed')
    }
  }

  useEffect(() => {
    if (!open || !hostRef.current) return

    const colors = TERMINAL_THEMES[resolveUiTheme(uiTheme)]
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      rightClickSelectsWord: true,
      theme: { ...colors }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const mod = ev.ctrlKey || ev.metaKey
      if (!mod) return true
      const key = ev.key.toLowerCase()

      if (key === 'c' && !ev.shiftKey && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).then(() => flash('Copied'))
        return false
      }
      if (key === 'c' && ev.shiftKey) {
        void (async () => {
          if (term.hasSelection()) {
            await writeClipboard(term.getSelection(), 'Copied selection')
            return
          }
          const id = idRef.current
          if (!id) {
            flash('Nothing to copy')
            return
          }
          try {
            const sb = await window.api.terminal.scrollback(id)
            await writeClipboard(sb.data.slice(-12_000), 'Copied terminal output')
          } catch {
            flash('Copy failed')
          }
        })()
        return false
      }
      if (key === 'v') {
        void navigator.clipboard.readText().then((t) => {
          if (t && idRef.current) window.api.terminal.write(idRef.current, t)
        })
        return false
      }
      return true
    })

    let disposed = false
    const unsubs: Array<() => void> = []

    void (async () => {
      const session = await window.api.terminal.create(cwd ?? undefined)
      if (disposed) return
      idRef.current = session.id
      fit.fit()
      window.api.terminal.resize(session.id, term.cols, term.rows)

      unsubs.push(
        window.api.terminal.onData(({ id, data }) => {
          if (id === session.id) term.write(data)
        })
      )
      unsubs.push(
        window.api.terminal.onExit(({ id, exitCode }) => {
          if (id === session.id) {
            term.writeln(`\r\n[process exited: ${exitCode}]`)
            idRef.current = null
          }
        })
      )

      try {
        const sb = await window.api.terminal.scrollback(session.id)
        if (!disposed && sb.data) {
          term.reset()
          term.write(sb.data)
        }
      } catch {
        /* ignore */
      }

      term.onData((data) => {
        if (idRef.current) window.api.terminal.write(idRef.current, data)
      })
    })()

    const onResize = (): void => {
      fit.fit()
      if (idRef.current) {
        window.api.terminal.resize(idRef.current, term.cols, term.rows)
      }
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      for (const u of unsubs) u()
      idRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per open/cwd/theme
  }, [open, cwd, uiTheme])

  if (!open) return null

  return (
    <div
      className={
        fill
          ? 'flex h-full min-h-0 flex-1 flex-col bg-ink-950'
          : 'flex h-52 shrink-0 flex-col border-t border-ink-line bg-ink-950'
      }
    >
      <div className="flex h-7 items-center gap-2 border-b border-ink-line px-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          Terminal
        </span>
        <span className="truncate font-mono text-[10px] text-ink-mute">{cwd}</span>
        {copyFlash && (
          <span className="font-mono text-[10px] text-signal">{copyFlash}</span>
        )}
        <button
          type="button"
          title="Copy selection or recent output (Ctrl+Shift+C)"
          onClick={() => void copySelectionOrRecent()}
          className="ml-auto text-[10px] text-ink-mute hover:text-ink-bright"
        >
          Copy
        </button>
        <button
          type="button"
          title="Copy full scrollback"
          onClick={() => void copyAll()}
          className="text-[10px] text-ink-mute hover:text-ink-bright"
        >
          Copy all
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-ink-mute hover:text-ink-bright"
        >
          Hide
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-1 py-1" />
    </div>
  )
}
