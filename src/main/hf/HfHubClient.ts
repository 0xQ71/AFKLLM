import {
  HF_RECOMMENDED_MODELS,
  findInstalledGgufPath,
  selectRecommendedForVram,
  type GpuInfo,
  type HfModelDetail,
  type HfModelListItem,
  type HfRepoFile,
  type HfSearchParams,
  type HfStoreHomeResult
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
    throw new Error(`HF API ${res.status}: ${body.slice(0, 200) || res.statusText}`)
  }
  return (await res.json()) as T
}

function markRecommended(
  id: string,
  preferredFile?: string
): {
  recommended: boolean
  preferredFile?: string
  description?: string
  sizeGb?: number
} {
  const hits = HF_RECOMMENDED_MODELS.filter((r) => r.repoId === id)
  if (!hits.length) return { recommended: false }
  const hit =
    (preferredFile
      ? hits.find((h) => h.preferredFile === preferredFile)
      : undefined) ?? hits[0]
  return {
    recommended: true,
    preferredFile: hit.preferredFile,
    description: hit.description,
    sizeGb: hit.sizeGb
  }
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
  localModels: Array<{ path: string; id: string }> = []
): Promise<HfModelListItem[]> {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 50)
  const q = (params.query ?? '').trim()
  const sp = new URLSearchParams()
  sp.set('filter', 'gguf')
  sp.set('sort', 'downloads')
  sp.set('direction', '-1')
  sp.set('limit', String(limit))
  if (q) sp.set('search', q)

  type Raw = {
    id: string
    downloads?: number
    likes?: number
    lastModified?: string
    pipeline_tag?: string | null
    tags?: string[]
  }

  const raw = await hfJson<Raw[]>(`${HF_API}/models?${sp.toString()}`)
  const items = await Promise.all(
    raw.map(async (m) => {
      const rec = markRecommended(m.id)
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
  const picks = selectRecommendedForVram(info?.vramGb ?? null, 6)
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

/** Empty-search home: GPU picks first, then popular Hub GGUF (deduped). */
export async function listStoreHome(
  localModels: Array<{ path: string; id: string }> = []
): Promise<HfStoreHomeResult> {
  const gpu = await detectGpuInfo()
  const picks = await listRecommendedModels(gpu, localModels)
  const seen = new Set(picks.map((p) => p.id))
  try {
    const top = await searchHfGgufModels({ limit: 20 }, localModels)
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
  localModels: Array<{ path: string; id: string }> = []
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
    if (!f.path.toLowerCase().endsWith('.gguf')) continue
    if (/mmproj/i.test(f.path)) continue
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

  const rec = markRecommended(meta.id || id, preferredFileHint)
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
