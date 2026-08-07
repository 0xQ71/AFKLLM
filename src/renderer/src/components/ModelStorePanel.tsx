import { useEffect, useMemo, useState } from 'react'
import {
  HF_IMAGE_GEN_CLIP_G_MODELS,
  HF_IMAGE_GEN_CLIP_L_MODELS,
  HF_IMAGE_GEN_LLM_MODELS,
  HF_IMAGE_GEN_RECOMMENDED_MODELS,
  HF_IMAGE_GEN_T5_MODELS,
  HF_IMAGE_GEN_VAE_MODELS,
  HF_RECOMMENDED_MODELS,
  HF_VISION_RECOMMENDED_MODELS,
  isImageGenStoreTarget
} from '../../../shared/hfStore'
import type {
  GpuInfo,
  HfDownloadProgress,
  HfModelDetail,
  HfModelListItem,
  HfRecommendFit,
  StoreDownloadTarget
} from '../../../shared/hfStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { MarkdownBody } from './MarkdownBody'
import { ModelBrandIcon } from './ModelBrandIcon'
import type { ModelBrand } from '../../../shared/modelBrand'

interface ModelStorePanelProps {
  open: boolean
  onClose: () => void
  /** Called after a successful download with absolute path */
  onDownloaded: (localPath: string) => void
  /** Which settings field this download fills */
  target?: StoreDownloadTarget
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function formatSpeed(bps: number | undefined): string {
  if (!bps || bps <= 0) return '—'
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(2)} MB/s`
}

function formatEta(sec: number | null | undefined): string {
  if (sec == null || sec < 0 || !Number.isFinite(sec)) return '—'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function allStaffCatalogs() {
  return [
    ...HF_RECOMMENDED_MODELS,
    ...HF_VISION_RECOMMENDED_MODELS,
    ...HF_IMAGE_GEN_RECOMMENDED_MODELS,
    ...HF_IMAGE_GEN_VAE_MODELS,
    ...HF_IMAGE_GEN_CLIP_L_MODELS,
    ...HF_IMAGE_GEN_CLIP_G_MODELS,
    ...HF_IMAGE_GEN_T5_MODELS,
    ...HF_IMAGE_GEN_LLM_MODELS
  ]
}

function repoTitle(id: string, preferredFile?: string): string {
  const catalogs = allStaffCatalogs()
  const rec =
    (preferredFile
      ? catalogs.find((r) => r.repoId === id && r.preferredFile === preferredFile)
      : undefined) ?? catalogs.find((r) => r.repoId === id)
  if (rec) return rec.title
  const name = id.split('/').pop() ?? id
  return name.replace(/-GGUF$/i, '').replace(/_/g, ' ')
}

function storeSubtitleKey(target: StoreDownloadTarget): MessageKey {
  switch (target) {
    case 'vision':
      return 'store.subtitleVision'
    case 'mmproj':
      return 'store.subtitleMmproj'
    case 'imageGen':
      return 'store.subtitleImageGen'
    case 'imageGenVae':
      return 'store.subtitleImageGenVae'
    case 'imageGenClipL':
      return 'store.subtitleImageGenClipL'
    case 'imageGenClipG':
      return 'store.subtitleImageGenClipG'
    case 'imageGenT5':
      return 'store.subtitleImageGenT5'
    case 'imageGenLlm':
      return 'store.subtitleImageGenLlm'
    default:
      return 'store.subtitle'
  }
}

function fitBadgeClass(fit?: HfRecommendFit): string {
  switch (fit) {
    case 'ideal':
      return 'bg-signal/20 text-signal'
    case 'comfortable':
      return 'bg-signal/15 text-signal'
    case 'tight':
      return 'bg-warn-muted text-warn'
    case 'heavy':
      return 'bg-danger-muted text-danger'
    default:
      return 'bg-ink-800 text-ink-mute'
  }
}

function fitLabelKey(fit: HfRecommendFit): MessageKey {
  return `store.fit.${fit}` as MessageKey
}

function asBrand(v?: string | null): ModelBrand | undefined {
  if (!v) return undefined
  return v as ModelBrand
}

function DownloadsPanel({
  open,
  onClose,
  downloads,
  onRefresh
}: {
  open: boolean
  onClose: () => void
  downloads: HfDownloadProgress[]
  onRefresh: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const q = filter.trim().toLowerCase()
  const filtered = q
    ? downloads.filter(
        (d) =>
          d.repoId.toLowerCase().includes(q) || d.filename.toLowerCase().includes(q)
      )
    : downloads

  const ongoing = filtered.filter(
    (d) => d.status === 'downloading' || d.status === 'paused'
  )
  const completed = filtered.filter(
    (d) => d.status === 'done' || d.status === 'error' || d.status === 'cancelled'
  )

  return (
    <div className="absolute inset-0 z-[70] flex items-start justify-end bg-ink-950/70 p-4 text-ink-bright backdrop-blur-[2px]">
      <div
        className="mt-10 flex max-h-[min(560px,80vh)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-ink-line bg-ink-950 text-ink-bright shadow-2xl"
        role="dialog"
        aria-label={t('store.downloads')}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink-bright">{t('store.downloads')}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
          >
            ×
          </button>
        </div>

        <div className="shrink-0 border-b border-ink-line/60 px-3 py-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('store.downloadsFilter')}
            className="input w-full text-[12px]"
            autoFocus
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-ink-mute">
            {t('store.ongoing')}
          </p>
          {ongoing.length === 0 ? (
            <p className="mb-3 px-1 text-[11px] text-ink-mute">{t('store.downloadsEmpty')}</p>
          ) : (
            <ul className="mb-4 space-y-2">
              {ongoing.map((d) => (
                <li
                  key={d.id}
                  className="rounded-lg border border-ink-line/50 bg-ink-950/40 px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <ModelBrandIcon
                      repoId={d.repoId}
                      size={32}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-ink-bright">
                        {d.repoId}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-800">
                          <div
                            className={
                              'h-full rounded-full ' +
                              (d.status === 'paused' ? 'bg-warn' : 'bg-signal')
                            }
                            style={{ width: `${Math.round(d.fraction * 100)}%` }}
                          />
                        </div>
                        {d.status === 'downloading' ? (
                          <button
                            type="button"
                            title={t('store.pause')}
                            onClick={() => void window.api.hf.pauseDownload(d.id)}
                            className="rounded p-1 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                          >
                            <PauseIcon />
                          </button>
                        ) : (
                          <button
                            type="button"
                            title={t('store.resume')}
                            onClick={() =>
                              void window.api.hf.resumeDownload(d.id).then(onRefresh)
                            }
                            className="rounded p-1 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                          >
                            <PlayIcon />
                          </button>
                        )}
                        <button
                          type="button"
                          title={t('store.cancel')}
                          onClick={() => void window.api.hf.cancelDownload(d.id)}
                          className="rounded p-1 text-ink-mute hover:bg-ink-800 hover:text-danger"
                        >
                          <CloseIcon />
                        </button>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-ink-mute">
                        {d.status === 'paused'
                          ? t('store.pausedMeta', {
                              received: formatBytes(d.bytesReceived),
                              total: formatBytes(d.bytesTotal)
                            })
                          : t('store.progressMeta', {
                              received: formatBytes(d.bytesReceived),
                              total: formatBytes(d.bytesTotal),
                              speed: formatSpeed(d.bytesPerSecond),
                              eta: formatEta(d.etaSeconds)
                            })}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-ink-mute">
              {t('store.completed')}
            </p>
            {completed.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  void window.api.hf.clearCompletedDownloads().then(onRefresh)
                }
                className="text-[11px] text-ink-mute hover:text-ink-bright"
              >
                {t('store.clear')}
              </button>
            ) : null}
          </div>
          {completed.length === 0 ? (
            <p className="px-1 text-[11px] text-ink-mute">{t('store.downloadsEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {completed.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-ink-800/60"
                >
                  <ModelBrandIcon repoId={d.repoId} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-ink-bright">
                      {d.repoId}
                    </p>
                    <p className="text-[10px] text-ink-mute">
                      {d.status === 'done'
                        ? t('store.completedMeta', {
                            size: formatBytes(d.bytesTotal || d.bytesReceived)
                          })
                        : d.status === 'error'
                          ? d.error || t('store.error')
                          : t('store.cancelled')}
                    </p>
                  </div>
                  {d.status === 'done' && d.destPath ? (
                    <button
                      type="button"
                      title={t('store.showInFolder')}
                      onClick={() => void window.api.hf.showInFolder(d.destPath!)}
                      className="rounded p-1.5 text-ink-mute hover:bg-ink-800 hover:text-ink-bright"
                    >
                      <FolderIcon />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-ink-line px-4 py-2.5 text-right">
          <button
            type="button"
            onClick={() => void window.api.hf.openModelsDir()}
            className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft hover:text-ink-bright"
          >
            <FolderIcon />
            {t('store.openDir')}
          </button>
        </div>
      </div>
    </div>
  )
}

function PauseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3" y="2" width="3.5" height="12" rx="0.5" />
      <rect x="9.5" y="2" width="3.5" height="12" rx="0.5" />
    </svg>
  )
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3.2 3.2l9.6 9.6M12.8 3.2L3.2 12.8" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M1.5 3.5h5l1.5 1.5H14.5v8H1.5z" opacity="0.9" />
    </svg>
  )
}

export function ModelStorePanel({
  open,
  onClose,
  onDownloaded,
  target = 'chat'
}: ModelStorePanelProps): React.JSX.Element | null {
  const { t, lang } = useI18n()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [list, setList] = useState<HfModelListItem[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preferredHint, setPreferredHint] = useState<string | null>(null)
  const [detail, setDetail] = useState<HfModelDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectionTick, setSelectionTick] = useState(0)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [readmeTranslating, setReadmeTranslating] = useState(false)
  const [filePath, setFilePath] = useState('')
  const [progress, setProgress] = useState<HfDownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [downloads, setDownloads] = useState<HfDownloadProgress[]>([])
  const [gpu, setGpu] = useState<GpuInfo | null>(null)

  const refreshDownloads = (): void => {
    void window.api.hf.listDownloads().then(setDownloads).catch(() => setDownloads([]))
  }

  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebounced('')
    setSelectedId(null)
    setPreferredHint(null)
    setDetail(null)
    setDetailError(null)
    setFilePath('')
  }, [open, target])

  useEffect(() => {
    if (!open) return
    const tmr = setTimeout(() => setDebounced(query.trim()), 280)
    return () => clearTimeout(tmr)
  }, [query, open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingList(true)
    setListError(null)
    const load = async (): Promise<void> => {
      try {
        if (!debounced) {
          const home = await window.api.hf.home(target)
          if (cancelled) return
          setGpu(home.gpu)
          setList(home.items)
          if (!selectedId && home.items[0]) {
            setSelectedId(home.items[0].id)
            setPreferredHint(home.items[0].preferredFile ?? null)
          }
        } else {
          const items = await window.api.hf.search({
            query: debounced,
            limit: 30,
            target
          })
          if (cancelled) return
          setList(items)
          if (!selectedId && items[0]) {
            setSelectedId(items[0].id)
            setPreferredHint(items[0].preferredFile ?? null)
          }
        }
      } catch (e) {
        if (cancelled) return
        setListError(e instanceof Error ? e.message : String(e))
        setList([])
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedId intentionally omitted
  }, [debounced, open, lang, target])

  useEffect(() => {
    if (!open || !selectedId) {
      setDetail(null)
      setDetailError(null)
      setReadmeTranslating(false)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setDetailError(null)
    setReadmeTranslating(false)
    void window.api.hf
      .model(selectedId, preferredHint ?? undefined, target)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setDetailError(null)
        setReadmeTranslating(lang === 'ru' && Boolean(d.readmeMarkdown?.trim()))
        const preferred =
          preferredHint && d.ggufFiles.some((f) => f.path === preferredHint)
            ? preferredHint
            : d.preferredFile && d.ggufFiles.some((f) => f.path === d.preferredFile)
              ? d.preferredFile
              : d.ggufFiles[0]?.path
        setFilePath(preferred ?? '')
      })
      .catch((e) => {
        if (!cancelled) {
          setDetail(null)
          setFilePath('')
          setDetailError(e instanceof Error ? e.message : String(e))
          setReadmeTranslating(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, preferredHint, open, lang, target, selectionTick])

  useEffect(() => {
    if (!open || lang !== 'ru') return
    return window.api.hf.onReadmeLocalized(({ id, readmeMarkdown, done }) => {
      if (readmeMarkdown) {
        setDetail((prev) => {
          if (!prev || prev.id !== id) return prev
          return { ...prev, readmeMarkdown }
        })
      }
      if (done && selectedId === id) setReadmeTranslating(false)
    })
  }, [open, lang, selectedId])

  /** Drop cancelled/done/error banners when leaving that model or reopening the store. */
  useEffect(() => {
    setProgress((p) => {
      if (!p) return null
      if (p.status === 'downloading' || p.status === 'paused') return p
      return null
    })
  }, [selectedId, preferredHint, filePath, open])

  useEffect(() => {
    if (!open) return
    refreshDownloads()
    return window.api.hf.onDownloadProgress((p) => {
      if (p.id === '__cleared__') {
        refreshDownloads()
        setProgress((cur) => {
          if (!cur) return null
          if (cur.status === 'downloading' || cur.status === 'paused') return cur
          return null
        })
        return
      }
      setProgress(p)
      setDownloads((prev) => {
        const i = prev.findIndex((x) => x.id === p.id)
        if (i >= 0) {
          const next = [...prev]
          next[i] = p
          return next
        }
        return [p, ...prev]
      })
      if (p.status === 'done' && p.destPath) onDownloaded(p.destPath)
      if (p.status !== 'downloading') setDownloading(false)
    })
  }, [open, onDownloaded])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !downloading && !downloadsOpen) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, downloading, downloadsOpen])

  const selectedFile = useMemo(
    () => detail?.ggufFiles.find((f) => f.path === filePath) ?? null,
    [detail, filePath]
  )
  const selectedInstalled = Boolean(selectedFile?.installed)

  const fileLeaf = (name: string): string =>
    name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? name.toLowerCase()

  /** Progress UI only for the model/quant currently open in the store. */
  const visibleProgress = useMemo(() => {
    if (!progress || !detail) return null
    if (progress.repoId !== detail.id) return null
    if (progress.filename && filePath && fileLeaf(progress.filename) !== fileLeaf(filePath)) {
      return null
    }
    return progress
  }, [progress, detail, filePath])

  const activeCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'paused'
  ).length

  const startDownload = async (): Promise<void> => {
    if (!detail || !filePath || downloading || selectedInstalled) return
    setDownloading(true)
    setProgress(null)
    try {
      const result = await window.api.hf.download({
        repoId: detail.id,
        filename: filePath
      })
      setProgress(result)
      if (result.status === 'done' && result.destPath) {
        onDownloaded(result.destPath)
      }
    } catch (e) {
      setProgress({
        id: 'err',
        repoId: detail.id,
        filename: filePath,
        bytesReceived: 0,
        bytesTotal: 0,
        fraction: 0,
        status: 'error',
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setDownloading(false)
      refreshDownloads()
    }
  }

  if (!open) return null

  const listBlurb = (m: HfModelListItem): string | undefined => {
    if (m.description) return m.description
    const catalogs = allStaffCatalogs()
    const rec = catalogs.find(
      (r) =>
        r.repoId === m.id &&
        (!m.preferredFile || r.preferredFile === m.preferredFile)
    )
    if (!rec) return undefined
    return lang === 'ru' ? rec.descriptionRu : rec.description
  }

  return (
    <div className="absolute inset-0 z-[60] flex items-stretch justify-center bg-ink-950/70 p-3 text-ink-bright backdrop-blur-sm">
      <div className="relative flex h-full max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-ink-line bg-ink-950 text-ink-bright shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-ink-line bg-ink-900 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
            className="rounded px-2 py-1 text-ink-mute hover:bg-ink-800 hover:text-ink-bright disabled:opacity-40"
          >
            ←
          </button>
          <h2 className="text-sm font-semibold text-ink-bright">{t('store.title')}</h2>
          <span className="text-[11px] text-ink-mute">
            {t(storeSubtitleKey(target))}
          </span>
          <button
            type="button"
            onClick={() => {
              refreshDownloads()
              setDownloadsOpen(true)
            }}
            className="ml-auto relative inline-flex items-center gap-1.5 rounded border border-ink-line px-2.5 py-1 text-[12px] text-ink-soft hover:bg-ink-800 hover:text-ink-bright"
          >
            <DownloadTrayIcon />
            {t('store.downloads')}
            {activeCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 text-[9px] font-semibold text-signal-on">
                {activeCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
            className="rounded px-2 py-1 text-ink-mute hover:bg-ink-800 hover:text-ink-bright disabled:opacity-40"
          >
            {t('settings.close')}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[320px] shrink-0 flex-col border-r border-ink-line bg-ink-900">
            <div className="border-b border-ink-line/60 p-2.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('store.searchPlaceholder')}
                className="input w-full font-mono text-[12px]"
                autoFocus
              />
              {!debounced ? (
                <div className="mt-2 rounded-md border border-ink-line/50 bg-ink-900/80 px-2.5 py-2">
                  {gpu ? (
                    <p className="text-[11px] leading-snug text-ink-soft">
                      {t('store.gpuBanner', {
                        name: gpu.name.replace(/^NVIDIA\s+/i, ''),
                        vram: String(gpu.vramGb)
                      })}
                    </p>
                  ) : (
                    <p className="text-[11px] leading-snug text-ink-mute">
                      {t('store.gpuUnknown')}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="mt-2 flex items-center justify-between px-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-ink-mute">
                  {debounced
                    ? t('store.results')
                    : gpu
                      ? t('store.forYourGpu')
                      : t('store.staffPicks')}
                </span>
                {loadingList ? (
                  <span className="text-[10px] text-ink-mute">…</span>
                ) : null}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listError ? (
                <p className="px-3 py-2 text-[11px] text-danger">{listError}</p>
              ) : null}
              {list.map((m, idx) => {
                const active =
                  m.id === selectedId &&
                  (m.preferredFile ?? null) === (preferredHint ?? null)
                const isHw = m.recommended && m.fit
                const isPopular = m.recommendReason === 'popular' && !isHw
                const blurb = listBlurb(m)
                const title = repoTitle(m.id, m.preferredFile)
                return (
                  <button
                    key={`${target}::${m.id}::${m.preferredFile ?? ''}::${idx}`}
                    type="button"
                    onClick={() => {
                      setSelectedId(m.id)
                      setPreferredHint(m.preferredFile ?? null)
                      setSelectionTick((n) => n + 1)
                      setDetailError(null)
                    }}
                    className={
                      'flex w-full gap-2.5 border-b border-ink-line/30 px-3 py-2.5 text-left ' +
                      (active
                        ? 'bg-signal/15 text-ink-bright'
                        : 'text-ink-soft hover:bg-ink-800/80')
                    }
                  >
                    <ModelBrandIcon
                      repoId={m.id}
                      brand={asBrand(m.brand)}
                      size={40}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="truncate text-[13px] font-medium text-ink-bright">
                          {title}
                        </span>
                        {active ? (
                          <span className="text-[12px] text-signal">✓</span>
                        ) : null}
                        {m.installed ? (
                          <span className="shrink-0 rounded bg-signal/15 px-1 py-px text-[9px] text-signal">
                            {t('store.installed')}
                          </span>
                        ) : null}
                        {isHw && m.fit ? (
                          <span
                            className={
                              'shrink-0 rounded px-1 py-px text-[9px] ' +
                              fitBadgeClass(m.fit)
                            }
                          >
                            {t(fitLabelKey(m.fit))}
                          </span>
                        ) : null}
                        {isPopular ? (
                          <span className="shrink-0 rounded bg-ink-800 px-1 py-px text-[9px] text-ink-mute">
                            {t('store.popular')}
                          </span>
                        ) : null}
                      </div>
                      {blurb ? (
                        <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-soft">
                          {blurb}
                        </span>
                      ) : (
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-mute">
                          {m.id}
                        </span>
                      )}
                      <span className="mt-1 block text-[10px] text-ink-mute">
                        {m.sizeGb
                          ? `~${m.sizeGb.toFixed(1)} GB`
                          : `↓ ${formatCount(m.downloads)} · ★ ${formatCount(m.likes)}`}
                        {m.sizeGb && m.downloads > 0
                          ? ` · ↓ ${formatCount(m.downloads)}`
                          : ''}
                      </span>
                    </div>
                  </button>
                )
              })}
              {!loadingList && list.length === 0 && !listError ? (
                <p className="px-3 py-4 text-[11px] text-ink-mute">{t('store.empty')}</p>
              ) : null}
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {loadingDetail && !detail ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-ink-mute">
                {t('store.loading')}
              </div>
            ) : detailError && !detail ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-[12px] text-danger">{detailError}</p>
                <p className="text-[11px] text-ink-mute">{t('store.pickModelRetry')}</p>
              </div>
            ) : !detail ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-ink-mute">
                {t('store.pickModel')}
              </div>
            ) : (
              <>
                <div className="shrink-0 space-y-3 border-b border-ink-line px-5 py-4">
                  <div className="flex items-start gap-3">
                    <ModelBrandIcon
                      repoId={detail.id}
                      brand={asBrand(detail.brand)}
                      size={56}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-semibold text-ink-bright">
                          {repoTitle(detail.id, preferredHint ?? undefined)}
                        </h3>
                        {detail.recommended ||
                        list.some(
                          (x) => x.id === detail.id && x.recommended
                        ) ? (
                          <span className="rounded bg-signal/15 px-1.5 py-0.5 text-[10px] text-signal">
                            {t('store.staffPick')}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate font-mono text-[11px] text-ink-mute">
                        {detail.id}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
                        <span>↓ {formatCount(detail.downloads)}</span>
                        <span>★ {formatCount(detail.likes)}</span>
                        {(() => {
                          const selected = list.find(
                            (x) =>
                              x.id === detail.id &&
                              (x.preferredFile ?? null) === (preferredHint ?? null)
                          )
                          if (!selected?.fit) return null
                          const label =
                            selected.fit === 'heavy'
                              ? t('store.gpuOffloadHeavy')
                              : selected.fit === 'tight'
                                ? t('store.gpuOffloadTight')
                                : t('store.gpuOffloadOk')
                          return (
                            <span
                              className={
                                'rounded px-1.5 py-0.5 text-[10px] ' +
                                fitBadgeClass(selected.fit)
                              }
                            >
                              {label}
                            </span>
                          )
                        })()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void window.api.app.openExternal(
                          `https://huggingface.co/${detail.id}`
                        )
                      }
                      className="shrink-0 rounded border border-ink-line px-2.5 py-1 text-[11px] text-ink-soft hover:bg-ink-800"
                    >
                      {t('store.openWeb')}
                    </button>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-[11px] text-ink-mute">
                      {target === 'mmproj'
                        ? t('store.mmprojFile')
                        : isImageGenStoreTarget(target)
                          ? t('store.weightFile')
                          : t('store.ggufFile')}
                    </label>
                    <select
                      value={filePath}
                      onChange={(e) => setFilePath(e.target.value)}
                      disabled={downloading || detail.ggufFiles.length === 0}
                      className="input w-full font-mono text-[11px]"
                    >
                      {detail.ggufFiles.length === 0 ? (
                        <option value="">
                          {target === 'mmproj'
                            ? t('store.noMmproj')
                            : isImageGenStoreTarget(target)
                              ? t('store.noImageGenWeights')
                              : t('store.noGguf')}
                        </option>
                      ) : (
                        detail.ggufFiles.map((f) => (
                          <option key={f.path} value={f.path}>
                            {f.path} · {formatBytes(f.size)}
                            {detail.preferredFile === f.path
                              ? ` · ${t('store.preferred')}`
                              : ''}
                            {f.installed ? ` · ${t('store.installed')}` : ''}
                          </option>
                        ))
                      )}
                    </select>
                    {detail.ggufFiles.length === 0 ? (
                      <p className="text-[11px] leading-snug text-ink-mute">
                        {target === 'mmproj'
                          ? t('store.noMmprojHint')
                          : isImageGenStoreTarget(target)
                            ? t('store.noImageGenHint')
                            : t('store.noGgufHint')}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!selectedFile || downloading || selectedInstalled}
                        onClick={() => void startDownload()}
                        className="rounded bg-signal px-3 py-1.5 text-[12px] font-medium text-signal-on hover:bg-signal-dim disabled:opacity-40"
                      >
                        {selectedInstalled
                          ? t('store.alreadyInstalled')
                          : downloading
                            ? t('store.downloading')
                            : t('store.download', {
                                size: formatBytes(selectedFile?.size ?? 0)
                              })}
                      </button>
                      {selectedInstalled && selectedFile?.installedPath ? (
                        <button
                          type="button"
                          onClick={() =>
                            void window.api.hf.showInFolder(selectedFile.installedPath!)
                          }
                          className="rounded border border-ink-line px-2.5 py-1.5 text-[12px] text-ink-soft hover:bg-ink-800"
                        >
                          {t('store.showInFolder')}
                        </button>
                      ) : null}
                      {visibleProgress?.status === 'downloading' && visibleProgress.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void window.api.hf.pauseDownload(visibleProgress.id)
                            }
                            className="rounded border border-ink-line px-2.5 py-1.5 text-[12px] text-ink-soft hover:bg-ink-800"
                          >
                            {t('store.pause')}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void window.api.hf.cancelDownload(visibleProgress.id)
                            }
                            className="rounded border border-danger/40 px-2.5 py-1.5 text-[12px] text-danger hover:bg-danger-muted"
                          >
                            {t('store.cancel')}
                          </button>
                        </>
                      ) : null}
                      {visibleProgress?.status === 'paused' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDownloading(true)
                            void window.api.hf
                              .resumeDownload(visibleProgress.id)
                              .then((r) => {
                                setProgress(r)
                                if (r.status === 'done' && r.destPath) onDownloaded(r.destPath)
                              })
                              .finally(() => {
                                setDownloading(false)
                                refreshDownloads()
                              })
                          }}
                          className="rounded border border-signal/40 px-2.5 py-1.5 text-[12px] text-signal hover:bg-signal/10"
                        >
                          {t('store.resume')}
                        </button>
                      ) : null}
                    </div>
                    {visibleProgress ? (
                      <div className="space-y-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
                          <div
                            className={
                              'h-full rounded-full transition-all ' +
                              (visibleProgress.status === 'error' ||
                              visibleProgress.status === 'cancelled'
                                ? 'bg-danger'
                                : visibleProgress.status === 'done'
                                  ? 'bg-signal'
                                  : visibleProgress.status === 'paused'
                                    ? 'bg-warn'
                                    : 'bg-signal')
                            }
                            style={{
                              width: `${Math.round(visibleProgress.fraction * 100)}%`
                            }}
                          />
                        </div>
                        <p className="font-mono text-[10px] text-ink-mute">
                          {visibleProgress.status === 'done'
                            ? t('store.done', { path: visibleProgress.destPath ?? '' })
                            : visibleProgress.status === 'error'
                              ? visibleProgress.error
                              : visibleProgress.status === 'cancelled'
                                ? t('store.cancelled')
                                : visibleProgress.status === 'paused'
                                  ? t('store.pausedMeta', {
                                      received: formatBytes(visibleProgress.bytesReceived),
                                      total: formatBytes(visibleProgress.bytesTotal)
                                    })
                                  : t('store.progressMeta', {
                                      received: formatBytes(visibleProgress.bytesReceived),
                                      total: formatBytes(visibleProgress.bytesTotal),
                                      speed: formatSpeed(visibleProgress.bytesPerSecond),
                                      eta: formatEta(visibleProgress.etaSeconds)
                                    })}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {detail.description ? (
                    <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">
                      {detail.description}
                    </p>
                  ) : null}
                  {detail.tags && detail.tags.length > 0 ? (
                    <div className="mb-5 flex flex-wrap gap-1.5">
                      {detail.tags
                        .filter((tag) => !tag.startsWith('license:') && tag !== 'gguf')
                        .slice(0, 14)
                        .map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-ink-line px-2 py-0.5 text-[10px] text-ink-mute"
                          >
                            {tag}
                          </span>
                        ))}
                    </div>
                  ) : null}

                  <div className="border-t border-ink-line/60 pt-4">
                    <h4 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-ink-mute">
                      {t('store.readme')}
                      {lang === 'ru' && readmeTranslating ? (
                        <span className="ml-2 font-normal normal-case tracking-normal text-ink-mute/80">
                          {t('store.readmeTranslating')}
                        </span>
                      ) : null}
                    </h4>
                    {detail.readmeMarkdown ? (
                      <MarkdownBody content={detail.readmeMarkdown} />
                    ) : (
                      <p className="text-[12px] text-ink-mute">{t('store.noDescription')}</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        <DownloadsPanel
          open={downloadsOpen}
          onClose={() => setDownloadsOpen(false)}
          downloads={downloads}
          onRefresh={refreshDownloads}
        />
      </div>
    </div>
  )
}

function DownloadTrayIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 2v7.2L5.4 6.6 4.3 7.7 8 11.4l3.7-3.7-1.1-1.1L9 9.2V2z" />
      <path d="M2.5 12.5h11v1.5h-11z" />
    </svg>
  )
}
