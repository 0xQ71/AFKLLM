import { contentLooksStructurallyComplete } from '../../../../shared/completeness'
import { looksLikeThemeToggleRequest, looksLikeNoCardDumpRequest } from '../agentPure'
import { formatI18nSanityHint, I18N_SANITY_PREFIX } from './i18nSanity'
import { looksLikeViteReactTask } from './landingWriteCap'

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
  const stripped = (css ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\s*\([^)]*\)/gi, 'url()')
  const blockRe = /([^{}]+)\{/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(stripped))) {
    const sel = block[1] ?? ''
    const classRe = /\.([a-zA-Z_][\w-]*)/g
    let m: RegExpExecArray | null
    while ((m = classRe.exec(sel))) {
      const n = m[1] ?? ''
      if (!n || /^(svg|png|jpe?g|gif|webp|ico|js|mjs|cjs|css|html)$/i.test(n)) continue
      if (!names.includes(n)) names.push(n)
      if (names.length >= max) return names
    }
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

export function countLandingCardClasses(html: string): number {
  return (html.match(/class\s*=\s*["'][^"']*\b(?:feature-card|why-card)\b[^"']*["']/gi) ?? [])
    .length
}

export function htmlLooksLikeCardDump(html: string): boolean {
  return countLandingCardClasses(html) >= 4
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

function isGameOrUiHandlerName(name: string): boolean {
  return /^(cast|hook|strike|reel|bait|fish)/i.test(name) || /^(handle|on)[A-Z]\w*$/.test(name)
}

/**
 * React/JSX: `castLine` / `handleClick` defined but never wired to onClick.
 * Static — does not execute the component.
 */
export function unboundJsxClickHandlers(src: string): string[] {
  const t = src ?? ''
  if (!t.trim()) return []
  const names: string[] = []
  const defRe =
    /(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g
  let m: RegExpExecArray | null
  while ((m = defRe.exec(t))) {
    const n = m[1] || m[2]
    if (n && isGameOrUiHandlerName(n) && !names.includes(n)) names.push(n)
  }
  return names.filter((n) => !jsxHandlerIsBound(t, n))
}

function jsxHandlerIsBound(src: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\bon[A-Z][A-Za-z]+\\s*=\\s*\\{[^}]*\\b${esc}\\b`).test(src)) {
    return true
  }
  if (
    new RegExp(
      `addEventListener\\s*\\(\\s*['"](?:click|pointerdown|mousedown)['"]\\s*,\\s*${esc}\\b`,
      'i'
    ).test(src)
  ) {
    return true
  }
  return false
}

export function extractHtmlModuleScriptSrcs(html: string): string[] {
  const out: string[] = []
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const s = (m[1] ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function pathBasename(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
}

export { looksLikeViteReactTask }

/** Relative `import './foo.css'` specifiers in JS/JSX. */
export function extractCssImportSpecs(js: string): string[] {
  const out: string[] = []
  const re = /import\s+['"]([^'"]+\.css)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js ?? ''))) {
    const s = (m[1] ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** JSX imports a stylesheet that is not the CSS file already written this turn. */
export function jsxMissingCssImports(js: string, knownCssPath?: string): string[] {
  const known = pathBasename(knownCssPath ?? '').toLowerCase()
  if (!known) return []
  return extractCssImportSpecs(js).filter((spec) => pathBasename(spec).toLowerCase() !== known)
}

/**
 * Vite React index.html should be a thin #root shell. Game UI in App.jsx.
 * data-i18n / extra buttons inside #root is a landing dump (T06f).
 */
export function viteReactHtmlLooksLikePageDump(html: string): boolean {
  if (!/<script[^>]+src=["'][^"']+\.(jsx|tsx)["']/i.test(html)) return false
  if (/data-i18n\s*=/i.test(html)) return true
  const buttons = html.match(/<button\b/gi)?.length ?? 0
  const headings = html.match(/<h[1-3]\b/gi)?.length ?? 0
  return buttons + headings >= 2
}

/** index.html script vs last React write. Vite main.jsx + App.jsx is not a mismatch. */
export function viteHtmlEntryMismatch(html: string, jsPath?: string): string | null {
  if (!html.trim() || !jsPath) return null
  const srcs = extractHtmlModuleScriptSrcs(html)
  if (!srcs.length) return null
  const jsNorm = jsPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const jsBase = pathBasename(jsNorm)
  if (!/\.(jsx?|tsx|mjs)$/i.test(jsBase)) return null
  const htmlPointsAtJs = srcs.some((s) => {
    const n = s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
    return n === jsNorm || n.endsWith(`/${jsBase}`) || pathBasename(n) === jsBase
  })
  if (htmlPointsAtJs) return null
  const other = srcs.find((s) => /\.(jsx?|tsx|mjs)$/i.test(s))
  if (!other) return null
  const htmlBase = pathBasename(other)
  if (htmlBase.toLowerCase() === jsBase.toLowerCase()) return null
  if (/^main\.(jsx|tsx|js)$/i.test(htmlBase) && /^App\.(jsx|tsx|js)$/i.test(jsBase)) {
    return null
  }
  if (/^App\.(jsx|tsx|js)$/i.test(htmlBase) && /^main\.(jsx|tsx|js)$/i.test(jsBase)) {
    return null
  }
  return other
}

export function extractJsxClassTokens(src: string): string[] {
  const out: string[] = []
  const re = /className\s*=\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src ?? ''))) {
    for (const tok of (m[1] ?? '').split(/\s+/)) {
      const c = tok.trim()
      if (c && !out.includes(c)) out.push(c)
    }
  }
  return out
}

const UTIL_CLASS =
  /^(flex|grid|hidden|block|inline|relative|absolute|fixed|sticky|sr-only|dark:|w-|h-|p-|m-|px-|py-|mx-|my-|pt-|pb-|pl-|pr-|mt-|mb-|text-|bg-|border|rounded|gap-|items-|justify-|overflow-|min-|max-|opacity-|shadow|cursor-|select-|font-|leading-|tracking-|whitespace-|break-|z-|top-|left-|right-|bottom-)/i

/** JSX invented class names that the stylesheet never styles (zero overlap). */
export function jsxCssClassMismatch(js: string, css: string): string[] {
  if (!js.trim() || css.trim().length < 80) return []
  const names = extractJsxClassTokens(js).filter((c) => !UTIL_CLASS.test(c))
  if (names.length < 3) return []
  const missing = names.filter((c) => !cssDefinesClass(css, c))
  const overlap = names.length - missing.length
  if (overlap === 0 && missing.length >= 3) return missing
  return []
}

function jsImportsStylesheet(js: string, cssPath?: string): boolean {
  if (/import\s+['"][^'"]+\.css['"]/.test(js)) return true
  const base = (cssPath ?? '').replace(/\\/g, '/').split('/').pop()
  if (!base) return false
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`import\\s+['"][^'"]*${escaped}['"]`).test(js)
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
  jsPath?: string
  userText?: string
}): string | null {
  const parts: string[] = []
  const viteReact = looksLikeViteReactTask(opts.userText, opts.html, opts.path || opts.jsPath)
  const i18n = formatI18nSanityHint({
    html: opts.html,
    js: opts.js,
    jsPath: opts.jsPath,
    userText: opts.userText
  })
  if (i18n) parts.push(i18n)
  const path = (opts.path ?? '').trim()
  const content = opts.content ?? ''
  const html = opts.html ?? ''
  const css = opts.css ?? ''
  const js = opts.js ?? ''

  if (html.trim() && /<html[\s>]|<!DOCTYPE\s+html/i.test(html)) {
    if (viteReactHtmlLooksLikePageDump(html) || (viteReact && /data-i18n\s*=/i.test(html))) {
      parts.push(
        `${EDIT_SANITY_PREFIX} Vite/React index.html must be a thin shell: empty <div id="root"></div> ` +
          'and <script type="module" src="/src/main.jsx">. Put the game UI in App.jsx. ' +
          'Do NOT dump data-i18n / buttons / headings into #root and do NOT write js/main.js. apply_diff index.html.'
      )
    }
    const jsHasCssImport = jsImportsStylesheet(js, opts.cssPath)
    const jsxEntry = /<script[^>]+src=["'][^"']+\.(jsx|tsx)["']/i.test(html)
    if (
      !viteReact &&
      !jsxEntry &&
      !/<link\b[^>]*rel\s*=\s*["']stylesheet["']/i.test(html) &&
      !jsHasCssImport
    ) {
      parts.push(
        `${EDIT_SANITY_PREFIX} index.html has no stylesheet <link>. ` +
          'Link styles.css (or the CSS you wrote) before claiming the page is done.'
      )
    } else if (
      !viteReact &&
      !jsxEntry &&
      opts.cssPath &&
      css.trim() &&
      !jsHasCssImport &&
      !htmlHasStylesheetLink(html, opts.cssPath)
    ) {
      parts.push(
        `${EDIT_SANITY_PREFIX} "${opts.cssPath}" exists but index.html does not <link> it. ` +
          'Fix the href with apply_diff — do not rewrite the whole page.'
      )
    }
    if (!viteReact) {
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
    const entrySrc = viteHtmlEntryMismatch(html, opts.jsPath)
    if (entrySrc) {
      parts.push(
        `${EDIT_SANITY_PREFIX} index.html <script src="${entrySrc}"> but the React file on disk is "${opts.jsPath}". ` +
          'Point the module script at the file you wrote (e.g. /App.jsx) or add src/main.jsx that mounts it. ' +
          'apply_diff — Vite cannot boot a missing /src/main.jsx.'
      )
    }
  }

  if (looksLikeThemeToggleRequest(opts.userText ?? '') && !htmlJsHasThemeControl(html, js)) {
    parts.push(
      `${EDIT_SANITY_PREFIX} the user asked for a light/dark theme toggle, but HTML/JS has no ` +
        'data-theme / theme control. Add it with apply_diff — do not claim the task is done.'
    )
  }

  if (looksLikeNoCardDumpRequest(opts.userText ?? '') && htmlLooksLikeCardDump(html)) {
    parts.push(
      `${EDIT_SANITY_PREFIX} the user forbade an AI card grid, but index.html has ` +
        `${countLandingCardClasses(html)} feature-card/why-card blocks. ` +
        'Rebuild Features as a layout (split, list, or two columns) — not a stack of identical cards. ' +
        'Do NOT Start-Process / claim the landing looks professional yet.'
    )
  }

  if (path && content.trim() && !contentLooksStructurallyComplete(content, path)) {
    parts.push(
      `${EDIT_SANITY_PREFIX} "${path}" looks structurally incomplete. ` +
        'Do not claim the task is done. Finish this file (balanced braces / complete document) ' +
        'with write_file overwrite=true or apply_diff — do not start another file.'
    )
  }

  const jsxSrc =
    /\.(jsx|tsx)$/i.test(path) && content.trim()
      ? content
      : /\.(jsx|tsx)$/i.test(opts.path ?? '') || /from\s+['"]react['"]/.test(js)
        ? js
        : ''
  const checkSrc = jsxSrc || (/\.(jsx|tsx)$/i.test(path) ? content : '')
  if (checkSrc) {
    const unbound = unboundJsxClickHandlers(checkSrc)
    if (unbound.length > 0) {
      parts.push(
        `${EDIT_SANITY_PREFIX} ${unbound.slice(0, 6).join(', ')} is defined but never bound to ` +
          'onClick / onPointerDown. Wire the handler in JSX before claiming the UI works. ' +
          'apply_diff — do not claim the game is playable yet.'
      )
    }
    const cssMismatch = jsxCssClassMismatch(checkSrc, css)
    if (cssMismatch.length > 0) {
      parts.push(
        `${EDIT_SANITY_PREFIX} JSX className tokens are not in CSS: ${cssMismatch.slice(0, 8).join(', ')}. ` +
          'Reuse class names from the stylesheet (or add matching CSS rules). apply_diff — do not claim the UI is styled yet.'
      )
    }
    const missingCss = jsxMissingCssImports(checkSrc, opts.cssPath)
    if (missingCss.length > 0) {
      parts.push(
        `${EDIT_SANITY_PREFIX} "${path || 'JSX'}" imports ${missingCss.slice(0, 4).join(', ')} ` +
          `but the CSS on disk is "${opts.cssPath}". Import that file (or write the missing stylesheet). ` +
          'Vite cannot resolve a phantom index.css. apply_diff — do not claim the preview works.'
      )
    }
  }
  return parts.length ? parts.join('\n') : null
}

export function isEditSanityFailure(text: string | null | undefined): boolean {
  const t = text ?? ''
  return t.includes(EDIT_SANITY_PREFIX) || t.includes(I18N_SANITY_PREFIX)
}
