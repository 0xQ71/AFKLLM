/**
 * Compact history must keep a valid write_file schema (relative_path + content).
 * A `note` field is not in the tool schema — models copy it and skip the file body.
 */

export function stubWriteFileArgs(opts: {
  relativePath?: string | null
  omittedChars?: number
  lineCount?: number | null
  latest?: boolean
}): string {
  const n = opts.omittedChars ?? 0
  const lines = opts.lineCount != null ? `, ${opts.lineCount} lines` : ''
  const when = opts.latest === false ? 'earlier write, ' : ''
  const args: Record<string, string> = {
    content: `[omitted — ${when}file on disk${n > 0 ? `, ${n} chars` : ''}${lines}]`
  }
  const path = (opts.relativePath ?? '').trim()
  if (path) args.relative_path = path
  return JSON.stringify(args)
}
