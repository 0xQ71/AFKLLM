import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  detectStacks,
  type ProjectStack
} from '../../shared/projectStack'

const ROOT_SCAN_MAX = 80

export interface ProjectStackSnapshot {
  stacks: ProjectStack[]
  markers: string[]
  text: string
}

/** Shallow scan of workspace root (+ one level) for stack marker files. */
export async function probeProjectStack(root: string): Promise<ProjectStackSnapshot> {
  if (!root) {
    return { stacks: [], markers: [], text: '' }
  }
  const files: string[] = []
  try {
    const top = await fs.readdir(root, { withFileTypes: true })
    for (const e of top) {
      if (e.name.startsWith('.') && e.name !== '.csproj') continue
      if (e.isFile()) {
        files.push(e.name)
        if (files.length >= ROOT_SCAN_MAX) break
        continue
      }
      if (!e.isDirectory()) continue
      if (
        /^(node_modules|\.git|dist|out|build|target|vendor|__pycache__|\.venv)$/i.test(
          e.name
        )
      ) {
        continue
      }
      let inner: import('node:fs').Dirent[]
      try {
        inner = await fs.readdir(join(root, e.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const c of inner) {
        if (!c.isFile()) continue
        files.push(`${e.name}/${c.name}`)
        if (files.length >= ROOT_SCAN_MAX) break
      }
      if (files.length >= ROOT_SCAN_MAX) break
    }
  } catch {
    return { stacks: [], markers: [], text: '' }
  }

  let packageJson: string | null = null
  if (files.some((f) => f === 'package.json' || f.endsWith('/package.json'))) {
    try {
      packageJson = await fs.readFile(join(root, 'package.json'), 'utf8')
    } catch {
      packageJson = null
    }
  }

  const stacks = detectStacks(files, { packageJson })
  const markers = [...new Set(files.filter((f) =>
    stacks.some((s) =>
      s.markers.some((m) => {
        const base = f.replace(/\\/g, '/').split('/').pop() ?? f
        if (m.startsWith('.')) return base.toLowerCase().endsWith(m.toLowerCase())
        return base.toLowerCase() === m.toLowerCase()
      })
    )
  ))]
  const text = formatSnapshot(stacks, markers)
  return { stacks, markers, text }
}

function formatSnapshot(stacks: ProjectStack[], markers: string[]): string {
  if (stacks.length === 0) {
    return 'stack: unknown'
  }
  return stacks
    .map((s) => {
      const cmds = [s.build && `build=${s.build}`, s.test && `test=${s.test}`]
        .filter(Boolean)
        .join('; ')
      return `${s.id} [${markers.join(', ')}]${cmds ? ` ${cmds}` : ''}`
    })
    .join('\n')
}
