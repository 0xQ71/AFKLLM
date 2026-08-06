import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  UPDATER_GITHUB,
  githubReleaseTagUrl,
  githubReleasesUrl,
  type UpdaterCheckResult,
  type UpdaterStatus
} from '../../shared/updater'

export type { UpdaterCheckResult, UpdaterStatus }

type GhRelease = {
  tag_name: string
  html_url?: string
  body?: string | null
  name?: string | null
  draft?: boolean
  prerelease?: boolean
}

/**
 * Updates from GitHub Releases. Launch only checks (no auto-download);
 * Settings downloads, then Restart installs. userData is preserved.
 */
export class AppUpdater {
  private window: BrowserWindow | null = null
  private feedWired = false
  private last: UpdaterCheckResult = {
    ok: true,
    status: 'idle',
    message: 'Idle',
    currentVersion: app.getVersion()
  }
  private pendingNotes = ''

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  getLast(): UpdaterCheckResult {
    return { ...this.last }
  }

  private emit(result: UpdaterCheckResult): void {
    this.last = {
      ...result,
      currentVersion: result.currentVersion ?? app.getVersion()
    }
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('updater:status', this.last)
  }

  private ensureFeed(): void {
    if (this.feedWired) return
    this.feedWired = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false

    try {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: UPDATER_GITHUB.owner,
        repo: UPDATER_GITHUB.repo
      })
    } catch {
      /* app-update.yml from electron-builder publish also works */
    }

    autoUpdater.on('download-progress', (p) => {
      const fraction =
        typeof p.percent === 'number' ? Math.min(1, Math.max(0, p.percent / 100)) : 0
      this.emit({
        ok: true,
        status: 'downloading',
        message: `Downloading update… ${Math.round(fraction * 100)}%`,
        version: this.last.version,
        currentVersion: app.getVersion(),
        releaseNotes: this.pendingNotes || this.last.releaseNotes,
        releaseUrl: this.last.releaseUrl,
        progress: fraction,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      const notes = notesFromInfo(info) || this.pendingNotes
      if (notes) this.pendingNotes = notes
      this.emit({
        ok: true,
        status: 'downloaded',
        message: `Update ${info.version} ready — restart to install`,
        version: info.version,
        currentVersion: app.getVersion(),
        releaseNotes: this.pendingNotes || undefined,
        releaseUrl: this.last.releaseUrl || githubReleaseTagUrl(info.version),
        progress: 1
      })
    })

    autoUpdater.on('error', (err) => {
      // Ignore quiet-check feed errors; surface during download
      if (this.last.status === 'downloading' || this.last.status === 'downloaded') {
        this.emit({
          ok: false,
          status: 'error',
          message: err?.message || String(err),
          version: this.last.version,
          currentVersion: app.getVersion(),
          releaseUrl: this.last.releaseUrl
        })
      }
    })
  }

  /** Background launch check; never downloads. */
  checkQuiet(): void {
    void this.check({ quiet: true })
  }

  async check(opts: { quiet?: boolean } = {}): Promise<UpdaterCheckResult> {
    const quiet = opts.quiet === true
    const current = app.getVersion()

    if (!quiet) {
      this.emit({
        ok: true,
        status: 'checking',
        message: 'Checking for updates…',
        currentVersion: current
      })
    }

    try {
      const release = await fetchLatestRelease()
      if (!release) {
        const result: UpdaterCheckResult = {
          ok: true,
          status: 'offline',
          message: quiet ? 'Idle' : 'Could not reach GitHub (offline?)',
          currentVersion: current,
          releaseUrl: githubReleasesUrl()
        }
        if (!quiet) this.emit(result)
        return result
      }

      const remote = normalizeVersion(release.tag_name)
      this.pendingNotes = (release.body ?? '').trim() || (release.name ?? '').trim()
      const releaseUrl = release.html_url || githubReleaseTagUrl(remote)

      if (isRemoteNewer(remote, current)) {
        const result: UpdaterCheckResult = {
          ok: true,
          status: 'available',
          message: `New version available: ${remote}`,
          version: remote,
          currentVersion: current,
          releaseNotes: this.pendingNotes || undefined,
          releaseUrl
        }
        this.emit(result)
        return result
      }

      const result: UpdaterCheckResult = {
        ok: true,
        status: 'not-available',
        message: 'You are on the latest version',
        version: remote,
        currentVersion: current,
        releaseUrl
      }
      this.emit(result)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|offline/i.test(
        msg
      )
      const result: UpdaterCheckResult = {
        ok: false,
        status: offline ? 'offline' : 'error',
        message: quiet ? 'Idle' : offline ? 'Could not reach GitHub (offline?)' : msg,
        currentVersion: current,
        releaseUrl: githubReleasesUrl()
      }
      if (!quiet) this.emit(result)
      return result
    }
  }

  /** Packaged builds only; needs a Release with latest.yml. */
  async download(): Promise<UpdaterCheckResult> {
    const current = app.getVersion()

    if (!app.isPackaged) {
      const result: UpdaterCheckResult = {
        ok: false,
        status: 'dev',
        message: 'In-app update only works in the installed build. Use a published Release.',
        currentVersion: current,
        version: this.last.version,
        releaseUrl: this.last.releaseUrl || githubReleasesUrl()
      }
      this.emit(result)
      return result
    }

    if (this.last.status !== 'available' && this.last.status !== 'downloading') {
      const checked = await this.check()
      if (checked.status !== 'available') return checked
    }

    this.ensureFeed()
    this.emit({
      ok: true,
      status: 'downloading',
      message: 'Downloading update…',
      version: this.last.version,
      currentVersion: current,
      releaseNotes: this.pendingNotes || this.last.releaseNotes,
      releaseUrl: this.last.releaseUrl,
      progress: 0
    })

    try {
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
      return this.getLast()
    } catch (e) {
      const result: UpdaterCheckResult = {
        ok: false,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
        version: this.last.version,
        currentVersion: current,
        releaseUrl: this.last.releaseUrl || githubReleasesUrl()
      }
      this.emit(result)
      return result
    }
  }

  /** Apply downloaded update and relaunch (preserves userData). */
  install(): UpdaterCheckResult {
    if (!app.isPackaged) {
      const result: UpdaterCheckResult = {
        ok: false,
        status: 'dev',
        message: 'In-app update only works in the installed build.',
        currentVersion: app.getVersion()
      }
      this.emit(result)
      return result
    }
    if (this.last.status !== 'downloaded') {
      const result: UpdaterCheckResult = {
        ok: false,
        status: 'error',
        message: 'No update downloaded yet',
        currentVersion: app.getVersion(),
        version: this.last.version
      }
      this.emit(result)
      return result
    }
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true)
    })
    return {
      ok: true,
      status: 'downloaded',
      message: 'Restarting to install update…',
      version: this.last.version,
      currentVersion: app.getVersion(),
      releaseNotes: this.last.releaseNotes,
      releaseUrl: this.last.releaseUrl
    }
  }

  async fetchReleaseNotes(version: string): Promise<{ version: string; body: string }> {
    const v = normalizeVersion(version)
    if (this.pendingNotes && this.last.version === v) {
      return { version: v, body: this.pendingNotes }
    }
    if (this.last.releaseNotes && this.last.version === v) {
      return { version: v, body: this.last.releaseNotes }
    }

    const tags = [`v${v}`, v]
    for (const tag of tags) {
      try {
        const url = `https://api.github.com/repos/${UPDATER_GITHUB.owner}/${UPDATER_GITHUB.repo}/releases/tags/${encodeURIComponent(tag)}`
        const res = await fetch(url, {
          headers: ghHeaders(),
          signal: AbortSignal.timeout(12_000)
        })
        if (!res.ok) continue
        const json = (await res.json()) as GhRelease
        const body = (json.body ?? '').trim()
        if (body) return { version: v, body }
        if (json.name?.trim()) return { version: v, body: json.name.trim() }
      } catch {
        /* try next */
      }
    }
    return { version: v, body: '' }
  }
}

async function fetchLatestRelease(): Promise<GhRelease | null> {
  const url = `https://api.github.com/repos/${UPDATER_GITHUB.owner}/${UPDATER_GITHUB.repo}/releases/latest`
  const res = await fetch(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(12_000)
  })
  if (res.status === 404) {
    return {
      tag_name: `v${app.getVersion()}`,
      body: '',
      html_url: githubReleasesUrl()
    }
  }
  if (!res.ok) {
    if (res.status === 403 || res.status >= 500) return null
    throw new Error(`GitHub releases API ${res.status}`)
  }
  const json = (await res.json()) as GhRelease
  if (json.draft || json.prerelease) return null
  if (!json.tag_name) return null
  return json
}

function ghHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AFKLLM',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '')
}

export function isRemoteNewer(remote: string, current: string): boolean {
  const a = normalizeVersion(remote)
    .split(/[.+-]/)
    .map((p) => parseInt(p, 10))
  const b = normalizeVersion(current)
    .split(/[.+-]/)
    .map((p) => parseInt(p, 10))
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(a[i]) ? a[i]! : 0
    const y = Number.isFinite(b[i]) ? b[i]! : 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

function notesFromInfo(info: {
  releaseNotes?: string | Array<{ note: string | null }> | null
  version?: string
}): string {
  const raw = info.releaseNotes
  if (!raw) return ''
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw
      .map((n) => (typeof n?.note === 'string' ? n.note : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }
  return ''
}
