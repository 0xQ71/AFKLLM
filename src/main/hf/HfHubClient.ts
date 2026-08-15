import {
  HF_APPLY_RECOMMENDED_MODELS,
  HF_IMAGE_GEN_CLIP_G_MODELS,
  HF_IMAGE_GEN_CLIP_L_MODELS,
  HF_IMAGE_GEN_LLM_MODELS,
  HF_IMAGE_GEN_RECOMMENDED_MODELS,
  HF_IMAGE_GEN_T5_MODELS,
  HF_IMAGE_GEN_VAE_MODELS,
  HF_RECOMMENDED_MODELS,
  HF_VISION_RECOMMENDED_MODELS,
  findInstalledGgufPath,
  isImageGenStoreTarget,
  selectRecommendedForVram,
  type GpuInfo,
  type HfModelDetail,
  type HfModelListItem,
  type HfRecommendedModel,
  type HfRepoFile,
  type HfSearchParams,
  type HfStoreHomeResult,
  type StoreDownloadTarget
} from '../../shared/hfStore'
import { detectModelBrand } from '../../shared/modelBrand'
import { detectGpuInfo } from '../hardware/GpuInfo'

const HF_API = 'https://huggingface.co/api'
const UA = 'AFKLLM/0.1 (local IDE; model store)'

const thumbnailCache = new Map<string, string | null>()
const blurbCache = new Map<string, string | undefined>()
const readmeCache = new Map<string, string | undefined>()

function stripYamlFrontmatter(text: string): string {
  let body = text.replace(/^\uFEFF/, '')
  if (/^---\r?\n/.test(body)) {
    const end = body.search(/\r?\n---\r?\n/)
    if (end >= 0) body = body.slice(end).replace(/^\r?\n---\r?\n/, '')
  }
  return body.trim()
}

async function hfJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': UA
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `HF API ${res.status}: repo gated or unavailable (sign in / accept license on the Hub).`
      )
    }
    if (res.status === 404) {
      throw new Error(`HF API 404: model not found — check the repo id.`)
    }
    throw new Error(`HF API ${res.status}: ${body.slice(0, 200) || res.statusText}`)
  }
  return (await res.json()) as T
}

function markRecommended(
  id: string,
  preferredFile?: string,
  catalog: HfRecommendedModel[] = HF_RECOMMENDED_MODELS,
  target: StoreDownloadTarget = 'chat'
): {
  recommended: boolean
  preferredFile?: string
  description?: string
  sizeGb?: number
} {
  const hits = catalog.filter((r) => r.repoId === id)
  if (!hits.length) return { recommended: false }
  const hit =
    (preferredFile
      ? hits.find(
          (h) =>
            h.preferredFile === preferredFile ||
            h.preferredMmproj === preferredFile
        )
      : undefined) ?? hits[0]
  const preferred =
    target === 'mmproj'
      ? (hit.preferredMmproj ?? hit.preferredFile)
      : hit.preferredFile
  return {
    recommended: true,
    preferredFile: preferred,
    description: hit.description,
    sizeGb: hit.sizeGb
  }
}

function catalogForTarget(target: StoreDownloadTarget): HfRecommendedModel[] {
  if (target === 'apply') return HF_APPLY_RECOMMENDED_MODELS
  if (target === 'vision' || target === 'mmproj') return HF_VISION_RECOMMENDED_MODELS
  if (target === 'imageGen') return HF_IMAGE_GEN_RECOMMENDED_MODELS
  if (target === 'imageGenVae') return HF_IMAGE_GEN_VAE_MODELS
  if (target === 'imageGenClipL') return HF_IMAGE_GEN_CLIP_L_MODELS
  if (target === 'imageGenClipG') return HF_IMAGE_GEN_CLIP_G_MODELS
  if (target === 'imageGenT5') return HF_IMAGE_GEN_T5_MODELS
  if (target === 'imageGenLlm') return HF_IMAGE_GEN_LLM_MODELS
  return HF_RECOMMENDED_MODELS
}

function acceptWeightFile(path: string, target: StoreDownloadTarget): boolean {
  const lower = path.toLowerCase()
  const base = lower.split(/[/\\]/).pop() ?? lower
  const isGguf = lower.endsWith('.gguf')
  const isMmproj = isGguf && /mmproj/i.test(path)
  const isSt =
    lower.endsWith('.safetensors') || lower.endsWith('.ckpt') || lower.endsWith('.sft')

  if (target === 'mmproj') return isMmproj

  if (target === 'imageGenVae') {
    if (!(isSt || isGguf)) return false
    return (
      /^ae(\.|$)/i.test(base) ||
      /vae/i.test(base) ||
      /flux2_ae/i.test(base) ||
      /\/vae\//i.test(lower)
    )
  }
  if (target === 'imageGenClipL') {
    return isSt && /clip_l/i.test(base)
  }
  if (target === 'imageGenClipG') {
    return isSt && /clip_g/i.test(base)
  }
  if (target === 'imageGenT5') {
    return isSt && /t5xxl/i.test(base)
  }
  if (target === 'imageGenLlm') {
    return isGguf && !isMmproj
  }

  if (target === 'imageGen') {
    if (isMmproj) return false
    if (isGguf) {
      // Skip text-encoder GGUFs parked in diffusion repos
      if (/^(clip_|t5xxl)/i.test(base)) return false
      return true
    }
    if (isSt) {
      if (
        /vae|text_encoder|tokenizer|scheduler|openai_clip|open_clip|lora|embedding|clip_[lg]|t5xxl|^ae\.safetensors/i.test(
          lower
        )
      ) {
        // Allow all-in-one packs that embed clips in the filename
        if (/incl_clips|includes?_clip|all.?in.?one/i.test(base)) return true
        return false
      }
      return true
    }
    return false
  }

  // chat / vision: chat weights only (skip mmproj side-cars)
  return isGguf && !isMmproj
}

/** Social thumbnail URL (not author avatar). */
export function modelThumbnailUrl(repoId: string): string {
  const id = repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/\?.*$/, '')
  return `https://cdn-thumbnails.huggingface.co/social-thumbnails/models/${id}.png`
}

/** Kept for downloads history; UI brand tiles prefer family icons. */
export async function resolveAvatarUrl(repoId: string): Promise<string | null> {
  const id = repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/\?.*$/, '')
  if (!id) return null
  if (thumbnailCache.has(id)) return thumbnailCache.get(id) ?? null
  const url = modelThumbnailUrl(id)
  thumbnailCache.set(id, url)
  return url
}

function pathId(repoId: string): string {
  return repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/\?.*$/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join('/')
}

function annotateInstalled(
  item: HfModelListItem,
  local: Array<{ path: string; id: string }>
): HfModelListItem {
  if (!item.preferredFile || !local.length) return item
  const path = findInstalledGgufPath(item.preferredFile, local)
  if (!path) return item
  return { ...item, installed: true, installedPath: path }
}

export async function searchHfGgufModels(
  params: HfSearchParams = {},
  localModels: Array<{ path: string; id: string }> = [],
  target: StoreDownloadTarget = 'chat'
): Promise<HfModelListItem[]> {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 50)
  const q = (params.query ?? '').trim()
  const sp = new URLSearchParams()
  if (target === 'imageGen') {
    // Prefer GGUF diffusion weights (sd.cpp); plain text-to-image hubs are often Diffusers-only.
    sp.set('filter', 'gguf')
    sp.set('search', q || 'FLUX SDXL "stable-diffusion-3.5" OR sdxl OR flux')
  } else if (target === 'imageGenVae') {
    sp.set('search', q || 'FLUX ae.safetensors VAE')
  } else if (target === 'imageGenClipL' || target === 'imageGenClipG') {
    sp.set('search', q || 'flux_text_encoders clip stable-diffusion-3.5')
  } else if (target === 'imageGenT5') {
    sp.set('search', q || 't5xxl flux_text_encoders')
  } else if (target === 'imageGenLlm') {
    sp.set('filter', 'gguf')
    sp.set('search', q || 'Qwen3-4B OR Mistral-Small-3.2')
  } else if (target === 'mmproj') {
    sp.set('filter', 'gguf')
    sp.set('search', q || 'Qwen3-VL MiniCPM-V gemma-3 VL vision')
  } else if (target === 'vision') {
    sp.set('filter', 'gguf')
    sp.set('search', q || 'Qwen3-VL MiniCPM-V gemma-3 VL vision')
  } else {
    sp.set('filter', 'gguf')
    if (q) sp.set('search', q)
  }
  sp.set('sort', 'downloads')
  sp.set('direction', '-1')
  sp.set('limit', String(limit))

  type Raw = {
    id: string
    downloads?: number
    likes?: number
    lastModified?: string
    pipeline_tag?: string | null
    tags?: string[]
  }

  const raw = await hfJson<Raw[]>(`${HF_API}/models?${sp.toString()}`)
  const catalog = catalogForTarget(target)
  const items = await Promise.all(
    raw.map(async (m) => {
      const rec = markRecommended(m.id, undefined, catalog, target)
      const [avatarUrl, readme] = await Promise.all([
        resolveAvatarUrl(m.id).catch(() => null),
        fetchReadmeBlurb(m.id).catch(() => undefined)
      ])
      const item: HfModelListItem = {
        id: m.id,
        downloads: m.downloads ?? 0,
        likes: m.likes ?? 0,
        lastModified: m.lastModified,
        pipeline_tag: m.pipeline_tag ?? null,
        tags: m.tags,
        recommended: rec.recommended,
        description: readme || rec.description,
        preferredFile: rec.preferredFile,
        sizeGb: rec.sizeGb,
        avatarUrl,
        brand: detectModelBrand(m.id, (m.tags ?? []).join(' '))
      }
      return annotateInstalled(item, localModels)
    })
  )
  return items
}

/** Curated picks for detected VRAM (coding/agent + popular). */
export async function listRecommendedModels(
  gpu?: GpuInfo | null,
  localModels: Array<{ path: string; id: string }> = []
): Promise<HfModelListItem[]> {
  const info = gpu === undefined ? await detectGpuInfo() : gpu
  const picks = selectRecommendedForVram(info?.vramGb ?? null, 6, info?.name)
  return Promise.all(
    picks.map(async (r) => {
      const [avatarUrl, readme] = await Promise.all([
        resolveAvatarUrl(r.repoId).catch(() => null),
        fetchReadmeBlurb(r.repoId).catch(() => undefined)
      ])
      const item: HfModelListItem = {
        id: r.repoId,
        downloads: 0,
        likes: 0,
        recommended: true,
        pipeline_tag: 'text-generation',
        tags: ['gguf', ...r.tags],
        description: readme || r.description,
        avatarUrl,
        fit: r.fit,
        sizeGb: r.sizeGb,
        preferredFile: r.preferredFile,
        recommendReason: 'hardware',
        brand: detectModelBrand(r.repoId, r.title)
      }
      return annotateInstalled(item, localModels)
    })
  )
}

/** Empty-search home: GPU picks first, then popular Hub models (deduped). */
export async function listStoreHome(
  localModels: Array<{ path: string; id: string }> = [],
  target: StoreDownloadTarget = 'chat'
): Promise<HfStoreHomeResult> {
  const gpu = await detectGpuInfo()
  const catalog = catalogForTarget(target)
  let picks: HfModelListItem[]
  if (target === 'chat') {
    picks = await listRecommendedModels(gpu, localModels)
  } else {
    picks = await Promise.all(
      catalog.slice(0, 8).map(async (r) => {
        const [avatarUrl, readme] = await Promise.all([
          resolveAvatarUrl(r.repoId).catch(() => null),
          fetchReadmeBlurb(r.repoId).catch(() => undefined)
        ])
        const preferredFile =
          target === 'mmproj'
            ? (r.preferredMmproj ?? r.preferredFile)
            : r.preferredFile
        const item: HfModelListItem = {
          id: r.repoId,
          downloads: 0,
          likes: 0,
          recommended: true,
          pipeline_tag: isImageGenStoreTarget(target)
            ? 'text-to-image'
            : target === 'vision' || target === 'mmproj'
              ? 'image-text-to-text'
              : 'text-generation',
          tags: [...r.tags],
          description: readme || r.description,
          avatarUrl,
          sizeGb: r.sizeGb,
          preferredFile,
          recommendReason: 'hardware',
          brand: detectModelBrand(r.repoId, r.title)
        }
        return annotateInstalled(item, localModels)
      })
    )
  }
  const seen = new Set(picks.map((p) => p.id))
  try {
    const top = await searchHfGgufModels({ limit: 20 }, localModels, target)
    const popular = top
      .filter((m) => !seen.has(m.id))
      .slice(0, 16)
      .map((m) => ({
        ...m,
        recommendReason: m.recommended ? m.recommendReason : 'popular'
      }))
    return { gpu, items: [...picks, ...popular] }
  } catch {
    return { gpu, items: picks }
  }
}

/** First useful README paragraphs after stripping YAML/HTML noise. */
export function parseReadmeBlurb(text: string): string | undefined {
  let body = text.replace(/^\uFEFF/, '')
  if (/^---\r?\n/.test(body)) {
    const end = body.search(/\r?\n---\r?\n/)
    if (end >= 0) body = body.slice(end).replace(/^\r?\n---\r?\n/, '')
  }
  // Drop HTML blocks/tags (Unsloth banners etc.)
  body = body.replace(/<div[\s\S]*?<\/div>/gi, '\n')
  body = body.replace(/<[^>]+>/g, ' ')

  const isPromo = (s: string): boolean =>
    /read our|see our collection|unsloth dynamic|learn to run|google colab|unsloth\.ai\/blog|view the rest of our notebooks|thank you to the llama|try gpt-oss|system card|openai blog|fine-tune gpt-oss|discord\.gg/i.test(
      s
    )

  const lines = body.split(/\r?\n/)
  const chunks: string[] = []
  let inFence = false
  for (const line of lines) {
    const raw = line.trim()
    if (raw.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!raw) {
      if (chunks.join(' ').length >= 180) break
      continue
    }
    if (
      raw.startsWith('|') ||
      raw.startsWith('[!') ||
      raw.startsWith('<!--') ||
      /^[-*_]{3,}$/.test(raw)
    ) {
      continue
    }

    // Skip leading bullet farms until we have a real paragraph
    if (
      (raw.startsWith('- ') || raw.startsWith('* ')) &&
      chunks.join(' ').length < 100
    ) {
      continue
    }

    const clean = raw
      .replace(/^#+\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!clean || isPromo(clean)) continue
    if (clean.length < 24 && chunks.length === 0) continue
    // Skip quant footnotes before the real intro
    if (
      chunks.length === 0 &&
      /^(the f\d+ quant|gpt-oss-\d+b details|guides\b|highlights\b)/i.test(clean)
    ) {
      continue
    }
    chunks.push(clean)
    if (chunks.join(' ').length > 420) break
  }

  const blurb = chunks.join(' ').trim()
  if (!blurb) return undefined
  return blurb.slice(0, 480)
}

async function fetchReadmeBlurb(repoId: string): Promise<string | undefined> {
  if (blurbCache.has(repoId)) return blurbCache.get(repoId)
  const raw = await fetchReadmeRaw(repoId)
  const out = raw ? parseReadmeBlurb(raw) : undefined
  blurbCache.set(repoId, out)
  return out
}

async function fetchReadmeRaw(repoId: string): Promise<string | undefined> {
  if (readmeCache.has(repoId)) return readmeCache.get(repoId)
  try {
    const res = await fetch(`https://huggingface.co/${repoId}/raw/main/README.md`, {
      headers: { 'User-Agent': UA, Accept: 'text/plain' }
    })
    if (!res.ok) {
      readmeCache.set(repoId, undefined)
      return undefined
    }
    const text = await res.text()
    readmeCache.set(repoId, text)
    return text
  } catch {
    readmeCache.set(repoId, undefined)
    return undefined
  }
}

export async function getHfModelDetail(
  repoId: string,
  preferredFileHint?: string,
  localModels: Array<{ path: string; id: string }> = [],
  target: StoreDownloadTarget = 'chat'
): Promise<HfModelDetail> {
  const id = repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/\?.*$/, '')
  const pid = pathId(id)

  type RawModel = {
    id: string
    downloads?: number
    likes?: number
    lastModified?: string
    pipeline_tag?: string | null
    tags?: string[]
    cardData?: { description?: string; base_model?: string | string[] }
  }
  type RawFile = {
    type?: string
    path: string
    size?: number
    oid?: string
    lfs?: { size?: number; oid?: string }
  }

  const [meta, tree, avatarUrl, readmeRaw] = await Promise.all([
    hfJson<RawModel>(`${HF_API}/models/${pid}`),
    hfJson<RawFile[]>(`${HF_API}/models/${pid}/tree/main?recursive=1`),
    resolveAvatarUrl(id),
    fetchReadmeRaw(id)
  ])

  const ggufFiles: HfRepoFile[] = []
  for (const f of tree) {
    if (f.type === 'directory') continue
    if (!acceptWeightFile(f.path, target)) continue
    const size = f.lfs?.size ?? f.size ?? 0
    const installedPath = findInstalledGgufPath(f.path, localModels)
    ggufFiles.push({
      path: f.path,
      size,
      oid: f.lfs?.oid ?? f.oid,
      installed: Boolean(installedPath),
      installedPath: installedPath ?? undefined
    })
  }
  ggufFiles.sort((a, b) => a.size - b.size)

  const catalog = catalogForTarget(target)
  const rec = markRecommended(meta.id || id, preferredFileHint, catalog, target)
  const readmeBlurb = readmeRaw ? parseReadmeBlurb(readmeRaw) : undefined
  const description =
    readmeBlurb ||
    meta.cardData?.description?.trim() ||
    rec.description ||
    undefined

  const preferredFile =
    preferredFileHint && ggufFiles.some((f) => f.path === preferredFileHint)
      ? preferredFileHint
      : rec.preferredFile && ggufFiles.some((f) => f.path === rec.preferredFile)
        ? rec.preferredFile
        : undefined

  const baseHint = Array.isArray(meta.cardData?.base_model)
    ? meta.cardData.base_model.join(' ')
    : meta.cardData?.base_model

  const readmeMarkdown = readmeRaw
    ? stripYamlFrontmatter(readmeRaw)
        .replace(/<div[\s\S]*?<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim()
    : undefined

  return {
    id: meta.id || id,
    downloads: meta.downloads ?? 0,
    likes: meta.likes ?? 0,
    lastModified: meta.lastModified,
    pipeline_tag: meta.pipeline_tag ?? null,
    tags: meta.tags,
    description,
    avatarUrl,
    ggufFiles,
    recommended: rec.recommended,
    preferredFile,
    sizeGb: rec.sizeGb,
    readmeMarkdown,
    brand: detectModelBrand(
      meta.id || id,
      `${baseHint ?? ''} ${(meta.tags ?? []).join(' ')}`
    )
  }
}

export function hfResolveUrl(repoId: string, filename: string): string {
  const base = `https://huggingface.co/${repoId}/resolve/main/`
  const parts = filename.split('/').map((p) => encodeURIComponent(p))
  return base + parts.join('/')
}
