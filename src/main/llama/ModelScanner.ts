import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { DiscoveredModel } from '../../shared/settings'
import { scoreMmprojForVision } from '../../shared/visionDetect'

/** Scan a directory tree for .gguf weights (skips mmproj side-cars). */
export async function scanGgufModels(root: string): Promise<DiscoveredModel[]> {
  if (!existsSync(root)) return []
  const found: DiscoveredModel[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue
      if (/mmproj/i.test(entry.name)) continue
      const st = await fs.stat(full)
      const rel = relative(root, full).replace(/\\/g, '/')
      found.push({
        id: rel || basename(full),
        path: full,
        sizeBytes: st.size
      })
    }
  }

  await walk(root)
  found.sort((a, b) => a.id.localeCompare(b.id))
  return found
}

/** Scan for mmproj / projector GGUF side-cars only. */
export async function scanMmprojFiles(root: string): Promise<DiscoveredModel[]> {
  if (!existsSync(root)) return []
  const found: DiscoveredModel[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue
      if (!/mmproj/i.test(entry.name)) continue
      const st = await fs.stat(full)
      const rel = relative(root, full).replace(/\\/g, '/')
      found.push({
        id: rel || basename(full),
        path: full,
        sizeBytes: st.size
      })
    }
  }

  await walk(root)
  found.sort((a, b) => a.id.localeCompare(b.id))
  return found
}

/**
 * Prefer an explicit path when it matches the model family; otherwise pick
 * the *mmproj*.gguf in the same folder that best matches the vision GGUF.
 * Never return an Ornith projector for Gemma (n_embd mismatch).
 */
export async function findMmprojForModel(
  visionModelPath: string,
  explicitMmprojPath?: string
): Promise<string | null> {
  const model = visionModelPath?.trim() || ''
  const explicit = explicitMmprojPath?.trim()
  if (explicit && existsSync(explicit)) {
    if (!model || scoreMmprojForVision(explicit, model) >= 0) return explicit
  }

  if (!model || !existsSync(model)) return null

  const dir = dirname(model)
  try {
    const entries = await fs.readdir(dir)
    const mmprojs = entries.filter(
      (n) => n.toLowerCase().endsWith('.gguf') && /mmproj/i.test(n)
    )
    let best: { path: string; score: number } | null = null
    for (const n of mmprojs) {
      const full = join(dir, n)
      const score = scoreMmprojForVision(full, model)
      if (score < 0) continue
      if (!best || score > best.score) best = { path: full, score }
    }
    if (best) return best.path
  } catch {
    /* ignore */
  }
  return null
}

/** Scan for downloadable weight files (gguf + safetensors + ckpt) under modelsDir. */
export async function scanWeightFiles(root: string): Promise<DiscoveredModel[]> {
  if (!existsSync(root)) return []
  const found: DiscoveredModel[] = []
  const exts = new Set(['.gguf', '.safetensors', '.ckpt', '.pt'])

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full)
        continue
      }
      const lower = entry.name.toLowerCase()
      const dot = lower.lastIndexOf('.')
      if (dot < 0) continue
      const ext = lower.slice(dot)
      if (!exts.has(ext)) continue
      const st = await fs.stat(full)
      const rel = relative(root, full).replace(/\\/g, '/')
      found.push({
        id: rel || basename(full),
        path: full,
        sizeBytes: st.size
      })
    }
  }

  await walk(root)
  found.sort((a, b) => a.id.localeCompare(b.id))
  return found
}
