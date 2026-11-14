import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

export const CHAT_IMAGE_MAX_COUNT = 4
export const CHAT_IMAGE_MAX_BYTES = 12 * 1024 * 1024

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])

export type ChatImageMeta = {
  id: string
  path: string
  mime: string
  name?: string
}

export function chatImagesRoot(): string {
  return join(app.getPath('userData'), 'chat-images')
}

export function sessionImageDir(sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return join(chatImagesRoot(), safe || 'unknown')
}

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.webp') return 'image/webp'
  if (e === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.bin'
}

/** Copy a local image into userData/chat-images/{sessionId}/. */
export async function importChatImage(params: {
  sessionId: string
  sourcePath?: string
  dataBase64?: string
  mime?: string
  name?: string
}): Promise<ChatImageMeta> {
  const dir = sessionImageDir(params.sessionId)
  mkdirSync(dir, { recursive: true })

  let buf: Buffer
  let mime = params.mime || ''
  let name = params.name

  if (params.sourcePath?.trim()) {
    const src = params.sourcePath.trim()
    if (!existsSync(src)) throw new Error(`Image not found: ${src}`)
    buf = await fs.readFile(src)
    name = name || basename(src)
    mime = mime || mimeFromExt(extname(src))
  } else if (params.dataBase64?.trim()) {
    const raw = params.dataBase64.trim().replace(/^data:[^;]+;base64,/, '')
    buf = Buffer.from(raw, 'base64')
    mime = mime || 'image/png'
    name = name || `paste${extFromMime(mime)}`
  } else {
    throw new Error('sourcePath or dataBase64 required')
  }

  if (buf.length > CHAT_IMAGE_MAX_BYTES) {
    throw new Error(`Image too large (max ${Math.round(CHAT_IMAGE_MAX_BYTES / 1024 / 1024)}MB)`)
  }
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_MIME.has(mime.replace('image/jpg', 'image/jpeg'))) {
    // normalize jpg
    if (mime === 'image/jpg') mime = 'image/jpeg'
    else throw new Error(`Unsupported image type: ${mime}`)
  }
  if (mime === 'image/jpg') mime = 'image/jpeg'

  const id = randomUUID()
  const dest = join(dir, `${id}${extFromMime(mime)}`)
  await fs.writeFile(dest, buf)
  return { id, path: dest, mime, ...(name ? { name } : {}) }
}

export async function readChatImageDataUrl(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath)
  const mime = mimeFromExt(extname(absPath))
  return `data:${mime};base64,${buf.toString('base64')}`
}
