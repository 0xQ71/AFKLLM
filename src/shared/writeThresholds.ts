/** Shared write-size gates for renderer + main (no landing-only allowlist). */

export const SMALL_FILE_OVERWRITE_CHARS = 6000
export const LARGE_FILE_OVERWRITE_CHARS = 40_000
export const TRUNCATION_GUARD_RATIO = 0.7

/** Any source file under this size may be overwritten in one shot. */
export function allowsFullOverwrite(relativePath: string, contentChars: number): boolean {
  if (contentChars < SMALL_FILE_OVERWRITE_CHARS) return true
  if (contentChars >= LARGE_FILE_OVERWRITE_CHARS) return false
  return /\.(html?|css|md|svg|js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|toml|xml|py|java|kt|cs|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|swift|rb|php|lua|scala|sh|ps1|bat|cmake|mk|gradle|proto|sql|txt)$/i.test(
    relativePath
  )
}

/** Refuse shrinking a finished file unless allow_full_rewrite is set. */
export function truncationGuardMessage(opts: {
  relativePath: string
  existingBytes: number
  newBytes: number
  allowFullRewrite?: boolean
  existingComplete?: boolean
}): string | null {
  if (opts.allowFullRewrite) return null
  if (!opts.existingComplete) return null
  if (opts.existingBytes <= 0) return null
  if (opts.newBytes >= opts.existingBytes * TRUNCATION_GUARD_RATIO) return null
  const pct = Math.round((1 - opts.newBytes / opts.existingBytes) * 100)
  return (
    `TRUNCATION_GUARD: "${opts.relativePath}" is ${opts.existingBytes} bytes, ` +
    `new content is ${opts.newBytes} bytes (-${pct}%).\n` +
    'Send the COMPLETE file or use apply_diff. Pass allow_full_rewrite=true to shrink it deliberately.'
  )
}
