/**
 * Same-turn write cap for from-scratch landings: one complete write per path
 * (Cursor-like), plus one recovery only on the file that failed sanity.
 */

import {
  WRITE_FILE_REQUIRED_PREFIX,
  formatWriteFileRequiredError
} from '../../../../shared/writeFileRequired'

export { WRITE_FILE_REQUIRED_PREFIX, formatWriteFileRequiredError }

export const WRITE_ONCE_PREFIX = 'WRITE_ONCE:'

/** From-scratch: apply_diff/apply_patch before a complete write this turn. */
export function shouldRequireWriteFileForApply(opts: {
  fromScratch: boolean
  path: string
  completeWritesThisTurn: number
}): boolean {
  if (!opts.fromScratch) return false
  if (!isCappedLandingWritePath(opts.path)) return false
  return opts.completeWritesThisTurn <= 0
}

export function formatScratchWriteFileHint(): string {
  return (
    'Call write_file overwrite=true allow_full_rewrite=true ONCE with the COMPLETE file, ' +
    'then WRITE_ONCE (do not overwrite that path again). Do not retry apply_diff.'
  )
}

export type LandingRewriteDecision = 'ok' | 'allow_recovery' | 'refuse'

export function landingSourceKind(
  relativePath: string
): 'html' | 'css' | 'js' | 'md' | null {
  const p = (relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (!p) return null
  if (/\.html?$/.test(p)) return 'html'
  if (/\.css$/.test(p)) return 'css'
  if (/\.(js|mjs|cjs)$/.test(p)) return 'js'
  if (/\.md$/.test(p)) return 'md'
  return null
}

export function isCappedLandingWritePath(relativePath: string): boolean {
  return landingSourceKind(relativePath) !== null
}

/**
 * First complete write is always ok.
 * Second write only if THIS path failed sanity and recovery was not used.
 * Otherwise refuse (including rewriting js/main.js after it already succeeded).
 */
export function shouldRefuseLandingRewrite(opts: {
  path: string
  completeWritesThisTurn: number
  recoveryUsedOnPath: boolean
  sanityFailedOnThisPath: boolean
}): LandingRewriteDecision {
  if (!isCappedLandingWritePath(opts.path)) return 'ok'
  const writes = opts.completeWritesThisTurn
  if (writes <= 0) return 'ok'
  if (opts.sanityFailedOnThisPath && !opts.recoveryUsedOnPath && writes === 1) {
    return 'allow_recovery'
  }
  return 'refuse'
}

export function formatWriteOnceError(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/') || 'this file'
  return (
    `${WRITE_ONCE_PREFIX} already wrote complete "${p}". Do not rewrite. ` +
    'Next missing file or Start-Process once, then STOP.'
  )
}

/** CSS + HTML + JS each have at least one complete write this turn. */
export function landingBundleReady(completeWritesByPath: Map<string, number>): boolean {
  let html = false
  let css = false
  let js = false
  for (const [p, n] of completeWritesByPath) {
    if (n < 1) continue
    const k = landingSourceKind(p)
    if (k === 'html') html = true
    if (k === 'css') css = true
    if (k === 'js') js = true
  }
  return html && css && js
}
