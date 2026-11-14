// Desktop shell: sessions sidebar, conversation with collapsed tool calls,
// a prompt box with folder / mode / model / context controls, a session rail (Changes · Todos · Context) and panes
// (Terminal · Changes · Browser). The agent itself runs in the main process (src/main/core/coreHost.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownBody } from '../components/MarkdownBody'
import logo from '../assets/app-icon-64.png'
import { TerminalPanel } from '../components/TerminalPanel'
import { BrowserPanel } from '../components/BrowserPanel'
import { applyDocumentTheme, migrateUiTheme, type UiTheme } from '../../../shared/theme'
import {
  MODES, applyEvent, blocksFromMessages, relTime, uid, type Block, type CoreEvent, type CoreStatus, type FileChange,
  type PermissionDecision, type PermissionMode, type SessionView,
} from './model'

type ViewMode = 'normal' | 'thinking' | 'verbose'
type Pane = 'terminal' | 'changes' | 'browser' | null
interface SessionMeta { id: string; title: string; updated: string; cwd: string }

const core = () => window.api.core
const LS_FOLDER = 'afk.code.folder'
const LS_RECENT = 'afk.code.recent'
const LS_VIEW = 'afk.code.view'

function readLS<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d }
}
function writeLS(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export default function CodeApp(): React.JSX.Element {
  const [status, setStatus] = useState<CoreStatus>({ state: 'idle', profile: 'q38', vision: false, imagegen: false })
  const [folder, setFolder] = useState<string | null>(() => readLS<string | null>(LS_FOLDER, null))
  const [recent, setRecent] = useState<string[]>(() => readLS<string[]>(LS_RECENT, []))
  const [list, setList] = useState<SessionMeta[]>([])
  const [sessions, setSessions] = useState<Record<string, SessionView>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>(() => readLS<ViewMode>(LS_VIEW, 'normal'))
  const [pane, setPane] = useState<Pane>(null)
  const [rail, setRail] = useState(true)
  const [uiTheme, setUiTheme] = useState<UiTheme>('classic')
  const [error, setError] = useState<string | null>(null)
  const [draftMode, setDraftMode] = useState<PermissionMode>('default') // mode picked before a session exists
  const [closeAsk, setCloseAsk] = useState<{ label?: string } | null>(null)
  const [unloading, setUnloading] = useState(false)
  const active = activeId ? sessions[activeId] : null

  // AFKLLM black (black + logo turquoise) is the shell's own palette, on top of the app theme setting
  useEffect(() => {
    document.documentElement.setAttribute('data-shell', 'afk-black')
    return () => document.documentElement.removeAttribute('data-shell')
  }, [])

  // theme from app settings (terminal pane colors etc.)
  useEffect(() => {
    void window.api.settings.get().then((s) => { const t = migrateUiTheme(s.uiTheme); setUiTheme(t); applyDocumentTheme(t) })
    return window.api.settings.onChanged((s) => { const t = migrateUiTheme(s.uiTheme); setUiTheme(t); applyDocumentTheme(t) })
  }, [])

  // X / Alt+F4 / tray "quit": the main process asks us first. With a model loaded, ask the user to unload it.
  useEffect(() => window.api.app.onCloseAttempt(async () => {
    const m = await core().modelLoaded()
    if (m.loaded && m.ours) setCloseAsk({ label: m.label })
    else void window.api.app.quit()
  }), [])

  // core events
  useEffect(() => {
    void core().status().then(setStatus)
    void core().ensure().then(setStatus).catch((e: Error) => setError(e.message))
    return core().onEvent((raw) => {
      const ev = raw as CoreEvent
      if (ev.kind === 'status') return setStatus(ev.status)
      setSessions((all) => {
        const id = ev.kind === 'activity' ? ev.sessionId : ev.sessionId
        if (!id || !all[id]) return all
        const s = all[id]
        if (ev.kind === 'agent') return { ...all, [id]: applyEvent(s, ev.event) }
        if (ev.kind === 'run_state') return { ...all, [id]: { ...s, running: ev.running, runStart: ev.running ? Date.now() : s.runStart, activity: ev.running ? s.activity : '' } }
        if (ev.kind === 'permission') {
          return { ...all, [id]: { ...s, blocks: [...s.blocks, { kind: 'permission', id: uid('p'), requestId: ev.requestId, request: ev.request }] } }
        }
        if (ev.kind === 'activity') {
          const ticking = /·\s*(step \d+\/\d+|\d+s)$/.test(ev.message)
          const blocks = [...s.blocks]
          const i = blocks.findLastIndex((b) => b.kind === 'tool' && !b.outcome)
          if (i >= 0 && !ticking) {
            const b = blocks[i] as Extract<Block, { kind: 'tool' }>
            blocks[i] = { ...b, log: [...b.log, ev.message] }
          }
          return { ...all, [id]: { ...s, blocks, activity: ev.message } }
        }
        return all
      })
    })
  }, [])

  // AFK_PROJECT (env) opens a folder on first start, e.g. `set AFK_PROJECT=D:\proj && npm run dev`
  // a folder remembered from the last start is re-checked once (a dangerous one needs a fresh yes)
  const checked = useRef(false)
  useEffect(() => {
    if (checked.current) return
    checked.current = true // only the folder present at start; later picks are checked when chosen
    if (!folder) return
    void core().checkFolder(folder).then((ok: boolean) => { if (!ok) { setFolder(null); writeLS(LS_FOLDER, null) } })
  }, [folder])
  useEffect(() => {
    if (folder) return
    void core().defaultFolder().then((f: string | null) => { if (f) { setFolder(f); writeLS(LS_FOLDER, f) } })
  }, [folder])

  const refreshList = useCallback(async (cwd: string | null) => {
    if (!cwd) return setList([])
    try { setList(await core().sessions(cwd)) } catch { setList([]) }
  }, [])
  useEffect(() => { void refreshList(folder) }, [folder, refreshList])

  const openSession = useCallback(async (cwd: string, id?: string) => {
    setError(null)
    try {
      const r = await core().open(cwd, id)
      const { blocks } = blocksFromMessages(r.state.messages)
      setSessions((all) => ({
        ...all,
        [r.id]: all[r.id] ?? {
          id: r.id, cwd: r.cwd, title: (list.find((x) => x.id === r.id)?.title) || 'New session', blocks,
          todos: r.state.todos ?? [], usage: null, mode: r.mode, running: false, runStart: 0, activity: '', changes: {},
        },
      }))
      setActiveId(r.id)
    } catch (e) { setError((e as Error).message) }
  }, [list])

  const chooseFolder = useCallback(async () => {
    const f = await core().pickFolder()
    if (!f) return
    setFolder(f); writeLS(LS_FOLDER, f)
    const r = [f, ...recent.filter((x) => x !== f)].slice(0, 8)
    setRecent(r); writeLS(LS_RECENT, r)
    setActiveId(null)
  }, [recent])

  const newSession = useCallback(async () => {
    if (!folder) return chooseFolder()
    await openSession(folder)
  }, [folder, chooseFolder, openSession])

  const send = useCallback(async (text: string) => {
    if (!folder) return chooseFolder()
    let id: string = activeId ?? ''
    if (!id) {
      const r = await core().open(folder)
      id = r.id as string
      if (draftMode !== 'default') await core().mode(r.id, draftMode)
      setSessions((all) => ({ ...all, [r.id]: { id: r.id, cwd: r.cwd, title: text.slice(0, 60), blocks: [], todos: [], usage: null, mode: draftMode, running: false, runStart: 0, activity: '', changes: {} } }))
      setActiveId(r.id)
    }
    const sid = id
    setSessions((all) => {
      const s = all[sid]
      if (!s) return all
      const title = s.blocks.length ? s.title : text.slice(0, 60)
      return { ...all, [sid]: { ...s, title, blocks: [...s.blocks, { kind: 'user', id: uid('u'), text, images: (text.match(/@\S+\.(png|jpe?g|webp|gif|bmp)/gi) ?? []).length }] } }
    })
    try { await core().run(sid, text) } catch (e) { setError((e as Error).message) }
    void refreshList(folder)
  }, [folder, activeId, chooseFolder, refreshList, draftMode])

  // Ctrl+O cycles view modes, Ctrl+N new session, Esc stops, Ctrl+` terminal, Ctrl+Shift+D changes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setView((v) => { const n: ViewMode = v === 'normal' ? 'thinking' : v === 'thinking' ? 'verbose' : 'normal'; writeLS(LS_VIEW, n); return n })
      } else if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void newSession() }
      else if (e.key === 'Escape' && active?.running) { void core().abort(active.id) }
      else if (e.ctrlKey && e.key === '`') { e.preventDefault(); setPane((p) => (p === 'terminal' ? null : 'terminal')) }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setPane((p) => (p === 'changes' ? null : 'changes')) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, newSession])

  const decide = useCallback((requestId: number, d: PermissionDecision) => {
    void core().permission(requestId, d)
    if (!activeId) return
    setSessions((all) => {
      const s = all[activeId]
      return { ...all, [activeId]: { ...s, blocks: s.blocks.map((b) => (b.kind === 'permission' && b.requestId === requestId ? { ...b, decided: d.allow ? 'allowed' : 'denied' } : b)) } }
    })
  }, [activeId])

  const setMode = (m: PermissionMode) => { if (active) void core().mode(active.id, m); else setDraftMode(m) }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-ink-950 font-sans text-ink-bright">
      <TitleRow
        title={active?.title ?? (folder ? baseName(folder) : 'AFKLLM')}
        pane={pane} setPane={setPane} rail={rail} setRail={setRail} view={view}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          folder={folder} recent={recent} list={list} activeId={activeId} sessions={sessions}
          onNew={newSession} onPickFolder={chooseFolder}
          onFolder={(f) => { void core().checkFolder(f).then((ok: boolean) => { if (ok) { setFolder(f); writeLS(LS_FOLDER, f); setActiveId(null) } }) }}
          onOpen={(id) => folder && openSession(folder, id)}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col">
              <Transcript session={active} view={view} onDecide={decide} status={status} folder={folder} onPickFolder={chooseFolder} />
              {error && <div className="mx-auto mb-2 w-full max-w-3xl rounded-md border border-danger/40 bg-danger-muted px-3 py-2 text-[12px] text-danger">{error}</div>}
              <Composer
                session={active} status={status} folder={folder} onSend={send} draftMode={draftMode}
                onStop={() => active && core().abort(active.id)} onMode={setMode} onPickFolder={chooseFolder}
                onCommand={(cmd, arg) => {
                  if (!active) return
                  if (cmd === 'compact') void core().compact(active.id, arg)
                  if (cmd === 'clear') { void core().clear(active.id); setSessions((all) => ({ ...all, [active.id]: { ...all[active.id], blocks: [], todos: [], changes: {} } })) }
                }}
              />
            </section>
            {pane && (
              <aside className="flex w-[46%] min-w-[360px] flex-col border-l border-ink-line bg-ink-900">
                <div className="flex h-9 items-center justify-between border-b border-ink-line px-3 text-[12px] text-ink-soft">
                  <span className="font-medium capitalize text-ink-bright">{pane}</span>
                  <button className="rounded px-1.5 hover:bg-ink-800" onClick={() => setPane(null)}>✕</button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {pane === 'terminal' && <TerminalPanel open cwd={active?.cwd ?? folder} uiTheme={uiTheme} onClose={() => setPane(null)} fill />}
                  {pane === 'browser' && <BrowserPanel open />}
                  {pane === 'changes' && <ChangesPane changes={active?.changes ?? {}} />}
                </div>
              </aside>
            )}
          </div>
        </main>
        {rail && <SessionRail session={active} status={status} onOpenChanges={() => setPane('changes')} />}
      </div>
      {closeAsk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[440px] rounded-xl border border-ink-line bg-ink-900 p-5 text-[13px]">
            <div className="mb-2 text-[15px] font-medium">Модель загружена</div>
            <div className="mb-4 text-ink-soft">
              {closeAsk.label ?? 'Модель'} занимает видеопамять. Выгрузить модель и закрыть AFKLLM?
              {Object.values(sessions).some((s) => s.running) && <div className="mt-2 text-warn">Агент сейчас работает — его работа будет остановлена.</div>}
            </div>
            <div className="flex justify-end gap-2">
              <button className="rounded-md border border-ink-line px-3 py-1.5 hover:bg-ink-800" disabled={unloading} onClick={() => setCloseAsk(null)}>Отмена</button>
              <button className="rounded-md bg-signal px-3 py-1.5 font-medium text-signal-on disabled:opacity-60" disabled={unloading}
                onClick={async () => { setUnloading(true); try { await core().unload() } finally { void window.api.app.quit() } }}>
                {unloading ? 'Выгружаю…' : 'Выгрузить и закрыть'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- title row

function TitleRow(p: { title: string; pane: Pane; setPane: (p: Pane) => void; rail: boolean; setRail: (b: boolean) => void; view: ViewMode }) {
  const btn = (id: Exclude<Pane, null>, label: string) => (
    <button
      className={`titlebar-no-drag rounded px-2 py-0.5 text-[12px] ${p.pane === id ? 'bg-ink-800 text-ink-bright' : 'text-ink-soft hover:bg-ink-800'}`}
      onClick={() => p.setPane(p.pane === id ? null : id)}
    >{label}</button>
  )
  return (
    <header className="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-ink-line bg-ink-900 pl-3 text-[13px]">
      <img src={logo} alt="" className="h-4 w-4" />
      <span className="truncate font-medium">{p.title}</span>
      <span className="text-[11px] text-ink-mute">· view: {p.view} (Ctrl+O)</span>
      <div className="flex-1" />
      {btn('terminal', 'Terminal')}
      {btn('changes', 'Changes')}
      {btn('browser', 'Browser')}
      <button className={`titlebar-no-drag rounded px-2 py-0.5 text-[12px] ${p.rail ? 'text-ink-bright' : 'text-ink-soft'} hover:bg-ink-800`} onClick={() => p.setRail(!p.rail)}>Rail</button>
      <button
        className="titlebar-no-drag rounded px-2 py-0.5 text-[12px] text-ink-mute hover:bg-ink-800"
        title="Switch to the classic interface (Ctrl+Shift+U switches back)"
        onClick={() => { try { localStorage.setItem('afk.ui', 'legacy') } catch { /* ignore */ } location.reload() }}
      >Classic UI</button>
      <div className="titlebar-no-drag flex">
        <button className="h-10 w-11 hover:bg-ink-800" onClick={() => window.api.window.minimize()}>–</button>
        <button className="h-10 w-11 hover:bg-ink-800" onClick={() => window.api.window.maximize()}>□</button>
        <button className="h-10 w-11 hover:bg-danger hover:text-white" onClick={() => window.api.window.close()}>✕</button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------- sidebar

function Sidebar(p: {
  folder: string | null; recent: string[]; list: SessionMeta[]; activeId: string | null; sessions: Record<string, SessionView>
  onNew: () => void; onPickFolder: () => void; onFolder: (f: string) => void; onOpen: (id: string) => void
}) {
  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-ink-line bg-ink-900">
      <div className="p-2">
        <button className="w-full rounded-md bg-signal px-3 py-1.5 text-left text-[13px] font-medium text-signal-on hover:opacity-90" onClick={p.onNew}>
          + New session <span className="float-right text-[11px] opacity-70">Ctrl+N</span>
        </button>
      </div>
      <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-ink-mute">Project</div>
      <button className="mx-2 truncate rounded-md px-2 py-1 text-left text-[13px] hover:bg-ink-800" title={p.folder ?? ''} onClick={p.onPickFolder}>
        📁 {p.folder ? baseName(p.folder) : 'Choose a folder…'}
      </button>
      {p.recent.filter((f) => f !== p.folder).slice(0, 4).map((f) => (
        <button key={f} className="mx-2 truncate rounded-md px-2 py-0.5 text-left text-[12px] text-ink-mute hover:bg-ink-800" title={f} onClick={() => p.onFolder(f)}>
          {baseName(f)}
        </button>
      ))}
      <div className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-ink-mute">Sessions</div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {Object.values(p.sessions).filter((s) => !p.list.some((x) => x.id === s.id) && s.cwd === p.folder).map((s) => (
          <SessionItem key={s.id} title={s.title} sub="new" active={s.id === p.activeId} running={s.running} onClick={() => p.onOpen(s.id)} />
        ))}
        {p.list.map((s) => (
          <SessionItem key={s.id} title={s.title || 'Untitled'} sub={relTime(s.updated)} active={s.id === p.activeId} running={!!p.sessions[s.id]?.running} onClick={() => p.onOpen(s.id)} />
        ))}
        {!p.list.length && !Object.keys(p.sessions).length && <div className="px-2 py-2 text-[12px] text-ink-mute">No sessions yet</div>}
      </div>
    </nav>
  )
}

function SessionItem(p: { title: string; sub: string; active: boolean; running: boolean; onClick: () => void }) {
  return (
    <button className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${p.active ? 'bg-ink-800' : 'hover:bg-ink-800/60'}`} onClick={p.onClick}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.running ? 'animate-pulse bg-signal' : 'bg-transparent'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{p.title}</span>
        <span className="block text-[11px] text-ink-mute">{p.sub}</span>
      </span>
    </button>
  )
}

// ---------------------------------------------------------------- transcript

function Transcript(p: { session: SessionView | null; view: ViewMode; onDecide: (id: number, d: PermissionDecision) => void; status: CoreStatus; folder: string | null; onPickFolder: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const blocks = p.session?.blocks ?? []
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [blocks])
  if (!p.session) return <Welcome status={p.status} folder={p.folder} onPickFolder={p.onPickFolder} />
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-auto"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        {blocks.map((b) => <BlockView key={b.id} b={b} view={p.view} onDecide={p.onDecide} />)}
        {p.session.running && <Working session={p.session} />}
      </div>
    </div>
  )
}

function Welcome(p: { status: CoreStatus; folder: string | null; onPickFolder: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="w-[520px] rounded-xl border border-ink-line bg-ink-900 p-6">
        <div className="mb-1 flex items-center gap-2 text-[18px] font-medium"><img src={logo} alt="" className="h-6 w-6" /> Welcome to AFKLLM</div>
        <div className="mb-4 text-[13px] text-ink-soft">A local coding agent that can work on its own for hours. Everything runs on this PC.</div>
        <div className="space-y-1 text-[12px] text-ink-mute">
          <div>model: <span className="text-ink-soft">{p.status.model ?? p.status.profile}</span>{p.status.ctx ? ` · ${Math.round(p.status.ctx / 1024)}K context` : ''} · {p.status.state === 'ready' ? <span className="text-green-400">ready</span> : p.status.message ?? p.status.state}</div>
          <div>vision: {p.status.vision ? 'screenshots & photos (@file or attach)' : 'off'} · images: {p.status.imagegen ? 'Qwen-Image 2.1' : 'not installed'}</div>
          <div>folder: {p.folder ?? <button className="text-signal hover:underline" onClick={p.onPickFolder}>choose a project folder</button>}</div>
        </div>
        <div className="mt-4 text-[12px] text-ink-mute">Type a task below. Shift+Tab / the mode menu switches Manual · Accept edits · Plan · Auto.</div>
      </div>
    </div>
  )
}

function Working({ session }: { session: SessionView }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t) }, [])
  const secs = Math.round((Date.now() - session.runStart) / 1000)
  const step = /step (\d+)\/(\d+)/.exec(session.activity)
  return (
    <div className="mt-2 flex items-center gap-2 text-[13px] text-signal">
      <span className="animate-pulse">●</span>
      <span className="truncate">{session.activity || 'Working…'}</span>
      {step && (
        <span className="h-1.5 w-28 overflow-hidden rounded bg-ink-800">
          <span className="block h-full bg-signal" style={{ width: `${(Number(step[1]) / Number(step[2])) * 100}%` }} />
        </span>
      )}
      <span className="text-[12px] text-ink-mute">({secs}s · Esc to interrupt)</span>
    </div>
  )
}

function BlockView({ b, view, onDecide }: { b: Block; view: ViewMode; onDecide: (id: number, d: PermissionDecision) => void }) {
  switch (b.kind) {
    case 'user':
      return (
        <div className="mb-4 mt-2 flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-ink-800 px-4 py-2 text-[13px] text-ink-bright">
            {b.text}{b.images ? <span className="ml-2 text-[11px] text-ink-mute">🖼 {b.images}</span> : null}
          </div>
        </div>
      )
    case 'thinking': {
      const secs = b.end && b.start ? Math.max(1, Math.round((b.end - b.start) / 1000)) : null
      if (view === 'normal') {
        return <div className="mb-1 text-[12px] italic text-ink-mute">∴ {b.end === undefined ? 'Thinking…' : `Thought${secs ? ` for ${secs}s` : ''}`}</div>
      }
      return (
        <details className="mb-2" open={b.end === undefined}>
          <summary className="cursor-pointer text-[12px] italic text-ink-mute">∴ {b.end === undefined ? 'Thinking…' : `Thought${secs ? ` for ${secs}s` : ''}`}</summary>
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-ink-line pl-3 text-[12px] italic text-ink-mute">{b.text}</div>
        </details>
      )
    }
    case 'text':
      return <div className="mb-3"><MarkdownBody content={b.text} streaming={b.open} /></div>
    case 'tool':
      return <ToolRow b={b} view={view} />
    case 'todos':
      return (
        <div className="mb-2 text-[13px]">
          <div className="text-ink-soft"><span className="text-green-400">●</span> Update Todos</div>
          <div className="ml-4 mt-0.5 space-y-0.5">
            {b.todos.map((t, i) => (
              <div key={i} className={t.status === 'completed' ? 'text-ink-mute line-through' : t.status === 'in_progress' ? 'font-medium text-ink-bright' : 'text-ink-soft'}>
                {t.status === 'completed' ? '☒' : '☐'} {t.content}
              </div>
            ))}
          </div>
        </div>
      )
    case 'notice':
      return <div className={`mb-2 text-[12px] ${b.tone === 'error' ? 'text-danger' : b.tone === 'warn' ? 'text-warn' : 'text-ink-mute'}`}>⎿ {b.text}</div>
    case 'compact':
      return <div className="my-3 text-center text-[12px] text-ink-mute">● Conversation compacted ({fmtTok(b.before)} → {fmtTok(b.after)} tokens)</div>
    case 'permission':
      return <PermissionCard b={b} onDecide={onDecide} />
  }
}

function ToolRow({ b, view }: { b: Extract<Block, { kind: 'tool' }>; view: ViewMode }) {
  const [open, setOpen] = useState(view === 'verbose')
  useEffect(() => { if (view === 'verbose') setOpen(true) }, [view])
  const o = b.outcome
  const dot = !o ? 'text-signal animate-pulse' : o.ok ? 'text-green-400' : 'text-danger'
  const [tool, ...rest] = b.label.split('(')
  const img = o?.images?.[0]
  return (
    <div className="mb-1.5 text-[13px]">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className={dot}>●</span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-ink-bright">{tool}</span>
          {rest.length ? <span className="text-ink-soft">({rest.join('(')}</span> : null}
          {o?.diff && <span className="ml-2 text-[11px]"><span className="text-green-400">+{o.diff.added}</span> <span className="text-danger">−{o.diff.removed}</span></span>}
        </span>
      </button>
      <div className="ml-5 text-[12px] text-ink-mute">
        ⎿ {o ? o.summary : b.log.length ? b.log[b.log.length - 1] : 'running…'}{b.ms && b.ms > 1500 ? ` · ${(b.ms / 1000).toFixed(1)}s` : ''}
      </div>
      {img && <img className="ml-5 mt-1 max-h-72 rounded-md border border-ink-line" src={`data:${img.mime};base64,${img.data}`} alt={img.path} />}
      {open && (
        <div className="ml-5 mt-1">
          {b.log.length > 0 && <div className="mb-1 whitespace-pre-wrap text-[11px] text-ink-mute">{b.log.join('\n')}</div>}
          {o?.diff ? <DiffBlock lines={o.diff.lines} /> : o?.output ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-ink-900 p-2 font-mono text-[11px] text-ink-soft">{o.output.slice(0, 20000)}</pre>
          ) : null}
        </div>
      )}
    </div>
  )
}

function DiffBlock({ lines }: { lines: FileChange['lines'] }) {
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-ink-line font-mono text-[11px]">
      {lines.slice(0, 400).map((l, i) => (
        <div key={i} className={l.kind === '+' ? 'bg-green-500/10 text-green-300' : l.kind === '-' ? 'bg-red-500/10 text-red-300' : 'text-ink-mute'}>
          <span className="inline-block w-10 select-none pr-2 text-right opacity-60">{l.line}</span>
          <span className="select-none pr-1">{l.kind === ' ' ? ' ' : l.kind}</span>{l.text}
        </div>
      ))}
    </div>
  )
}

function PermissionCard({ b, onDecide }: { b: Extract<Block, { kind: 'permission' }>; onDecide: (id: number, d: PermissionDecision) => void }) {
  const [fb, setFb] = useState('')
  const r = b.request
  const exec = r.kind === 'exec'
  if (b.decided) return <div className="mb-2 ml-5 text-[12px] text-ink-mute">⎿ {b.decided === 'allowed' ? 'Allowed' : 'Denied'}: {r.title}</div>
  return (
    <div className={`my-2 rounded-lg border ${exec ? 'border-orange-400/50' : 'border-purple-400/50'} bg-ink-900 p-3 text-[13px]`}>
      <div className="mb-1 font-medium">{exec ? 'Run command?' : r.title}</div>
      {exec && <pre className="mb-2 overflow-auto rounded bg-ink-950 p-2 font-mono text-[12px]">{r.detail}</pre>}
      {r.diff && <div className="mb-2"><DiffBlock lines={r.diff.lines} /></div>}
      {r.reason && <div className="mb-2 text-[12px] text-warn">⚠ {r.reason}</div>}
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-signal px-3 py-1 text-signal-on" onClick={() => onDecide(b.requestId, { allow: true })}>Allow once</button>
        {!r.reason && <button className="rounded-md border border-ink-line px-3 py-1 hover:bg-ink-800" onClick={() => onDecide(b.requestId, { allow: true, remember: true })}>Allow for this session</button>}
        <input className="min-w-[180px] flex-1 rounded-md border border-ink-line bg-ink-950 px-2 py-1 text-[12px]" placeholder="…or tell the agent what to do instead" value={fb} onChange={(e) => setFb(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onDecide(b.requestId, { allow: false, feedback: fb || undefined }) }} />
        <button className="rounded-md border border-ink-line px-3 py-1 hover:bg-ink-800" onClick={() => onDecide(b.requestId, { allow: false, feedback: fb || undefined })}>Deny</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- composer

function Composer(p: {
  session: SessionView | null; status: CoreStatus; folder: string | null; onSend: (t: string) => void; onStop: () => void; draftMode: PermissionMode
  onMode: (m: PermissionMode) => void; onPickFolder: () => void; onCommand: (cmd: string, arg?: string) => void
}) {
  const [text, setText] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const running = !!p.session?.running
  const mode = p.session?.mode ?? p.draftMode
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? mode
  const u = p.session?.usage
  const pct = u && p.status.ctx ? Math.min(100, Math.round(((u.promptTokens + u.completionTokens) / p.status.ctx) * 100)) : 0

  useEffect(() => {
    const el = ta.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(240, el.scrollHeight)}px` }
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || running) return
    if (t === '/clear') { p.onCommand('clear'); setText(''); return }
    if (t.startsWith('/compact')) { p.onCommand('compact', t.slice(8).trim()); setText(''); return }
    p.onSend(t)
    setText('')
  }
  const attach = async () => {
    const files = await window.api.chatImages.pick()
    if (files?.length) setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${files.map((f) => (/\s/.test(f) ? `@"${f}"` : `@${f}`)).join(' ')} `)
  }
  const cycleMode = () => {
    const i = MODES.findIndex((m) => m.id === mode)
    p.onMode(MODES[(i + 1) % MODES.length].id)
  }

  return (
    <div className="shrink-0 px-4 pb-3">
      <div
        className="mx-auto w-full max-w-3xl rounded-xl border border-ink-line bg-ink-900 focus-within:border-signal/60"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const paths = [...e.dataTransfer.files].map((f) => window.api.getPathForFile(f)).filter(Boolean)
          if (paths.length) setText((t) => `${t} ${paths.map((f) => (/\s/.test(f) ? `@"${f}"` : `@${f}`)).join(' ')} `)
        }}
      >
        <textarea
          ref={ta}
          autoFocus
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[13px] text-ink-bright outline-none placeholder:text-ink-mute"
          rows={1}
          placeholder={running ? 'The agent is working — Esc to interrupt' : p.folder ? 'Describe a task… (@file.png attaches an image, /compact, /clear)' : 'Choose a project folder first'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode() }
          }}
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 text-[12px]">
          <IconBtn title="Attach image" onClick={attach}>+</IconBtn>
          <Chip title={p.folder ?? ''} onClick={p.onPickFolder}>📁 {p.folder ? baseName(p.folder) : 'folder'}</Chip>
          <div className="relative">
            <Chip onClick={() => setModeOpen(!modeOpen)} accent={mode === 'auto' ? 'text-warn' : mode === 'plan' ? 'text-teal-400' : mode === 'acceptEdits' ? 'text-purple-300' : undefined}>
              {mode === 'auto' ? '⏵⏵ ' : mode === 'plan' ? '⏸ ' : ''}{modeLabel} ▾
            </Chip>
            {modeOpen && (
              <div className="absolute bottom-8 left-0 z-20 w-72 rounded-lg border border-ink-line bg-ink-900 p-1 shadow-xl">
                {MODES.map((m) => (
                  <button key={m.id} className={`block w-full rounded-md px-2 py-1.5 text-left hover:bg-ink-800 ${m.id === mode ? 'bg-ink-800' : ''}`} onClick={() => { p.onMode(m.id); setModeOpen(false) }}>
                    <div className="text-[13px]">{m.label}</div>
                    <div className="text-[11px] text-ink-mute">{m.hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Chip title={p.status.message ?? ''}>
            <span className={p.status.state === 'ready' ? 'text-green-400' : p.status.state === 'error' ? 'text-danger' : 'text-warn'}>●</span> {p.status.model ?? p.status.profile}
          </Chip>
          <div className="flex-1" />
          {u?.genPerSecond ? <span className="text-[11px] text-ink-mute">{u.genPerSecond.toFixed(0)} t/s</span> : null}
          <Ring pct={pct} />
          {running ? (
            <button className="rounded-md bg-danger/80 px-3 py-1 text-white hover:bg-danger" onClick={p.onStop}>■ Stop</button>
          ) : (
            <button className="rounded-md bg-signal px-3 py-1 text-signal-on disabled:opacity-40" disabled={!text.trim()} onClick={submit}>Send ↵</button>
          )}
        </div>
      </div>
    </div>
  )
}

function Chip(p: { children: React.ReactNode; onClick?: () => void; title?: string; accent?: string }) {
  return (
    <button title={p.title} onClick={p.onClick} className={`max-w-[220px] truncate rounded-md px-2 py-0.5 text-ink-soft hover:bg-ink-800 ${p.accent ?? ''}`}>
      {p.children}
    </button>
  )
}
function IconBtn(p: { children: React.ReactNode; onClick: () => void; title: string }) {
  return <button title={p.title} onClick={p.onClick} className="h-6 w-6 rounded-md text-[15px] leading-none text-ink-soft hover:bg-ink-800">{p.children}</button>
}
function Ring({ pct }: { pct: number }) {
  const r = 7, c = 2 * Math.PI * r
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="mx-1" aria-label={`context ${pct}%`}>
      <title>{`Context used: ${pct}% (auto-compact at 80%)`}</title>
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" className="text-ink-line" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" className={pct >= 70 ? 'text-warn' : 'text-signal'} strokeWidth="2.5"
        strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 10 10)" />
    </svg>
  )
}

// ---------------------------------------------------------------- rail and panes

function SessionRail(p: { session: SessionView | null; status: CoreStatus; onOpenChanges: () => void }) {
  const changes = useMemo(() => Object.values(p.session?.changes ?? {}), [p.session?.changes])
  const u = p.session?.usage
  const used = u ? u.promptTokens + u.completionTokens : 0
  const pct = p.status.ctx ? Math.round((used / p.status.ctx) * 100) : 0
  return (
    <aside className="w-72 shrink-0 overflow-auto border-l border-ink-line bg-ink-900 p-3 text-[12px]">
      <Card title="Changes" right={changes.length ? <button className="text-signal hover:underline" onClick={p.onOpenChanges}>
        <span className="text-green-400">+{changes.reduce((a, c) => a + c.added, 0)}</span> <span className="text-danger">−{changes.reduce((a, c) => a + c.removed, 0)}</span></button> : null}>
        {changes.length ? changes.map((c) => (
          <div key={c.path} className="flex justify-between gap-2 py-0.5"><span className="truncate text-ink-soft" title={c.path}>{c.path}</span>
            <span className="shrink-0"><span className="text-green-400">+{c.added}</span> <span className="text-danger">−{c.removed}</span></span></div>
        )) : <div className="text-ink-mute">No changes yet</div>}
      </Card>
      <Card title="Todos" right={p.session?.todos.length ? <span className="text-ink-mute">{p.session.todos.filter((t) => t.status === 'completed').length}/{p.session.todos.length}</span> : null}>
        {p.session?.todos.length ? p.session.todos.map((t, i) => (
          <div key={i} className={`py-0.5 ${t.status === 'completed' ? 'text-ink-mute line-through' : t.status === 'in_progress' ? 'text-ink-bright' : 'text-ink-soft'}`}>
            {t.status === 'completed' ? '☒' : t.status === 'in_progress' ? '▸' : '☐'} {t.content}
          </div>
        )) : <div className="text-ink-mute">The agent keeps its plan here</div>}
      </Card>
      <Card title="Context" right={<span className={pct >= 70 ? 'text-warn' : 'text-ink-mute'}>{pct}%</span>}>
        <div className="mb-1 h-1.5 overflow-hidden rounded bg-ink-800"><div className={`h-full ${pct >= 70 ? 'bg-warn' : 'bg-signal'}`} style={{ width: `${pct}%` }} /></div>
        <div className="text-ink-mute">{fmtTok(used)} / {p.status.ctx ? fmtTok(p.status.ctx) : '—'} tokens · auto-compact at 80%</div>
        {u?.genPerSecond ? <div className="mt-1 text-ink-mute">{u.genPerSecond.toFixed(1)} t/s gen{u.promptPerSecond ? ` · ${u.promptPerSecond.toFixed(0)} t/s prefill` : ''}{u.draftAcceptRate ? ` · MTP ${Math.round(u.draftAcceptRate * 100)}%` : ''}</div> : null}
      </Card>
      <Card title="Environment">
        <div className="text-ink-soft">{p.status.model ?? p.status.profile}</div>
        <div className="text-ink-mute">{p.status.state === 'ready' ? 'ready' : p.status.message ?? p.status.state}</div>
        <div className="text-ink-mute">vision {p.status.vision ? 'on (CPU)' : 'off'} · images {p.status.imagegen ? 'Qwen-Image 2.1' : 'off'}</div>
        <div className="truncate text-ink-mute" title={p.session?.cwd}>{p.session?.cwd ?? ''}</div>
      </Card>
    </aside>
  )
}

function Card(p: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border border-ink-line bg-ink-950 p-2.5">
      <div className="mb-1.5 flex items-center justify-between"><span className="font-medium text-ink-bright">{p.title}</span>{p.right}</div>
      {p.children}
    </div>
  )
}

function ChangesPane({ changes }: { changes: Record<string, FileChange> }) {
  const files = Object.values(changes)
  if (!files.length) return <div className="p-4 text-[12px] text-ink-mute">No changes in this session yet.</div>
  return (
    <div className="space-y-4 p-3">
      {files.map((f) => (
        <div key={f.path}>
          <div className="mb-1 flex justify-between text-[12px]"><span className="font-medium text-ink-bright">{f.path}</span>
            <span><span className="text-green-400">+{f.added}</span> <span className="text-danger">−{f.removed}</span></span></div>
          <DiffBlock lines={f.lines} />
        </div>
      ))}
    </div>
  )
}

function fmtTok(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n) }
