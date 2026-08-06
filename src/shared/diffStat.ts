/** +/- line stats for agent tool rows (also used by smoke tests). */

export interface DiffStat {
  added: number
  removed: number
}

export function formatDiffStat(stat: DiffStat | null | undefined): string | null {
  if (!stat) return null
  if (stat.added <= 0 && stat.removed <= 0) return null
  const parts: string[] = []
  if (stat.added > 0) parts.push(`+${stat.added}`)
  if (stat.removed > 0) parts.push(`-${stat.removed}`)
  return parts.join(' ')
}

/** Count +/- from apply_patch body or unified-ish preview. */
export function diffStatFromPatchText(text: string): DiffStat {
  let added = 0
  let removed = 0
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/** write_file / plain preview: treat all lines as added. */
export function diffStatFromCodePreview(
  toolName: string | undefined,
  codePreview: string | undefined,
  content?: string
): DiffStat | null {
  const name = toolName ?? ''
  if (name === 'apply_patch' || name === 'apply_diff') {
    const src = codePreview || content || ''
    if (!src.trim()) return null
    return diffStatFromPatchText(src)
  }
  if (name === 'write_file' || name === 'create_directory') {
    const src = codePreview || ''
    if (!src.trim()) return null
    const n = src.split('\n').length
    return { added: n, removed: 0 }
  }
  if (codePreview?.trim()) {
    return { added: codePreview.split('\n').length, removed: 0 }
  }
  return null
}
