import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { isDefaultChatTitle } from '../../../shared/chats'
import { SettingsGearIcon } from './SettingsGearIcon'

export interface AgentSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

interface AgentRailProps {
  sessionsByRoot: Record<string, AgentSessionMeta[]>
  activeSessionId: string | null
  roots: string[]
  activeRoot: string | null
  width?: number
  onNewAgentInRoot: (root: string) => void
  onSelectSession: (root: string, id: string) => void
  onDeleteSession?: (root: string, id: string) => void
  onSelectRoot: (root: string) => void
  onRemoveRoot: (root: string) => void
  onSearch: () => void
  onOpenFolder: () => void
  onSettings: () => void
  llmState?: string
}

function folderLabel(root: string): string {
  return root.replace(/\\/g, '/').split('/').filter(Boolean).pop() || root
}

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

interface CtxMenu {
  root: string
  x: number
  y: number
}

export function AgentRail({
  sessionsByRoot,
  activeSessionId,
  roots,
  activeRoot,
  width = 220,
  onNewAgentInRoot,
  onSelectSession,
  onDeleteSession,
  onSelectRoot,
  onRemoveRoot,
  onSearch,
  onOpenFolder,
  onSettings,
  llmState: _llmState
}: AgentRailProps): React.JSX.Element {
  const { t } = useI18n()
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const expandedByDefault = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const root of roots) map[root] = true
    return map
  }, [roots])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onPointer = (e: PointerEvent): void => {
      const el = e.target
      if (el instanceof Element && el.closest('[data-repo-menu]')) return
      close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const isExpanded = (root: string): boolean => {
    if (Object.prototype.hasOwnProperty.call(collapsed, root)) {
      return !collapsed[root]
    }
    return expandedByDefault[root] !== false
  }

  const toggleExpanded = (root: string): void => {
    setCollapsed((prev) => ({ ...prev, [root]: isExpanded(root) }))
  }

  return (
    <nav
      className="flex h-full shrink-0 flex-col bg-ink-950"
      style={{ width }}
    >
      <div className="flex items-center gap-1 border-b border-ink-line/80 px-2 py-2">
        <div className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-ink-soft">
          {t('rail.repositories')}
        </div>
        <button
          type="button"
          title={t('rail.search')}
          onClick={onSearch}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-mute hover:bg-ink-900 hover:text-ink-bright"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" />
            <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-1.5 py-2">
          {roots.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-ink-mute">
              {t('rail.noRepos')}
            </div>
          ) : (
            roots.map((root) => {
              const label = folderLabel(root)
              const sessions = sessionsByRoot[root] ?? []
              const open = isExpanded(root)
              const rootActive = activeRoot === root
              return (
                <div key={root} className="mb-0.5">
                  <div
                    className={
                      'group flex items-center gap-0.5 rounded-md ' +
                      (rootActive ? 'bg-ink-900/80' : 'hover:bg-ink-900/50')
                    }
                  >
                    <button
                      type="button"
                      title={open ? 'Collapse' : 'Expand'}
                      onClick={() => toggleExpanded(root)}
                      className="flex h-7 w-5 shrink-0 items-center justify-center text-[10px] text-ink-mute hover:text-ink-soft"
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <button
                      type="button"
                      title={root}
                      onClick={() => onSelectRoot(root)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ root, x: e.clientX, y: e.clientY })
                      }}
                      className={
                        'min-w-0 flex-1 truncate py-1.5 pr-1 text-left text-[12px] ' +
                        (rootActive ? 'text-ink-bright' : 'text-ink-soft')
                      }
                    >
                      {label}
                    </button>
                    <button
                      type="button"
                      title={`${t('rail.newAgent')} — ${label}`}
                      onClick={() => onNewAgentInRoot(root)}
                      className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-mute opacity-0 hover:bg-ink-800 hover:text-signal group-hover:opacity-100"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      title={`Remove ${label} from list`}
                      onClick={() => onRemoveRoot(root)}
                      className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-mute opacity-0 hover:bg-ink-800 hover:text-rose-400 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>

                  {open ? (
                    <div className="ml-3 flex flex-col gap-0.5 border-l border-ink-line/50 pl-1.5">
                      {sessions.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-ink-mute">No agents yet</div>
                      ) : (
                        sessions.map((s) => {
                          const active = rootActive && s.id === activeSessionId
                          return (
                            <div
                              key={s.id}
                              className={
                                'group/agent flex items-center gap-0.5 rounded-md ' +
                                (active ? 'bg-ink-800' : 'hover:bg-ink-900')
                              }
                            >
                              <button
                                type="button"
                                onClick={() => onSelectSession(root, s.id)}
                                className="min-w-0 flex-1 px-2 py-1.5 text-left"
                              >
                                <div
                                  className={
                                    'truncate text-[12px] ' +
                                    (active ? 'text-ink-bright' : 'text-ink-soft')
                                  }
                                >
                                  {isDefaultChatTitle(s.title) ? t('chat.newAgent') : s.title || t('chat.newAgent')}
                                </div>
                                <div className="font-mono text-[9px] text-ink-mute">
                                  {formatRelativeTime(s.updatedAt)}
                                </div>
                              </button>
                              {onDeleteSession ? (
                                <button
                                  type="button"
                                  title={t('rail.deleteChat')}
                                  onClick={() => onDeleteSession(root, s.id)}
                                  className="mr-1 hidden h-6 w-6 items-center justify-center rounded text-ink-mute hover:text-rose-400 group-hover/agent:flex"
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          )
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
          <button
            type="button"
            onClick={onOpenFolder}
            className="mt-1 rounded-md border border-dashed border-ink-line px-2 py-1.5 text-left text-[11px] text-ink-mute hover:border-signal hover:text-signal"
          >
            + {t('rail.openFolder')}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-ink-line/80 px-2 py-2">
        <button
          type="button"
          title={t('rail.settings')}
          onClick={onSettings}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-ink-mute hover:bg-ink-900 hover:text-ink-soft"
        >
          <SettingsGearIcon size={15} />
          <span className="text-[11px] font-medium">{t('rail.settings')}</span>
        </button>
      </div>

      {menu && (
        <div
          data-repo-menu
          className="fixed z-[90] min-w-[160px] rounded-md border border-ink-line bg-ink-900 py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink-soft hover:bg-ink-800"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const root = menu.root
              setMenu(null)
              onNewAgentInRoot(root)
            }}
          >
            {t('rail.newAgent')}
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-rose-400 hover:bg-ink-800"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const root = menu.root
              setMenu(null)
              onRemoveRoot(root)
            }}
          >
            {t('rail.removeRepo')}
          </button>
        </div>
      )}
    </nav>
  )
}
