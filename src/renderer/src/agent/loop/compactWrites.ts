/**
 * Compact history must keep a valid write_file schema (relative_path + content).
 * A `note` field is not in the tool schema — models copy it and skip the file body.
 *
 * The stub MUST look like a history marker, never like source. Ornith treated
 * `[omitted — file on disk, N chars]` as the bytes it wrote, then rewrote the
 * marker or stopped mid-scaffold.
 */

export const WRITE_FILE_HISTORY_COMPACT_PREFIX = '[HISTORY_COMPACT]'

export function stubWriteFileArgs(opts: {
  relativePath?: string | null
  omittedChars?: number
  lineCount?: number | null
  latest?: boolean
}): string {
  const n = opts.omittedChars ?? 0
  const lines = opts.lineCount != null ? `, ${opts.lineCount} lines` : ''
  const when = opts.latest === false ? 'earlier write, ' : ''
  const meta =
    n > 0 || lines
      ? ` (${when}already on disk${n > 0 ? `, ${n} chars` : ''}${lines})`
      : when
        ? ' (earlier write, already on disk)'
        : ' (already on disk)'
  const args: Record<string, string> = {
    content:
      `${WRITE_FILE_HISTORY_COMPACT_PREFIX} This is NOT file contents${meta}. ` +
      'The real file is already saved. Do NOT copy this marker into write_file. ' +
      'Do NOT rewrite this path. Next missing file: full real source only.'
  }
  const path = (opts.relativePath ?? '').trim()
  if (path) args.relative_path = path
  return JSON.stringify(args)
}
