/**
 * Best-effort EN→RU translation for HF store blurbs + README markdown.
 * Uses MyMemory (no API key). Falls back to the original when offline / rate-limited.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const UA = 'AFKLLM/0.1 (local IDE; store translate)'
const TIMEOUT_MS = 8_000
const MAX_CHARS = 480
/** Cap API calls per README so store stays responsive. */
const MAX_README_CALLS = 24
const MAX_README_SRC = 14_000

let cacheDir: string | null = null
const memory = new Map<string, string>()

export function setTranslateCacheDir(dir: string): void {
  cacheDir = dir
}

export function looksMostlyCyrillic(text: string): boolean {
  const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/g, '')
  if (!letters) return false
  const cyr = (letters.match(/[А-Яа-яЁё]/g) ?? []).length
  return cyr / letters.length >= 0.35
}

function cacheKey(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 32)
}

async function readDisk(key: string): Promise<string | null> {
  if (!cacheDir) return null
  try {
    const raw = await fs.readFile(join(cacheDir, `${key}.json`), 'utf8')
    const parsed = JSON.parse(raw) as { text?: string }
    return typeof parsed.text === 'string' ? parsed.text : null
  } catch {
    return null
  }
}

async function writeDisk(key: string, text: string): Promise<void> {
  if (!cacheDir) return
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ text }), 'utf8')
  } catch {
    /* ignore */
  }
}

/** Translate English store blurb to Russian; return original on failure / offline. */
export async function translateEnToRu(text: string): Promise<string> {
  const src = text.trim().slice(0, MAX_CHARS)
  if (!src) return text
  if (looksMostlyCyrillic(src)) return src

  const key = cacheKey(src)
  const mem = memory.get(key)
  if (mem) return mem
  const disk = await readDisk(key)
  if (disk) {
    memory.set(key, disk)
    return disk
  }

  try {
    const url =
      'https://api.mymemory.translated.net/get?' +
      new URLSearchParams({ q: src, langpair: 'en|ru' }).toString()
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return src
    const json = (await res.json()) as {
      responseStatus?: number | string
      responseData?: { translatedText?: string }
    }
    const status = Number(json.responseStatus)
    const out = json.responseData?.translatedText?.trim()
    if (!out || (Number.isFinite(status) && status !== 200)) return src
    if (/^MYMEMORY WARNING/i.test(out) || out === src) return src
    memory.set(key, out)
    void writeDisk(key, out)
    return out
  } catch {
    return src
  }
}

type MdSeg = { kind: 'code' | 'text'; text: string }

/** Split markdown so fenced code stays untranslated. Exported for smoke tests. */
export function splitMarkdownForTranslate(md: string): MdSeg[] {
  const parts: MdSeg[] = []
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    if (m.index > last) parts.push({ kind: 'text', text: md.slice(last, m.index) })
    parts.push({ kind: 'code', text: m[0]! })
    last = m.index + m[0]!.length
  }
  if (last < md.length) parts.push({ kind: 'text', text: md.slice(last) })
  return parts
}

/** Break long text into ≤maxLen pieces on paragraph / sentence boundaries. */
export function chunkForTranslate(text: string, maxLen = MAX_CHARS): string[] {
  if (text.length <= maxLen) return text ? [text] : []
  const out: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n\n', maxLen)
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf('\n', maxLen)
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf('. ', maxLen)
    if (cut < maxLen * 0.4) cut = maxLen
    else cut = cut + (rest[cut] === '.' ? 2 : 1)
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Translate README-like markdown EN→RU. Code fences kept as-is.
 * Caps work with MAX_README_CALLS; leftover English text stays.
 */
export async function translateMarkdownEnToRu(markdown: string): Promise<string> {
  const md = markdown.replace(/\r\n/g, '\n')
  if (!md.trim()) return markdown
  if (looksMostlyCyrillic(md.slice(0, 500))) return markdown

  const truncated = md.length > MAX_README_SRC
  const body = truncated ? md.slice(0, MAX_README_SRC) : md
  const remainder = truncated ? md.slice(MAX_README_SRC) : ''

  const segs = splitMarkdownForTranslate(body)
  let calls = 0
  const out: string[] = []

  for (const seg of segs) {
    if (seg.kind === 'code') {
      out.push(seg.text)
      continue
    }
    // Preserve leading/trailing whitespace around translated chunks
    const chunks = chunkForTranslate(seg.text, MAX_CHARS)
    if (chunks.length === 0) {
      out.push(seg.text)
      continue
    }
    for (const chunk of chunks) {
      if (!/[A-Za-z]{3,}/.test(chunk)) {
        out.push(chunk)
        continue
      }
      if (calls >= MAX_README_CALLS) {
        out.push(chunk)
        continue
      }
      calls++
      out.push(await translateEnToRu(chunk))
    }
  }

  let result = out.join('')
  if (remainder) result += remainder
  return result
}
