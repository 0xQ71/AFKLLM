import { createWriteStream, existsSync, mkdirSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { BrowserWindow } from 'electron'
import type { HfDownloadProgress, HfDownloadStatus } from '../../shared/hfStore'
import { hfResolveUrl, resolveAvatarUrl } from './HfHubClient'

type Job = {
  id: string
  repoId: string
  filename: string
  modelsDir: string
  destPath: string
  partialPath: string
  bytesTotal: number
  bytesReceived: number
  status: HfDownloadStatus
  controller: AbortController | null
  avatarUrl?: string | null
  lastTickAt: number
  lastTickBytes: number
  bytesPerSecond: number
  /** Abort without deleting partial. */
  pauseRequested: boolean
}

/** GGUF downloads: progress, pause/resume (Range), history. */
export class HfDownloadManager {
  private window: BrowserWindow | null = null
  private jobs = new Map<string, Job>()
  private history: HfDownloadProgress[] = []

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  private emit(progress: HfDownloadProgress): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('hf:download-progress', progress)
  }

  private toProgress(job: Job, extra?: Partial<HfDownloadProgress>): HfDownloadProgress {
    const fraction =
      job.bytesTotal > 0
        ? Math.min(1, job.bytesReceived / job.bytesTotal)
        : job.status === 'done'
          ? 1
          : 0
    const etaSeconds =
      job.status === 'downloading' && job.bytesPerSecond > 0 && job.bytesTotal > job.bytesReceived
        ? Math.round((job.bytesTotal - job.bytesReceived) / job.bytesPerSecond)
        : null
    return {
      id: job.id,
      repoId: job.repoId,
      filename: job.filename,
      bytesReceived: job.bytesReceived,
      bytesTotal: job.bytesTotal,
      fraction,
      status: job.status,
      bytesPerSecond: job.bytesPerSecond,
      etaSeconds,
      destPath: job.status === 'done' ? job.destPath : undefined,
      partialPath: job.partialPath,
      avatarUrl: job.avatarUrl,
      updatedAt: Date.now(),
      ...extra
    }
  }

  private upsertHistory(p: HfDownloadProgress): void {
    const i = this.history.findIndex((h) => h.id === p.id)
    if (i >= 0) this.history[i] = p
    else this.history.unshift(p)
    if (this.history.length > 40) this.history.length = 40
  }

  list(): HfDownloadProgress[] {
    const live = [...this.jobs.values()].map((j) => this.toProgress(j))
    const liveIds = new Set(live.map((l) => l.id))
    const rest = this.history.filter((h) => !liveIds.has(h.id))
    return [...live, ...rest]
  }

  clearCompleted(): { ok: boolean } {
    this.history = this.history.filter(
      (h) => h.status === 'downloading' || h.status === 'paused'
    )
    this.emit({
      id: '__cleared__',
      repoId: '',
      filename: '',
      bytesReceived: 0,
      bytesTotal: 0,
      fraction: 0,
      status: 'done'
    })
    return { ok: true }
  }

  cancel(id?: string): { ok: boolean } {
    const job = id
      ? this.jobs.get(id)
      : [...this.jobs.values()].find((j) => j.status === 'downloading' || j.status === 'paused')
    if (!job) return { ok: false }
    job.pauseRequested = false
    job.controller?.abort()
    job.status = 'cancelled'
    const p = this.toProgress(job, { error: 'Cancelled' })
    this.upsertHistory(p)
    this.emit(p)
    void fs.unlink(job.partialPath).catch(() => {
      /* ignore */
    })
    this.jobs.delete(job.id)
    return { ok: true }
  }

  pause(id: string): { ok: boolean } {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'downloading') return { ok: false }
    job.pauseRequested = true
    job.controller?.abort()
    return { ok: true }
  }

  async resume(id: string): Promise<HfDownloadProgress> {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'paused') {
      throw new Error('Download is not paused')
    }
    return this.runTransfer(job)
  }

  async download(input: {
    repoId: string
    filename: string
    modelsDir: string
  }): Promise<HfDownloadProgress> {
    const busy = [...this.jobs.values()].some((j) => j.status === 'downloading')
    if (busy) throw new Error('Another download is already in progress')

    const { repoId, filename, modelsDir } = input
    if (!modelsDir?.trim()) throw new Error('modelsDir is empty')
    if (!existsSync(modelsDir)) mkdirSync(modelsDir, { recursive: true })

    const id = `dl_${Date.now().toString(36)}`
    const destPath = join(modelsDir, filename.replace(/[/\\]+/g, '_'))
    const partialPath = `${destPath}.partial`
    const avatarUrl = await resolveAvatarUrl(repoId).catch(() => null)

    let existing = 0
    try {
      const st = await fs.stat(partialPath)
      existing = st.size
    } catch {
      /* none */
    }

    const job: Job = {
      id,
      repoId,
      filename,
      modelsDir,
      destPath,
      partialPath,
      bytesTotal: 0,
      bytesReceived: existing,
      status: 'downloading',
      controller: null,
      avatarUrl,
      lastTickAt: Date.now(),
      lastTickBytes: existing,
      bytesPerSecond: 0,
      pauseRequested: false
    }
    this.jobs.set(id, job)
    return this.runTransfer(job)
  }

  private async runTransfer(job: Job): Promise<HfDownloadProgress> {
    job.status = 'downloading'
    job.pauseRequested = false
    const controller = new AbortController()
    job.controller = controller
    job.lastTickAt = Date.now()
    job.lastTickBytes = job.bytesReceived

    const url = hfResolveUrl(job.repoId, job.filename)
    const headers: Record<string, string> = {
      'User-Agent': 'AFKLLM/0.1 (local IDE; model store)',
      Accept: '*/*'
    }
    if (job.bytesReceived > 0) {
      headers.Range = `bytes=${job.bytesReceived}-`
    }

    const push = (extra?: Partial<HfDownloadProgress>): HfDownloadProgress => {
      const p = this.toProgress(job, extra)
      this.upsertHistory(p)
      this.emit(p)
      return p
    }

    try {
      push()
      const res = await fetch(url, {
        signal: controller.signal,
        headers,
        redirect: 'follow'
      })

      if (res.status === 416) {
        job.bytesReceived = job.bytesTotal || job.bytesReceived
      } else if (!res.ok || !res.body) {
        const err = `Download failed HTTP ${res.status}`
        job.status = 'error'
        const p = push({ error: err })
        this.jobs.delete(job.id)
        return p
      } else {
        const contentRange = res.headers.get('content-range')
        const len = res.headers.get('content-length')
        if (contentRange) {
          const m = /\/(\d+)\s*$/.exec(contentRange)
          if (m) job.bytesTotal = Number(m[1])
        } else if (len) {
          const n = Number(len)
          job.bytesTotal = job.bytesReceived > 0 && res.status === 206 ? job.bytesReceived + n : n
        }

        const nodeReadable = Readable.fromWeb(
          res.body as import('stream/web').ReadableStream
        )
        const flags = job.bytesReceived > 0 && res.status === 206 ? 'a' : 'w'
        if (flags === 'w') {
          await fs.writeFile(job.partialPath, '')
          job.bytesReceived = 0
        }
        const out = createWriteStream(job.partialPath, { flags })

        await new Promise<void>((resolve, reject) => {
          nodeReadable.on('data', (chunk: Buffer | string) => {
            const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
            job.bytesReceived += n
            const now = Date.now()
            const dt = (now - job.lastTickAt) / 1000
            if (dt >= 0.4) {
              const db = job.bytesReceived - job.lastTickBytes
              const instant = db / dt
              job.bytesPerSecond =
                job.bytesPerSecond > 0 ? job.bytesPerSecond * 0.7 + instant * 0.3 : instant
              job.lastTickAt = now
              job.lastTickBytes = job.bytesReceived
              push()
            } else if (job.bytesReceived === n || job.bytesReceived % (256 * 1024) < n) {
              push()
            }
          })
          nodeReadable.on('error', reject)
          out.on('error', reject)
          out.on('finish', () => resolve())
          nodeReadable.pipe(out)
        })
        await finished(out).catch(() => {
          /* already finished */
        })
      }

      mkdirSync(dirname(job.destPath), { recursive: true })
      await fs.rename(job.partialPath, job.destPath)
      job.status = 'done'
      job.bytesPerSecond = 0
      const done = push({
        destPath: job.destPath,
        bytesTotal: job.bytesTotal || job.bytesReceived
      })
      this.jobs.delete(job.id)
      return done
    } catch (err) {
      if (job.pauseRequested || (err instanceof Error && /aborted/i.test(err.message))) {
        if (job.pauseRequested) {
          job.status = 'paused'
          job.bytesPerSecond = 0
          job.controller = null
          return push()
        }
        job.status = 'cancelled'
        const p = push({ error: 'Cancelled' })
        void fs.unlink(job.partialPath).catch(() => {
          /* ignore */
        })
        this.jobs.delete(job.id)
        return p
      }
      const message = err instanceof Error ? err.message : String(err)
      job.status = 'error'
      const p = push({ error: message })
      this.jobs.delete(job.id)
      return p
    } finally {
      job.controller = null
    }
  }
}

export const hfDownloads = new HfDownloadManager()
