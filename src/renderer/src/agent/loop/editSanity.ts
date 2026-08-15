import { contentLooksStructurallyComplete } from '../../../../shared/completeness'
import { looksLikeThemeToggleRequest } from '../agentPure'
import { formatI18nSanityHint, I18N_SANITY_PREFIX } from './i18nSanity'

export const EDIT_SANITY_PREFIX = 'EDIT_SANITY:'

function htmlHasStylesheetLink(html: string, cssPath?: string): boolean {
  if (!/<link\b[^>]*rel\s*=\s*["']stylesheet["']/i.test(html)) return false
  const base = (cssPath ?? 'styles.css').replace(/\\/g, '/').split('/').pop() ?? 'styles.css'
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<link\\b[^>]*href\\s*=\\s*["'][^"']*${escaped}["']`, 'i').test(html)
}

/** True when a nav list exists in HTML but CSS never makes it a horizontal bar. */
export function navLooksUnstyled(html: string, css: string): boolean {
  if (!html.trim() || !css.trim()) return false
  const hasNavList =
    /class\s*=\s*["'][^"']*nav-links/i.test(html) ||
    /<nav\b[\s\S]{0,800}<ul\b/i.test(html)
  if (!hasNavList) return false
  const re = /([^{}]+)\{([^{}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const sel = m[1] ?? ''
    const body = m[2] ?? ''
    if (!/(?:\.nav-links|\.nav\b|\bnav\b)/i.test(sel)) continue
    if (!/(?:ul|\.nav-links)/i.test(sel) && !/\.nav\b/i.test(sel)) continue
    if (/display\s*:\s*(?:flex|grid)|list-style\s*:\s*none/i.test(body)) return false
  }
  return true
}

export function htmlJsHasThemeControl(html: string, js: string): boolean {
  const blob = `${html}\n${js}`
  return /data-theme|theme-toggle|themeToggle|id\s*=\s*["']theme|class\s*=\s*["'][^"']*theme-toggle/i.test(
    blob
  )
}

/**
 * Static post-write checks. Does not execute code.
 * Combines language-agnostic completeness with HTML/JS i18n and landing wiring.
 */
export function formatEditSanityHint(opts: {
  path?: string
  content?: string
  html?: string
  js?: string
  css?: string
  cssPath?: string
  userText?: string
}): string | null {
  const i18n = formatI18nSanityHint({ html: opts.html, js: opts.js })
  if (i18n) return i18n
  const path = (opts.path ?? '').trim()
  const content = opts.content ?? ''
  const html = opts.html ?? ''
  const css = opts.css ?? ''
  const js = opts.js ?? ''

  if (html.trim() && /<html[\s>]|<!DOCTYPE\s+html/i.test(html)) {
    if (!/<link\b[^>]*rel\s*=\s*["']stylesheet["']/i.test(html)) {
      return (
        `${EDIT_SANITY_PREFIX} index.html has no stylesheet <link>. ` +
        'Link styles.css (or the CSS you wrote) before claiming the page is done.'
      )
    }
    if (opts.cssPath && css.trim() && !htmlHasStylesheetLink(html, opts.cssPath)) {
      return (
        `${EDIT_SANITY_PREFIX} "${opts.cssPath}" exists but index.html does not <link> it. ` +
        'Fix the href with apply_diff — do not rewrite the whole page.'
      )
    }
    if (navLooksUnstyled(html, css)) {
      return (
        `${EDIT_SANITY_PREFIX} nav <ul> will render as a vertical bulleted list. ` +
        'Give .nav-links / nav ul display:flex and list-style:none via apply_diff. ' +
        'Do not claim the landing looks professional yet.'
      )
    }
  }

  if (looksLikeThemeToggleRequest(opts.userText ?? '') && !htmlJsHasThemeControl(html, js)) {
    return (
      `${EDIT_SANITY_PREFIX} the user asked for a light/dark theme toggle, but HTML/JS has no ` +
      'data-theme / theme control. Add it with apply_diff — do not claim the task is done.'
    )
  }

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
