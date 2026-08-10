import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { createCanvas } from '@napi-rs/canvas'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { importChatImage, type ChatImageMeta } from './ChatImages'

function resolvePdfjsRoot(): string {
  // electron-vite bundles main as CJS — import.meta.resolve is stripped to void.
  const req = createRequire(join(process.cwd(), 'package.json'))
  return dirname(req.resolve('pdfjs-dist/package.json'))
}

export const CHAT_DOC_MAX_COUNT = 4
export const CHAT_DOC_MAX_BYTES = 20 * 1024 * 1024
/** Injected text budget (matches runAgentTurn attach budget order). */
export const CHAT_DOC_TEXT_MAX = 28_000
/** Max PDF pages sent through vision when text is sparse. */
export const CHAT_DOC_VISION_PAGES = 4
/** Chars per page below this → treat as sparse/scanned. */
const SPARSE_CHARS_PER_PAGE = 40

export type ChatDocumentKind = 'pdf' | 'docx' | 'doc'

export type ChatDocumentResult = {
  id: string
  path: string
  mime: string
  name: string
  kind: ChatDocumentKind
  /** Extracted text (may be empty for scanned PDFs). */
  text: string
  pageCount?: number
  /** When sparse PDF: chat-image metas for first pages (vision). */
  pageImages?: ChatImageMeta[]
  note?: string
}

function chatDocsRoot(): string {
  return join(app.getPath('userData'), 'chat-docs')
}

function sessionDocDir(sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return join(chatDocsRoot(), safe || 'unknown')
}

function kindFromPath(filePath: string): ChatDocumentKind | null {
  const e = extname(filePath).toLowerCase()
  if (e === '.pdf') return 'pdf'
  if (e === '.docx') return 'docx'
  if (e === '.doc') return 'doc'
  return null
}

function kindFromMime(mime: string, name?: string): ChatDocumentKind | null {
  const m = (mime || '').toLowerCase()
  if (m === 'application/pdf' || m === 'application/x-pdf') return 'pdf'
  if (
    m ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    m === 'application/docx'
  ) {
    return 'docx'
  }
  if (m === 'application/msword') return 'doc'
  if (name) return kindFromPath(name)
  return null
}

function mimeForKind(kind: ChatDocumentKind): string {
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return 'application/msword'
}

function extForKind(kind: ChatDocumentKind): string {
  if (kind === 'pdf') return '.pdf'
  if (kind === 'docx') return '.docx'
  return '.doc'
}

function truncateText(text: string, max = CHAT_DOC_TEXT_MAX): string {
  const t = text.replace(/\r\n/g, '\n').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…`
}

async function extractDocxText(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf })
  return truncateText(result.value || '')
}

async function extractPdf(params: {
  buf: Buffer
  sessionId: string
  name: string
}): Promise<{ text: string; pageCount: number; pageImages?: ChatImageMeta[]; note?: string }> {
  const data = new Uint8Array(params.buf)
  const pdfjsRoot = resolvePdfjsRoot()
  const standardFontDataUrl = pathToFileURL(join(pdfjsRoot, 'standard_fonts') + '/').href

  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl,
    disableWorker: true
  } as Parameters<typeof getDocument>[0])
  const pdf = await loadingTask.promise
  const pageCount = pdf.numPages || 0

  const textParts: string[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item) => ('str' in item ? String(item.str) : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (pageText) textParts.push(`--- page ${i} ---\n${pageText}`)
  }
  const rawText = textParts.join('\n\n')
  const text = truncateText(rawText)
  const charsPerPage = pageCount > 0 ? rawText.length / pageCount : 0
  const sparse = pageCount > 0 && charsPerPage < SPARSE_CHARS_PER_PAGE

  if (!sparse) {
    return { text, pageCount }
  }

  // Scanned / image PDF — render first pages for vision cold-swap
  const pageImages: ChatImageMeta[] = []
  const maxPages = Math.min(pageCount, CHAT_DOC_VISION_PAGES)
  try {
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 1.35 })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport
      }).promise
      const png = canvas.toBuffer('image/png')
      const meta = await importChatImage({
        sessionId: params.sessionId,
        dataBase64: png.toString('base64'),
        mime: 'image/png',
        name: `${params.name.replace(/\.[^.]+$/, '')}-p${i}.png`
      })
      pageImages.push(meta)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      text,
      pageCount,
      note: `Sparse PDF text; page render failed (${msg}).`
    }
  }

  return {
    text,
    pageCount,
    pageImages,
    note:
      pageImages.length > 0
        ? `Sparse PDF — sent ${pageImages.length} page image(s) through vision.`
        : 'Sparse PDF and no page images produced.'
  }
}

/**
 * Import a document into userData/chat-docs and extract text
 * (plus optional vision page images for scanned PDFs).
 */
export async function importChatDocument(params: {
  sessionId: string
  sourcePath?: string
  dataBase64?: string
  mime?: string
  name?: string
}): Promise<ChatDocumentResult> {
  let buf: Buffer
  let name = params.name?.trim() || ''
  let kind: ChatDocumentKind | null = null

  if (params.sourcePath?.trim()) {
    const src = params.sourcePath.trim()
    if (!existsSync(src)) throw new Error(`Document not found: ${src}`)
    kind = kindFromPath(src)
    name = name || basename(src)
    buf = await fs.readFile(src)
  } else if (params.dataBase64?.trim()) {
    const raw = params.dataBase64.trim().replace(/^data:[^;]+;base64,/, '')
    buf = Buffer.from(raw, 'base64')
    kind = kindFromMime(params.mime || '', name)
    name = name || `paste${kind ? extForKind(kind) : '.bin'}`
  } else {
    throw new Error('sourcePath or dataBase64 required')
  }

  if (!kind) throw new Error('Unsupported document type (use PDF or DOCX)')
  if (kind === 'doc') {
    throw new Error(
      'Legacy .doc is not supported. Save as .docx in Word / LibreOffice and attach again.'
    )
  }

  if (buf.length > CHAT_DOC_MAX_BYTES) {
    throw new Error(`Document too large (max ${Math.round(CHAT_DOC_MAX_BYTES / 1024 / 1024)}MB)`)
  }

  const dir = sessionDocDir(params.sessionId)
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const dest = join(dir, `${id}${extForKind(kind)}`)
  await fs.writeFile(dest, buf)

  if (kind === 'docx') {
    const text = await extractDocxText(buf)
    if (!text.trim()) {
      throw new Error('DOCX has no extractable text')
    }
    return {
      id,
      path: dest,
      mime: mimeForKind(kind),
      name,
      kind,
      text
    }
  }

  // PDF
  const pdf = await extractPdf({ buf, sessionId: params.sessionId, name })
  if (!pdf.text.trim() && !(pdf.pageImages && pdf.pageImages.length > 0)) {
    throw new Error('PDF has no extractable text and page render produced nothing')
  }
  return {
    id,
    path: dest,
    mime: mimeForKind('pdf'),
    name,
    kind: 'pdf',
    text: pdf.text,
    pageCount: pdf.pageCount,
    ...(pdf.pageImages?.length ? { pageImages: pdf.pageImages } : {}),
    ...(pdf.note ? { note: pdf.note } : {})
  }
}
