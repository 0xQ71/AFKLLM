/** Curated AFKLLM recommendations + HF Hub store types. */

export interface GpuInfo {
  name: string
  /** MiB from nvidia-smi */
  vramMb: number
  /** GiB for UI */
  vramGb: number
}

export type HfRecommendFit = 'ideal' | 'comfortable' | 'tight' | 'heavy'

/** Which setting a store download should fill. */
export type StoreDownloadTarget =
  | 'chat'
  | 'vision'
  | 'mmproj'
  | 'imageGen'
  | 'imageGenVae'
  | 'imageGenClipL'
  | 'imageGenClipG'
  | 'imageGenT5'
  | 'imageGenLlm'

const STORE_TARGETS: StoreDownloadTarget[] = [
  'chat',
  'vision',
  'mmproj',
  'imageGen',
  'imageGenVae',
  'imageGenClipL',
  'imageGenClipG',
  'imageGenT5',
  'imageGenLlm'
]

export function isStoreDownloadTarget(v: unknown): v is StoreDownloadTarget {
  return typeof v === 'string' && (STORE_TARGETS as string[]).includes(v)
}

export function isImageGenStoreTarget(t: StoreDownloadTarget): boolean {
  return (
    t === 'imageGen' ||
    t === 'imageGenVae' ||
    t === 'imageGenClipL' ||
    t === 'imageGenClipG' ||
    t === 'imageGenT5' ||
    t === 'imageGenLlm'
  )
}

export interface HfRecommendedModel {
  repoId: string
  title: string
  description: string
  /** Russian blurb for UI when language is RU (offline-safe). */
  descriptionRu: string
  preferredFile: string
  /** Optional projector file when the same repo ships mmproj (vision stores). */
  preferredMmproj?: string
  /** Approx on-disk GiB */
  sizeGb: number
  /** Soft min VRAM (GiB) for mostly-GPU offload; below → CPU-heavy fallback */
  minVramGb: number
  tags: Array<'coding' | 'agent' | 'general' | 'popular' | 'vision' | 'imageGen'>
}

/** Staff/hardware picks, roughly small → large. */
export const HF_RECOMMENDED_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    title: 'Llama 3.2 3B Instruct',
    description: 'Tiny & fast — Q4_K_M (~2.0 GB). Good for weak GPUs.',
    descriptionRu: 'Крошечная и быстрая — Q4_K_M (~2.0 ГБ). Хороша для слабых GPU.',
    preferredFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeGb: 2.0,
    minVramGb: 4,
    tags: ['general', 'popular']
  },
  {
    repoId: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    title: 'Qwen2.5 Coder 7B',
    description: 'Popular coding 7B — Q4_K_M (~4.7 GB). Strong value on 6–8 GB.',
    descriptionRu: 'Популярный coding 7B — Q4_K_M (~4.7 ГБ). Отличный вариант на 6–8 ГБ.',
    preferredFile: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    sizeGb: 4.7,
    minVramGb: 6,
    tags: ['coding', 'popular']
  },
  {
    repoId: 'bartowski/gemma-2-9b-it-GGUF',
    title: 'Gemma 2 9B Instruct',
    description: 'Popular 9B instruct — Q4_K_M (~5.8 GB). Solid on 8 GB cards.',
    descriptionRu: 'Популярный 9B instruct — Q4_K_M (~5.8 ГБ). Уверенно на картах 8 ГБ.',
    preferredFile: 'gemma-2-9b-it-Q4_K_M.gguf',
    sizeGb: 5.8,
    minVramGb: 8,
    tags: ['general', 'popular']
  },
  {
    repoId: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    title: 'Qwen2.5 Coder 7B (Q6)',
    description: 'Higher quality 7B — Q6_K (~6.3 GB). Comfortable on 8 GB+.',
    descriptionRu: 'Более качественный 7B — Q6_K (~6.3 ГБ). Комфортно на 8 ГБ+.',
    preferredFile: 'Qwen2.5-Coder-7B-Instruct-Q6_K.gguf',
    sizeGb: 6.3,
    minVramGb: 8,
    tags: ['coding']
  },
  {
    repoId: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
    title: 'Qwen2.5 Coder 14B',
    description: 'Popular mid coding — Q4_K_M (~9.0 GB). Ideal around 12–16 GB.',
    descriptionRu: 'Популярный mid coding — Q4_K_M (~9.0 ГБ). Идеально около 12–16 ГБ.',
    preferredFile: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    sizeGb: 9.0,
    minVramGb: 11,
    tags: ['coding', 'popular']
  },
  {
    repoId: 'yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF',
    title: 'Gemma 4 12B Agentic v2',
    description: 'Agentic Gemma 4 for IDE work — Q6_K (~9.1 GB). Great on 12–16 GB.',
    descriptionRu: 'Агентная Gemma 4 для IDE — Q6_K (~9.1 ГБ). Отлично на 12–16 ГБ.',
    preferredFile: 'gemma4-v2-Q6_K.gguf',
    sizeGb: 9.1,
    minVramGb: 12,
    tags: ['agent', 'coding']
  },
  {
    repoId: 'unsloth/gpt-oss-20b-GGUF',
    title: 'GPT-OSS 20B',
    description:
      'OpenAI open-weight MoE — Q4_K_M (~11.6 GB). Strong reasoning / tools on 12–16 GB.',
    descriptionRu:
      'OpenAI open-weight MoE — Q4_K_M (~11.6 ГБ). Сильные рассуждения / tools на 12–16 ГБ.',
    preferredFile: 'gpt-oss-20b-Q4_K_M.gguf',
    sizeGb: 11.6,
    minVramGb: 12,
    tags: ['agent', 'general', 'popular']
  },
  {
    repoId: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF',
    title: 'Devstral Small 2 24B',
    description: 'Strong coding / agent instruct — IQ4_XS (~12.8 GB). Best on 16 GB+.',
    descriptionRu: 'Сильный coding / agent instruct — IQ4_XS (~12.8 ГБ). Лучше на 16 ГБ+.',
    preferredFile: 'Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf',
    sizeGb: 12.8,
    minVramGb: 15,
    tags: ['coding', 'agent']
  },
  {
    repoId: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF',
    title: 'Qwen2.5 Coder 32B',
    description: 'Larger popular coder — Q3_K_M (~15.6 GB). Needs ~16–20 GB VRAM.',
    descriptionRu: 'Более крупный популярный coder — Q3_K_M (~15.6 ГБ). Нужно ~16–20 ГБ VRAM.',
    preferredFile: 'Qwen2.5-Coder-32B-Instruct-Q3_K_M.gguf',
    sizeGb: 15.6,
    minVramGb: 16,
    tags: ['coding', 'popular']
  },
  {
    repoId: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF',
    title: 'Qwen2.5 Coder 32B (Q4)',
    description: 'Higher quality 32B — Q4_K_M (~19.9 GB). For 24 GB cards.',
    descriptionRu: 'Более качественный 32B — Q4_K_M (~19.9 ГБ). Для карт 24 ГБ.',
    preferredFile: 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf',
    sizeGb: 19.9,
    minVramGb: 22,
    tags: ['coding', 'popular']
  },
  {
    repoId: 'bartowski/Qwen2.5-72B-Instruct-GGUF',
    title: 'Qwen2.5 72B Instruct',
    description: 'Popular large general model — Q3_K_S (~31 GB). 24 GB+ or multi-GPU.',
    descriptionRu: 'Популярная крупная general-модель — Q3_K_S (~31 ГБ). 24 ГБ+ или multi-GPU.',
    preferredFile: 'Qwen2.5-72B-Instruct-Q3_K_S.gguf',
    sizeGb: 31.0,
    minVramGb: 24,
    tags: ['general', 'popular']
  }
]

/** Vision / VL GGUF staff picks for ~16 GB VRAM (pair with mmproj from the same repo). */
export const HF_VISION_RECOMMENDED_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
    title: 'Qwen3-VL 8B',
    description:
      'Top open VL for UI/screenshots — Q4_K_M (~5.0 GB) + mmproj. Best default on 16 GB.',
    descriptionRu:
      'Топ open VL для UI/скринов — Q4_K_M (~5.0 ГБ) + mmproj. Лучший дефолт на 16 ГБ.',
    preferredFile: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    preferredMmproj: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    sizeGb: 5.0,
    minVramGb: 8,
    tags: ['vision', 'popular']
  },
  {
    repoId: 'ggml-org/MiniCPM-V-4.6-GGUF',
    title: 'MiniCPM-V 4.6',
    description:
      'Strong OCR / document VL — Q4_K_M + mmproj. Great for text-heavy screenshots.',
    descriptionRu:
      'Сильный OCR / документы — Q4_K_M + mmproj. Отлично для скринов с текстом.',
    preferredFile: 'MiniCPM-V-4.6-Q4_K_M.gguf',
    preferredMmproj: 'mmproj-MiniCPM-V-4.6-Q8_0.gguf',
    sizeGb: 5.2,
    minVramGb: 8,
    tags: ['vision', 'popular']
  },
  {
    repoId: 'ggml-org/gemma-3-12b-it-GGUF',
    title: 'Gemma 3 12B',
    description:
      'Long-context multimodal (128k) — Q4_K_M (~7+ GB) + mmproj. Heavier, strong OCR.',
    descriptionRu:
      'Мультимодал с длинным контекстом (128k) — Q4_K_M (~7+ ГБ) + mmproj. Тяжелее, сильный OCR.',
    preferredFile: 'gemma-3-12b-it-Q4_K_M.gguf',
    preferredMmproj: 'mmproj-model-f16.gguf',
    sizeGb: 7.3,
    minVramGb: 12,
    tags: ['vision']
  }
]

/**
 * Diffusion staff picks for sd.cpp on ~16 GB VRAM (multi-file stacks).
 * Pair with VAE / CLIP / T5 / LLM sidecars from the Image Gen sidecar Store buttons.
 */
export const HF_IMAGE_GEN_RECOMMENDED_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'leejet/FLUX.2-klein-4B-GGUF',
    title: 'FLUX.2 Klein 4B',
    description:
      'Best 16 GB FLUX.2 — Q4_0 + VAE (ae) + Qwen3-4B LLM. Fast (~4 steps). Needs sidecars.',
    descriptionRu:
      'Лучший FLUX.2 на 16 ГБ — Q4_0 + VAE (ae) + Qwen3-4B LLM. Быстро (~4 шага). Нужны sidecar’ы.',
    preferredFile: 'flux-2-klein-4b-Q4_0.gguf',
    sizeGb: 2.5,
    minVramGb: 8,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'city96/FLUX.1-dev-gguf',
    title: 'FLUX.1 Dev',
    description:
      'Flagship FLUX.1 — Q4_K_S + VAE + CLIP-L + T5. Needs sidecars; cfg≈1.',
    descriptionRu:
      'Флагман FLUX.1 — Q4_K_S + VAE + CLIP-L + T5. Нужны sidecar’ы; cfg≈1.',
    preferredFile: 'flux1-dev-Q4_K_S.gguf',
    sizeGb: 6.5,
    minVramGb: 12,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'Comfy-Org/stable-diffusion-3.5-fp8',
    title: 'SD 3.5 Medium (all-in-one)',
    description:
      'Single safetensors with clips+T5 included — works with −m alone. Great LoRA base.',
    descriptionRu:
      'Один safetensors с clips+T5 — хватает −m. Отличная база под LoRA.',
    preferredFile: 'sd3.5_medium_incl_clips_t5xxlfp8scaled.safetensors',
    sizeGb: 11.0,
    minVramGb: 12,
    tags: ['imageGen', 'popular']
  }
]

/** VAE sidecars (FLUX.1 / FLUX.2 ae.safetensors). Prefer ungated mirrors — BFL repos need HF login. */
export const HF_IMAGE_GEN_VAE_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'camenduru/FLUX.1-dev',
    title: 'FLUX.1 VAE (ae) — ungated',
    description: 'ae.safetensors mirror (no BFL license gate). Use with FLUX.1 Dev GGUF.',
    descriptionRu:
      'Зеркало ae.safetensors без gate BFL. Для FLUX.1 Dev GGUF.',
    preferredFile: 'ae.safetensors',
    sizeGb: 0.3,
    minVramGb: 4,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'Kijai/flux-fp8',
    title: 'FLUX VAE bf16 (Kijai)',
    description: 'Alternate ungated FLUX VAE — flux-vae-bf16.safetensors.',
    descriptionRu: 'Альтернативный ungated FLUX VAE — flux-vae-bf16.safetensors.',
    preferredFile: 'flux-vae-bf16.safetensors',
    sizeGb: 0.16,
    minVramGb: 4,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'black-forest-labs/FLUX.1-dev',
    title: 'FLUX.1 VAE (official, gated)',
    description:
      'Official ae.safetensors — needs Hugging Face login + accept license on the Hub.',
    descriptionRu:
      'Официальный ae.safetensors — нужен логин HF и принятие лицензии на Hub.',
    preferredFile: 'ae.safetensors',
    sizeGb: 0.3,
    minVramGb: 4,
    tags: ['imageGen']
  }
]

/** CLIP-L for FLUX.1 / SD3. */
export const HF_IMAGE_GEN_CLIP_L_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'comfyanonymous/flux_text_encoders',
    title: 'FLUX CLIP-L',
    description: 'CLIP-L for FLUX.1 (comfyanonymous pack).',
    descriptionRu: 'CLIP-L для FLUX.1 (пакет comfyanonymous).',
    preferredFile: 'clip_l.safetensors',
    sizeGb: 0.2,
    minVramGb: 4,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'Comfy-Org/stable-diffusion-3.5-fp8',
    title: 'SD3.5 CLIP-L',
    description: 'CLIP-L for SD 3.5 when using split UNet + encoders.',
    descriptionRu: 'CLIP-L для SD 3.5 при раздельном UNet + encoders.',
    preferredFile: 'text_encoders/clip_l.safetensors',
    sizeGb: 0.2,
    minVramGb: 4,
    tags: ['imageGen']
  }
]

/** CLIP-G for SD3. */
export const HF_IMAGE_GEN_CLIP_G_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'Comfy-Org/stable-diffusion-3.5-fp8',
    title: 'SD3.5 CLIP-G',
    description: 'CLIP-G for SD 3.5 split stack.',
    descriptionRu: 'CLIP-G для раздельного стека SD 3.5.',
    preferredFile: 'text_encoders/clip_g.safetensors',
    sizeGb: 1.3,
    minVramGb: 4,
    tags: ['imageGen', 'popular']
  }
]

/** T5-XXL for FLUX.1 / SD3. */
export const HF_IMAGE_GEN_T5_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'comfyanonymous/flux_text_encoders',
    title: 'FLUX T5-XXL FP8',
    description: 'T5-XXL FP8 for FLUX.1 — smaller VRAM than FP16.',
    descriptionRu: 'T5-XXL FP8 для FLUX.1 — меньше VRAM, чем FP16.',
    preferredFile: 't5xxl_fp8_e4m3fn.safetensors',
    sizeGb: 4.9,
    minVramGb: 8,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'Comfy-Org/stable-diffusion-3.5-fp8',
    title: 'SD3.5 T5-XXL FP8',
    description: 'T5-XXL for SD 3.5 split stack.',
    descriptionRu: 'T5-XXL для раздельного стека SD 3.5.',
    preferredFile: 'text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors',
    sizeGb: 4.9,
    minVramGb: 8,
    tags: ['imageGen']
  }
]

/** Text LLM for FLUX.2 (--llm). */
export const HF_IMAGE_GEN_LLM_MODELS: HfRecommendedModel[] = [
  {
    repoId: 'unsloth/Qwen3-4B-GGUF',
    title: 'Qwen3 4B (FLUX.2 Klein)',
    description: 'Text backbone for FLUX.2 Klein 4B — Q4_K_M (~2.5 GB).',
    descriptionRu: 'Текстовый бэкбон для FLUX.2 Klein 4B — Q4_K_M (~2.5 ГБ).',
    preferredFile: 'Qwen3-4B-Q4_K_M.gguf',
    sizeGb: 2.5,
    minVramGb: 6,
    tags: ['imageGen', 'popular']
  },
  {
    repoId: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF',
    title: 'Mistral Small 24B (FLUX.2 Dev)',
    description:
      'Required for full FLUX.2 Dev — heavy; use with --offload-to-cpu on 16 GB.',
    descriptionRu:
      'Нужен для полного FLUX.2 Dev — тяжёлый; на 16 ГБ с --offload-to-cpu.',
    preferredFile: 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf',
    sizeGb: 13.0,
    minVramGb: 16,
    tags: ['imageGen']
  }
]

/**
 * Top-3 staff order per VRAM tier (by preferredFile).
 * 16+: Devstral → Gemma → GPT-OSS; 12: Gemma → Qwen14 → GPT-OSS; 8: Qwen7 → Gemma9 → Llama3B
 */
export const HF_TIER_STAFF_FILES: Record<'8' | '12' | '16' | '24', string[]> = {
  '8': [
    'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    'gemma-2-9b-it-Q4_K_M.gguf',
    'Llama-3.2-3B-Instruct-Q4_K_M.gguf'
  ],
  '12': [
    'gemma4-v2-Q6_K.gguf',
    'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    'gpt-oss-20b-Q4_K_M.gguf'
  ],
  '16': [
    'Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf',
    'gemma4-v2-Q6_K.gguf',
    'gpt-oss-20b-Q4_K_M.gguf'
  ],
  '24': [
    'Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf',
    'gemma4-v2-Q6_K.gguf',
    'gpt-oss-20b-Q4_K_M.gguf'
  ]
}

export function vramTier(vramGb: number): keyof typeof HF_TIER_STAFF_FILES {
  if (vramGb < 10) return '8'
  if (vramGb < 14) return '12'
  if (vramGb < 20) return '16'
  return '24'
}

/** Downloader leaf name under modelsDir. */
export function hfLocalFileName(filename: string): string {
  return filename.replace(/[/\\]+/g, '_')
}

export function findInstalledGgufPath(
  filename: string,
  local: Array<{ path: string; id?: string }>
): string | null {
  const want = hfLocalFileName(filename).toLowerCase()
  const base = (filename.split(/[/\\]/).pop() ?? filename).toLowerCase()
  for (const m of local) {
    const leaf = m.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
    if (leaf === want || leaf === base) return m.path
    const idLeaf = (m.id ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase()
    if (idLeaf === want || idLeaf === base) return m.path
  }
  return null
}

/** Headroom when estimating full GPU offload (GiB). */
export const HF_VRAM_HEADROOM_GB = 1.5

export function classifyVramFit(
  sizeGb: number,
  vramGb: number
): HfRecommendFit {
  const budget = Math.max(1, vramGb - HF_VRAM_HEADROOM_GB)
  const ratio = sizeGb / budget
  if (ratio <= 0.55) return 'comfortable'
  if (ratio <= 0.88) return 'ideal'
  if (ratio <= 1.05) return 'tight'
  return 'heavy'
}

/** Curated picks for VRAM: tier staff pins first, then hardware score. */
export function selectRecommendedForVram(
  vramGb: number | null | undefined,
  limit = 6
): Array<HfRecommendedModel & { fit: HfRecommendFit; score: number }> {
  const vram = vramGb && vramGb > 0 ? vramGb : 12
  const budget = Math.max(1, vram - HF_VRAM_HEADROOM_GB)
  const tier = vramTier(vram)

  const withFit = (m: HfRecommendedModel): HfRecommendedModel & {
    fit: HfRecommendFit
    score: number
  } => {
    const fit = classifyVramFit(m.sizeGb, vram)
    let score = 0
    if (fit === 'ideal') score += 100
    else if (fit === 'comfortable') score += 70
    else if (fit === 'tight') score += 35
    else score -= 40

    const util = Math.min(1, m.sizeGb / budget)
    score += util * 25

    if (m.tags.includes('coding')) score += 18
    if (m.tags.includes('agent')) score += 14
    if (m.tags.includes('popular')) score += 8

    if (vram < m.minVramGb) score -= (m.minVramGb - vram) * 12

    return { ...m, fit, score }
  }

  const picked: Array<HfRecommendedModel & { fit: HfRecommendFit; score: number }> =
    []
  const seenFiles = new Set<string>()
  const seenRepos = new Set<string>()

  const tryAdd = (
    m: HfRecommendedModel & { fit: HfRecommendFit; score: number },
    opts: { allowHeavy?: boolean; allowSameRepo?: boolean } = {}
  ): void => {
    if (picked.length >= limit) return
    if (m.fit === 'heavy' && !opts.allowHeavy) {
      // Staff pin OK if file roughly fits raw VRAM
      if (m.sizeGb > vram) return
    }
    const fileKey = `${m.repoId}::${m.preferredFile}`
    if (seenFiles.has(fileKey)) return
    if (seenRepos.has(m.repoId) && !opts.allowSameRepo) return
    seenFiles.add(fileKey)
    seenRepos.add(m.repoId)
    picked.push(m)
  }

  // Tier staff order
  for (const file of HF_TIER_STAFF_FILES[tier]) {
    const hit = HF_RECOMMENDED_MODELS.find((m) => m.preferredFile === file)
    if (hit) tryAdd(withFit(hit), { allowSameRepo: true })
  }

  // Fill by hardware score
  const scored = HF_RECOMMENDED_MODELS.map(withFit).sort((a, b) => b.score - a.score)
  for (const m of scored) {
    if (picked.length >= limit) break
    tryAdd(m, { allowHeavy: picked.length >= 3 })
  }

  // At least one small/fast option when VRAM is mid/high
  if (vram >= 8 && !picked.some((p) => p.sizeGb <= 5.5)) {
    const small = scored.find((s) => s.sizeGb <= 5.5 && s.fit !== 'heavy')
    if (small) {
      const fileKey = `${small.repoId}::${small.preferredFile}`
      if (!seenFiles.has(fileKey)) {
        const lastIdx = [...picked]
          .map((p, i) => ({ p, i }))
          .reverse()
          .find((x) => !HF_TIER_STAFF_FILES[tier].includes(x.p.preferredFile))?.i
        if (lastIdx != null) {
          const removed = picked[lastIdx]
          seenFiles.delete(`${removed.repoId}::${removed.preferredFile}`)
          seenRepos.delete(removed.repoId)
          picked.splice(lastIdx, 1)
        }
        tryAdd(small, { allowSameRepo: true })
      }
    }
  }

  return picked.slice(0, limit)
}

export interface HfModelListItem {
  id: string
  downloads: number
  likes: number
  lastModified?: string
  pipeline_tag?: string | null
  tags?: string[]
  recommended?: boolean
  avatarUrl?: string | null
  description?: string
  fit?: HfRecommendFit
  sizeGb?: number
  preferredFile?: string
  recommendReason?: string
  installed?: boolean
  installedPath?: string
  brand?: string
}

export interface HfRepoFile {
  path: string
  size: number
  oid?: string
  installed?: boolean
  installedPath?: string
}

export interface HfModelDetail {
  id: string
  downloads: number
  likes: number
  lastModified?: string
  pipeline_tag?: string | null
  tags?: string[]
  description?: string
  avatarUrl?: string | null
  ggufFiles: HfRepoFile[]
  recommended?: boolean
  preferredFile?: string
  fit?: HfRecommendFit
  sizeGb?: number
  /** README body, frontmatter stripped */
  readmeMarkdown?: string
  brand?: string
}

export type HfDownloadStatus =
  | 'downloading'
  | 'paused'
  | 'done'
  | 'error'
  | 'cancelled'

export interface HfDownloadProgress {
  id: string
  repoId: string
  filename: string
  bytesReceived: number
  bytesTotal: number
  fraction: number
  status: HfDownloadStatus
  /** Smoothed B/s; 0 when idle */
  bytesPerSecond?: number
  etaSeconds?: number | null
  destPath?: string
  partialPath?: string
  error?: string
  avatarUrl?: string | null
  updatedAt?: number
}

export interface HfSearchParams {
  query?: string
  limit?: number
}

export interface HfStoreHomeResult {
  gpu: GpuInfo | null
  items: HfModelListItem[]
}
