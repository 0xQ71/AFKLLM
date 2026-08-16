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

const LAYOUT_CLASS =
  /^(?:site-)?(?:header|nav|navbar|hero|brand|btn|container|feature|footer|section|lang|cta|step|why|download|logo)[\w-]*/i

export function extractHtmlClassTokens(html: string): string[] {
  const out: string[] = []
  const re = /class\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    for (const tok of (m[1] ?? '').split(/\s+/)) {
      const c = tok.trim()
      if (c && !out.includes(c)) out.push(c)
    }
  }
  return out
}

export function extractCssClassNames(css: string, max = 40): string[] {
  const names: string[] = []
  const re = /\.([a-zA-Z_][\w-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const n = m[1] ?? ''
    if (n && !names.includes(n)) names.push(n)
    if (names.length >= max) break
  }
  return names
}

export function cssDefinesClass(css: string, name: string): boolean {
  if (!name.trim()) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\.${escaped}(?:\\s|,|\\.|:|\\[|\\{)`, 'i').test(css)
}

/** HTML invented layout classes that the stylesheet never styles. */
export function missingHtmlLayoutClassesInCss(html: string, css: string): string[] {
  if (!html.trim() || css.trim().length < 80) return []
  const missing: string[] = []
  for (const c of extractHtmlClassTokens(html)) {
    if (!LAYOUT_CLASS.test(c)) continue
    if (cssDefinesClass(css, c)) continue
    missing.push(c)
  }
  return missing
}

export function htmlCssLayoutMismatch(html: string, css: string): boolean {
  return missingHtmlLayoutClassesInCss(html, css).length >= 4
}

/** Header/logo SVG without width/height and without a CSS size — fills the viewport. */
export function inlineSvgLooksUnsized(html: string, css: string): boolean {
  const chunk =
    html.match(/<header\b[\s\S]{0,3500}/i)?.[0] ??
    html.match(/<a\b[^>]*class\s*=\s*["'][^"']*(?:brand|logo)[^"']*["'][^>]*>[\s\S]{0,800}/i)?.[0] ??
    html.slice(0, 2800)
  const re = /<svg\b([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(chunk))) {
    const attrs = m[1] ?? ''
    if (/\b(?:width|height)\s*=/i.test(attrs)) continue
    if (/\bstyle\s*=\s*["'][^"']*(?:width|height|max-width)\s*:/i.test(attrs)) continue
    const clsM = attrs.match(/\bclass\s*=\s*["']([^"']+)/i)
    const classes = (clsM?.[1] ?? '').split(/\s+/).filter(Boolean)
    const sized = classes.some((c) => {
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rule = new RegExp(`\\.${escaped}\\b[^{]{0,80}\\{([^}]*)\\}`, 'i')
      const body = css.match(rule)?.[1] ?? ''
      return /(?:width|height|max-width|inline-size)\s*:/i.test(body)
    })
    if (!sized) return true
  }
  return false
}

/** After CSS is on disk: next HTML write must reuse these class names. */
export function formatLandingCssContractHint(css: string): string | null {
  const names = extractCssClassNames(css, 36)
  if (names.length < 6) return null
  return (
    'LANDING_CONTRACT: styles.css already defines ' +
    names.map((n) => `.${n}`).join(' ') +
    '. index.html MUST use these class names from THIS stylesheet. ' +
    'Every inline <svg> needs width and height attributes (e.g. 32) or a CSS rule that sets them. ' +
    'When writing index.html, JS getElementById / #id and data-i18n keys must match that markup.'
  )
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
  const parts: string[] = []
  const i18n = formatI18nSanityHint({ html: opts.html, js: opts.js })
  if (i18n) parts.push(i18n)
  const path = (opts.path ?? '').trim()
  const content = opts.content ?? ''
  const html = opts.html ?? ''
  const css = opts.css ?? ''
  const js = opts.js ?? ''

  if (html.trim() && /<html[\s>]|<!DOCTYPE\s+html/i.test(html)) {
    if (!/<link\b[^>]*rel\s*=\s*["']stylesheet["']/i.test(html)) {
      parts.push(
        `${EDIT_SANITY_PREFIX} index.html has no stylesheet <link>. ` +
          'Link styles.css (or the CSS you wrote) before claiming the page is done.'
      )
    } else if (opts.cssPath && css.trim() && !htmlHasStylesheetLink(html, opts.cssPath)) {
      parts.push(
        `${EDIT_SANITY_PREFIX} "${opts.cssPath}" exists but index.html does not <link> it. ` +
          'Fix the href with apply_diff — do not rewrite the whole page.'
      )
    }
    const missing = missingHtmlLayoutClassesInCss(html, css)
    if (missing.length >= 4) {
      parts.push(
        `${EDIT_SANITY_PREFIX} HTML class names are not in CSS: ${missing.slice(0, 10).join(', ')}. ` +
          'index.html must reuse class names from styles.css (e.g. .navbar .nav-links .hero-content) — ' +
          'do not invent .site-header / .hero-inner. apply_diff HTML to match CSS, or add the missing CSS rules. ' +
          'Do NOT Start-Process / claim the landing looks professional yet.'
      )
    }
    if (inlineSvgLooksUnsized(html, css)) {
      parts.push(
        `${EDIT_SANITY_PREFIX} header/logo <svg> has no width/height and CSS does not size it — it will fill the screen. ` +
          'Set width="32" height="32" on the svg (or a CSS rule). apply_diff — do not claim done.'
      )
    }
    if (navLooksUnstyled(html, css)) {
      parts.push(
        `${EDIT_SANITY_PREFIX} nav <ul> will render as a vertical bulleted list. ` +
          'Give .nav-links / nav ul display:flex and list-style:none via apply_diff. ' +
          'Do not claim the landing looks professional yet.'
      )
    }
  }

  if (looksLikeThemeToggleRequest(opts.userText ?? '') && !htmlJsHasThemeControl(html, js)) {
    parts.push(
      `${EDIT_SANITY_PREFIX} the user asked for a light/dark theme toggle, but HTML/JS has no ` +
        'data-theme / theme control. Add it with apply_diff — do not claim the task is done.'
    )
  }

  if (path && content.trim() && !contentLooksStructurallyComplete(content, path)) {
    parts.push(
      `${EDIT_SANITY_PREFIX} "${path}" looks structurally incomplete. ` +
        'Do not claim the task is done. Finish this file (balanced braces / complete document) ' +
        'with write_file overwrite=true or apply_diff — do not start another file.'
    )
  }
  return parts.length ? parts.join('\n') : null
}

export function isEditSanityFailure(text: string | null | undefined): boolean {
  const t = text ?? ''
  return t.includes(EDIT_SANITY_PREFIX) || t.includes(I18N_SANITY_PREFIX)
}
