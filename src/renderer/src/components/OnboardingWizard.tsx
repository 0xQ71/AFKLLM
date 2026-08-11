import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, DiscoveredModel, UiTheme } from '../../../shared/settings'
import type { UiLanguage } from '../../../shared/i18n'
import type { StoreDownloadTarget } from '../../../shared/hfStore'
import { applyDocumentTheme, UI_THEMES } from '../../../shared/theme'
import { isLikelyVisionGguf, scoreVisionGguf } from '../../../shared/visionDetect'
import { applyMonacoTheme } from '../editor/monacoSetup'
import { useI18n } from '../i18n/I18nProvider'
import { ModelStorePanel } from './ModelStorePanel'

type Step = 'welcome' | 'modes' | 'models' | 'tip'

interface OnboardingWizardProps {
  open: boolean
  onComplete: () => void
  onOpenSettings: (page?: 'agent' | 'model') => void
}

/** @deprecated Prefer OnboardingWizard — kept for App import stability during rename. */
export function ModelWizard(props: OnboardingWizardProps): React.JSX.Element | null {
  return <OnboardingWizard {...props} />
}

export function OnboardingWizard({
  open,
  onComplete,
  onOpenSettings
}: OnboardingWizardProps): React.JSX.Element | null {
  const { t, lang, setLang } = useI18n()
  const [step, setStep] = useState<Step>('welcome')
  const [codingMode, setCodingMode] = useState(true)
  const [imageMode, setImageMode] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [loadAfterSave, setLoadAfterSave] = useState(true)
  const [storeOpen, setStoreOpen] = useState(false)
  const [storeTarget, setStoreTarget] = useState<StoreDownloadTarget>('chat')

  const themeLabelKey: Record<(typeof UI_THEMES)[number], string> = {
    auto: 'settings.theme.auto',
    classic: 'settings.theme.classic',
    light: 'settings.theme.light',
    sepia: 'settings.theme.sepia',
    dark: 'settings.theme.dark',
    'deep-dark': 'settings.theme.deepDark',
    'solarized-dark': 'settings.theme.solarizedDark'
  }

  const refreshModels = async (modelsDir?: string): Promise<void> => {
    if (modelsDir) {
      await window.api.settings.save({ modelsDir })
    }
    const list = await window.api.llm.listModels()
    setModels(list)
    const s = await window.api.settings.get()
    let next = { ...s }
    if (list.length > 0 && (!s.modelPath || !list.some((m) => m.path === s.modelPath))) {
      next = { ...next, modelPath: list[0]!.path }
    }
    // Suggest best VL GGUF when vision path empty (optional — user can clear).
    if (!next.visionModelPath?.trim()) {
      const ranked = [...list]
        .map((m) => ({ m, score: scoreVisionGguf(m.path) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
      if (ranked[0]) {
        next = { ...next, visionModelPath: ranked[0].m.path }
      }
    }
    setSettings(next)
  }

  useEffect(() => {
    if (!open) return
    setStep('welcome')
    setCodingMode(true)
    setImageMode(false)
    setMessage(null)
    setStoreOpen(false)
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      await refreshModels()
    })()
  }, [open])

  const visionModels = useMemo(
    () =>
      models
        .filter((m) => isLikelyVisionGguf(m.path))
        .sort((a, b) => scoreVisionGguf(b.path) - scoreVisionGguf(a.path)),
    [models]
  )

  if (!open || !settings) return null

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setSettings({ ...settings, [key]: value })
  }

  const setTheme = (theme: UiTheme): void => {
    patch('uiTheme', theme)
    applyDocumentTheme(theme)
    applyMonacoTheme(theme)
    void window.api.settings.save({ uiTheme: theme })
  }

  const setLanguage = (next: UiLanguage): void => {
    patch('uiLanguage', next)
    setLang(next)
  }

  const pickDir = async (): Promise<void> => {
    const dir = await window.api.workspace.pickModelsDir()
    if (!dir) return
    setBusy(true)
    setMessage(t('onboarding.scanning'))
    try {
      patch('modelsDir', dir)
      await refreshModels(dir)
      setMessage(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const browseModel = async (): Promise<void> => {
    const path = await window.api.workspace.pickModel()
    if (path) patch('modelPath', path)
  }

  const finish = async (opts?: { openSettingsPage?: 'agent' | 'model' }): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const next = await window.api.settings.save({
        modelsDir: settings.modelsDir,
        modelPath: settings.modelPath,
        visionModelPath: settings.visionModelPath,
        visionMmprojPath: settings.visionMmprojPath,
        imageGenModelPath: settings.imageGenModelPath,
        agentImageGenEnabled: imageMode,
        setupComplete: true
      })
      setSettings(next)
      if (loadAfterSave && next.modelPath?.trim()) {
        setMessage(t('onboarding.startingServer'))
        const status = await window.api.llm.restart()
        setMessage(
          status.state === 'ready'
            ? `${t('onboarding.ready')} · ${status.baseUrl}`
            : `${t('onboarding.saved')} · ${status.state}${status.error ? ` — ${status.error}` : ''}`
        )
      }
      onComplete()
      if (opts?.openSettingsPage) {
        onOpenSettings(opts.openSettingsPage)
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openStore = (target: StoreDownloadTarget): void => {
    setStoreTarget(target)
    setStoreOpen(true)
  }

  const canAdvanceModes = codingMode || imageMode

  return (
    <div className="absolute inset-0 z-[60] flex flex-col bg-ink-950">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-10">
        <div className="mb-8">
          <p className="text-xs font-medium tracking-[0.2em] text-signal uppercase">AFKLLM</p>
          <div className="mt-3 flex gap-2">
            {(['welcome', 'modes', 'models', 'tip'] as Step[]).map((s, i) => (
              <span
                key={s}
                className={
                  'h-1 flex-1 rounded-full ' +
                  (step === s ||
                  (['welcome', 'modes', 'models', 'tip'].indexOf(step) > i)
                    ? 'bg-signal'
                    : 'bg-ink-800')
                }
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {step === 'welcome' && (
            <div className="space-y-4">
              <h1 className="text-3xl font-semibold tracking-tight text-ink-bright">
                {t('onboarding.welcome.title')}
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
                {t('onboarding.welcome.body')}
              </p>
            </div>
          )}

          {step === 'modes' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold text-ink-bright">
                {t('onboarding.modes.title')}
              </h1>
              <p className="text-sm text-ink-mute">{t('onboarding.modes.body')}</p>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-line bg-ink-900/60 p-4">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={codingMode}
                  onChange={(e) => setCodingMode(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-ink-bright">
                    {t('onboarding.modes.coding')}
                  </span>
                  <span className="mt-1 block text-xs text-ink-mute">
                    {t('onboarding.modes.codingHint')}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-line bg-ink-900/60 p-4">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={imageMode}
                  onChange={(e) => setImageMode(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-ink-bright">
                    {t('onboarding.modes.image')}
                  </span>
                  <span className="mt-1 block text-xs text-ink-mute">
                    {t('onboarding.modes.imageHint')}
                  </span>
                </span>
              </label>
              {!canAdvanceModes && (
                <p className="text-xs text-amber-400/90">{t('onboarding.modes.required')}</p>
              )}
            </div>
          )}

          {step === 'models' && (
            <div className="space-y-5">
              <h1 className="text-2xl font-semibold text-ink-bright">
                {t('onboarding.models.title')}
              </h1>
              <p className="text-sm text-ink-mute">{t('onboarding.models.body')}</p>

              {codingMode && (
                <div className="space-y-3 rounded-lg border border-ink-line bg-ink-900/50 p-4">
                  <h2 className="text-sm font-medium text-ink-bright">
                    {t('onboarding.models.chatTitle')}
                  </h2>
                  <label className="block space-y-1">
                    <span className="text-xs text-ink-mute">{t('onboarding.models.dir')}</span>
                    <div className="flex gap-2">
                      <input
                        value={settings.modelsDir}
                        onChange={(e) => patch('modelsDir', e.target.value)}
                        className="onb-input font-mono text-xs"
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => void pickDir()}
                        disabled={busy}
                        className="shrink-0 rounded border border-ink-line px-2 text-xs hover:bg-ink-800 disabled:opacity-50"
                      >
                        {t('onboarding.browse')}
                      </button>
                    </div>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-ink-mute">{t('onboarding.models.gguf')}</span>
                    <div className="flex gap-2">
                      <select
                        value={settings.modelPath}
                        onChange={(e) => patch('modelPath', e.target.value)}
                        className="onb-input font-mono text-xs"
                        disabled={busy}
                      >
                        {models.length === 0 && (
                          <option value={settings.modelPath}>
                            {settings.modelPath || t('onboarding.models.noneFound')}
                          </option>
                        )}
                        {models.map((m) => (
                          <option key={m.path} value={m.path}>
                            {m.id} ({(m.sizeBytes / 1e9).toFixed(1)} GB)
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void browseModel()}
                        disabled={busy}
                        className="shrink-0 rounded border border-ink-line px-2 text-xs hover:bg-ink-800 disabled:opacity-50"
                      >
                        {t('onboarding.file')}
                      </button>
                    </div>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openStore('chat')}
                      className="rounded border border-signal/40 px-3 py-1.5 text-xs text-signal hover:bg-ink-800"
                    >
                      {t('onboarding.models.openStore')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshModels(settings.modelsDir)}
                      disabled={busy}
                      className="rounded border border-ink-line px-3 py-1.5 text-xs text-ink-soft hover:bg-ink-800 disabled:opacity-50"
                    >
                      {t('onboarding.rescan')}
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-ink-soft">
                    <input
                      type="checkbox"
                      checked={loadAfterSave}
                      onChange={(e) => setLoadAfterSave(e.target.checked)}
                      disabled={busy || !settings.modelPath?.trim()}
                    />
                    <span className="text-xs">{t('onboarding.models.loadAfter')}</span>
                  </label>
                </div>
              )}

              {imageMode && (
                <div className="space-y-3 rounded-lg border border-ink-line bg-ink-900/50 p-4">
                  <h2 className="text-sm font-medium text-ink-bright">
                    {t('onboarding.models.imageTitle')}
                  </h2>
                  <p className="text-xs leading-relaxed text-ink-mute">
                    {t('onboarding.models.imageStack')}
                  </p>
                  <button
                    type="button"
                    onClick={() => openStore('imageGen')}
                    className="rounded border border-signal/40 px-3 py-1.5 text-xs text-signal hover:bg-ink-800"
                  >
                    {t('onboarding.models.openImageStore')}
                  </button>
                </div>
              )}

              <div className="space-y-3 rounded-lg border border-ink-line bg-ink-900/50 p-4">
                <h2 className="text-sm font-medium text-ink-bright">
                  {t('onboarding.models.visionTitle')}
                </h2>
                <p className="text-xs leading-relaxed text-ink-mute">
                  {t('onboarding.models.visionBody')}
                </p>
                <label className="block space-y-1">
                  <span className="text-xs text-ink-mute">
                    {t('onboarding.models.visionGguf')}
                  </span>
                  <select
                    value={settings.visionModelPath}
                    onChange={(e) => patch('visionModelPath', e.target.value)}
                    className="onb-input font-mono text-xs"
                    disabled={busy}
                  >
                    <option value="">{t('onboarding.models.visionSkip')}</option>
                    {(visionModels.length > 0 ? visionModels : models).map((m) => (
                      <option key={m.path} value={m.path}>
                        {m.id} ({(m.sizeBytes / 1e9).toFixed(1)} GB)
                      </option>
                    ))}
                    {settings.visionModelPath &&
                      !models.some((m) => m.path === settings.visionModelPath) && (
                        <option value={settings.visionModelPath}>
                          {settings.visionModelPath.split(/[/\\]/).pop()}
                        </option>
                      )}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => openStore('vision')}
                    className="rounded border border-signal/40 px-3 py-1.5 text-xs text-signal hover:bg-ink-800"
                  >
                    {t('onboarding.models.openVisionStore')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      patch('visionModelPath', '')
                      patch('visionMmprojPath', '')
                    }}
                    disabled={busy || !settings.visionModelPath}
                    className="rounded border border-ink-line px-3 py-1.5 text-xs text-ink-soft hover:bg-ink-800 disabled:opacity-50"
                  >
                    {t('onboarding.models.visionClear')}
                  </button>
                </div>
              </div>

              {message && (
                <p className="font-mono text-[11px] text-ink-mute">{message}</p>
              )}
            </div>
          )}

          {step === 'tip' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold text-ink-bright">
                {t('onboarding.tip.title')}
              </h1>
              <p className="text-sm leading-relaxed text-ink-soft">{t('onboarding.tip.body')}</p>
              <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-mute">
                <li>{t('onboarding.tip.step1')}</li>
                <li>{t('onboarding.tip.step2')}</li>
                <li>{t('onboarding.tip.step3')}</li>
              </ol>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-ink-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={settings.uiTheme}
              onChange={(e) => setTheme(e.target.value as UiTheme)}
              className="onb-input !w-auto min-w-[9rem] py-1.5 text-xs"
              aria-label={t('settings.theme')}
              title={t('settings.theme')}
            >
              {UI_THEMES.map((id) => (
                <option key={id} value={id}>
                  {t(themeLabelKey[id] as 'settings.theme.auto')}
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              {(
                [
                  ['en', 'settings.language.en'],
                  ['ru', 'settings.language.ru']
                ] as const
              ).map(([id, labelKey]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setLanguage(id)}
                  className={
                    'rounded-md border px-2.5 py-1.5 text-xs ' +
                    (lang === id
                      ? 'border-signal bg-signal/15 text-ink-bright'
                      : 'border-ink-line text-ink-mute hover:bg-ink-800')
                  }
                  title={t(labelKey)}
                >
                  {id.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
          {step === 'welcome' && (
            <button
              type="button"
              onClick={() => setStep('modes')}
              className="rounded bg-signal px-4 py-2 text-sm font-medium text-ink-950 hover:opacity-90"
            >
              {t('onboarding.next')}
            </button>
          )}

          {step === 'modes' && (
            <>
              <button
                type="button"
                onClick={() => setStep('welcome')}
                className="rounded border border-ink-line px-3 py-2 text-sm text-ink-soft hover:bg-ink-800"
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                disabled={!canAdvanceModes}
                onClick={() => setStep('models')}
                className="rounded bg-signal px-4 py-2 text-sm font-medium text-ink-950 hover:opacity-90 disabled:opacity-40"
              >
                {t('onboarding.next')}
              </button>
            </>
          )}

          {step === 'models' && (
            <>
              <button
                type="button"
                onClick={() => setStep('modes')}
                disabled={busy}
                className="rounded border border-ink-line px-3 py-2 text-sm text-ink-soft hover:bg-ink-800 disabled:opacity-50"
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                onClick={() => setStep('tip')}
                disabled={busy}
                className="rounded border border-ink-line px-3 py-2 text-sm text-ink-soft hover:bg-ink-800 disabled:opacity-50"
              >
                {t('onboarding.later')}
              </button>
              <button
                type="button"
                onClick={() => void finish()}
                disabled={busy}
                className="rounded bg-signal px-4 py-2 text-sm font-medium text-ink-950 hover:opacity-90 disabled:opacity-50"
              >
                {busy ? t('onboarding.working') : t('onboarding.finish')}
              </button>
            </>
          )}

          {step === 'tip' && (
            <>
              <button
                type="button"
                onClick={() => setStep('models')}
                disabled={busy}
                className="rounded border border-ink-line px-3 py-2 text-sm text-ink-soft hover:bg-ink-800 disabled:opacity-50"
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                onClick={() => void finish({ openSettingsPage: 'model' })}
                disabled={busy}
                className="rounded border border-signal/40 px-3 py-2 text-sm text-signal hover:bg-ink-800 disabled:opacity-50"
              >
                {t('onboarding.tip.openSettings')}
              </button>
              <button
                type="button"
                onClick={() => void finish()}
                disabled={busy}
                className="rounded bg-signal px-4 py-2 text-sm font-medium text-ink-950 hover:opacity-90 disabled:opacity-50"
              >
                {busy ? t('onboarding.working') : t('onboarding.tip.done')}
              </button>
            </>
          )}
          </div>
        </div>
      </div>

      <ModelStorePanel
        open={storeOpen}
        target={storeTarget}
        onClose={() => {
          setStoreOpen(false)
          void refreshModels(settings.modelsDir)
        }}
        onDownloaded={(localPath) => {
          if (storeTarget === 'chat') {
            patch('modelPath', localPath)
          } else if (storeTarget === 'vision') {
            patch('visionModelPath', localPath)
            void window.api.settings.save({ visionModelPath: localPath })
          } else if (storeTarget === 'imageGen') {
            patch('imageGenModelPath', localPath)
            void window.api.settings.save({ imageGenModelPath: localPath })
          }
          void refreshModels(settings.modelsDir)
        }}
      />

      <style>{`
        .onb-input {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid var(--afk-line);
          background: var(--afk-bg);
          padding: 0.4rem 0.6rem;
          color: var(--afk-bright);
          outline: none;
        }
        .onb-input:focus { border-color: var(--afk-signal); }
        .onb-input:disabled { opacity: 0.45; }
      `}</style>
    </div>
  )
}
