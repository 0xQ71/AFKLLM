import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ProjectRulesSnapshot } from '../../shared/context'

export type { ProjectRulesSnapshot }

const RULES_MAX_CHARS = 5_000
const RULES_MAX_FILES = 12

/**
 * Load project rules from `.afkllm/`
 * (rules.md, AGENTS.md, RULES.md, and markdown under rules/).
 */
export async function loadProjectRules(root: string): Promise<ProjectRulesSnapshot> {
  const files: string[] = []
  const chunks: string[] = []
  let used = 0

  const tryRead = async (abs: string, label: string): Promise<void> => {
    if (used >= RULES_MAX_CHARS || files.length >= RULES_MAX_FILES) return
    try {
      const raw = await fs.readFile(abs, 'utf8')
      const body = raw.trim()
      if (!body) return
      const room = RULES_MAX_CHARS - used
      const slice = body.length > room ? body.slice(0, room) + '\n…(truncated)' : body
      chunks.push(`### ${label}\n${slice}`)
      used += slice.length
      files.push(label)
    } catch {
      /* missing ok */
    }
  }

  const base = join(root, '.afkllm')
  await tryRead(join(base, 'rules.md'), '.afkllm/rules.md')
  await tryRead(join(base, 'AGENTS.md'), '.afkllm/AGENTS.md')
  await tryRead(join(base, 'RULES.md'), '.afkllm/RULES.md')

  const rulesDir = join(base, 'rules')
  try {
    const entries = await listMdRecursive(rulesDir, root, 3)
    for (const rel of entries) {
      if (files.length >= RULES_MAX_FILES) break
      await tryRead(join(root, ...rel.split('/')), rel)
    }
  } catch {
    /* no rules dir */
  }

  if (chunks.length === 0) {
    return { text: '', files: [] }
  }

  return {
    text:
      '[Project rules — follow these for this repository]\n' + chunks.join('\n\n'),
    files
  }
}

async function listMdRecursive(
  dir: string,
  root: string,
  maxDepth: number,
  depth = 0
): Promise<string[]> {
  if (depth > maxDepth) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const e of sorted) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await listMdRecursive(full, root, maxDepth, depth + 1)))
    } else if (/\.md$/i.test(e.name)) {
      out.push(relative(root, full).split(sep).join('/'))
    }
  }
  return out
}
