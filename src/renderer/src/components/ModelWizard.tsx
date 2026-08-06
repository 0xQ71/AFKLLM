import { useEffect, useState } from 'react'
import type { AppSettings, DiscoveredModel } from '../../../shared/settings'

interface ModelWizardProps {
  open: boolean
  onComplete: () => void
}

export function ModelWizard({ open, onComplete }: ModelWizardProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [loadAfterSave, setLoadAfterSave] = useState(true)

  const refreshModels = async (modelsDir?: string): Promise<void> => {
    if (modelsDir) {
      await window.api.settings.save({ modelsDir })
    }
    const list = await window.api.llm.listModels()
    setModels(list)
    const s = await window.api.settings.get()
    setSettings(s)
    if (list.length > 0 && (!s.modelPath || !list.some((m) => m.path === s.modelPath))) {
      setSettings({ ...s, modelPath: list[0]!.path })
    }
  }

  useEffect(() => {
    if (!open) return
    setMessage(null)
    void (async () => {
      const s = await window.api.settings.get()
      setSettings(s)
      await refreshModels()
    })()
  }, [open])

  if (!open || !settings) return null

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setSettings({ ...settings, [key]: value })
  }

  const pickDir = async (): Promise<void> => {
    const dir = await window.api.workspace.pickModelsDir()
    if (!dir) return
    setBusy(true)
    setMessage('Scanning…')
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

  const finish = async (): Promise<void> => {
    if (!settings.modelPath?.trim()) {
      setMessage('Select a .gguf model to continue.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const next = await window.api.settings.save({
        modelsDir: settings.modelsDir,
        modelPath: settings.modelPath,
        setupComplete: true
      })
      setSettings(next)
      if (loadAfterSave) {
        setMessage('Starting llama-server…')
        const status = await window.api.llm.restart()
        setMessage(
          status.state === 'ready'
            ? `Ready · ${status.baseUrl}`
            : `Saved · ${status.state}${status.error ? ` — ${status.error}` : ''}`
        )
      }
      onComplete()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-ink-line bg-ink-900 shadow-2xl">
        <div className="border-b border-ink-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-bright">Welcome to AFKLLM</h2>
          <p className="mt-1 text-xs text-ink-mute">
            Choose a folder with GGUF models, pick one, then load it into llama-server.
          </p>
        </div>

        <div className="space-y-4 p-4 text-sm">
          <label className="block space-y-1">
            <span className="text-xs text-ink-mute">Models directory</span>
            <div className="flex gap-2">
              <input
                value={settings.modelsDir}
                onChange={(e) => patch('modelsDir', e.target.value)}
                className="input font-mono text-xs"
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => void pickDir()}
                disabled={busy}
                className="shrink-0 rounded border border-ink-line px-2 hover:bg-ink-800 disabled:opacity-50"
              >
                Browse…
              </button>
            </div>
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-ink-mute">Model (.gguf)</span>
            <div className="flex gap-2">
              <select
                value={settings.modelPath}
                onChange={(e) => patch('modelPath', e.target.value)}
                className="input font-mono text-xs"
                disabled={busy}
              >
                {models.length === 0 && (
                  <option value={settings.modelPath}>
                    {settings.modelPath || 'No models found — browse…'}
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
                className="shrink-0 rounded border border-ink-line px-2 hover:bg-ink-800 disabled:opacity-50"
              >
                File…
              </button>
            </div>
          </label>

          <label className="flex items-center gap-2 text-ink-soft">
            <input
              type="checkbox"
              checked={loadAfterSave}
              onChange={(e) => setLoadAfterSave(e.target.checked)}
              disabled={busy}
            />
            <span className="text-xs">Load model after save</span>
          </label>

          {message && (
            <p className="font-mono text-[11px] text-ink-mute">{message}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-line px-4 py-3">
          <button
            type="button"
            onClick={() => void refreshModels(settings.modelsDir)}
            disabled={busy}
            className="rounded border border-ink-line px-3 py-1.5 text-xs text-ink-soft hover:bg-ink-800 disabled:opacity-50"
          >
            Rescan
          </button>
          <button
            type="button"
            onClick={() => void finish()}
            disabled={busy || !settings.modelPath?.trim()}
            className="rounded bg-signal px-3 py-1.5 text-xs font-medium text-ink-950 hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Continue'}
          </button>
        </div>

        <style>{`
          .input {
            width: 100%;
            border-radius: 0.375rem;
            border: 1px solid var(--afk-line);
            background: var(--afk-bg);
            padding: 0.4rem 0.6rem;
            color: var(--afk-bright);
            outline: none;
          }
          .input:focus { border-color: var(--afk-signal); }
          .input:disabled { opacity: 0.45; }
        `}</style>
      </div>
    </div>
  )
}
