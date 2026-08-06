import { existsSync, promises as fs } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { DiscoveredModel } from '../../shared/settings'

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
