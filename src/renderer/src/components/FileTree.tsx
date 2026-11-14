import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

interface FileTreeProps {
  root: string | null
  activePath: string | null
  onOpenFile: (relativePath: string) => void
  onOpenFolder: () => void
  onFileDeleted?: (relativePath: string) => void
  onFileRenamed?: (from: string, to: string) => void
  fill?: boolean
  gitMarks?: Record<string, string>
}

interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  children?: TreeNode[]
}

type DraftMode =
  | { kind: 'new-file'; parent: string }
  | { kind: 'new-dir'; parent: string }
  | { kind: 'rename'; path: string; isDir: boolean }
  | null

function buildTree(paths: string[]): TreeNode[] {
  type Mutable = {
    name: string
    path: string
    kind: 'file' | 'dir'
    children: Map<string, Mutable>
  }

  const root = new Map<string, Mutable>()

  const ensureDir = (parts: string[]): Map<string, Mutable> => {
    let level = root
    let acc = ''
    for (const part of parts) {
      if (!part) continue
      acc = acc ? `${acc}/${part}` : part
      let node = level.get(part)
      if (!node) {
        node = { name: part, path: acc, kind: 'dir', children: new Map() }
        level.set(part, node)
      } else if (node.kind === 'file') {
        node = { name: part, path: acc, kind: 'dir', children: new Map() }
        level.set(part, node)
      }
      level = node.children
    }
    return level
  }

  for (const raw of paths) {
    const isDir = raw.endsWith('/')
    const clean = (isDir ? raw.slice(0, -1) : raw).replace(/^\/+|\/+$/g, '')
    if (!clean) continue
    const parts = clean.split('/')
    if (isDir) {
      ensureDir(parts)
      continue
    }
    const fileName = parts.pop()
    if (!fileName) continue
    const level = parts.length ? ensureDir(parts) : root
    if (!level.has(fileName)) {
      level.set(fileName, {
        name: fileName,
        path: clean,
        kind: 'file',
        children: new Map()
      })
    }
  }

  const toArray = (map: Map<string, Mutable>): TreeNode[] =>
    [...map.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      .map((n) => ({
        name: n.name,
        path: n.path,
        kind: n.kind,
        children: n.kind === 'dir' ? toArray(n.children) : undefined
      }))

  return toArray(root)
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '' : path.slice(0, i)
}

function TreeRows({
  nodes,
  depth,
  expanded,
  activePath,
  busyPath,
  gitMarks,
  renamingPath,
  renameValue,
  onToggle,
  onOpenFile,
  onDelete,
  onStartRename,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel
}: {
  nodes: TreeNode[]
  depth: number
  expanded: Set<string>
  activePath: string | null
  busyPath: string | null
  gitMarks?: Record<string, string>
  renamingPath: string | null
  renameValue: string
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onDelete: (path: string, e: React.MouseEvent) => void
  onStartRename: (path: string, isDir: boolean) => void
  onRenameChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
}): React.JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.kind === 'dir'
        const open = isDir && expanded.has(node.path)
        const active = !isDir && activePath === node.path
        const pad = 8 + depth * 12
        const mark = !isDir ? gitMarks?.[node.path] : undefined
        const markColor =
          mark === 'A' || mark === '?'
            ? 'text-emerald-400'
            : mark === 'D'
              ? 'text-rose-400'
              : mark === 'M'
                ? 'text-amber-400'
                : 'text-ink-mute'
        const renaming = renamingPath === node.path

        return (
          <div key={node.path}>
            <div
              className={`group flex w-full items-center ${
                active ? 'bg-ink-800' : 'hover:bg-ink-900'
              }`}
            >
              {renaming ? (
                <div className="flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-1" style={{ paddingLeft: pad }}>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => onRenameChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        onRenameSubmit()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        onRenameCancel()
                      }
                    }}
                    onBlur={() => onRenameSubmit()}
                    className="min-w-0 flex-1 rounded border border-signal/50 bg-ink-950 px-1 py-0.5 font-mono text-[11px] text-ink-bright outline-none"
                  />
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => (isDir ? onToggle(node.path) : onOpenFile(node.path))}
                    style={{ paddingLeft: pad }}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left font-mono text-[11px] ${
                      active ? 'text-signal' : 'text-ink-soft group-hover:text-ink-bright'
                    }`}
                    title={node.path}
                  >
                    {isDir ? (
                      <span className="w-3 shrink-0 text-[9px] text-ink-mute">
                        {open ? '▾' : '▸'}
                      </span>
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&_svg]:block">
                      {isDir ? (
                        <FolderIcon folderName={node.name} width={14} height={14} />
                      ) : (
                        <FileIcon
                          fileName={node.name}
                          autoAssign
                          width={14}
                          height={14}
                        />
                      )}
                    </span>
                    <span className="truncate">{node.name}</span>
                    {mark ? (
                      <span className={`ml-auto shrink-0 pl-1 text-[10px] ${markColor}`}>
                        {mark}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    title="Rename"
                    disabled={busyPath === node.path}
                    onClick={(e) => {
                      e.stopPropagation()
                      onStartRename(node.path, isDir)
                    }}
                    className="hidden shrink-0 px-1 font-mono text-[10px] text-ink-mute hover:text-signal group-hover:inline disabled:opacity-40"
                  >
                    ✎
                  </button>
                  {!isDir && (
                    <button
                      type="button"
                      title="Delete"
                      disabled={busyPath === node.path}
                      onClick={(e) => onDelete(node.path, e)}
                      className="mr-1 hidden shrink-0 px-1.5 font-mono text-[10px] text-ink-mute hover:text-rose-400 group-hover:inline disabled:opacity-40"
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
            {isDir && open && node.children && node.children.length > 0 && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                busyPath={busyPath}
                gitMarks={gitMarks}
                renamingPath={renamingPath}
                renameValue={renameValue}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onDelete={onDelete}
                onStartRename={onStartRename}
                onRenameChange={onRenameChange}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function FileTree({
  root,
  activePath,
  onOpenFile,
  onOpenFolder,
  onFileDeleted,
  onFileRenamed,
  fill = false,
  gitMarks
}: FileTreeProps): React.JSX.Element {
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<DraftMode>(null)
  const [draftValue, setDraftValue] = useState('')

  const refresh = useCallback(async () => {
    if (!root) {
      setPaths([])
      return
    }
    const res = await window.api.workspace.list('.')
    if (!res.ok) {
      setError(res.error ?? 'Failed to list')
      return
    }
    setError(null)
    const next = res.content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 2000)
    setPaths(next)
  }, [root])

  useEffect(() => {
    void refresh()
    setExpanded(new Set())
  }, [refresh])

  useEffect(() => {
    return window.api.workspace.onChanged(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    const topDirs = paths
      .filter((p) => p.endsWith('/') && !p.slice(0, -1).includes('/'))
      .map((p) => p.slice(0, -1))
    if (topDirs.length === 0) return
    setExpanded((prev) => {
      if (prev.size > 0) return prev
      return new Set(topDirs)
    })
  }, [paths])

  const tree = useMemo(() => buildTree(paths), [paths])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const deleteFile = async (path: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setBusyPath(path)
    try {
      const res = await window.api.workspace.deleteFile(path)
      if (res.ok) {
        onFileDeleted?.(path)
        await refresh()
      } else {
        setError(res.error ?? 'Delete failed')
      }
    } finally {
      setBusyPath(null)
    }
  }

  const startNew = (kind: 'new-file' | 'new-dir'): void => {
    let parent = ''
    if (activePath) {
      parent = parentOf(activePath)
    }
    if (parent) {
      setExpanded((prev) => new Set(prev).add(parent))
    }
    setDraft({ kind, parent })
    setDraftValue(kind === 'new-dir' ? 'new-folder' : 'untitled.ts')
    setError(null)
  }

  const submitDraft = async (): Promise<void> => {
    if (!draft) return
    const name = draftValue.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!name || name.includes('..')) {
      setDraft(null)
      return
    }
    const base = draft.kind === 'rename' ? parentOf(draft.path) : draft.parent
    const leaf = name.includes('/') ? name.split('/').pop()! : name
    const target = base ? `${base}/${leaf}` : leaf

    setBusyPath(target)
    try {
      if (draft.kind === 'new-file') {
        const res = await window.api.workspace.createFile(target, '')
        if (!res.ok) {
          setError(res.error ?? 'Create failed')
          return
        }
        await refresh()
        onOpenFile(target)
      } else if (draft.kind === 'new-dir') {
        const res = await window.api.workspace.createDir(target)
        if (!res.ok) {
          setError(res.error ?? 'Create folder failed')
          return
        }
        setExpanded((prev) => new Set(prev).add(target))
        await refresh()
      } else {
        const from = draft.path
        if (from === target) {
          setDraft(null)
          return
        }
        const res = await window.api.workspace.rename(from, target)
        if (!res.ok) {
          setError(res.error ?? 'Rename failed')
          return
        }
        onFileRenamed?.(from, target)
        await refresh()
        if (!draft.isDir) onOpenFile(target)
      }
      setDraft(null)
    } finally {
      setBusyPath(null)
    }
  }

  const name = root ? root.replace(/\\/g, '/').split('/').filter(Boolean).pop() : null
  const renamingPath = draft?.kind === 'rename' ? draft.path : null

  return (
    <aside
      className={
        fill
          ? 'flex h-full min-w-0 flex-1 flex-col bg-ink-950'
          : 'flex h-full w-56 shrink-0 flex-col border-r border-ink-line bg-ink-950'
      }
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-ink-line px-1.5">
        <span
          className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] font-medium text-ink-bright"
          title={root ?? undefined}
        >
          {name ?? 'no folder'}
        </span>
        <button
          type="button"
          title="New file"
          disabled={!root}
          onClick={() => startNew('new-file')}
          className="px-1.5 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
        >
          +F
        </button>
        <button
          type="button"
          title="New folder"
          disabled={!root}
          onClick={() => startNew('new-dir')}
          className="px-1.5 font-mono text-[10px] text-ink-mute hover:text-signal disabled:opacity-40"
        >
          +D
        </button>
        <button
          type="button"
          title="Refresh"
          onClick={() => void refresh()}
          className="px-1.5 text-[10px] text-ink-mute hover:text-signal"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="px-1.5 text-[10px] text-signal hover:underline"
        >
          Open
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!root && (
          <button
            type="button"
            onClick={onOpenFolder}
            className="m-3 w-[calc(100%-1.5rem)] rounded border border-dashed border-ink-line px-2 py-6 text-center text-xs text-ink-mute hover:border-signal hover:text-signal"
          >
            Open a project folder
          </button>
        )}
        {error && <p className="px-3 text-xs text-rose-400">{error}</p>}
        {(draft?.kind === 'new-file' || draft?.kind === 'new-dir') && (
          <div className="mx-2 mb-1 flex items-center gap-1 rounded border border-signal/40 bg-ink-900 px-1.5 py-1">
            <span className="shrink-0 font-mono text-[9px] text-ink-mute">
              {draft.kind === 'new-dir' ? 'folder' : 'file'}
            </span>
            <input
              autoFocus
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitDraft()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDraft(null)
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink-bright outline-none"
              placeholder="name"
            />
            <button
              type="button"
              onClick={() => void submitDraft()}
              className="font-mono text-[10px] text-signal"
            >
              OK
            </button>
          </div>
        )}
        <TreeRows
          nodes={tree}
          depth={0}
          expanded={expanded}
          activePath={activePath}
          busyPath={busyPath}
          gitMarks={gitMarks}
          renamingPath={renamingPath}
          renameValue={draftValue}
          onToggle={toggle}
          onOpenFile={onOpenFile}
          onDelete={(path, e) => void deleteFile(path, e)}
          onStartRename={(path, isDir) => {
            setDraft({ kind: 'rename', path, isDir })
            setDraftValue(path.split('/').pop() ?? path)
            setError(null)
          }}
          onRenameChange={setDraftValue}
          onRenameSubmit={() => void submitDraft()}
          onRenameCancel={() => setDraft(null)}
        />
      </div>
    </aside>
  )
}
