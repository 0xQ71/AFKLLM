import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

interface BrowserPanelProps {
  open: boolean
  navigateUrl?: string | null
  navigateKey?: number
}

type AfkWebview = HTMLElement & {
  src: string
  loadURL: (url: string) => void
  reload: () => void
  stop: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  getTitle: () => string
  openDevTools: () => void
  closeDevTools: () => void
  isDevToolsOpened: () => boolean
}

function normalizeUrl(raw: string): string | null {
  let next = raw.trim()
  if (!next) return null
  if (!/^https?:\/\//i.test(next) && !/^file:\/\//i.test(next) && !next.startsWith('about:')) {
    next = `https://${next}`
  }
  return next
}

export function BrowserPanel({
  open,
  navigateUrl = null,
  navigateKey = 0
}: BrowserPanelProps): React.JSX.Element | null {
  const [url, setUrl] = useState('https://example.com')
  const [title, setTitle] = useState('Browser')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const webviewRef = useRef<AfkWebview | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [guestSrc, setGuestSrc] = useState('https://example.com')
  const lastNavKey = useRef(0)

  const syncNavState = useCallback((): void => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    } catch {
      /* guest not ready */
    }
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open || !navigateUrl || !navigateKey) return
    if (navigateKey === lastNavKey.current) return
    lastNavKey.current = navigateKey
    const next = normalizeUrl(navigateUrl)
    if (!next) return
    setUrl(next)
    setError(null)
    setGuestSrc(next)
    const t = setTimeout(() => {
      try {
        webviewRef.current?.loadURL(next)
      } catch {
        /* remount via guestSrc covers cold start */
      }
    }, 120)
    return () => clearTimeout(t)
  }, [open, navigateUrl, navigateKey])

  useEffect(() => {
    if (!open) return
    const wv = webviewRef.current
    if (!wv) return

    const onStart = (): void => {
      setLoading(true)
      setError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      syncNavState()
    }
    const onNavigate = (e: Event): void => {
      const url = (e as Event & { url?: string }).url
      if (url) setUrl(url)
      syncNavState()
    }
    const onTitle = (e: Event): void => {
      const t = (e as Event & { title?: string }).title
      if (t) setTitle(t)
    }
    const onFail = (e: Event): void => {
      const detail = e as Event & {
        errorDescription?: string
        errorCode?: number
        validatedURL?: string
      }
      setLoading(false)
      setError(
        detail.errorDescription ||
          (detail.errorCode != null ? `Error ${detail.errorCode}` : 'Load failed')
      )
      syncNavState()
    }

    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-fail-load', onFail)

    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [open, guestSrc, syncNavState])

  const navigate = useCallback((raw: string): void => {
    const next = normalizeUrl(raw)
    if (!next) return
    setUrl(next)
    setError(null)
    setGuestSrc(next)
    const wv = webviewRef.current
    if (wv) {
      try {
        wv.loadURL(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    navigate(url)
  }

  const back = (): void => {
    const wv = webviewRef.current
    if (wv?.canGoBack()) wv.goBack()
  }

  const forward = (): void => {
    const wv = webviewRef.current
    if (wv?.canGoForward()) wv.goForward()
  }

  const reload = (): void => {
    webviewRef.current?.reload()
  }

  const toggleDevTools = (): void => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      if (wv.isDevToolsOpened()) {
        wv.closeDevTools()
        setDevtoolsOpen(false)
      } else {
        wv.openDevTools()
        setDevtoolsOpen(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!open) return null

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-ink-900">
      <form
        onSubmit={onSubmit}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-ink-line bg-ink-950 px-2"
      >
        <button
          type="button"
          title="Back"
          disabled={!canBack}
          onClick={back}
          className="rounded px-1.5 font-mono text-xs text-ink-mute hover:text-ink-bright disabled:opacity-30"
        >
          ←
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!canForward}
          onClick={forward}
          className="rounded px-1.5 font-mono text-xs text-ink-mute hover:text-ink-bright disabled:opacity-30"
        >
          →
        </button>
        <button
          type="button"
          title="Reload"
          onClick={reload}
          className="rounded px-1.5 font-mono text-xs text-ink-mute hover:text-ink-bright"
        >
          ↻
        </button>
        <input
          ref={inputRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 rounded border border-ink-line bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-bright outline-none focus:border-signal"
          placeholder="https://…"
          spellCheck={false}
          title={title}
        />
        {loading && (
          <span className="shrink-0 font-mono text-[9px] text-ink-mute" aria-hidden>
            …
          </span>
        )}
        <button
          type="submit"
          className="rounded border border-ink-line px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:border-signal hover:text-signal"
        >
          Go
        </button>
        <button
          type="button"
          title="Guest DevTools"
          onClick={toggleDevTools}
          className={
            'rounded border px-2 py-0.5 font-mono text-[10px] ' +
            (devtoolsOpen
              ? 'border-signal/50 text-signal'
              : 'border-ink-line text-ink-soft hover:border-signal hover:text-signal')
          }
        >
          DevTools
        </button>
      </form>
      {error && (
        <div className="shrink-0 border-b border-ink-line bg-rose-500/10 px-3 py-1 font-mono text-[10px] text-rose-300">
          {error}
        </div>
      )}
      {/* Electron custom element */}
      <webview
        key={guestSrc}
        ref={(el) => {
          webviewRef.current = el as AfkWebview | null
        }}
        src={guestSrc}
        allowpopups={true}
        webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        style={{ display: 'flex' }}
      />
    </div>
  )
}
