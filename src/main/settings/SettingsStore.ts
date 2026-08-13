import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  CACHE_QUANT_OPTIONS,
  DEFAULT_MODELS_DIR,
  DEFAULT_SETTINGS,
  defaultModelProfile,
  extractModelProfile,
  syncActiveModelProfile,
  switchModelPath,
  type AppSettings,
  type CacheQuant,
  type FlashAttnMode,
  type LoadMode,
  type ModelTuningProfile
} from '../../shared/settings'
import { isUiTheme, migrateUiTheme } from '../../shared/theme'
import { isUiLanguage } from '../../shared/i18n'
import { isLlamaRuntimeSelection } from '../../shared/llamaRuntime'
import { sanitizeMcpServers } from '../../shared/mcp'
import { scanGgufModels } from '../llama/ModelScanner'
import {
  autofillImageGenPaths,
  clearMissingImageGenPaths,
  imageGenPathsNeedAutofill
} from '../imagegen/ImageGenAutofill'
import {
  autofillVisionPaths,
  visionPathsNeedAutofill
} from '../llama/VisionAutofill'

export class SettingsStore {
  private path: string
  private cache: AppSettings
  private saveChain: Promise<void> = Promise.resolve()

  constructor() {
    this.path = join(app.getPath('userData'), 'settings.json')
    this.cache = { ...DEFAULT_SETTINGS }
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      this.cache = sanitize(parsed)
      const path = this.cache.modelPath
      const stored = path ? this.cache.modelProfiles[path] : undefined
      if (stored) {
        this.cache = { ...this.cache, ...stored, modelProfiles: this.cache.modelProfiles }
      }
      const nextRaw = JSON.stringify(this.cache, null, 2)
      if (nextRaw !== raw) await this.persist()
    } catch {
      this.cache = { ...DEFAULT_SETTINGS }
      await this.persist()
    }
    await this.repairMissingModel()
    await this.autofillImageGenIfNeeded()
    await this.autofillVisionIfNeeded()
    // Auto-complete first-run when a chat GGUF already exists.
    // Skipped when AFKLLM_FORCE_ONBOARDING=1 so we can re-show the wizard.
    if (
      process.env.AFKLLM_FORCE_ONBOARDING !== '1' &&
      this.cache.modelPath &&
      existsSync(this.cache.modelPath) &&
      !this.cache.setupComplete
    ) {
      this.cache.setupComplete = true
      await this.persist()
    }
    return this.get()
  }

  /** Fill empty image-gen paths from modelsDir when sidecars exist on disk. */
  async autofillImageGenIfNeeded(): Promise<AppSettings> {
    if (!imageGenPathsNeedAutofill(this.cache)) return this.get()
    const cleared = clearMissingImageGenPaths(this.cache)
    const base =
      Object.keys(cleared).length > 0
        ? sanitize({ ...this.cache, ...cleared })
        : this.cache
    const filled = await autofillImageGenPaths(base)
    if (Object.keys(cleared).length === 0 && Object.keys(filled).length === 0) {
      return this.get()
    }
    this.cache = sanitize({ ...base, ...filled })
    await this.persist()
    return this.get()
  }

  /** Fill empty vision paths from modelsDir when a VL GGUF (+ mmproj) exists. */
  async autofillVisionIfNeeded(): Promise<AppSettings> {
    if (!visionPathsNeedAutofill(this.cache)) return this.get()
    const filled = await autofillVisionPaths(this.cache)
    if (Object.keys(filled).length === 0) return this.get()
    this.cache = sanitize({ ...this.cache, ...filled })
    await this.persist()
    return this.get()
  }

  private async repairMissingModel(): Promise<void> {
    if (this.cache.modelPath && existsSync(this.cache.modelPath)) return

    const preferredDir = this.cache.modelsDir?.trim() || ''
    const dirs = [preferredDir, DEFAULT_MODELS_DIR].filter(
      (d, i, arr) => d && arr.indexOf(d) === i
    )
    for (const dir of dirs) {
      const models = await scanGgufModels(dir)
      if (models.length === 0) continue
      this.cache = switchModelPath(this.cache, models[0]!.path)
      // Keep the user's modelsDir; only fill it when unset.
      if (!preferredDir) {
        this.cache.modelsDir = dir
      }
      await this.persist()
      return
    }
  }

  /** Shallow clone for IPC / renderer. */
  get(): AppSettings {
    return { ...this.cache, modelProfiles: { ...this.cache.modelProfiles } }
  }

  /** Live cache — do not mutate; for main-process hot paths. */
  peek(): AppSettings {
    return this.cache
  }

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    const run = this.saveChain.then(() => this.saveInner(patch))
    this.saveChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async saveInner(patch: Partial<AppSettings>): Promise<AppSettings> {
    const prevPath = this.cache.modelPath
    let merged: AppSettings
    if (
      typeof patch.modelPath === 'string' &&
      patch.modelPath.trim() &&
      patch.modelPath !== prevPath
    ) {
      const switched = switchModelPath(this.cache, patch.modelPath)
      merged = sanitize({ ...switched, ...patch, modelPath: patch.modelPath })
    } else {
      merged = sanitize({ ...this.cache, ...patch })
    }
    this.cache = merged
    await this.persist()
    // Fill any still-empty image-gen slots from modelsDir (e.g. after download / clear).
    await this.autofillImageGenIfNeeded()
    const visionExplicitlyCleared =
      Object.prototype.hasOwnProperty.call(patch, 'visionModelPath') &&
      !String(patch.visionModelPath ?? '').trim()
    if (!visionExplicitlyCleared) {
      await this.autofillVisionIfNeeded()
    }
    return this.get()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8')
  }
}

function asCacheQuant(v: unknown, fallback: CacheQuant): CacheQuant {
  return CACHE_QUANT_OPTIONS.includes(v as CacheQuant) ? (v as CacheQuant) : fallback
}

function sanitizeProfile(raw: unknown, fallback: ModelTuningProfile): ModelTuningProfile {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const src = raw as Record<string, unknown>
  const base = { ...fallback }
  for (const key of Object.keys(fallback) as (keyof ModelTuningProfile)[]) {
    if (src[key] !== undefined && src[key] !== null) {
      ;(base as unknown as Record<string, unknown>)[key] = src[key]
    }
  }
  base.parallel = Math.max(1, Number(base.parallel) || 1)
  base.cacheTypeK = asCacheQuant(base.cacheTypeK, fallback.cacheTypeK)
  base.cacheTypeV = asCacheQuant(base.cacheTypeV, fallback.cacheTypeV)
  if (!['on', 'off', 'auto'].includes(base.flashAttn)) base.flashAttn = fallback.flashAttn
  if (!['mmap', 'mmap+mlock', 'none'].includes(base.loadMode)) base.loadMode = fallback.loadMode
  if (!Array.isArray(base.stopStrings)) base.stopStrings = []
  base.stopStrings = base.stopStrings.map(String).filter(Boolean)
  return base
}

function sanitize(input: Record<string, unknown> | AppSettings): AppSettings {
  const raw = input as Record<string, unknown>
  const next: AppSettings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (key === 'modelProfiles' || key === 'collectLogsToFile') continue
    if (raw[key] !== undefined && raw[key] !== null) {
      ;(next as unknown as Record<string, unknown>)[key] = raw[key]
    }
  }
  next.baseUrl = `http://${next.host}:${next.port}`
  if (next.port === 1234) {
    next.port = 8080
    next.host = '127.0.0.1'
    next.baseUrl = 'http://127.0.0.1:8080'
  }

  // Never leave 0/"auto" — llama-server turns that into 4 slots
  next.parallel = Math.max(1, Number(next.parallel) || 1)

  next.cacheTypeK = asCacheQuant(next.cacheTypeK, DEFAULT_SETTINGS.cacheTypeK)
  next.cacheTypeV = asCacheQuant(next.cacheTypeV, DEFAULT_SETTINGS.cacheTypeV)

  if (!['on', 'off', 'auto'].includes(next.flashAttn)) {
    next.flashAttn = DEFAULT_SETTINGS.flashAttn as FlashAttnMode
  }
  if (!['mmap', 'mmap+mlock', 'none'].includes(next.loadMode)) {
    next.loadMode = DEFAULT_SETTINGS.loadMode as LoadMode
  }
  if (!Array.isArray(next.stopStrings)) next.stopStrings = []
  next.stopStrings = next.stopStrings.map(String).filter(Boolean)

  next.agentAutoApprove = next.agentAutoApprove === true
  next.agentThinkThrough = next.agentThinkThrough !== false
  next.agentImageGenEnabled = next.agentImageGenEnabled === true
  next.setupComplete = next.setupComplete === true
  next.localApiEnabled = next.localApiEnabled === true

  // telemetryEnabled → collectLogsToFile (never uploaded either way)
  if (typeof raw.collectLogsToFile === 'boolean') {
    next.collectLogsToFile = raw.collectLogsToFile
  } else if (typeof raw.telemetryEnabled === 'boolean') {
    next.collectLogsToFile = raw.telemetryEnabled === true
  } else {
    next.collectLogsToFile = DEFAULT_SETTINGS.collectLogsToFile
  }

  next.mcpServers = sanitizeMcpServers(next.mcpServers)
  next.lastSeenVersion =
    typeof next.lastSeenVersion === 'string' ? next.lastSeenVersion.trim() : ''

  // Manual Load — do not spawn llama-server on app open
  next.autoStart = next.autoStart === true

  next.uiTheme = migrateUiTheme(raw.uiTheme ?? next.uiTheme)
  if (!isUiTheme(next.uiTheme)) next.uiTheme = DEFAULT_SETTINGS.uiTheme
  if (!isUiLanguage(next.uiLanguage)) next.uiLanguage = DEFAULT_SETTINGS.uiLanguage
  if (!isLlamaRuntimeSelection(next.llamaRuntimeVariant)) {
    next.llamaRuntimeVariant = DEFAULT_SETTINGS.llamaRuntimeVariant
  }

  if (!Array.isArray(next.recentRoots)) next.recentRoots = []
  next.recentRoots = next.recentRoots
    .map(String)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 12)

  next.threads = Number(next.threads) || DEFAULT_SETTINGS.threads
  next.batchSize = Number(next.batchSize) || DEFAULT_SETTINGS.batchSize
  next.ubatchSize = Number(next.ubatchSize) || DEFAULT_SETTINGS.ubatchSize
  next.ctxCheckpoints = Number(next.ctxCheckpoints) || DEFAULT_SETTINGS.ctxCheckpoints
  next.ctxSize = Math.max(0, Number(next.ctxSize) || 0)
  next.nGpuLayers = Number(next.nGpuLayers)
  if (Number.isNaN(next.nGpuLayers)) next.nGpuLayers = DEFAULT_SETTINGS.nGpuLayers

  next.modelsDir =
    typeof next.modelsDir === 'string' && next.modelsDir.trim()
      ? next.modelsDir.trim()
      : DEFAULT_MODELS_DIR
  next.modelPath = typeof next.modelPath === 'string' ? next.modelPath : ''

  next.visionModelPath = typeof next.visionModelPath === 'string' ? next.visionModelPath : ''
  next.visionMmprojPath = typeof next.visionMmprojPath === 'string' ? next.visionMmprojPath : ''
  next.imageGenModelPath =
    typeof next.imageGenModelPath === 'string' ? next.imageGenModelPath : ''
  next.imageGenVaePath =
    typeof next.imageGenVaePath === 'string' ? next.imageGenVaePath : ''
  next.imageGenClipLPath =
    typeof next.imageGenClipLPath === 'string' ? next.imageGenClipLPath : ''
  next.imageGenClipGPath =
    typeof next.imageGenClipGPath === 'string' ? next.imageGenClipGPath : ''
  next.imageGenT5Path =
    typeof next.imageGenT5Path === 'string' ? next.imageGenT5Path : ''
  next.imageGenLlmPath =
    typeof next.imageGenLlmPath === 'string' ? next.imageGenLlmPath : ''
  next.sdCppPath = typeof next.sdCppPath === 'string' ? next.sdCppPath : ''
  next.imageGenSteps = Math.max(1, Math.min(150, Number(next.imageGenSteps) || DEFAULT_SETTINGS.imageGenSteps))
  // Hard ceiling: never allow >1536 on either side (VRAM / freeze safety).
  next.imageGenWidth = Math.max(
    64,
    Math.min(1536, Number(next.imageGenWidth) || DEFAULT_SETTINGS.imageGenWidth)
  )
  next.imageGenHeight = Math.max(
    64,
    Math.min(1536, Number(next.imageGenHeight) || DEFAULT_SETTINGS.imageGenHeight)
  )
  next.imageGenCfg = Math.max(
    0,
    Math.min(30, Number.isFinite(Number(next.imageGenCfg)) ? Number(next.imageGenCfg) : 0)
  )
  const weightOk = ['disk', 'ram', 'vram'].includes(
    String(next.imageGenWeightStorage ?? '')
  )
  if (weightOk) {
    /* keep */
  } else if (next.imageGenOffloadCpu === true) {
    next.imageGenWeightStorage = 'ram'
  } else {
    next.imageGenWeightStorage = DEFAULT_SETTINGS.imageGenWeightStorage
  }
  // Drop legacy flag from runtime object (still accepted on load above).
  delete next.imageGenOffloadCpu

  next.imageGenHires =
    typeof next.imageGenHires === 'boolean'
      ? next.imageGenHires
      : DEFAULT_SETTINGS.imageGenHires
  next.imageGenHiresScale = Math.max(
    1.05,
    Math.min(
      4,
      Number(next.imageGenHiresScale) || DEFAULT_SETTINGS.imageGenHiresScale
    )
  )
  next.imageGenHiresDenoising = Math.max(
    0.05,
    Math.min(
      1,
      Number.isFinite(Number(next.imageGenHiresDenoising))
        ? Number(next.imageGenHiresDenoising)
        : DEFAULT_SETTINGS.imageGenHiresDenoising
    )
  )
  next.imageGenNegativePrompt =
    typeof next.imageGenNegativePrompt === 'string'
      ? next.imageGenNegativePrompt
      : DEFAULT_SETTINGS.imageGenNegativePrompt

  const fallbackProfile = defaultModelProfile()
  const profilesIn = raw.modelProfiles
  const profiles: Record<string, ModelTuningProfile> = {}
  if (profilesIn && typeof profilesIn === 'object') {
    for (const [path, profile] of Object.entries(profilesIn as Record<string, unknown>)) {
      if (!path) continue
      profiles[path] = sanitizeProfile(profile, fallbackProfile)
    }
  }
  if (next.modelPath && !profiles[next.modelPath]) {
    profiles[next.modelPath] = extractModelProfile(next)
  }
  next.modelProfiles = profiles

  return syncActiveModelProfile(next)
}
