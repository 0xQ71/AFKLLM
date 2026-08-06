import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, type BrowserWindow } from 'electron'
import { detectGpuInfo } from '../hardware/GpuInfo'
import type {
  LlamaRuntimeEnsureOptions,
  LlamaRuntimePack,
  LlamaRuntimePackStatus,
  LlamaRuntimeProgress,
  LlamaRuntimeSelection,
  LlamaRuntimeStatus
} from '../../shared/llamaRuntime'
import { LLAMA_RUNTIME_PACKS, isLlamaRuntimePack } from '../../shared/llamaRuntime'
import {
  pickAssetsForVariant,
  pickUsableRelease,
  type LlamaGhAsset
} from '../../shared/llamaRuntimeAssets'

const execFileAsync = promisify(execFile)

const GH_API_LATEST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
const GH_API_LIST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20'
const UA = 'AFKLLM-runtime-fetcher'

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': UA,
  'X-GitHub-Api-Version': '2022-11-28'
} as const

type GhAsset = LlamaGhAsset

type GhRelease = {
  tag_name: string
  assets: GhAsset[]
}

type Manifest = {
  tag: string
  variant: LlamaRuntimePack
  binary: string
  installedAt: string
}

/** Downloads llama-server (+ CUDA cudart) into userData/llama-runtime when missing. */
export class LlamaRuntimeManager {
  private window: BrowserWindow | null = null
  private progress: LlamaRuntimeProgress = idleProgress()
  private inflight: Promise<LlamaRuntimeStatus> | null = null
  private latestTagCache: { tag: string; at: number } | null = null

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  getProgress(): LlamaRuntimeProgress {
    return this.progress
  }

  runtimeDir(): string {
    return join(app.getPath('userData'), 'llama-runtime')
  }

  private packDir(pack: LlamaRuntimePack): string {
    return join(this.runtimeDir(), pack)
  }

  private manifestPath(pack: LlamaRuntimePack): string {
    return join(this.packDir(pack), 'manifest.json')
  }

  listPacks(): LlamaRuntimePackStatus[] {
    return LLAMA_RUNTIME_PACKS.map((variant) => {
      const binaryPath = join(this.packDir(variant), 'llama-server.exe')
      const ready = existsSync(binaryPath)
      const manifest = ready ? this.readManifest(variant) : null
      return {
        variant,
        ready,
        tag: manifest?.tag ?? null,
        binaryPath: ready ? binaryPath : null
      }
    })
  }

  resolveStatus(
    customPath?: string,
    selection: LlamaRuntimeSelection = 'auto'
  ): LlamaRuntimeStatus {
    const dir = this.runtimeDir()
    const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const packs = this.listPacks()

    if (customPath?.trim() && existsSync(customPath.trim())) {
      return {
        ready: true,
        binaryPath: customPath.trim(),
        dir: dirname(customPath.trim()),
        tag: null,
        variant: null,
        source: 'custom',
        latestTag: null,
        updateAvailable: false,
        packs
      }
    }

    const candidates: { path: string; source: LlamaRuntimeStatus['source'] }[] = []
    if (!app.isPackaged) {
      candidates.push(
        { path: join(process.cwd(), 'bin', name), source: 'dev-bin' },
        { path: join(app.getAppPath(), '..', '..', 'bin', name), source: 'dev-bin' }
      )
    }
    candidates.push(
      { path: join(process.resourcesPath, 'bin', name), source: 'bundled' }
    )

    for (const c of candidates) {
      if (!existsSync(c.path)) continue
      return {
        ready: true,
        binaryPath: c.path,
        dir: dirname(c.path),
        tag: null,
        variant: null,
        source: c.source,
        latestTag: null,
        updateAvailable: false,
        packs
      }
    }

    const activePack = this.resolvePack(selection, packs)
    const active = packs.find((p) => p.variant === activePack)
    if (active?.ready && active.binaryPath) {
      const manifest = this.readManifest(activePack)
      return {
        ready: true,
        binaryPath: active.binaryPath,
        dir: this.packDir(activePack),
        tag: manifest?.tag ?? null,
        variant: activePack,
        source: 'downloaded',
        latestTag: null,
        updateAvailable: false,
        packs
      }
    }

    return {
      ready: false,
      binaryPath: null,
      dir: activePack ? this.packDir(activePack) : dir,
      tag: null,
      variant: activePack,
      source: 'missing',
      latestTag: null,
      updateAvailable: false,
      packs
    }
  }

  private resolvePack(
    selection: LlamaRuntimeSelection,
    packs: LlamaRuntimePackStatus[]
  ): LlamaRuntimePack {
    if (isLlamaRuntimePack(selection)) return selection
    for (const v of ['cuda-12.4', 'cuda', 'vulkan', 'cpu'] as LlamaRuntimePack[]) {
      if (packs.find((p) => p.variant === v)?.ready) return v
    }
    return 'cuda-12.4'
  }

  private async migrateFlatLayout(): Promise<void> {
    const dir = this.runtimeDir()
    const flatBinary = join(dir, 'llama-server.exe')
    if (!existsSync(flatBinary)) return
    const manifest = this.readManifestAt(join(dir, 'manifest.json'))
    const pack: LlamaRuntimePack = manifest?.variant ?? 'cuda-12.4'
    const dest = this.packDir(pack)
    if (existsSync(join(dest, 'llama-server.exe'))) return
    try {
      await fs.mkdir(dest, { recursive: true })
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const ent of entries) {
        if (ent.isDirectory() && LLAMA_RUNTIME_PACKS.includes(ent.name as LlamaRuntimePack)) {
          continue
        }
        if (!ent.isFile()) continue
        await fs.copyFile(join(dir, ent.name), join(dest, ent.name))
      }
      if (manifest) {
        await fs.writeFile(this.manifestPath(pack), JSON.stringify(manifest, null, 2), 'utf8')
      }
    } catch {
      /* ignore */
    }
  }

  private emit(patch: Partial<LlamaRuntimeProgress>): void {
    this.progress = { ...this.progress, ...patch }
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('llama-runtime:progress', this.progress)
  }

  async getStatus(
    customPath?: string,
    selection: LlamaRuntimeSelection = 'auto'
  ): Promise<LlamaRuntimeStatus> {
    await this.migrateFlatLayout()
    const base = this.resolveStatus(customPath, selection)
    try {
      const latestTag = await this.fetchLatestTagCached()
      const packs = base.packs.map((p) => ({
        ...p,
        updateAvailable: Boolean(
          p.ready && p.tag && latestTag && p.tag !== latestTag
        )
      }))
      const selectedPack = isLlamaRuntimePack(selection)
        ? selection
        : base.variant
      const selected = selectedPack
        ? packs.find((p) => p.variant === selectedPack)
        : undefined
      const updateAvailable = Boolean(
        selected?.updateAvailable ||
          (base.source === 'downloaded' &&
            base.tag &&
            latestTag &&
            base.tag !== latestTag)
      )
      return { ...base, packs, latestTag, updateAvailable }
    } catch {
      return base
    }
  }

  private async fetchLatestTagCached(): Promise<string> {
    const now = Date.now()
    if (this.latestTagCache && now - this.latestTagCache.at < 5 * 60_000) {
      return this.latestTagCache.tag
    }
    const release = await fetchLatestRelease()
    this.latestTagCache = { tag: release.tag_name, at: now }
    return release.tag_name
  }

  /** Download if missing (or force); skip when custom/bundled binary exists. */
  async ensure(
    options: LlamaRuntimeEnsureOptions = {},
    customPath?: string,
    selection: LlamaRuntimeSelection = 'auto'
  ): Promise<LlamaRuntimeStatus> {
    if (this.inflight) return this.inflight
    this.inflight = this.ensureInner(options, customPath, selection).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async ensureInner(
    options: LlamaRuntimeEnsureOptions,
    customPath?: string,
    selection: LlamaRuntimeSelection = 'auto'
  ): Promise<LlamaRuntimeStatus> {
    await this.migrateFlatLayout()
    const packs = this.listPacks()
    const want = options.variant ?? selection
    const targetPack = await this.resolveTargetPack(want, packs)
    const existing = this.resolveStatus(customPath, want)
    const packReady = Boolean(packs.find((p) => p.variant === targetPack)?.ready)
    const explicitPack = isLlamaRuntimePack(want)

    // Load path: custom / bundled / ./bin is enough when not installing a specific pack.
    if (
      existing.ready &&
      existing.source !== 'downloaded' &&
      !options.force &&
      !explicitPack
    ) {
      this.emit({
        phase: 'ready',
        label: `Runtime ready (${existing.source})`,
        fraction: 1,
        bytesReceived: 0,
        bytesTotal: 0,
        tag: existing.tag ?? undefined,
        variant: existing.variant ?? undefined
      })
      return existing
    }

    if (packReady && !options.force) {
      this.emit({
        phase: 'ready',
        label: `Runtime ready (${targetPack})`,
        fraction: 1,
        bytesReceived: 0,
        bytesTotal: 0,
        tag: existing.tag ?? undefined,
        variant: targetPack
      })
      return this.getStatus(customPath, want)
    }

    if (process.platform !== 'win32') {
      const msg =
        'Automatic llama.cpp runtime download is only implemented for Windows. Place llama-server next to the app or set a custom path.'
      this.emit({ phase: 'error', label: msg, error: msg, fraction: 0 })
      throw new Error(msg)
    }

    this.emit({
      phase: 'resolving',
      label: 'Resolving llama.cpp release…',
      fraction: 0,
      bytesReceived: 0,
      bytesTotal: 0,
      error: undefined
    })

    const release = await fetchLatestRelease()
    const picked = pickAssetsForVariant(release.assets, targetPack)
    if (!picked.server) {
      const msg = `No suitable Windows llama.cpp ${targetPack} asset in ${release.tag_name}`
      this.emit({ phase: 'error', label: msg, error: msg })
      throw new Error(msg)
    }

    const variant = targetPack
    const destDir = this.packDir(variant)
    const staging = join(app.getPath('userData'), 'llama-runtime-staging', variant)
    const downloads = join(app.getPath('userData'), 'llama-runtime-downloads', variant)

    await fs.mkdir(downloads, { recursive: true })
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true })

    const files: { asset: GhAsset; label: string }[] = [
      { asset: picked.server, label: 'llama.cpp server' }
    ]
    if (picked.cudart) {
      files.push({ asset: picked.cudart, label: 'CUDA runtime DLLs' })
    }

    const totalBytes = files.reduce((s, f) => s + (f.asset.size || 0), 0)
    let receivedGlobal = 0
    let speedLastAt = Date.now()
    let speedLastBytes = 0
    let bytesPerSecond = 0

    for (const file of files) {
      const zipPath = join(downloads, file.asset.name)
      this.emit({
        phase: 'downloading',
        label: `Downloading ${file.label}…`,
        file: file.asset.name,
        tag: release.tag_name,
        variant,
        bytesTotal: totalBytes,
        bytesReceived: receivedGlobal,
        fraction: totalBytes > 0 ? receivedGlobal / totalBytes : 0,
        bytesPerSecond: 0
      })

      await downloadFile(file.asset.browser_download_url, zipPath, (n, total) => {
        const base = receivedGlobal
        const overall = base + n
        const overallTotal = totalBytes > 0 ? totalBytes : base + total
        const now = Date.now()
        const dt = now - speedLastAt
        if (dt >= 400) {
          bytesPerSecond = ((overall - speedLastBytes) * 1000) / dt
          speedLastAt = now
          speedLastBytes = overall
        }
        this.emit({
          phase: 'downloading',
          label: `Downloading ${file.label}…`,
          file: file.asset.name,
          tag: release.tag_name,
          variant,
          bytesReceived: overall,
          bytesTotal: overallTotal,
          fraction: overallTotal > 0 ? Math.min(1, overall / overallTotal) : 0,
          bytesPerSecond
        })
      })

      this.emit({
        phase: 'verifying',
        label: `Verifying ${file.label}…`,
        file: file.asset.name,
        tag: release.tag_name,
        variant,
        bytesReceived: receivedGlobal + (file.asset.size || 0),
        bytesTotal: totalBytes || receivedGlobal,
        fraction: 0.92,
        bytesPerSecond: 0
      })
      try {
        await verifySha256(zipPath, file.asset.digest, file.asset.name)
      } catch (err) {
        try {
          await fs.unlink(zipPath)
        } catch {
          /* ignore */
        }
        throw err
      }

      receivedGlobal += file.asset.size || statSync(zipPath).size

      this.emit({
        phase: 'extracting',
        label: `Extracting ${file.label}…`,
        file: file.asset.name,
        tag: release.tag_name,
        variant,
        bytesReceived: receivedGlobal,
        bytesTotal: totalBytes || receivedGlobal,
        fraction: 0.95,
        bytesPerSecond: 0
      })
      const extractTo = join(staging, file.asset.name.replace(/\.zip$/i, ''))
      await fs.mkdir(extractTo, { recursive: true })
      await unzipWindows(zipPath, extractTo)
      await flattenCopy(extractTo, staging)
    }

    const binaryName = 'llama-server.exe'
    const stagedBinary = join(staging, binaryName)
    if (!existsSync(stagedBinary)) {
      const found = findFile(staging, binaryName)
      if (!found) {
        const msg = `Downloaded archive did not contain ${binaryName}`
        this.emit({ phase: 'error', label: msg, error: msg })
        throw new Error(msg)
      }
      await flattenCopy(dirname(found), staging)
    }
    if (!existsSync(join(staging, binaryName))) {
      const msg = `Downloaded archive did not contain ${binaryName}`
      this.emit({ phase: 'error', label: msg, error: msg })
      throw new Error(msg)
    }

    await fs.rm(destDir, { recursive: true, force: true })
    await fs.mkdir(dirname(destDir), { recursive: true })
    await fs.rename(staging, destDir)

    const manifest: Manifest = {
      tag: release.tag_name,
      variant,
      binary: binaryName,
      installedAt: new Date().toISOString()
    }
    await fs.writeFile(this.manifestPath(variant), JSON.stringify(manifest, null, 2), 'utf8')

    try {
      await fs.rm(downloads, { recursive: true, force: true })
    } catch {
      /* ignore */
    }

    const status = await this.getStatus(customPath, want)
    this.latestTagCache = { tag: release.tag_name, at: Date.now() }
    this.emit({
      phase: 'ready',
      label: `Installed ${release.tag_name} (${variant})`,
      tag: release.tag_name,
      variant,
      fraction: 1,
      bytesReceived: receivedGlobal,
      bytesTotal: totalBytes || receivedGlobal,
      bytesPerSecond: 0
    })
    return status
  }

  private async resolveTargetPack(
    selection: LlamaRuntimeSelection,
    packs: LlamaRuntimePackStatus[]
  ): Promise<LlamaRuntimePack> {
    if (isLlamaRuntimePack(selection)) return selection
    const gpu = await detectGpuInfo()
    if (gpu) return 'cuda-12.4'
    if (packs.find((p) => p.variant === 'vulkan')?.ready) return 'vulkan'
    return 'cpu'
  }

  private readManifest(pack: LlamaRuntimePack): Manifest | null {
    return this.readManifestAt(this.manifestPath(pack))
  }

  private readManifestAt(path: string): Manifest | null {
    try {
      const raw = readFileSync(path, 'utf8')
      return JSON.parse(raw) as Manifest
    } catch {
      return null
    }
  }
}

function idleProgress(): LlamaRuntimeProgress {
  return {
    phase: 'idle',
    label: '',
    bytesReceived: 0,
    bytesTotal: 0,
    fraction: 0
  }
}

async function fetchLatestRelease(): Promise<GhRelease> {
  // Prefer /latest, but llama.cpp often publishes the tag before Windows zips finish uploading.
  let latest: GhRelease | null = null
  try {
    latest = await fetchReleaseJson(GH_API_LATEST)
  } catch {
    /* fall through to list */
  }

  const res = await fetch(GH_API_LIST, { headers: GH_HEADERS })
  if (!res.ok) {
    throw new Error(`GitHub releases API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const list = (await res.json()) as GhRelease[]
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Unexpected GitHub releases list')
  }
  const usable = pickUsableRelease(latest, list)
  if (!usable) {
    throw new Error('No llama.cpp release with Windows runtime assets found')
  }
  return usable
}

async function fetchReleaseJson(url: string): Promise<GhRelease> {
  const res = await fetch(url, { headers: GH_HEADERS })
  if (!res.ok) {
    throw new Error(`GitHub releases API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = (await res.json()) as GhRelease
  if (!json?.tag_name || !Array.isArray(json.assets)) {
    throw new Error('Unexpected GitHub release payload')
  }
  return json
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} for ${url}`)
  }
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  const out = createWriteStream(dest)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total || received)
  })
  await pipeline(nodeStream, out)
}

function parseSha256Digest(digest: string | undefined): string | null {
  if (!digest?.trim()) return null
  const m = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim())
  return m ? m[1]!.toLowerCase() : null
}

async function verifySha256(
  filePath: string,
  digest: string | undefined,
  name: string
): Promise<void> {
  const expected = parseSha256Digest(digest)
  if (!expected) {
    throw new Error(`Missing SHA256 digest for ${name}; refusing to install`)
  }
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${name}`)
  }
}

async function unzipWindows(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  // Windows Expand-Archive — avoid an extra unzip dependency
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    ],
    { windowsHide: true, timeout: 600_000 }
  )
}

async function flattenCopy(fromDir: string, toDir: string): Promise<void> {
  if (!existsSync(fromDir)) return
  await fs.mkdir(toDir, { recursive: true })
  const entries = await fs.readdir(fromDir, { withFileTypes: true })
  for (const ent of entries) {
    const src = join(fromDir, ent.name)
    const dest = join(toDir, ent.name)
    if (ent.isDirectory()) {
      // Flatten nested zip folders into toDir
      await flattenCopy(src, toDir)
    } else if (ent.isFile()) {
      await fs.copyFile(src, dest)
    }
  }
}

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const ent of entries) {
      const p = join(dir, ent)
      try {
        const st = statSync(p)
        if (st.isDirectory()) stack.push(p)
        else if (st.isFile() && ent.toLowerCase() === name.toLowerCase()) return p
      } catch {
        /* skip */
      }
    }
  }
  return null
}

export const llamaRuntime = new LlamaRuntimeManager()
