import type { SdRuntimeProgress, SdRuntimeStatus } from '../../shared/sdRuntime'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, type BrowserWindow } from 'electron'
import { detectGpuInfo } from '../hardware/GpuInfo'

const execFileAsync = promisify(execFile)

const GH_API_LATEST = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest'
const UA = 'AFKLLM-sd-runtime-fetcher'
const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': UA,
  'X-GitHub-Api-Version': '2022-11-28'
} as const

type GhAsset = { name: string; browser_download_url: string; size: number }
type GhRelease = { tag_name: string; assets: GhAsset[] }
type Manifest = {
  tag: string
  binary: string
  installedAt: string
  /** Set when CUDA redistributable DLLs were merged into runtimeDir */
  cudart?: boolean
}

/** Downloads sd-cli into userData/sd-runtime (Windows auto; else manual path). */
export class SdRuntimeManager {
  private window: BrowserWindow | null = null
  private progress: SdRuntimeProgress = {
    phase: 'idle',
    label: '',
    fraction: 0
  }
  private inflight: Promise<SdRuntimeStatus> | null = null
  private latestTagCache: { tag: string; at: number } | null = null
  private lastCheckError: string | null = null

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  getProgress(): SdRuntimeProgress {
    return { ...this.progress }
  }

  runtimeDir(): string {
    return join(app.getPath('userData'), 'sd-runtime')
  }

  private manifestPath(): string {
    return join(this.runtimeDir(), 'manifest.json')
  }

  private binaryName(): string {
    return process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
  }

  resolveStatus(customPath?: string): SdRuntimeStatus {
    const dir = this.runtimeDir()
    if (customPath?.trim() && existsSync(customPath.trim())) {
      return this.withCheckCache({
        ready: true,
        binaryPath: customPath.trim(),
        dir: dirname(customPath.trim()),
        tag: null,
        source: 'custom'
      })
    }
    const binaryPath = join(dir, this.binaryName())
    if (existsSync(binaryPath)) {
      const manifest = this.readManifest()
      return this.withCheckCache({
        ready: true,
        binaryPath,
        dir,
        tag: manifest?.tag ?? null,
        source: 'downloaded'
      })
    }
    const nested = this.findBinaryRecursive(dir)
    if (nested) {
      return this.withCheckCache({
        ready: true,
        binaryPath: nested,
        dir,
        tag: this.readManifest()?.tag ?? null,
        source: 'downloaded'
      })
    }
    return this.withCheckCache({
      ready: false,
      binaryPath: null,
      dir,
      tag: null,
      source: 'missing'
    })
  }

  /** Local status merged with last GitHub check cache (no network). */
  getStatus(customPath?: string): SdRuntimeStatus {
    return this.resolveStatus(customPath)
  }

  private withCheckCache(base: SdRuntimeStatus): SdRuntimeStatus {
    const latestTag = this.latestTagCache?.tag ?? null
    const updateAvailable = Boolean(
      base.source === 'downloaded' &&
        base.tag &&
        latestTag &&
        base.tag !== latestTag
    )
    return {
      ...base,
      latestTag,
      updateAvailable,
      checkError: this.lastCheckError
    }
  }

  /**
   * Fetch latest GitHub release tag and compare to installed manifest.
   * Does not download. Sets checkError on failure (does not throw when quiet).
   */
  async check(
    customPath?: string,
    opts: { quiet?: boolean } = {}
  ): Promise<SdRuntimeStatus> {
    const quiet = opts.quiet === true
    const base = this.resolveStatus(customPath)
    if (base.source === 'custom') {
      this.lastCheckError = null
      return this.withCheckCache(base)
    }
    try {
      const release = await fetchLatestRelease()
      this.latestTagCache = { tag: release.tag_name, at: Date.now() }
      this.lastCheckError = null
      if (!quiet) {
        this.emit({
          phase: 'ready',
          label: `Latest sd-cli: ${release.tag_name}`,
          fraction: 1,
          tag: release.tag_name
        })
      }
      return this.withCheckCache(this.resolveStatus(customPath))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastCheckError = msg
      if (!quiet) {
        this.emit({ phase: 'error', label: msg, error: msg, fraction: 0 })
      }
      return this.withCheckCache(this.resolveStatus(customPath))
    }
  }

  /** Background launch check; never downloads. */
  checkQuiet(customPath?: string): void {
    void this.check(customPath, { quiet: true })
  }

  private findBinaryRecursive(root: string, depth = 0): string | null {
    if (!existsSync(root) || depth > 4) return null
    const want = this.binaryName().toLowerCase()
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, ent.name)
        if (ent.isFile() && ent.name.toLowerCase() === want) return full
        if (ent.isDirectory()) {
          const hit = this.findBinaryRecursive(full, depth + 1)
          if (hit) return hit
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  private readManifest(): Manifest | null {
    try {
      const raw = readFileSync(this.manifestPath(), 'utf8')
      return JSON.parse(raw) as Manifest
    } catch {
      return null
    }
  }

  private emit(patch: Partial<SdRuntimeProgress>): void {
    this.progress = { ...this.progress, ...patch }
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('sd-runtime:progress', this.progress)
  }

  async ensure(customPath?: string, force = false): Promise<SdRuntimeStatus> {
    if (this.inflight) return this.inflight
    this.inflight = this.ensureInner(customPath, force).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** CUDA build present but missing cudart/cublas → GPU backend won't load (CPU-only). */
  private missingCudaRuntime(): boolean {
    const dir = this.runtimeDir()
    if (!existsSync(join(dir, 'ggml-cuda.dll'))) return false
    try {
      const files = readdirSync(dir)
      const hasCudart = files.some((f) => /^cudart64_/i.test(f))
      const hasCublas = files.some((f) => /^cublas64_/i.test(f))
      return !(hasCudart && hasCublas)
    } catch {
      return true
    }
  }

  private async ensureInner(customPath?: string, force = false): Promise<SdRuntimeStatus> {
    const existing = this.resolveStatus(customPath)
    if (existing.ready && !force && !this.missingCudaRuntime()) {
      this.emit({ phase: 'ready', label: 'sd-cli ready', fraction: 1 })
      return existing
    }

    if (process.platform !== 'win32') {
      const msg =
        'Automatic sd-cli download is only implemented for Windows. Set sdCppPath to your sd-cli binary.'
      this.emit({ phase: 'error', label: msg, error: msg, fraction: 0 })
      throw new Error(msg)
    }

    this.emit({
      phase: 'resolving',
      label: 'Resolving stable-diffusion.cpp release…',
      fraction: 0,
      error: undefined
    })

    const release = await fetchLatestRelease()
    const destDir = this.runtimeDir()
    const staging = join(app.getPath('userData'), 'sd-runtime-staging')
    mkdirSync(destDir, { recursive: true })
    mkdirSync(staging, { recursive: true })

    // Binary already OK — only pull CUDA redistributables so ggml-cuda.dll can load.
    if (existing.ready && this.missingCudaRuntime() && !force) {
      await this.installCudart(release, destDir, staging)
      return this.resolveStatus(customPath)
    }

    const asset = await pickWindowsAsset(release.assets)
    if (!asset) {
      const msg = `No suitable Windows sd-cli asset in ${release.tag_name}`
      this.emit({ phase: 'error', label: msg, error: msg })
      throw new Error(msg)
    }

    const zipPath = join(staging, asset.name)
    this.emit({
      phase: 'downloading',
      label: `Downloading ${asset.name}…`,
      fraction: 0.05,
      tag: release.tag_name
    })
    await downloadFile(asset.browser_download_url, zipPath, (recv, total) => {
      const frac = total > 0 ? Math.min(0.75, 0.05 + (recv / total) * 0.7) : 0.1
      this.emit({
        phase: 'downloading',
        label: `Downloading ${asset.name}…`,
        fraction: frac,
        tag: release.tag_name
      })
    })

    this.emit({
      phase: 'extracting',
      label: 'Extracting sd-cli…',
      fraction: 0.8,
      tag: release.tag_name
    })
    await extractZip(zipPath, destDir)

    const binary = this.findBinaryRecursive(destDir)
    if (!binary) {
      const msg = 'sd-cli.exe not found after extract'
      this.emit({ phase: 'error', label: msg, error: msg })
      throw new Error(msg)
    }

    const binName = this.binaryName()
    const flatBin = join(destDir, binName)
    if (binary !== flatBin) {
      await fs.copyFile(binary, flatBin)
      const binDir = dirname(binary)
      try {
        for (const ent of await fs.readdir(binDir)) {
          if (!/\.(dll|so|dylib)$/i.test(ent)) continue
          await fs.copyFile(join(binDir, ent), join(destDir, ent)).catch(() => undefined)
        }
      } catch {
        /* ignore */
      }
    }

    const wantsCuda = /cuda/i.test(asset.name)
    let cudart = false
    if (wantsCuda) {
      await this.installCudart(release, destDir, staging)
      cudart = !this.missingCudaRuntime()
    }

    const manifest: Manifest = {
      tag: release.tag_name,
      binary: binName,
      installedAt: new Date().toISOString(),
      cudart
    }
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
    this.latestTagCache = { tag: release.tag_name, at: Date.now() }
    this.lastCheckError = null

    this.emit({
      phase: 'ready',
      label: cudart ? 'sd-cli ready (CUDA)' : 'sd-cli ready',
      fraction: 1,
      tag: release.tag_name
    })
    return this.resolveStatus(customPath)
  }

  private async installCudart(
    release: GhRelease,
    destDir: string,
    staging: string
  ): Promise<void> {
    const cudart = pickCudartAsset(release.assets)
    if (!cudart) {
      this.emit({
        phase: 'ready',
        label: 'sd-cli ready (CUDA DLLs missing — GPU may fall back to CPU)',
        fraction: 1,
        tag: release.tag_name
      })
      return
    }
    const zipPath = join(staging, cudart.name)
    this.emit({
      phase: 'downloading',
      label: `Downloading CUDA runtime ${cudart.name}…`,
      fraction: 0.82,
      tag: release.tag_name
    })
    await downloadFile(cudart.browser_download_url, zipPath, (recv, total) => {
      const frac = total > 0 ? Math.min(0.95, 0.82 + (recv / total) * 0.12) : 0.85
      this.emit({
        phase: 'downloading',
        label: `Downloading CUDA runtime…`,
        fraction: frac,
        tag: release.tag_name
      })
    })
    this.emit({
      phase: 'extracting',
      label: 'Extracting CUDA runtime…',
      fraction: 0.96,
      tag: release.tag_name
    })
    const cudartStaging = join(staging, 'cudart-extract')
    mkdirSync(cudartStaging, { recursive: true })
    await extractZip(zipPath, cudartStaging)
    await flattenDllsInto(cudartStaging, destDir)

    const prev = this.readManifest()
    const manifest: Manifest = {
      tag: prev?.tag ?? release.tag_name,
      binary: prev?.binary ?? this.binaryName(),
      installedAt: new Date().toISOString(),
      cudart: true
    }
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
    this.emit({
      phase: 'ready',
      label: 'sd-cli ready (CUDA)',
      fraction: 1,
      tag: release.tag_name
    })
  }
}

async function flattenDllsInto(fromDir: string, destDir: string, depth = 0): Promise<void> {
  if (depth > 6 || !existsSync(fromDir)) return
  for (const ent of await fs.readdir(fromDir, { withFileTypes: true })) {
    const full = join(fromDir, ent.name)
    if (ent.isDirectory()) {
      await flattenDllsInto(full, destDir, depth + 1)
      continue
    }
    if (/\.(dll|pdb)$/i.test(ent.name)) {
      await fs.copyFile(full, join(destDir, ent.name)).catch(() => undefined)
    }
  }
}

async function pickWindowsAsset(assets: GhAsset[]): Promise<GhAsset | null> {
  const gpu = await detectGpuInfo()
  const names = assets.map((a) => a.name.toLowerCase())
  const pick = (pred: (n: string) => boolean): GhAsset | null => {
    const i = names.findIndex(pred)
    return i >= 0 ? assets[i]! : null
  }
  if (gpu && (gpu.vramMb ?? 0) > 0) {
    const cuda =
      pick(
        (n) =>
          n.includes('win') &&
          n.includes('cuda12') &&
          !n.includes('cudart') &&
          n.endsWith('.zip')
      ) ||
      pick(
        (n) =>
          n.includes('win') &&
          n.includes('cuda') &&
          !n.includes('cudart') &&
          n.endsWith('.zip')
      )
    if (cuda) return cuda
  }
  return (
    pick((n) => n.includes('win') && n.includes('vulkan') && n.endsWith('.zip')) ||
    pick((n) => n.includes('win') && n.includes('cpu') && n.endsWith('.zip')) ||
    pick(
      (n) =>
        n.includes('win') &&
        n.endsWith('.zip') &&
        !n.includes('cudart') &&
        !n.includes('rocm')
    )
  )
}

function pickCudartAsset(assets: GhAsset[]): GhAsset | null {
  const names = assets.map((a) => a.name.toLowerCase())
  const i = names.findIndex(
    (n) => n.includes('cudart') && n.includes('win') && n.endsWith('.zip')
  )
  return i >= 0 ? assets[i]! : null
}

async function fetchLatestRelease(): Promise<GhRelease> {
  const res = await fetch(GH_API_LATEST, { headers: GH_HEADERS })
  if (!res.ok) throw new Error(`GitHub release fetch failed: ${res.status}`)
  return (await res.json()) as GhRelease
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  const out = createWriteStream(dest)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total)
  })
  await pipeline(nodeStream, out)
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    const ps = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
`
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return
  }
  await execFileAsync('unzip', ['-o', zipPath, '-d', destDir])
}

export const sdRuntime = new SdRuntimeManager()
