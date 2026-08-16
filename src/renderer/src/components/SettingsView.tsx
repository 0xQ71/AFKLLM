import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CACHE_QUANT_OPTIONS,
  DEFAULT_MODELS_DIR,
  switchModelPath,
  type AppSettings,
  type CacheQuant,
  type DiscoveredModel,
  type LlmRuntimeStatus,
  type UiTheme
} from '../../../shared/settings'
import type { UiLanguage } from '../../../shared/i18n'
import type { McpServerConfig, McpServerStatus } from '../../../shared/mcp'
import { applyDocumentTheme, UI_THEMES } from '../../../shared/theme'
import { visionReusesChatModel, VISION_SAME_AS_CHAT, isVisionSameAsChat } from '../../../shared/visionDetect'
import { parseTelemetryLogText } from '../../../shared/telemetry'
import { applyMonacoTheme } from '../editor/monacoSetup'
import { useI18n } from '../i18n/I18nProvider'
import { ModelStorePanel } from './ModelStorePanel'
import type { StoreDownloadTarget } from '../../../shared/hfStore'
import type {
  LlamaRuntimePack,
  LlamaRuntimeSelection,
  LlamaRuntimeStatus
} from '../../../shared/llamaRuntime'
import {
  LLAMA_RUNTIME_PACKS,
  llamaRuntimePackLabel
} from '../../../shared/llamaRuntime'
import type { SdRuntimeStatus } from '../../../shared/sdRuntime'
import type { UpdaterCheckResult } from '../../../shared/updater'
import { PAGE_TITLE, SETTINGS_NAV, type SettingsPageId } from './settings/nav'
import {
  Field,
  SettingRow,
  Toggle,
  Well,
  settingsBtnClass,
  settingsInputClass,
  settingsPrimaryBtnClass
} from './settings/ui'

export interface SettingsViewProps {
  open: boolean
  onClose: () => void
  llmStatus?: LlmRuntimeStatus | null
  onLoadModel?: () => void | Promise<void>
  onUnloadModel?: () => void | Promise<void>
  initialPage?: SettingsPageId
}

export function SettingsView({
  open,
  onClose,
  llmStatus = null,
  onLoadModel,
  onUnloadModel,
  initialPage = 'general'
}: SettingsViewProps): React.JSX.Element | null {
  const { t, lang, setLang } = useI18n()
  const [page, setPage] = useState<SettingsPageId>(initialPage)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState(false)
  const [modelActionBusy, setModelActionBusy] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  const [storeTarget, setStoreTarget] = useState<StoreDownloadTarget>('chat')
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])
  const [runtime, setRuntime] = useState<LlamaRuntimeStatus | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setPage(initialPage)
    setMessage(null)
    setSaveOk(false)
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      const list = await window.api.llm.listModels()
      setModels(list)
      try {
        setMcpStatus(await window.api.mcp.status())
      } catch {
        setMcpStatus([])
      }
      try {
        setRuntime(await window.api.llamaRuntime.status())
      } catch {
        setRuntime(null)
      }
    })()
    return window.api.mcp.onChanged((st) => setMcpStatus(st))
  }, [open, initialPage])

  useEffect(() => {
    if (!saveOk) return
    const tmr = window.setTimeout(() => {
      setSaveOk(false)
      setMessage((m) => (m === t('settings.msg.saved') ? null : m))
    }, 3500)
    return () => window.clearTimeout(tmr)
  }, [saveOk, t])

  if (!open) return null

  if (!settings) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-ink-950 text-sm text-ink-mute">
        …
      </div>
    )
  }

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    if (key === 'modelPath' && typeof value === 'string') {
      setSettings(switchModelPath(settings, value))
      void window.api.settings.save({ modelPath: value })
      return
    }
    if (key === 'applyModelPath' && typeof value === 'string') {
      setSettings({ ...settings, applyModelPath: value })
      void window.api.settings.save({ applyModelPath: value })
      return
    }
    if (key === 'visionModelPath' && typeof value === 'string') {
      setSettings({ ...settings, visionModelPath: value })
      void window.api.settings.save({ visionModelPath: value })
      return
    }
    if (key === 'visionMmprojPath' && typeof value === 'string') {
      setSettings({ ...settings, visionMmprojPath: value })
      void window.api.settings.save({ visionMmprojPath: value })
      return
    }
    setSettings({ ...settings, [key]: value })
  }

  const save = async (): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    setSaveOk(false)
    try {
      const next = await window.api.settings.save({
        ...settings,
        parallel: Math.max(1, settings.parallel || 1)
      })
      setSettings(next)
      try {
        setModels(await window.api.llm.listModels())
      } catch {
        /* ignore */
      }
      try {
        setMcpStatus(await window.api.mcp.status())
      } catch {
        /* ignore */
      }
      setSaveOk(true)
      setMessage(t('settings.msg.saved'))
      return true
    } catch (err) {
      setSaveOk(false)
      setMessage(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const loadAfterSave = async (): Promise<void> => {
    const ok = await save()
    if (!ok) return
    await Promise.resolve(onLoadModel?.())
  }

  const applyModelsDir = async (dir: string): Promise<void> => {
    setSettings((prev) => (prev ? { ...prev, modelsDir: dir } : prev))
    try {
      let next = await window.api.settings.save({ modelsDir: dir })
      const list = await window.api.llm.listModels()
      setModels(list)
      if (
        list.length > 0 &&
        (!next.modelPath || !list.some((m) => m.path === next.modelPath))
      ) {
        next = await window.api.settings.save({ modelPath: list[0]!.path })
      }
      setSettings(next)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-ink-950 text-ink-bright">
        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <aside className="flex w-[220px] shrink-0 flex-col border-r border-ink-line bg-ink-900/90">
            <div className="border-b border-ink-line p-3">
              <button
                type="button"
                onClick={onClose}
                className="flex w-full items-center gap-2 rounded-md border border-ink-line px-2.5 py-1.5 text-left text-xs text-ink-soft hover:bg-ink-800 hover:text-ink-bright"
              >
                <span aria-hidden>←</span>
                {t('settings.back')}
              </button>
              <div className="mt-3 px-1 text-[11px] font-medium text-ink-bright">
                {t('settings.title')}
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
              {SETTINGS_NAV.map((group) => (
                <div key={group.labelKey} className="mb-4">
                  <div className="mb-1.5 px-2 font-mono text-[9px] uppercase tracking-wider text-ink-mute">
                    {t(group.labelKey)}
                  </div>
                  <ul className="space-y-0.5">
                    {group.items.map((item) => {
                      const active = page === item.id
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => setPage(item.id)}
                            className={
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ' +
                              (active
                                ? 'bg-signal text-signal-on'
                                : 'text-ink-soft hover:bg-ink-800 hover:text-ink-bright')
                            }
                          >
                            <NavIcon id={item.id} active={active} />
                            {t(item.labelKey)}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center gap-2 border-b border-ink-line px-5 py-3">
              <h1 className="text-base font-semibold text-ink-bright">{t(PAGE_TITLE[page])}</h1>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="mx-auto max-w-3xl space-y-6 text-sm">
                {page === 'general' && (
                  <GeneralPage settings={settings} patch={patch} />
                )}
                {page === 'appearance' && (
                  <AppearancePage
                    settings={settings}
                    patch={patch}
                    lang={lang}
                    setLang={setLang}
                  />
                )}
                {page === 'agent' && <AgentPage settings={settings} patch={patch} />}
                {page === 'model' && (
                  <ModelPage
                    settings={settings}
                    patch={patch}
                    models={models}
                    llmStatus={llmStatus}
                    busy={busy}
                    modelActionBusy={modelActionBusy}
                    setModelActionBusy={setModelActionBusy}
                    onLoadModel={loadAfterSave}
                    onUnloadModel={onUnloadModel}
                    onModelsDirChange={applyModelsDir}
                    onOpenStore={(target: StoreDownloadTarget = 'chat') => {
                      setStoreTarget(target)
                      setStoreOpen(true)
                    }}
                  />
                )}
                {page === 'performance' && (
                  <PerformancePage settings={settings} patch={patch} />
                )}
                {page === 'memory' && <MemoryPage settings={settings} patch={patch} />}
                {page === 'generation' && (
                  <GenerationPage settings={settings} patch={patch} />
                )}
                {page === 'runtime' && (
                  <RuntimePage
                    settings={settings}
                    patch={patch}
                    runtime={runtime}
                    setRuntime={setRuntime}
                    runtimeBusy={runtimeBusy}
                    setRuntimeBusy={setRuntimeBusy}
                    busy={busy}
                    setMessage={setMessage}
                  />
                )}
                {page === 'mcp' && (
                  <McpPage
                    settings={settings}
                    patch={patch}
                    mcpStatus={mcpStatus}
                  />
                )}

                {message && !saveOk ? (
                  <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/40 bg-danger-muted px-3 py-2 font-mono text-xs text-danger">
                    {message}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-3 border-t border-ink-line px-5 py-3">
              {saveOk ? (
                <div
                  role="status"
                  className="mr-auto rounded-md border border-signal/40 bg-signal/15 px-3 py-1.5 text-[12px] text-signal"
                >
                  ✓ {t('settings.msg.saved')}
                  <span className="ml-2 text-ink-mute">{t('settings.msg.savedHint')}</span>
                </div>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className={settingsPrimaryBtnClass + ' px-4 py-2 text-sm'}
              >
                {busy ? '…' : t('settings.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ModelStorePanel
        open={storeOpen}
        target={storeTarget}
        onClose={() => setStoreOpen(false)}
        onDownloaded={(localPath: string) => {
          setSettings((prev) => {
            if (!prev) return prev
            if (storeTarget === 'vision') {
              return { ...prev, visionModelPath: localPath }
            }
            if (storeTarget === 'apply') {
              return { ...prev, applyModelPath: localPath }
            }
            if (storeTarget === 'mmproj') {
              return { ...prev, visionMmprojPath: localPath }
            }
            if (storeTarget === 'imageGen') {
              return { ...prev, imageGenModelPath: localPath }
            }
            if (storeTarget === 'imageGenVae') {
              return { ...prev, imageGenVaePath: localPath }
            }
            if (storeTarget === 'imageGenClipL') {
              return { ...prev, imageGenClipLPath: localPath }
            }
            if (storeTarget === 'imageGenClipG') {
              return { ...prev, imageGenClipGPath: localPath }
            }
            if (storeTarget === 'imageGenT5') {
              return { ...prev, imageGenT5Path: localPath }
            }
            if (storeTarget === 'imageGenLlm') {
              return { ...prev, imageGenLlmPath: localPath }
            }
            return switchModelPath(prev, localPath)
          })
          if (storeTarget === 'apply') {
            void window.api.settings.save({ applyModelPath: localPath })
          } else if (storeTarget === 'vision') {
            void window.api.settings.save({ visionModelPath: localPath })
          } else if (storeTarget === 'mmproj') {
            void window.api.settings.save({ visionMmprojPath: localPath })
          } else if (storeTarget === 'chat') {
            void window.api.settings.save({ modelPath: localPath })
          }
          setStoreOpen(false)
          setMessage(t('store.imported', { path: localPath }))
          void window.api.llm.listModels().then(setModels).catch(() => {
            /* ignore */
          })
        }}
      />
    </>
  )
}

function NavIcon({ id, active }: { id: SettingsPageId; active: boolean }): React.JSX.Element {
  const stroke = active ? 'currentColor' : 'currentColor'
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: 1.75,
    className: 'shrink-0 opacity-90'
  } as const
  switch (id) {
    case 'general':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )
    case 'appearance':
      return (
        <svg {...common}>
          <path d="M12 3a9 9 0 1 0 9 9c0-1.2-.3-2.3-.8-3.3A5 5 0 0 1 12 12V3z" />
        </svg>
      )
    case 'agent':
      return (
        <svg {...common}>
          <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM4 20a8 8 0 0 1 16 0" />
        </svg>
      )
    case 'model':
      return (
        <svg {...common}>
          <path d="M4 7h16v10H4zM8 7V5h8v2" />
        </svg>
      )
    case 'performance':
      return (
        <svg {...common}>
          <path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6" />
        </svg>
      )
    case 'memory':
      return (
        <svg {...common}>
          <rect x="4" y="6" width="16" height="12" rx="1" />
          <path d="M8 6v12M16 6v12" />
        </svg>
      )
    case 'generation':
      return (
        <svg {...common}>
          <path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5" />
        </svg>
      )
    case 'runtime':
      return (
        <svg {...common}>
          <rect x="5" y="4" width="14" height="16" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </svg>
      )
    case 'mcp':
      return (
        <svg {...common}>
          <path d="M8 12h8M12 8v8M7 7l10 10M17 7 7 17" />
        </svg>
      )
    default:
      return <span className="inline-block w-4" />
  }
}

function PageIntro({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="text-[12px] text-ink-mute">{children}</p>
}

function GeneralPage({
  settings,
  patch
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [logText, setLogText] = useState('')
  const [logBusy, setLogBusy] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  const refreshLog = async (): Promise<void> => {
    setLogBusy(true)
    try {
      const res = await window.api.telemetry.readLog()
      setLogText(res.text || (res.error ? res.error : ''))
    } catch (e) {
      setLogText(e instanceof Error ? e.message : String(e))
    } finally {
      setLogBusy(false)
    }
  }

  const clearLog = async (): Promise<void> => {
    setLogBusy(true)
    try {
      await window.api.telemetry.clearLog()
      setLogText('')
    } catch (e) {
      setLogText(e instanceof Error ? e.message : String(e))
    } finally {
      setLogBusy(false)
    }
  }

  useEffect(() => {
    void refreshLog()
    const id = window.setInterval(() => void refreshLog(), 4000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!stickBottom.current || !feedRef.current) return
    feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [logText])

  const entries = parseTelemetryLogText(logText)

  return (
    <>
      <PageIntro>{t('settings.page.generalIntro')}</PageIntro>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink-bright">{t('settings.updates')}</h2>
        <Well>
          <UpdaterBlock />
        </Well>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight text-ink-bright">
          {t('settings.diag')}
        </h2>
        <Well>
          <Toggle
            title={t('settings.diag.collectLogs')}
            description={t('settings.diag.note')}
            checked={settings.collectLogsToFile !== false}
            onChange={(v) => {
              patch('collectLogsToFile', v)
              void window.api.settings.save({ collectLogsToFile: v })
            }}
          />
        </Well>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-sm font-semibold text-ink-bright">{t('settings.diag.console')}</h3>
            <p className="text-[12px] leading-snug text-ink-mute">
              {t('settings.diag.consoleDesc')}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={logBusy}
              onClick={() => void window.api.telemetry.openLogDir()}
              className={settingsBtnClass}
            >
              {t('settings.diag.openLog')}
            </button>
            <button
              type="button"
              disabled={logBusy}
              onClick={() => void clearLog()}
              className={settingsBtnClass}
            >
              {t('settings.diag.clearLog')}
            </button>
          </div>
        </div>
        <div
          ref={feedRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          className="max-h-[28rem] min-h-[14rem] overflow-y-auto rounded-lg border border-ink-line/80 bg-ink-950/90"
        >
          {!entries.length ? (
            <p className="px-4 py-8 text-center text-[12px] text-ink-mute">
              {t('settings.diag.consoleEmpty')}
            </p>
          ) : (
            <ul className="divide-y divide-ink-line/50">
              {entries.map((entry, i) => (
                <li key={`${entry.time}-${entry.level}-${i}`} className="px-4 py-3">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3 font-mono text-[11px] text-ink-mute">
                    <span className="tabular-nums">{entry.time || '—'}</span>
                    <span className="uppercase tracking-wide">{entry.level}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-soft">
                    {entry.message}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  )
}

function AppearancePage({
  settings,
  patch,
  lang,
  setLang
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  lang: UiLanguage
  setLang: (l: UiLanguage) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const themeLabelKey: Record<(typeof UI_THEMES)[number], string> = {
    auto: 'settings.theme.auto',
    classic: 'settings.theme.classic',
    light: 'settings.theme.light',
    sepia: 'settings.theme.sepia',
    dark: 'settings.theme.dark',
    'deep-dark': 'settings.theme.deepDark',
    'solarized-dark': 'settings.theme.solarizedDark'
  }
  return (
    <>
      <PageIntro>{t('settings.page.appearanceIntro')}</PageIntro>
      <Well>
        <SettingRow title={t('settings.theme')} description={t('settings.page.themeDesc')}>
          <select
            value={settings.uiTheme}
            onChange={(e) => {
              const theme = e.target.value as UiTheme
              patch('uiTheme', theme)
              applyDocumentTheme(theme)
              applyMonacoTheme(theme)
              void window.api.settings.save({ uiTheme: theme })
            }}
            className={settingsInputClass + ' w-full min-w-[12rem] sm:w-56'}
          >
            {UI_THEMES.map((id) => (
              <option key={id} value={id}>
                {t(themeLabelKey[id] as 'settings.theme.auto')}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title={t('settings.language')} description={t('settings.page.langDesc')}>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['en', 'settings.language.en'],
                ['ru', 'settings.language.ru']
              ] as const
            ).map(([id, labelKey]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  const next = id as UiLanguage
                  patch('uiLanguage', next)
                  setLang(next)
                }}
                className={
                  'rounded-md border px-3 py-1.5 text-xs ' +
                  (lang === id
                    ? 'border-signal bg-signal/15 text-ink-bright'
                    : 'border-ink-line text-ink-soft hover:bg-ink-800')
                }
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </SettingRow>
      </Well>
    </>
  )
}

function AgentPage({
  settings,
  patch
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageIntro>{t('settings.page.agentIntro')}</PageIntro>
      <Well>
        <Toggle
          title={t('settings.agent.autoApprove')}
          checked={settings.agentAutoApprove}
          onChange={(v) => patch('agentAutoApprove', v)}
        />
        <Toggle
          title={t('settings.agent.imageGen')}
          checked={settings.agentImageGenEnabled === true}
          onChange={(v) => {
            patch('agentImageGenEnabled', v)
            void window.api.settings.save({ agentImageGenEnabled: v })
          }}
        />
        <p className="px-1 text-[11px] text-ink-mute">{t('settings.agent.imageGenHint')}</p>
      </Well>
    </>
  )
}

function ModelPage({
  settings,
  patch,
  models,
  llmStatus,
  busy,
  modelActionBusy,
  setModelActionBusy,
  onLoadModel,
  onUnloadModel,
  onModelsDirChange,
  onOpenStore
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  models: DiscoveredModel[]
  llmStatus: LlmRuntimeStatus | null
  busy: boolean
  modelActionBusy: boolean
  setModelActionBusy: (v: boolean) => void
  onLoadModel?: () => void | Promise<void>
  onUnloadModel?: () => void | Promise<void>
  onModelsDirChange: (dir: string) => void | Promise<void>
  onOpenStore: (target?: StoreDownloadTarget) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const reuseVision = visionReusesChatModel({
    chatPath: settings.modelPath,
    visionPath: settings.visionModelPath,
    mmprojPath: settings.visionMmprojPath
  })
  const [sdStatus, setSdStatus] = useState<SdRuntimeStatus | null>(null)
  const [sdBusy, setSdBusy] = useState(false)
  const [sdMessage, setSdMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.api.sdRuntime.status().then(setSdStatus).catch(() => setSdStatus(null))
    return window.api.sdRuntime.onProgress(() => {
      void window.api.sdRuntime.status().then(setSdStatus).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    void window.api.sdRuntime.status().then(setSdStatus).catch(() => undefined)
  }, [settings.sdCppPath])

  const pickModelsDir = async (): Promise<void> => {
    const dir = await window.api.workspace.pickModelsDir()
    if (dir) await onModelsDirChange(dir)
  }

  const usingCustomSd = Boolean(settings.sdCppPath?.trim())
  const canUpdateSd = !usingCustomSd && Boolean(sdStatus?.updateAvailable)
  const canCheckSd = !usingCustomSd

  const refreshSd = async (): Promise<SdRuntimeStatus | null> => {
    try {
      const next = await window.api.sdRuntime.status()
      setSdStatus(next)
      return next
    } catch {
      setSdStatus(null)
      return null
    }
  }

  const runSdCheck = (): void => {
    void (async () => {
      setSdBusy(true)
      setSdMessage(t('settings.multimodal.sdChecking'))
      try {
        const next = await window.api.sdRuntime.check()
        setSdStatus(next)
        if (next.checkError) {
          setSdMessage(next.checkError)
        } else if (next.updateAvailable && next.latestTag) {
          setSdMessage(
            t('settings.multimodal.sdUpdateAvailable', { tag: next.latestTag })
          )
        } else if (next.source === 'missing') {
          setSdMessage(t('settings.multimodal.sdNotInstalled'))
        } else if (next.source === 'custom') {
          setSdMessage(t('settings.multimodal.sdCustomPath'))
        } else {
          setSdMessage(t('settings.multimodal.sdUptoDate'))
        }
      } catch (e) {
        setSdMessage(e instanceof Error ? e.message : String(e))
      } finally {
        setSdBusy(false)
      }
    })()
  }

  const runSdUpdate = (): void => {
    void (async () => {
      setSdBusy(true)
      setSdMessage(t('settings.multimodal.sdBusy'))
      try {
        const next = await window.api.sdRuntime.ensure({ force: true })
        setSdStatus(next)
        setSdMessage(
          next.ready
            ? t('settings.multimodal.sdReady', {
                tag: next.tag ? ` · ${next.tag}` : ''
              })
            : t('settings.multimodal.sdNotInstalled')
        )
      } catch (e) {
        setSdMessage(e instanceof Error ? e.message : String(e))
        await refreshSd()
      } finally {
        setSdBusy(false)
      }
    })()
  }

  const sdStatusLine = [
    usingCustomSd
      ? t('settings.multimodal.sdCustomPath')
      : sdStatus?.source === 'missing'
        ? t('settings.multimodal.sdNotInstalled')
        : sdStatus?.ready
          ? t('settings.multimodal.sdReady', {
              tag: sdStatus.tag ? ` · ${sdStatus.tag}` : ''
            })
          : t('settings.multimodal.sdNotInstalled'),
    !usingCustomSd && sdStatus?.updateAvailable && sdStatus.latestTag
      ? t('settings.multimodal.sdUpdateAvailable', { tag: sdStatus.latestTag })
      : !usingCustomSd && sdStatus?.ready && sdStatus.latestTag && !sdStatus.updateAvailable
        ? t('settings.multimodal.sdUptoDate')
        : null,
    sdMessage
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <PageIntro>{t('settings.page.modelIntro')}</PageIntro>
      <Well>
        <Toggle
          title={t('settings.api.enabled')}
          description={t('settings.api.note')}
          checked={settings.localApiEnabled === true}
          onChange={(v) => {
            patch('localApiEnabled', v)
            void window.api.settings.save({ localApiEnabled: v })
          }}
        />
        <SettingRow
          title={t('settings.api.baseUrl')}
          description={
            llmStatus?.state === 'ready'
              ? t('settings.api.running')
              : t('settings.api.stopped')
          }
        >
          <span
            className={
              'font-mono text-xs ' +
              (settings.localApiEnabled && llmStatus?.state === 'ready'
                ? 'text-emerald-400'
                : settings.localApiEnabled
                  ? 'text-amber-400'
                  : 'text-rose-400')
            }
          >
            {`http://127.0.0.1:${settings.port}`}
          </span>
        </SettingRow>
        <Field label={t('settings.model.gguf')}>
          <div className="flex gap-2">
            <select
              value={settings.modelPath}
              onChange={(e) => patch('modelPath', e.target.value)}
              className={settingsInputClass + ' font-mono text-xs'}
            >
              {models.length === 0 && (
                <option value={settings.modelPath}>
                  {settings.modelPath || t('settings.model.none')}
                </option>
              )}
              {models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.id} ({(m.sizeBytes / 1e9).toFixed(1)} GB)
                </option>
              ))}
            </select>
            <button type="button" onClick={() => onOpenStore('chat')} className={settingsBtnClass + ' text-signal border-signal/40'}>
              {t('settings.model.storeShort')}
            </button>
            <button
              type="button"
              onClick={() => void window.api.hf.openModelsDir()}
              className={settingsBtnClass}
              title={t('settings.model.browseFolder')}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <Field label={t('settings.model.applyGguf')}>
          <div className="flex gap-2">
            <select
              value={settings.applyModelPath}
              onChange={(e) => patch('applyModelPath', e.target.value)}
              className={settingsInputClass + ' font-mono text-xs'}
            >
              <option value="">{t('settings.multimodal.none')}</option>
              {models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.id} ({(m.sizeBytes / 1e9).toFixed(1)} GB)
                </option>
              ))}
              {settings.applyModelPath &&
                !models.some((m) => m.path === settings.applyModelPath) && (
                  <option value={settings.applyModelPath}>
                    {settings.applyModelPath.split(/[/\\]/).pop()}
                  </option>
                )}
            </select>
            <button
              type="button"
              onClick={() => onOpenStore('apply')}
              className={settingsBtnClass + ' text-signal border-signal/40'}
            >
              {t('settings.model.storeShort')}
            </button>
            <button
              type="button"
              onClick={() => void window.api.hf.openModelsDir()}
              className={settingsBtnClass}
              title={t('settings.model.browseFolder')}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <Field
          label={t('settings.model.applyCtx')}
          hint={t('settings.model.applyCtxHint')}
        >
          <input
            type="number"
            min={0}
            step={2048}
            value={settings.applyCtxSize}
            onChange={(e) => patch('applyCtxSize', Number(e.target.value) || 0)}
            className={settingsInputClass}
          />
        </Field>
        <Field
          label={t('settings.multimodal.visionModel')}
          hint={
            reuseVision
              ? t('settings.multimodal.visionSameAsChatHint')
              : undefined
          }
        >
          <div className="flex gap-2">
            <select
              value={settings.visionModelPath}
              onChange={(e) => patch('visionModelPath', e.target.value)}
              className={settingsInputClass + ' font-mono text-xs'}
            >
              <option value="">{t('settings.multimodal.none')}</option>
              <option value={VISION_SAME_AS_CHAT} disabled={!settings.modelPath?.trim()}>
                {t('settings.multimodal.visionSameAsChat')}
              </option>
              {models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.id} ({(m.sizeBytes / 1e9).toFixed(1)} GB)
                </option>
              ))}
              {settings.visionModelPath &&
                !isVisionSameAsChat(settings.visionModelPath) &&
                !models.some((m) => m.path === settings.visionModelPath) && (
                  <option value={settings.visionModelPath}>
                    {settings.visionModelPath.split(/[/\\]/).pop()}
                  </option>
                )}
            </select>
            <button
              type="button"
              className={settingsBtnClass + ' text-signal border-signal/40'}
              onClick={() => onOpenStore('vision')}
            >
              {t('settings.model.storeShort')}
            </button>
            <button
              type="button"
              className={settingsBtnClass}
              onClick={() => {
                void window.api.workspace.pickModel().then((p) => {
                  if (p) patch('visionModelPath', p)
                })
              }}
              title={t('settings.model.browseFolder')}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <Field label={t('settings.multimodal.mmproj')}>
          <div className="flex gap-2">
            <input
              value={settings.visionMmprojPath}
              onChange={(e) => patch('visionMmprojPath', e.target.value)}
              placeholder={t('settings.multimodal.mmprojHint')}
              className={settingsInputClass + ' min-w-0 flex-1 font-mono text-xs'}
            />
            <button
              type="button"
              className={settingsBtnClass + ' text-signal border-signal/40'}
              onClick={() => onOpenStore('mmproj')}
            >
              {t('settings.model.storeShort')}
            </button>
            <button
              type="button"
              className={settingsBtnClass}
              onClick={() => {
                void window.api.workspace.pickMmproj().then((p) => {
                  if (p) patch('visionMmprojPath', p)
                })
              }}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <Toggle
          title={t('settings.model.visionKeep')}
          description={
            reuseVision
              ? t('settings.model.visionKeepReuseHint')
              : t('settings.model.visionKeepHint')
          }
          checked={settings.visionKeepLoaded !== false}
          onChange={(v) => {
            patch('visionKeepLoaded', v)
            void window.api.settings.save({ visionKeepLoaded: v })
          }}
        />
        <SettingRow
          title={t('settings.model.status')}
          description={
            llmStatus?.detail && llmStatus.detail !== llmStatus.state
              ? llmStatus.detail
              : undefined
          }
        >
          <span
            className={
              'mr-2 text-xs ' +
              (llmStatus?.state === 'ready'
                ? 'text-signal'
                : llmStatus?.state === 'error'
                  ? 'text-rose-400'
                  : llmStatus?.state === 'starting'
                    ? 'text-amber-400'
                    : 'text-ink-mute')
            }
          >
            {llmStatus?.state ?? '…'}
          </span>
          {llmStatus?.state === 'ready' || llmStatus?.state === 'starting' ? (
            <button
              type="button"
              disabled={modelActionBusy || busy}
              onClick={() => {
                setModelActionBusy(true)
                void Promise.resolve(onUnloadModel?.()).finally(() => setModelActionBusy(false))
              }}
              className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-400 hover:bg-rose-500/20 disabled:opacity-50"
            >
              {llmStatus?.state === 'starting'
                ? t('settings.model.loading')
                : t('settings.model.unload')}
            </button>
          ) : (
            <button
              type="button"
              disabled={modelActionBusy || busy || !settings.modelPath}
              onClick={() => {
                setModelActionBusy(true)
                void Promise.resolve(onLoadModel?.()).finally(() => setModelActionBusy(false))
              }}
              className={settingsPrimaryBtnClass}
            >
              {t('settings.model.load')}
            </button>
          )}
        </SettingRow>
        <SettingRow
          title={t('settings.model.applyStatus')}
          description={
            llmStatus?.applyError && llmStatus.applyState === 'error'
              ? llmStatus.applyError
              : !settings.applyModelPath?.trim()
                ? t('settings.model.applyStatusHint')
                : undefined
          }
        >
          <span
            className={
              'text-xs ' +
              (llmStatus?.applyState === 'ready'
                ? 'text-signal'
                : llmStatus?.applyState === 'error'
                  ? 'text-rose-400'
                  : llmStatus?.applyState === 'starting'
                    ? 'text-amber-400'
                    : 'text-ink-mute')
            }
          >
            {!settings.applyModelPath?.trim()
              ? '—'
              : (llmStatus?.applyState ?? 'stopped')}
          </span>
        </SettingRow>
        <SettingRow
          title={t('settings.model.visionStatus')}
          description={
            llmStatus?.visionError && llmStatus.visionState === 'error'
              ? llmStatus.visionError
              : reuseVision
                ? t('settings.model.visionStatusReuse')
                : !settings.visionModelPath?.trim()
                  ? t('settings.model.visionStatusHint')
                  : settings.visionKeepLoaded === false
                    ? t('settings.model.visionStatusSwap')
                    : undefined
          }
        >
          <span
            className={
              'text-xs ' +
              (llmStatus?.visionState === 'ready'
                ? 'text-signal'
                : llmStatus?.visionState === 'error'
                  ? 'text-rose-400'
                  : llmStatus?.visionState === 'starting'
                    ? 'text-amber-400'
                    : 'text-ink-mute')
            }
          >
            {!reuseVision && !settings.visionModelPath?.trim()
              ? '—'
              : (llmStatus?.visionState ?? 'stopped')}
          </span>
        </SettingRow>
        <SettingRow title={t('settings.model.port')}>
          <input
            type="number"
            value={settings.port}
            onChange={(e) => patch('port', Number(e.target.value))}
            className={settingsInputClass + ' w-28'}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.model.modelsDir')}
          description={t('settings.model.modelsDirDefault', { path: DEFAULT_MODELS_DIR })}
        >
          <div className="flex w-full max-w-md gap-2">
            <input
              value={settings.modelsDir}
              onChange={(e) => patch('modelsDir', e.target.value)}
              onBlur={(e) => {
                const dir = e.target.value.trim()
                if (dir) void onModelsDirChange(dir)
              }}
              className={settingsInputClass + ' min-w-0 flex-1 font-mono text-xs'}
            />
            <button type="button" onClick={() => void pickModelsDir()} className={settingsBtnClass}>
              {t('settings.model.pickDir')}
            </button>
          </div>
        </SettingRow>
      </Well>
      <PageIntro>{t('settings.multimodal.intro')}</PageIntro>
      <p className="mb-2 text-[11px] text-ink-mute">{t('settings.multimodal.agentGateHint')}</p>
      <Well>
        <Field label={t('settings.multimodal.imageGenModel')}>
          <div className="flex gap-2">
            <input
              value={settings.imageGenModelPath}
              onChange={(e) => patch('imageGenModelPath', e.target.value)}
              placeholder={t('settings.multimodal.imageGenHint')}
              className={settingsInputClass + ' min-w-0 flex-1 font-mono text-xs'}
            />
            <button
              type="button"
              className={settingsBtnClass + ' text-signal border-signal/40'}
              onClick={() => onOpenStore('imageGen')}
            >
              {t('settings.model.storeShort')}
            </button>
            <button
              type="button"
              className={settingsBtnClass}
              onClick={() => {
                void window.api.workspace.pickImageGenModel().then((p) => {
                  if (p) patch('imageGenModelPath', p)
                })
              }}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <p className="px-1 text-[11px] leading-snug text-ink-mute">
          {t('settings.multimodal.stackHint')}
        </p>
        <p className="px-1 text-[11px] leading-snug text-ink-mute">
          {t('settings.multimodal.imageGenAutofillHint')}
        </p>
        {(
          [
            [
              'imageGenVaePath',
              'settings.multimodal.vae',
              'settings.multimodal.vaeHint',
              'imageGenVae'
            ],
            [
              'imageGenClipLPath',
              'settings.multimodal.clipL',
              'settings.multimodal.clipLHint',
              'imageGenClipL'
            ],
            [
              'imageGenClipGPath',
              'settings.multimodal.clipG',
              'settings.multimodal.clipGHint',
              'imageGenClipG'
            ],
            [
              'imageGenT5Path',
              'settings.multimodal.t5',
              'settings.multimodal.t5Hint',
              'imageGenT5'
            ],
            [
              'imageGenLlmPath',
              'settings.multimodal.llm',
              'settings.multimodal.llmHint',
              'imageGenLlm'
            ]
          ] as const
        ).map(([key, labelKey, hintKey, storeKey]) => (
          <Field key={key} label={t(labelKey)}>
            <div className="flex gap-2">
              <input
                value={settings[key]}
                onChange={(e) => patch(key, e.target.value)}
                placeholder={t(hintKey)}
                className={settingsInputClass + ' min-w-0 flex-1 font-mono text-xs'}
              />
              <button
                type="button"
                className={settingsBtnClass + ' text-signal border-signal/40'}
                onClick={() => onOpenStore(storeKey)}
              >
                {t('settings.model.storeShort')}
              </button>
              <button
                type="button"
                className={settingsBtnClass}
                onClick={() => {
                  void window.api.workspace.pickImageGenModel().then((p) => {
                    if (p) patch(key, p)
                  })
                }}
              >
                {t('settings.model.browse')}
              </button>
            </div>
            {key === 'imageGenT5Path' &&
            /scaled/i.test(settings.imageGenT5Path) ? (
              <p className="mt-1 text-[11px] leading-snug text-amber-400/90">
                {t('settings.multimodal.t5ScaledWarn')}
              </p>
            ) : null}
          </Field>
        ))}
        <Field label={t('settings.multimodal.sdCppPath')}>
          <div className="flex gap-2">
            <input
              value={settings.sdCppPath}
              onChange={(e) => patch('sdCppPath', e.target.value)}
              placeholder={t('settings.multimodal.sdCppHint')}
              className={settingsInputClass + ' min-w-0 flex-1 font-mono text-xs'}
            />
            <button
              type="button"
              className={settingsBtnClass}
              onClick={() => {
                void window.api.workspace.pickSdCli().then((p) => {
                  if (p) patch('sdCppPath', p)
                })
              }}
            >
              {t('settings.model.browse')}
            </button>
          </div>
        </Field>
        <Field label={t('settings.multimodal.weightStorage')}>
          <select
            value={settings.imageGenWeightStorage}
            onChange={(e) =>
              patch(
                'imageGenWeightStorage',
                e.target.value as AppSettings['imageGenWeightStorage']
              )
            }
            className={settingsInputClass}
          >
            <option value="disk">{t('settings.multimodal.weightStorage.disk')}</option>
            <option value="ram">{t('settings.multimodal.weightStorage.ram')}</option>
            <option value="vram">{t('settings.multimodal.weightStorage.vram')}</option>
          </select>
          <p className="mt-1 text-[11px] text-ink-mute">
            {t('settings.multimodal.weightStorageHint')}
          </p>
        </Field>
        <div className="grid gap-0 sm:grid-cols-2">
          {(
            [
              ['imageGenSteps', 'settings.multimodal.steps'],
              ['imageGenWidth', 'settings.multimodal.width'],
              ['imageGenHeight', 'settings.multimodal.height'],
              ['imageGenCfg', 'settings.multimodal.cfg']
            ] as const
          ).map(([key, labelKey]) => (
            <Field key={key} label={t(labelKey)}>
              <input
                type="number"
                min={key === 'imageGenCfg' ? 0 : key === 'imageGenSteps' ? 1 : 64}
                max={
                  key === 'imageGenWidth' || key === 'imageGenHeight'
                    ? 1536
                    : key === 'imageGenSteps'
                      ? 150
                      : 30
                }
                value={settings[key]}
                onChange={(e) => {
                  let n = Number(e.target.value)
                  if (key === 'imageGenWidth' || key === 'imageGenHeight') {
                    n = Math.max(64, Math.min(1536, n || 64))
                  }
                  patch(key, n)
                }}
                className={settingsInputClass}
              />
            </Field>
          ))}
        </div>
        <p className="px-1 text-[11px] text-ink-mute">{t('settings.multimodal.cfgHint')}</p>
        <SettingRow
          title={t('settings.multimodal.hires')}
          description={t('settings.multimodal.hiresHint')}
        >
          <input
            type="checkbox"
            checked={settings.imageGenHires}
            onChange={(e) => patch('imageGenHires', e.target.checked)}
          />
        </SettingRow>
        <div className="grid gap-0 sm:grid-cols-2">
          <Field label={t('settings.multimodal.hiresScale')}>
            <input
              type="number"
              step={0.05}
              min={1.05}
              max={4}
              disabled={!settings.imageGenHires}
              value={settings.imageGenHiresScale}
              onChange={(e) => patch('imageGenHiresScale', Number(e.target.value))}
              className={settingsInputClass}
            />
          </Field>
          <Field label={t('settings.multimodal.hiresDenoising')}>
            <input
              type="number"
              step={0.05}
              min={0.05}
              max={1}
              disabled={!settings.imageGenHires}
              value={settings.imageGenHiresDenoising}
              onChange={(e) =>
                patch('imageGenHiresDenoising', Number(e.target.value))
              }
              className={settingsInputClass}
            />
          </Field>
        </div>
        <Field label={t('settings.multimodal.negativePrompt')}>
          <textarea
            value={settings.imageGenNegativePrompt}
            onChange={(e) => patch('imageGenNegativePrompt', e.target.value)}
            rows={3}
            className={settingsInputClass + ' font-mono text-xs'}
            spellCheck={false}
          />
          <p className="mt-1 text-[11px] text-ink-mute">
            {t('settings.multimodal.negativePromptHint')}
          </p>
        </Field>
        <SettingRow title={t('settings.multimodal.sdRuntime')} description={sdStatusLine}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={sdBusy || busy || !canCheckSd}
              onClick={() => runSdCheck()}
              className={settingsBtnClass}
              title={
                usingCustomSd
                  ? t('settings.multimodal.sdCustomPath')
                  : t('settings.multimodal.sdCheckHint')
              }
            >
              {t('settings.multimodal.sdCheck')}
            </button>
            <button
              type="button"
              disabled={sdBusy || busy || !canUpdateSd}
              onClick={() => runSdUpdate()}
              className={canUpdateSd ? settingsPrimaryBtnClass : settingsBtnClass}
              title={
                canUpdateSd && sdStatus?.latestTag
                  ? t('settings.multimodal.sdUpdateAvailable', {
                      tag: sdStatus.latestTag
                    })
                  : t('settings.multimodal.sdUpdateDisabled')
              }
            >
              {t('settings.multimodal.sdUpdate')}
            </button>
          </div>
        </SettingRow>
      </Well>
    </>
  )
}

function PerformancePage({
  settings,
  patch
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageIntro>{t('settings.page.perfIntro')}</PageIntro>
      <Well>
        <Toggle
          title={t('settings.perf.fit')}
          checked={settings.fitHardware}
          onChange={(v) => patch('fitHardware', v)}
        />
        <Field label={t('settings.prompt.system')}>
          <textarea
            value={settings.systemPrompt}
            onChange={(e) => patch('systemPrompt', e.target.value)}
            rows={3}
            placeholder={t('settings.prompt.systemPlaceholder')}
            className={settingsInputClass + ' resize-y font-mono text-xs'}
          />
        </Field>
        <div className="grid gap-0 sm:grid-cols-2">
          {(
            [
              ['ctxSize', 'settings.perf.ctxSize'],
              ['nGpuLayers', 'settings.perf.gpuLayers'],
              ['threads', 'settings.perf.threads'],
              ['parallel', 'settings.perf.parallel'],
              ['batchSize', 'settings.perf.batch'],
              ['ubatchSize', 'settings.perf.ubatch']
            ] as const
          ).map(([key, labelKey]) => (
            <Field key={key} label={t(labelKey)}>
              <input
                type="number"
                min={key === 'threads' || key === 'parallel' ? 1 : undefined}
                value={settings[key]}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (key === 'parallel') patch('parallel', Math.max(1, n || 1))
                  else patch(key, n)
                }}
                className={settingsInputClass}
              />
            </Field>
          ))}
          <Field label={t('settings.perf.flashAttn')}>
            <select
              value={settings.flashAttn}
              onChange={(e) => patch('flashAttn', e.target.value as AppSettings['flashAttn'])}
              className={settingsInputClass}
            >
              <option value="on">on</option>
              <option value="auto">auto</option>
              <option value="off">off</option>
            </select>
          </Field>
        </div>
      </Well>
    </>
  )
}

function MemoryPage({
  settings,
  patch
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageIntro>{t('settings.page.memoryIntro')}</PageIntro>
      <Well>
        <Toggle
          title={t('settings.memory.kvOffload')}
          checked={settings.kvOffload}
          onChange={(v) => patch('kvOffload', v)}
        />
        <Toggle
          title={t('settings.memory.kvUnified')}
          checked={settings.kvUnified}
          onChange={(v) => patch('kvUnified', v)}
        />
        <div className="grid sm:grid-cols-2">
          <Field label={t('settings.memory.checkpoints')}>
            <input
              type="number"
              value={settings.ctxCheckpoints}
              onChange={(e) => patch('ctxCheckpoints', Number(e.target.value))}
              className={settingsInputClass}
            />
          </Field>
          <Field label={t('settings.memory.loadMode')}>
            <select
              value={settings.loadMode}
              onChange={(e) => patch('loadMode', e.target.value as AppSettings['loadMode'])}
              className={settingsInputClass}
            >
              <option value="mmap">{t('settings.memory.loadMode.mmap')}</option>
              <option value="mmap+mlock">{t('settings.memory.loadMode.mmapMlock')}</option>
              <option value="none">{t('settings.memory.loadMode.none')}</option>
            </select>
          </Field>
          <Field label={t('settings.memory.cacheK')}>
            <select
              value={settings.cacheTypeK}
              onChange={(e) => patch('cacheTypeK', e.target.value as CacheQuant)}
              className={settingsInputClass + ' font-mono'}
            >
              {CACHE_QUANT_OPTIONS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.memory.cacheV')}>
            <select
              value={settings.cacheTypeV}
              onChange={(e) => patch('cacheTypeV', e.target.value as CacheQuant)}
              className={settingsInputClass + ' font-mono'}
            >
              {CACHE_QUANT_OPTIONS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Well>
    </>
  )
}

function GenerationPage({
  settings,
  patch
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageIntro>{t('settings.page.genIntro')}</PageIntro>
      <Well>
        <Field label={t('settings.gen.temperature', { n: settings.temperature })}>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.temperature}
            onChange={(e) => patch('temperature', Number(e.target.value))}
            className="w-full"
          />
        </Field>
        <div className="grid sm:grid-cols-2">
          <Field label={t('settings.gen.topK')}>
            <input
              type="number"
              value={settings.topK}
              onChange={(e) => patch('topK', Number(e.target.value))}
              className={settingsInputClass}
            />
          </Field>
          {(
            [
              ['topP', 'topPEnabled', 'settings.gen.topP'],
              ['minP', 'minPEnabled', 'settings.gen.minP'],
              ['repeatPenalty', 'repeatPenaltyEnabled', 'settings.gen.repeatPenalty'],
              ['presencePenalty', 'presencePenaltyEnabled', 'settings.gen.presencePenalty']
            ] as const
          ).map(([valKey, enKey, labelKey]) => (
            <Field key={valKey} label={t(labelKey)}>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings[enKey]}
                  onChange={(e) => patch(enKey, e.target.checked)}
                />
                <input
                  type="number"
                  step={0.01}
                  disabled={!settings[enKey]}
                  value={settings[valKey]}
                  onChange={(e) => patch(valKey, Number(e.target.value))}
                  className={settingsInputClass}
                />
              </div>
            </Field>
          ))}
          <Field label={t('settings.gen.overflow')}>
            <select
              value={settings.contextOverflow}
              onChange={(e) =>
                patch('contextOverflow', e.target.value as AppSettings['contextOverflow'])
              }
              className={settingsInputClass}
            >
              <option value="truncate_middle">{t('settings.gen.overflow.truncate')}</option>
              <option value="context_shift">{t('settings.gen.overflow.shift')}</option>
              <option value="stop">{t('settings.gen.overflow.stop')}</option>
            </select>
          </Field>
        </div>
        <Toggle
          title={t('settings.gen.limitLength')}
          checked={settings.limitResponseLength}
          onChange={(v) => patch('limitResponseLength', v)}
        />
        {settings.limitResponseLength && (
          <Field label={t('settings.gen.maxTokens')}>
            <input
              type="number"
              value={settings.maxTokens}
              onChange={(e) => patch('maxTokens', Number(e.target.value))}
              className={settingsInputClass}
            />
          </Field>
        )}
        <Field label={t('settings.gen.stopStrings')}>
          <input
            value={settings.stopStrings.join(', ')}
            onChange={(e) =>
              patch(
                'stopStrings',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
            className={settingsInputClass + ' font-mono text-xs'}
          />
        </Field>
      </Well>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink-bright">{t('settings.reasoning')}</h2>
        <Well>
          <SettingRow title={t('settings.reasoning.budget')}>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.reasoningBudgetEnabled}
                onChange={(e) => patch('reasoningBudgetEnabled', e.target.checked)}
              />
              <input
                type="number"
                disabled={!settings.reasoningBudgetEnabled}
                value={settings.reasoningBudget}
                onChange={(e) => patch('reasoningBudget', Number(e.target.value))}
                className={settingsInputClass + ' w-28'}
              />
            </div>
          </SettingRow>
          <Field label={t('settings.reasoning.budgetMessage')}>
            <input
              value={settings.reasoningBudgetMessage}
              onChange={(e) => patch('reasoningBudgetMessage', e.target.value)}
              disabled={!settings.reasoningBudgetEnabled}
              className={settingsInputClass}
            />
          </Field>
        </Well>
      </section>
    </>
  )
}

function RuntimePage({
  settings,
  patch,
  runtime,
  setRuntime,
  runtimeBusy,
  setRuntimeBusy,
  busy,
  setMessage
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  runtime: LlamaRuntimeStatus | null
  setRuntime: (r: LlamaRuntimeStatus | null) => void
  runtimeBusy: boolean
  setRuntimeBusy: (v: boolean) => void
  busy: boolean
  setMessage: (m: string | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const selection = settings.llamaRuntimeVariant ?? 'auto'
  const downloadPack: LlamaRuntimePack | null =
    selection === 'auto' ? 'cuda-12.4' : selection
  const downloadPackStatus = runtime?.packs.find((p) => p.variant === downloadPack)
  const usingCustom = Boolean(settings.llamaServerPath?.trim())
  const installedCount = runtime?.packs.filter((p) => p.ready).length ?? 0
  const canDownloadPack = Boolean(downloadPack) && !downloadPackStatus?.ready
  const packUpdateAvailable = Boolean(downloadPackStatus?.updateAvailable)
  // Installed pack can always be force-refreshed; highlight when newer release exists
  const canUpdatePack = Boolean(downloadPackStatus?.ready)

  const refreshRuntime = async (): Promise<void> => {
    try {
      setRuntime(await window.api.llamaRuntime.status())
    } catch {
      setRuntime(null)
    }
  }

  const onSelectionChange = (value: LlamaRuntimeSelection): void => {
    patch('llamaRuntimeVariant', value)
    void refreshRuntime()
  }

  const runEnsure = (force: boolean): void => {
    if (!downloadPack) return
    void (async () => {
      setRuntimeBusy(true)
      setMessage(t('settings.runtime.busy'))
      try {
        const next = await window.api.llamaRuntime.ensure({
          force,
          variant: downloadPack
        })
        setRuntime(next)
        const pack = next.packs.find((p) => p.variant === downloadPack)
        setMessage(
          pack?.ready
            ? t('settings.runtime.packReady', {
                pack: llamaRuntimePackLabel(downloadPack, pack.tag)
              })
            : t('settings.runtime.missing')
        )
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e))
      } finally {
        setRuntimeBusy(false)
      }
    })()
  }

  const selectionLabel =
    selection === 'auto'
      ? t('settings.runtime.selectionAutoHint', {
          pack: llamaRuntimePackLabel(downloadPack!)
        })
      : downloadPackStatus?.ready
        ? llamaRuntimePackLabel(selection, downloadPackStatus.tag)
        : `${llamaRuntimePackLabel(selection)} (${t('settings.runtime.notInstalled')})`
  const packFooter = [
    t('settings.runtime.packsInstalled', { count: installedCount }),
    packUpdateAvailable && runtime?.latestTag
      ? t('settings.runtime.updateAvailable', { tag: runtime.latestTag })
      : downloadPackStatus?.ready
        ? t('settings.runtime.uptoDate')
        : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <PageIntro>{t('settings.runtime.note')}</PageIntro>
      <Well>
        <div className="border-b border-ink-800 px-4 py-2 text-xs font-medium uppercase tracking-wide text-ink-mute">
          {t('settings.runtime.selections')}
        </div>
        <SettingRow title="GGUF" description={selectionLabel}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              value={selection}
              disabled={runtimeBusy || busy}
              onChange={(e) => onSelectionChange(e.target.value as LlamaRuntimeSelection)}
              className={settingsInputClass + ' min-w-[14rem]'}
            >
              <option value="auto">{t('settings.runtime.selectionAuto')}</option>
              {LLAMA_RUNTIME_PACKS.map((pack) => {
                const packStatus = runtime?.packs.find((p) => p.variant === pack)
                const mark = packStatus?.updateAvailable
                  ? ` ↑${runtime?.latestTag ?? ''}`
                  : packStatus?.ready
                    ? ''
                    : ` (${t('settings.runtime.notInstalled')})`
                return (
                  <option key={pack} value={pack}>
                    {llamaRuntimePackLabel(pack, packStatus?.tag)}
                    {mark}
                  </option>
                )
              })}
            </select>
            <button
              type="button"
              disabled={runtimeBusy || busy || !canDownloadPack}
              onClick={() => runEnsure(false)}
              className={canDownloadPack ? settingsPrimaryBtnClass : settingsBtnClass}
              title={
                canDownloadPack
                  ? t('settings.runtime.downloadPackHint', {
                      pack: llamaRuntimePackLabel(downloadPack!)
                    })
                  : t('settings.runtime.downloadDisabled')
              }
            >
              {t('settings.runtime.download')}
            </button>
            <button
              type="button"
              disabled={runtimeBusy || busy || !canUpdatePack}
              onClick={() => runEnsure(true)}
              className={
                canUpdatePack && packUpdateAvailable
                  ? settingsPrimaryBtnClass
                  : settingsBtnClass
              }
              title={
                !canUpdatePack
                  ? t('settings.runtime.downloadDisabled')
                  : packUpdateAvailable && runtime?.latestTag
                    ? t('settings.runtime.updateAvailable', {
                        tag: runtime.latestTag
                      })
                    : t('settings.runtime.updateForceHint')
              }
            >
              {t('settings.runtime.update')}
            </button>
          </div>
        </SettingRow>
        <div className="border-t border-ink-800 px-4 py-2 text-xs text-ink-mute">
          {packFooter}
        </div>
      </Well>
      <Well>
        <SettingRow
          title={t('settings.runtime.status')}
          description={
            usingCustom
              ? t('settings.runtime.customPath')
              : runtime?.ready
                ? t('settings.runtime.activeBinary', {
                    source: runtime.source,
                    tag: runtime.tag
                      ? ` · ${runtime.tag}${runtime.variant ? `/${runtime.variant}` : ''}`
                      : ''
                  })
                : t('settings.runtime.missing')
          }
        >
          <button
            type="button"
            disabled={runtimeBusy}
            onClick={() => void window.api.llamaRuntime.openDir()}
            className={settingsBtnClass}
          >
            {t('settings.runtime.open')}
          </button>
        </SettingRow>
        {runtime?.binaryPath && (
          <div className="px-4 pb-3 font-mono text-[10px] text-ink-mute">{runtime.binaryPath}</div>
        )}
        <Field label={t('settings.paths.llamaServer')}>
          <input
            value={settings.llamaServerPath}
            onChange={(e) => patch('llamaServerPath', e.target.value)}
            className={settingsInputClass + ' font-mono text-xs'}
            placeholder={t('settings.paths.llamaPlaceholder')}
          />
        </Field>
      </Well>
    </>
  )
}

function McpPage({
  settings,
  patch,
  mcpStatus
}: {
  settings: AppSettings
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  mcpStatus: McpServerStatus[]
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <PageIntro>{t('settings.mcp.note')}</PageIntro>
      <Well>
        <div className="p-3">
          <McpServersEditor
            servers={settings.mcpServers ?? []}
            status={mcpStatus}
            onChange={(mcpServers) => patch('mcpServers', mcpServers)}
          />
        </div>
      </Well>
    </>
  )
}

function UpdaterBlock(): React.JSX.Element {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<UpdaterCheckResult | null>(null)

  useEffect(() => {
    void window.api.updater.getStatus().then(setStatus)
    void window.api.getVersion().then((v) => {
      const currentVersion = String(v || '').trim()
      if (!currentVersion) return
      setStatus((prev) =>
        prev?.currentVersion
          ? prev
          : {
              ok: true,
              status: prev?.status ?? 'idle',
              currentVersion,
              message: prev?.message ?? ''
            }
      )
    })
    return window.api.updater.onStatus(setStatus)
  }, [])

  const checking = busy || status?.status === 'checking'
  const downloading = status?.status === 'downloading'
  const available = status?.status === 'available'
  const downloaded = status?.status === 'downloaded'
  const current = status?.currentVersion
  const remote = status?.version

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.updater.check())
    } catch (e) {
      setStatus({
        ok: false,
        status: 'error',
        message: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(false)
    }
  }

  const updateApp = async (): Promise<void> => {
    setBusy(true)
    try {
      if (downloaded) {
        setStatus(await window.api.updater.install())
        return
      }
      setStatus(await window.api.updater.download())
    } catch (e) {
      setStatus({
        ok: false,
        status: 'error',
        message: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingRow
        title={t('settings.updates.current')}
        description={
          (available || downloading || downloaded) && remote
            ? `${t('settings.updates.latest')}: ${remote}`
            : status?.status === 'not-available'
              ? t('settings.updates.uptoDate')
              : status?.message || t('settings.updates.note')
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-ink-bright">{current || '…'}</span>
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking || downloading}
            className={settingsBtnClass}
          >
            {checking ? t('settings.updates.checking') : t('settings.updates.check')}
          </button>
          {(available || downloading || downloaded) && (
            <button
              type="button"
              onClick={() => void updateApp()}
              disabled={busy || downloading || checking}
              className={settingsPrimaryBtnClass}
            >
              {downloading
                ? t('settings.updates.downloading')
                : downloaded
                  ? t('settings.updates.install')
                  : t('settings.updates.update')}
            </button>
          )}
        </div>
      </SettingRow>
      {typeof status?.progress === 'number' && downloading && (
        <div className="px-4 pb-3">
          <div className="h-1.5 overflow-hidden rounded bg-ink-950">
            <div
              className="h-full bg-signal transition-[width] duration-200"
              style={{ width: `${Math.round(status.progress * 100)}%` }}
            />
          </div>
        </div>
      )}
    </>
  )
}

function McpServersEditor({
  servers,
  status,
  onChange
}: {
  servers: McpServerConfig[]
  status: McpServerStatus[]
  onChange: (next: McpServerConfig[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const statusById = new Map(status.map((s) => [s.id, s]))

  const update = (id: string, p: Partial<McpServerConfig>): void => {
    onChange(servers.map((s) => (s.id === id ? { ...s, ...p } : s)))
  }

  const remove = (id: string): void => {
    onChange(servers.filter((s) => s.id !== id))
  }

  const add = (): void => {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `mcp-${Date.now().toString(36)}`
    onChange([
      ...servers,
      {
        id,
        name: t('settings.mcp.newName'),
        enabled: false,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything']
      }
    ])
  }

  return (
    <div className="space-y-3">
      {servers.map((s) => {
        const st = statusById.get(s.id)
        return (
          <div key={s.id} className="space-y-2 rounded-md border border-ink-line bg-ink-950/60 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => update(s.id, { enabled: e.target.checked })}
                title={t('settings.mcp.enabled')}
              />
              <input
                value={s.name}
                onChange={(e) => update(s.id, { name: e.target.value })}
                className={settingsInputClass + ' max-w-[10rem] font-mono text-xs'}
                placeholder={t('settings.mcp.name')}
              />
              <span
                className={
                  'font-mono text-[9px] uppercase ' +
                  (st?.state === 'connected'
                    ? 'text-emerald-400'
                    : st?.state === 'error'
                      ? 'text-rose-400'
                      : 'text-ink-mute')
                }
                title={st?.error}
              >
                {st
                  ? `${st.state}${st.toolCount ? ` · ${t('settings.mcp.tools', { n: st.toolCount })}` : ''}`
                  : s.enabled
                    ? t('settings.mcp.pending')
                    : t('settings.mcp.off')}
              </span>
              <button
                type="button"
                onClick={() => remove(s.id)}
                className="ml-auto font-mono text-[10px] text-ink-mute hover:text-rose-400"
              >
                {t('settings.mcp.remove')}
              </button>
            </div>
            <input
              value={s.command}
              onChange={(e) => update(s.id, { command: e.target.value })}
              className={settingsInputClass + ' font-mono text-xs'}
              placeholder={t('settings.mcp.command')}
            />
            <input
              value={s.args.join(' ')}
              onChange={(e) =>
                update(s.id, {
                  args: e.target.value
                    .split(/\s+/)
                    .map((x) => x.trim())
                    .filter(Boolean)
                })
              }
              className={settingsInputClass + ' font-mono text-xs'}
              placeholder={t('settings.mcp.args')}
            />
          </div>
        )
      })}
      <button
        type="button"
        onClick={add}
        className="rounded-md border border-dashed border-ink-line px-2 py-1 font-mono text-[10px] text-ink-soft hover:border-signal/50 hover:text-signal"
      >
        {t('settings.mcp.add')}
      </button>
    </div>
  )
}

export const SettingsPanel = SettingsView
