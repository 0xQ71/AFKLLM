import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import {
  changeLetter,
  isStagedChange,
  isUnstagedChange,
  type GitCommitDetail,
  type GitCommitNode,
  type GitDiff,
  type GitFileChange,
  type GitStatus
} from '../../../shared/git'
import { languageIdFromPath } from '../editor/language'
import { AFK_SCROLLBAR } from '../editor/monacoSetup'

type Tab = 'changes' | 'graph'

interface GitSidebarProps {
  root: string | null
  /** External refresh tick (status bar / workspace) */
  refreshKey?: number
  focusCommit?: number
  editorTheme?: string
  onOpenFile: (relativePath: string) => void
  onStatus?: (status: GitStatus) => void
}

const emptyStatus: GitStatus = {
  available: false,
  branch: null,
  ahead: null,
  behind: null,
  files: [],
  stagedCount: 0,
  unstagedCount: 0
}

export function GitSidebar({
  root,
  refreshKey = 0,
  focusCommit = 0,
  editorTheme = 'afkllm-dark',
  onOpenFile,
  onStatus
}: GitSidebarProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<GitStatus>(emptyStatus)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(
    null
  )
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [commits, setCommits] = useState<GitCommitNode[]>([])
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const commitRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async () => {
    if (!root) {
      setStatus(emptyStatus)
      onStatus?.(emptyStatus)
      setCommits([])
      return
    }
    const st = await window.api.git.status()
    setStatus(st)
    onStatus?.(st)
    if (tab === 'graph' && st.available) {
      setCommits(await window.api.git.log(40))
    }
  }, [root, onStatus, tab])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  useEffect(() => {
    if (!focusCommit) return
    setTab('changes')
    setTimeout(() => commitRef.current?.focus(), 50)
  }, [focusCommit])

  useEffect(() => {
    if (tab !== 'graph' || !status.available) return
    void window.api.git.log(40).then(setCommits)
  }, [tab, status.available, refreshKey, root])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    void window.api.git.diff(selected.path, selected.staged).then((d) => {
      if (!cancelled) setDiff(d)
    })
    return () => {
      cancelled = true
    }
  }, [selected, refreshKey, status])

  const staged = useMemo(
    () => status.files.filter(isStagedChange),
    [status.files]
  )
  const unstaged = useMemo(
    () => status.files.filter(isUnstagedChange),
    [status.files]
  )

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      if (!res.ok) setError(res.error ?? 'Failed')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const selectFile = (path: string, stagedSel: boolean): void => {
    setSelected({ path, staged: stagedSel })
    if (!path.endsWith('/') && !path.includes('..')) {
      onOpenFile(path)
    }
  }

  const doCommit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.git.commit(message)
      if (!res.ok) setError(res.error ?? 'Commit failed')
      else setMessage('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const lang = selected ? languageIdFromPath(selected.path) : 'plaintext'

  return (
    <aside className="flex h-full min-w-0 flex-1 flex-col bg-ink-950">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-ink-line px-2">
        <span className="mr-auto truncate font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {status.available
            ? `${status.branch ?? 'git'}${
                status.ahead != null || status.behind != null
                  ? ` ↑${status.ahead ?? 0} ↓${status.behind ?? 0}`
                  : ''
              }`
            : root
              ? 'no git'
              : 'Source Control'}
        </span>
        <TabBtn active={tab === 'changes'} onClick={() => setTab('changes')}>
          Changes
        </TabBtn>
        <TabBtn active={tab === 'graph'} onClick={() => setTab('graph')}>
          Graph
        </TabBtn>
        {status.available && (
          <>
            <button
              type="button"
              title="Fetch"
              disabled={busy}
              onClick={() => void run(() => window.api.git.fetch())}
              className="px-1 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
            >
              Fetch
            </button>
            <button
              type="button"
              title="Pull (ff-only)"
              disabled={busy}
              onClick={() => void run(() => window.api.git.pull())}
              className="px-1 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
            >
              Pull
            </button>
            <button
              type="button"
              title="Push"
              disabled={busy}
              onClick={() => void run(() => window.api.git.push())}
              className="px-1 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
            >
              Push
            </button>
          </>
        )}
        <button
          type="button"
          title="Refresh"
          disabled={busy}
          onClick={() => void refresh()}
          className="px-1.5 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
        >
          ↻
        </button>
      </div>

      {!root && (
        <p className="m-3 font-mono text-xs text-ink-mute">Open a project folder</p>
      )}
      {root && !status.available && (
        <p className="m-3 font-mono text-xs text-ink-mute">Not a git repository</p>
      )}
      {error && <p className="px-3 py-1 font-mono text-[10px] text-rose-400">{error}</p>}

      {status.available && tab === 'changes' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 space-y-1 border-b border-ink-line px-2 py-2">
            <textarea
              ref={commitRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              rows={3}
              className="w-full resize-none rounded border border-ink-line bg-ink-900 px-2 py-1.5 font-mono text-xs text-ink-bright outline-none placeholder:text-ink-mute focus:border-signal"
            />
            <div className="flex flex-wrap gap-1">
              <ActionBtn
                disabled={busy || staged.length === 0 || !message.trim()}
                onClick={() => void doCommit()}
              >
                Commit
              </ActionBtn>
              <ActionBtn
                disabled={busy || unstaged.length === 0}
                onClick={() => void run(() => window.api.git.stageAll())}
              >
                Stage All
              </ActionBtn>
              <ActionBtn
                disabled={busy || staged.length === 0}
                onClick={() => void run(() => window.api.git.unstageAll())}
              >
                Unstage All
              </ActionBtn>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <Section title={`Staged (${staged.length})`}>
              {staged.map((f) => (
                <FileRow
                  key={`s:${f.path}`}
                  file={f}
                  letter={changeLetter(f, 'index')}
                  active={selected?.path === f.path && selected.staged}
                  onSelect={() => selectFile(f.path, true)}
                  actionLabel="−"
                  actionTitle="Unstage"
                  onAction={() => void run(() => window.api.git.unstage([f.path]))}
                  busy={busy}
                />
              ))}
              {staged.length === 0 && (
                <p className="px-3 py-1 font-mono text-[10px] text-ink-mute">None</p>
              )}
            </Section>
            <Section title={`Changes (${unstaged.length})`}>
              {unstaged.map((f) => (
                <FileRow
                  key={`u:${f.path}`}
                  file={f}
                  letter={changeLetter(f, 'worktree')}
                  active={selected?.path === f.path && !selected.staged}
                  onSelect={() => selectFile(f.path, false)}
                  actionLabel="+"
                  actionTitle="Stage"
                  onAction={() => void run(() => window.api.git.stage([f.path]))}
                  busy={busy}
                />
              ))}
              {unstaged.length === 0 && (
                <p className="px-3 py-1 font-mono text-[10px] text-ink-mute">None</p>
              )}
            </Section>
          </div>

          <div className="flex h-[38%] min-h-[120px] shrink-0 flex-col border-t border-ink-line">
            <div className="flex h-7 items-center border-b border-ink-line px-2 font-mono text-[10px] text-ink-mute">
              {selected
                ? `Diff · ${selected.staged ? 'staged' : 'working'} · ${selected.path}`
                : 'Select a file for diff'}
            </div>
            <div className="min-h-0 flex-1">
              {diff?.error ? (
                <p className="p-2 font-mono text-[10px] text-rose-400">{diff.error}</p>
              ) : diff && selected ? (
                <DiffEditor
                  key={`${selected.path}:${selected.staged}:${diff.oldText.length}:${diff.newText.length}`}
                  original={diff.oldText}
                  modified={diff.newText}
                  language={lang}
                  theme={editorTheme}
                  options={{
                    readOnly: true,
                    renderSideBySide: false,
                    scrollbar: AFK_SCROLLBAR,
                    minimap: { enabled: false },
                    fontSize: 11,
                    lineNumbers: 'off',
                    folding: false,
                    overviewRulerLanes: 0
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {status.available && tab === 'graph' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {commits.length === 0 ? (
              <p className="px-3 py-2 font-mono text-[10px] text-ink-mute">No commits</p>
            ) : (
              commits.map((c) => (
                <button
                  key={c.hash}
                  type="button"
                  onClick={() => {
                    void window.api.git.show(c.hash).then(setDetail)
                  }}
                  className={
                    'flex w-full items-start gap-1 px-2 py-1 text-left font-mono text-[10px] hover:bg-ink-900 ' +
                    (detail?.hash === c.hash ? 'bg-ink-800 text-ink-bright' : 'text-ink-soft')
                  }
                >
                  <span className="shrink-0 whitespace-pre text-ink-mute">{c.graph}</span>
                  <span className="shrink-0 text-signal">{c.shortHash}</span>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 text-ink-mute">{c.date}</span>
                </button>
              ))
            )}
          </div>
          {detail && (
            <div className="flex max-h-[45%] min-h-[100px] shrink-0 flex-col border-t border-ink-line">
              <div className="border-b border-ink-line px-2 py-1.5">
                <div className="font-mono text-[11px] text-ink-bright">{detail.subject}</div>
                <div className="font-mono text-[10px] text-ink-mute">
                  {detail.shortHash} · {detail.author} · {detail.date}
                </div>
                {detail.body ? (
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-ink-soft">
                    {detail.body}
                  </pre>
                ) : null}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-2 font-mono text-[10px] text-ink-mute">
                {detail.error ?? detail.patch}
              </pre>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded px-1.5 py-0.5 font-mono text-[10px] ' +
        (active ? 'bg-ink-800 text-ink-bright' : 'text-ink-mute hover:text-ink-soft')
      }
    >
      {children}
    </button>
  )
}

function ActionBtn({
  disabled,
  onClick,
  children
}: {
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-ink-line px-2 py-0.5 font-mono text-[10px] text-ink-soft hover:border-signal hover:text-signal disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="py-1">
      <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        {title}
      </div>
      {children}
    </div>
  )
}

function FileRow({
  file,
  letter,
  active,
  onSelect,
  actionLabel,
  actionTitle,
  onAction,
  busy
}: {
  file: GitFileChange
  letter: string
  active: boolean
  onSelect: () => void
  actionLabel: string
  actionTitle: string
  onAction: () => void
  busy: boolean
}): React.JSX.Element {
  const color =
    letter === 'A' || letter === '?'
      ? 'text-emerald-400'
      : letter === 'D'
        ? 'text-rose-400'
        : letter === 'M'
          ? 'text-amber-400'
          : 'text-ink-mute'
  return (
    <div
      className={
        'group flex w-full items-center ' + (active ? 'bg-ink-800' : 'hover:bg-ink-900')
      }
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1 text-left font-mono text-[11px] text-ink-soft"
        title={file.path}
      >
        <span className={`w-3 shrink-0 ${color}`}>{letter}</span>
        <span className="truncate">{file.path}</span>
      </button>
      <button
        type="button"
        title={actionTitle}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          onAction()
        }}
        className="mr-1 hidden shrink-0 px-1.5 font-mono text-[11px] text-ink-mute hover:text-signal group-hover:inline disabled:opacity-40"
      >
        {actionLabel}
      </button>
    </div>
  )
}
