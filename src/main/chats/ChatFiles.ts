import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { importChatImage, type ChatImageMeta } from './ChatImages'
import { importChatDocument } from './ChatDocuments'

export const CHAT_FILE_MAX_COUNT = 8
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024
export const CHAT_FILE_TEXT_MAX = 28_000

export type ChatFileKind = 'image' | 'pdf' | 'docx' | 'text' | 'binary'

export type ChatFileResult = {
  id: string
  path: string
  mime: string
  name: string
  /** Uppercase extension for UI badge, e.g. PDF / TS / ZIP */
  extLabel: string
  kind: ChatFileKind
  /** Extracted / decoded text for agent context (when available). */
  text?: string
  pageImages?: ChatImageMeta[]
  note?: string
  /** Present when kind === 'image' (chat-images copy). */
  image?: ChatImageMeta
}

function chatFilesRoot(): string {
  return join(app.getPath('userData'), 'chat-files')
}

function sessionFileDir(sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return join(chatFilesRoot(), safe || 'unknown')
}

function extLabelFromName(name: string): string {
  const e = extname(name).replace(/^\./, '').toUpperCase()
  if (!e) return 'FILE'
  return e.length > 5 ? e.slice(0, 5) : e
}

function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const e = extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.js': 'text/javascript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.css': 'text/css',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
    '.toml': 'text/toml',
    '.sh': 'text/x-shellscript',
    '.bat': 'text/plain',
    '.ps1': 'text/plain',
    '.sql': 'application/sql',
    '.log': 'text/plain'
  }
  return map[e] || fallback
}

function isImageName(name: string, mime?: string): boolean {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(name)
}

function isPdfName(name: string, mime?: string): boolean {
  const m = (mime || '').toLowerCase()
  return m === 'application/pdf' || m === 'application/x-pdf' || /\.pdf$/i.test(name)
}

function isDocxName(name: string, mime?: string): boolean {
  const m = (mime || '').toLowerCase()
  return (
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(name)
  )
}

function isLegacyDocName(name: string, mime?: string): boolean {
  const m = (mime || '').toLowerCase()
  return m === 'application/msword' || /\.doc$/i.test(name)
}

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.bat',
  '.cmd',
  '.ps1',
  '.sql',
  '.log',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.vue',
  '.svelte',
  '.astro',
  '.php',
  '.rb',
  '.swift',
  '.r',
  '.lua',
  '.pl',
  '.gradle',
  '.properties',
  '.gradle.kts'
])

function looksLikeText(name: string, mime?: string, buf?: Buffer): boolean {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('text/')) return true
  if (
    m.includes('json') ||
    m.includes('xml') ||
    m.includes('javascript') ||
    m.includes('typescript') ||
    m.includes('yaml')
  ) {
    return true
  }
  const e = extname(name).toLowerCase()
  if (TEXT_EXTS.has(e)) return true
  if (!buf || buf.length === 0) return false
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  let weird = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i]!
    if (c === 0) return false
    if (c < 7 || (c > 14 && c < 32 && c !== 9 && c !== 10 && c !== 13)) weird++
  }
  return weird / sample.length < 0.02
}

function truncateText(text: string, max = CHAT_FILE_TEXT_MAX): string {
  const t = text.replace(/\r\n/g, '\n').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…`
}

/**
 * Import any file for chat: images / PDF / DOCX / text / binary copy.
 */
export async function importChatFile(params: {
  sessionId: string
  sourcePath?: string
  dataBase64?: string
  mime?: string
  name?: string
}): Promise<ChatFileResult> {
  let name = params.name?.trim() || ''
  let mime = (params.mime || '').trim()
  let sourcePath = params.sourcePath?.trim() || ''

  if (sourcePath) {
    if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`)
    name = name || basename(sourcePath)
  } else if (params.dataBase64?.trim()) {
    name = name || 'paste.bin'
  } else {
    throw new Error('sourcePath or dataBase64 required')
  }

  if (!mime || mime === 'application/octet-stream') {
    mime = mimeFromName(name, mime || 'application/octet-stream')
  }

  if (isLegacyDocName(name, mime)) {
    throw new Error(
      'Legacy .doc is not supported. Save as .docx in Word / LibreOffice and attach again.'
    )
  }

  // Images → chat-images pipeline
  if (isImageName(name, mime)) {
    const image = await importChatImage({
      sessionId: params.sessionId,
      sourcePath: sourcePath || undefined,
      dataBase64: sourcePath ? undefined : params.dataBase64,
      mime,
      name
    })
    return {
      id: image.id,
      path: image.path,
      mime: image.mime,
      name: image.name || name,
      extLabel: extLabelFromName(image.name || name),
      kind: 'image',
      image
    }
  }

  // PDF / DOCX → existing document extract
  if (isPdfName(name, mime) || isDocxName(name, mime)) {
    const doc = await importChatDocument({
      sessionId: params.sessionId,
      sourcePath: sourcePath || undefined,
      dataBase64: sourcePath ? undefined : params.dataBase64,
      mime,
      name
    })
    return {
      id: doc.id,
      path: doc.path,
      mime: doc.mime,
      name: doc.name,
      extLabel: doc.kind === 'pdf' ? 'PDF' : 'DOCX',
      kind: doc.kind === 'pdf' ? 'pdf' : 'docx',
      ...(doc.text ? { text: doc.text } : {}),
      ...(doc.pageImages?.length ? { pageImages: doc.pageImages } : {}),
      ...(doc.note ? { note: doc.note } : {})
    }
  }

  // Generic copy into chat-files
  let buf: Buffer
  if (sourcePath) {
    buf = await fs.readFile(sourcePath)
  } else {
    const raw = String(params.dataBase64 || '')
      .trim()
      .replace(/^data:[^;]+;base64,/, '')
    buf = Buffer.from(raw, 'base64')
  }

  if (buf.length > CHAT_FILE_MAX_BYTES) {
    throw new Error(`File too large (max ${Math.round(CHAT_FILE_MAX_BYTES / 1024 / 1024)}MB)`)
  }

  const dir = sessionFileDir(params.sessionId)
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const ext = extname(name) || ''
  const dest = join(dir, `${id}${ext}`)
  await fs.writeFile(dest, buf)

  if (looksLikeText(name, mime, buf)) {
    const text = truncateText(buf.toString('utf8'))
    if (!text.trim()) {
      return {
        id,
        path: dest,
        mime,
        name,
        extLabel: extLabelFromName(name),
        kind: 'binary',
        note: 'Empty text file.'
      }
    }
    return {
      id,
      path: dest,
      mime,
      name,
      extLabel: extLabelFromName(name),
      kind: 'text',
      text
    }
  }

  return {
    id,
    path: dest,
    mime,
    name,
    extLabel: extLabelFromName(name),
    kind: 'binary',
    note: `Binary file (${buf.length} bytes). Content not inlined — open or convert if you need text.`
  }
}
