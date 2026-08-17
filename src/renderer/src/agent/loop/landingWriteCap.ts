/**
 * From-scratch landing helpers: require write_file before apply on a missing
 * path; overwrites of a complete file are allowed.
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
  return 'Call write_file overwrite=true allow_full_rewrite=true with the COMPLETE file.'
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

/** Overwrite of a complete landing file is allowed. */
export function shouldRefuseLandingRewrite(_opts: {
  path: string
  completeWritesThisTurn: number
  recoveryUsedOnPath: boolean
  sanityFailedOnThisPath: boolean
}): LandingRewriteDecision {
  return 'ok'
}

export function formatWriteOnceError(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/') || 'this file'
  return (
    `${WRITE_ONCE_PREFIX} already wrote complete "${p}". Do not rewrite. ` +
    'Next missing file or Start-Process once, then STOP.'
  )
}

/** JS landed first — missing HTML ids are expected, not a JS bug. */
export function formatLandingJsBeforeHtmlHint(): string {
  return (
    'LANDING_ORDER: index.html is not on disk yet. Missing #ids / data-i18n in markup are expected. ' +
    'Do NOT rewrite this JS file to "fix" selectors. Next: styles.css (if missing), then a complete index.html that uses those ids, then README.'
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
