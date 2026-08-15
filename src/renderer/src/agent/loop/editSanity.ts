import { contentLooksStructurallyComplete } from '../../../../shared/completeness'
import { formatI18nSanityHint, I18N_SANITY_PREFIX } from './i18nSanity'

export const EDIT_SANITY_PREFIX = 'EDIT_SANITY:'

/**
 * Static post-write checks. Does not execute code.
 * Combines language-agnostic completeness with HTML/JS i18n object-in-DOM.
 */
export function formatEditSanityHint(opts: {
  path?: string
  content?: string
  html?: string
  js?: string
}): string | null {
  const i18n = formatI18nSanityHint({ html: opts.html, js: opts.js })
  if (i18n) return i18n
  const path = (opts.path ?? '').trim()
  const content = opts.content ?? ''
  if (!path || !content.trim()) return null
  if (!contentLooksStructurallyComplete(content, path)) {
    return (
      `${EDIT_SANITY_PREFIX} "${path}" looks structurally incomplete. ` +
      'Do not claim the task is done. Finish this file (balanced braces / complete document) ' +
      'with write_file overwrite=true or apply_diff — do not start another file.'
    )
  }
  return null
}

export function isEditSanityFailure(text: string | null | undefined): boolean {
  const t = text ?? ''
  return t.includes(EDIT_SANITY_PREFIX) || t.includes(I18N_SANITY_PREFIX)
}
