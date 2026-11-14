import { isUiTheme, type UiTheme } from './theme'
import type { McpServerConfig } from './mcp'
import type { LlamaRuntimeSelection } from './llamaRuntime'
import { DEFAULT_UI_LANGUAGE, type UiLanguage } from './i18n'
import {
  looksLikeOrnithGguf,
  ornithTuningOverlay,
  isStockAfkllmSampling
} from './ornithDefaults'

export type FlashAttnMode = 'on' | 'off' | 'auto'
export type CacheQuant = 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'bf16'
export type LoadMode = 'mmap' | 'mmap+mlock' | 'none'
export type ContextOverflow = 'truncate_middle' | 'context_shift' | 'stop'
export type { UiTheme }

/** Per-model knobs keyed by absolute .gguf path. */
export interface ModelTuningProfile {
  systemPrompt: string
  fitHardware: boolean
  ctxSize: number
  nGpuLayers: number
  threads: number
  batchSize: number
  ubatchSize: number
  parallel: number
  flashAttn: FlashAttnMode
  kvOffload: boolean
  kvUnified: boolean
  ctxCheckpoints: number
  cacheTypeK: CacheQuant
  cacheTypeV: CacheQuant
  loadMode: LoadMode
  temperature: number
  topK: number
  topP: number
  topPEnabled: boolean
  minP: number
  minPEnabled: boolean
  repeatPenalty: number
  repeatPenaltyEnabled: boolean
  presencePenalty: number
  presencePenaltyEnabled: boolean
  limitResponseLength: boolean
  maxTokens: number
  contextOverflow: ContextOverflow
  stopStrings: string[]
  reasoningBudgetEnabled: boolean
  reasoningBudget: number
  reasoningBudgetMessage: string
}

export const MODEL_TUNING_KEYS: (keyof ModelTuningProfile)[] = [
  'systemPrompt',
  'fitHardware',
  'ctxSize',
  'nGpuLayers',
  'threads',
  'batchSize',
  'ubatchSize',
  'parallel',
  'flashAttn',
  'kvOffload',
  'kvUnified',
  'ctxCheckpoints',
  'cacheTypeK',
  'cacheTypeV',
  'loadMode',
  'temperature',
  'topK',
  'topP',
  'topPEnabled',
  'minP',
  'minPEnabled',
  'repeatPenalty',
  'repeatPenaltyEnabled',
  'presencePenalty',
  'presencePenaltyEnabled',
  'limitResponseLength',
  'maxTokens',
  'contextOverflow',
  'stopStrings',
  'reasoningBudgetEnabled',
  'reasoningBudget',
  'reasoningBudgetMessage'
]

export function extractModelProfile(
  s: Pick<AppSettings, keyof ModelTuningProfile>
): ModelTuningProfile {
  const out = {} as ModelTuningProfile
  for (const key of MODEL_TUNING_KEYS) {
    ;(out as unknown as Record<string, unknown>)[key] = s[key]
  }
  return out
}

export function applyModelProfile(
  settings: AppSettings,
  profile: ModelTuningProfile
): AppSettings {
  return { ...settings, ...profile }
}

export function defaultModelProfile(): ModelTuningProfile {
  return extractModelProfile(DEFAULT_SETTINGS)
}

export function profileForModelPath(modelPath: string): ModelTuningProfile {
  const base = defaultModelProfile()
  if (!looksLikeOrnithGguf(modelPath)) return base
  return { ...base, ...ornithTuningOverlay() }
}

/**
 * If Chat is Ornith and knobs are still the stock AFKLLM 0.1/0.1/8k profile,
 * lift them to official agent sampling + 256K ctx. Custom values stay.
 */
export function applyOrnithRecommendedTuning(settings: AppSettings): AppSettings {
  if (!looksLikeOrnithGguf(settings.modelPath)) return settings
  const overlay = ornithTuningOverlay()
  const sampling = isStockAfkllmSampling(settings)
  const ctx = settings.ctxSize > 0 && settings.ctxSize <= 8192
  if (!sampling && !ctx) return settings
  const next: AppSettings = {
    ...settings,
    ...(sampling
      ? {
          temperature: overlay.temperature,
          topK: overlay.topK,
          topP: overlay.topP,
          topPEnabled: overlay.topPEnabled
        }
      : {}),
    ...(ctx ? { ctxSize: overlay.ctxSize } : {})
  }
  const profiles = { ...(next.modelProfiles ?? {}) }
  if (next.modelPath) profiles[next.modelPath] = extractModelProfile(next)
  next.modelProfiles = profiles
  return next
}

export interface AppSettings {
  /** OpenAI-compatible base URL of llama-server */
  baseUrl: string
  host: string
  port: number
  modelPath: string
  modelsDir: string
  /** Empty = local bin / auto-downloaded runtime */
  llamaServerPath: string
  /** GGUF llama.cpp pack: auto | cpu | cuda-12.4 | cuda | vulkan */
  llamaRuntimeVariant: LlamaRuntimeSelection
  autoStart: boolean

  uiTheme: UiTheme
  uiLanguage: UiLanguage
  recentRoots: string[]

  systemPrompt: string
  /** --fit on/off */
  fitHardware: boolean
  /** --ctx-size; 0 = auto */
  ctxSize: number
  /** --n-gpu-layers; -1/999 = all */
  nGpuLayers: number
  /** --threads; −1 = auto */
  threads: number
  /** --batch-size */
  batchSize: number
  /** --ubatch-size */
  ubatchSize: number
  /** --parallel; always ≥1 (llama defaults to 4 if unset) */
  parallel: number
  flashAttn: FlashAttnMode

  /** --kv-offload / --no-kv-offload */
  kvOffload: boolean
  /** --kv-unified */
  kvUnified: boolean
  /** --ctx-checkpoints */
  ctxCheckpoints: number
  /** --cache-type-k */
  cacheTypeK: CacheQuant
  /** --cache-type-v */
  cacheTypeV: CacheQuant
  /** --load-mode */
  loadMode: LoadMode

  temperature: number
  topK: number
  topP: number
  topPEnabled: boolean
  minP: number
  minPEnabled: boolean
  repeatPenalty: number
  repeatPenaltyEnabled: boolean
  presencePenalty: number
  presencePenaltyEnabled: boolean
  limitResponseLength: boolean
  maxTokens: number
  contextOverflow: ContextOverflow
  stopStrings: string[]

  reasoningBudgetEnabled: boolean
  reasoningBudget: number
  reasoningBudgetMessage: string

  /** Skip shell/delete dialogs and edit Accept/Reject gates */
  agentAutoApprove: boolean

  /** Brief reasoning step before tools / final answer */
  agentThinkThrough: boolean

  /** When true, expose generate_image to the agent.
   * Default false — coding mode must not invent image gens.
   */
  agentImageGenEnabled: boolean

  /**
   * Honest agent loop (language-agnostic prompts, evidence-gated plan).
   * Default true. Set false only to force the legacy turn path.
   */
  agentLoopV2: boolean

  /** First-run wizard done with a valid .gguf */
  setupComplete: boolean

  /** Keep local OpenAI-compatible API running */
  localApiEnabled: boolean

  /** Append crashes/errors to local log (never uploaded) */
  collectLogsToFile: boolean

  /** Absolute .gguf path → tuning; active fields mirror modelProfiles[modelPath] */
  modelProfiles: Record<string, ModelTuningProfile>

  mcpServers: McpServerConfig[]

  /** Last version that showed the changelog modal; empty skips until an upgrade */
  lastSeenVersion: string

  /**
   * Separate VL GGUF for image attach, empty = not set,
   * or VISION_SAME_AS_CHAT to reuse the chat GGUF + mmproj.
   */
  visionModelPath: string
  /** Projector for visionModelPath; empty = auto sibling *mmproj*.gguf */
  visionMmprojPath: string
  /**
   * When true (default): load vision with chat on Load (port+2) and keep it.
   * When false: cold-swap chat↔vision on attach, then unload vision after use.
   */
  visionKeepLoaded: boolean
  /**
   * Fast-apply / Morph-style edit GGUF — unused. Chat applies patches.
   * Kept so older settings.json still loads; SettingsStore clears the path.
   */
  applyModelPath: string
  /**
   * Context for the apply slot. 0 = follow chat ctx (clamped 8192…32768).
   * A bigger window lets fast-apply see whole medium files instead of a clip.
   */
  applyCtxSize: number
  /** Diffusion weights for generate_image (safetensors / gguf) */
  imageGenModelPath: string
  /** FLUX / FLUX.2 VAE (ae.safetensors) */
  imageGenVaePath: string
  /** FLUX.1 / SD3 CLIP-L */
  imageGenClipLPath: string
  /** SD3 CLIP-G */
  imageGenClipGPath: string
  /** FLUX.1 / SD3 T5-XXL */
  imageGenT5Path: string
  /** FLUX.2 text LLM (Qwen3-4B / Mistral-Small GGUF) */
  imageGenLlmPath: string
  /** Empty = auto-downloaded sd-cli under userData/sd-runtime */
  sdCppPath: string
  imageGenSteps: number
  imageGenWidth: number
  imageGenHeight: number
  imageGenCfg: number
  /**
   * Where sd-cli keeps weights while generating.
   * - vram: diffusion resident on GPU; TE on CPU; VAE on CUDA (default, fastest)
   * - ram: --offload-to-cpu staged upload (safer for hires / tight VRAM)
   * - disk: --params-backend disk (lowest RAM; slower)
   */
  imageGenWeightStorage: ImageGenWeightStorage
  /**
   * Enable sd-cli highres fix (second denoise pass after upscale).
   * Hires steps always equal imageGenSteps.
   */
  imageGenHires: boolean
  /** Upscale factor for hires (e.g. 1.5). */
  imageGenHiresScale: number
  /** Denoising strength for hires pass (0–1). */
  imageGenHiresDenoising: number
  /**
   * Extra negative prompt always merged into generate_image (-n).
   * Default suppresses gibberish UI text / glyphs (FLUX cannot render real words well).
   */
  imageGenNegativePrompt: string
  /**
   * @deprecated Prefer imageGenWeightStorage. Kept for settings.json migration.
   * true → ram, false ignored when weightStorage is set.
   */
  imageGenOffloadCpu?: boolean
}

/** sd-cli --params-backend strategy for generate_image */
export type ImageGenWeightStorage = 'disk' | 'ram' | 'vram'

export const CACHE_QUANT_OPTIONS: CacheQuant[] = [
  'f16',
  'q8_0',
  'q4_0',
  'q4_1',
  'q5_0',
  'bf16'
]

export const DEFAULT_MODELS_DIR = 'C:\\Models'
export const DEFAULT_MODEL =
  'C:\\Models\\Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf'

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'http://127.0.0.1:8080',
  host: '127.0.0.1',
  port: 8080,
  modelPath: DEFAULT_MODEL,
  modelsDir: DEFAULT_MODELS_DIR,
  llamaServerPath: '',
  llamaRuntimeVariant: 'auto',
  autoStart: false,

  uiTheme: 'classic',
  uiLanguage: DEFAULT_UI_LANGUAGE,
  recentRoots: [],

  systemPrompt: '',

  fitHardware: true,
  ctxSize: 8192,
  nGpuLayers: 999,
  threads: 6,
  batchSize: 2048,
  ubatchSize: 512,
  parallel: 1,
  flashAttn: 'on',

  kvOffload: true,
  kvUnified: true,
  ctxCheckpoints: 32,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  loadMode: 'mmap',

  temperature: 0.1,
  topK: 50,
  topP: 0.1,
  topPEnabled: true,
  minP: 0.05,
  minPEnabled: false,
  repeatPenalty: 1.05,
  repeatPenaltyEnabled: true,
  presencePenalty: 0,
  presencePenaltyEnabled: false,
  limitResponseLength: false,
  maxTokens: 4096,
  contextOverflow: 'truncate_middle',
  stopStrings: [],

  reasoningBudgetEnabled: true,
  reasoningBudget: 8192,
  reasoningBudgetMessage: 'I have to answer now.',

  agentAutoApprove: false,

  agentThinkThrough: true,

  agentImageGenEnabled: false,

  agentLoopV2: true,

  setupComplete: false,

  localApiEnabled: false,

  collectLogsToFile: true,

  modelProfiles: {},

  mcpServers: [],

  lastSeenVersion: '',

  visionModelPath: '',
  visionMmprojPath: '',
  visionKeepLoaded: false,
  applyModelPath: '',
  applyCtxSize: 0,
  imageGenModelPath: '',
  imageGenVaePath: '',
  imageGenClipLPath: '',
  imageGenClipGPath: '',
  imageGenT5Path: '',
  imageGenLlmPath: '',
  sdCppPath: '',
  imageGenSteps: 20,
  imageGenWidth: 1024,
  imageGenHeight: 1024,
  /** 0 = auto by stack (FLUX≈1, SD3≈4.5, SDXL≈7) */
  imageGenCfg: 0,
  /** disk = reload weights from file on demand — avoids RAM crash spikes */
  imageGenWeightStorage: 'vram',
  /** Quality pass on by default; keep base size ≤1536² */
  imageGenHires: true,
  imageGenHiresScale: 1.25,
  imageGenHiresDenoising: 0.4,
  /** Ban gibberish lettering; FLUX is poor at readable text — prefer text-free UI art. */
  imageGenNegativePrompt:
    'text, letters, words, typography, watermark, logo, caption, title, subtitle, ' +
    'gibberish text, misspelled text, random characters, hieroglyphs, glyphs, ' +
    'unreadable text, lorem ipsum, ui labels with text, written language'
}

export interface DiscoveredModel {
  id: string
  path: string
  sizeBytes: number
}

export interface LlmRuntimeStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error'
  baseUrl: string | null
  modelPath: string | null
  /** --ctx-size (0 = auto) */
  ctxSize: number | null
  pending: number
  error?: string
  detail?: string
  /** Coresident apply llama-server (port+1); absent when applyModelPath empty */
  applyState?: 'stopped' | 'starting' | 'ready' | 'error'
  applyModelPath?: string | null
  applyBaseUrl?: string | null
  applyError?: string
  /** Coresident vision llama-server (port+2) when visionKeepLoaded */
  visionState?: 'stopped' | 'starting' | 'ready' | 'error'
  visionModelPath?: string | null
  visionBaseUrl?: string | null
  visionError?: string
}

export function samplingFromSettings(s: AppSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {
    temperature: s.temperature,
    top_k: s.topK
  }
  if (s.topPEnabled) body.top_p = s.topP
  if (s.minPEnabled) body.min_p = s.minP
  if (s.repeatPenaltyEnabled) body.repeat_penalty = s.repeatPenalty
  if (s.presencePenaltyEnabled) body.presence_penalty = s.presencePenalty
  if (s.stopStrings.length > 0) body.stop = s.stopStrings
  if (s.limitResponseLength) body.max_tokens = s.maxTokens
  return body
}

/** Stash current tuning under old path, load (or default) for the new path. */
export function switchModelPath(settings: AppSettings, nextPath: string): AppSettings {
  const path = String(nextPath || '').trim()
  if (!path || path === settings.modelPath) {
    return syncActiveModelProfile(settings)
  }
  const profiles = { ...(settings.modelProfiles ?? {}) }
  if (settings.modelPath) {
    profiles[settings.modelPath] = extractModelProfile(settings)
  }
  const loaded = profiles[path] ?? profileForModelPath(path)
  profiles[path] = loaded
  return applyModelProfile(
    { ...settings, modelPath: path, modelProfiles: profiles },
    loaded
  )
}

/** Write active knobs into modelProfiles[modelPath]. */
export function syncActiveModelProfile(settings: AppSettings): AppSettings {
  const path = String(settings.modelPath || '').trim()
  if (!path) return { ...settings, modelProfiles: { ...(settings.modelProfiles ?? {}) } }
  const profiles = { ...(settings.modelProfiles ?? {}) }
  profiles[path] = extractModelProfile(settings)
  return { ...settings, modelProfiles: profiles }
}
