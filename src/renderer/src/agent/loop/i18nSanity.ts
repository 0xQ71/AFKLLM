/**
 * Static checks so the agent cannot claim a language switcher works while
 * Features cards render `[object Object]` (object/array assigned to textContent).
 */

export const I18N_SANITY_PREFIX = 'I18N_SANITY:'

const I18N_HINT =
  `${I18N_SANITY_PREFIX} do NOT claim the language switcher works. ` +
  'i18n values MUST be strings. Never assign objects/arrays to textContent/innerHTML ' +
  '(that renders "[object Object]"). Query [data-i18n="key"] and set a string. ' +
  'Features cards need separate title and body string keys — not one object per card.'

export function extractDataI18nKeys(html: string): string[] {
  const keys: string[] = []
  const re = /data-i18n\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const k = m[1]!.trim()
    if (k && !keys.includes(k)) keys.push(k)
  }
  return keys
}

export function extractHtmlIds(html: string): Set<string> {
  const ids = new Set<string>()
  const re = /\bid\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const id = m[1]!.trim()
    if (id) ids.add(id)
  }
  return ids
}

export function extractJsIdSelectors(js: string): string[] {
  const ids: string[] = []
  const re =
    /(?:querySelector\(\s*['"]#([\w-]+)|getElementById\(\s*['"]([\w-]+)|['"]#([\w-]+)['"])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js))) {
    const id = (m[1] || m[2] || m[3] || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Dict values are objects `{ ru, en }` / `{ title, desc }` or selector arrays. */
export function jsI18nDictLooksBroken(js: string): boolean {
  if (!js.trim()) return false
  if (/:\s*\[\s*['"]\[data-i18n=/i.test(js)) return true
  if (
    /['"]?\w+['"]?\s*:\s*\{\s*['"]?(?:ru|en|title|desc|text|label|subtitle)['"]?\s*:/i.test(
      js
    )
  ) {
    return true
  }
  return false
}

export function jsAssignsNonStringToDom(js: string): boolean {
  if (!js.trim()) return false
  if (
    /\.(?:textContent|innerHTML|innerText)\s*=\s*(?:item|feat|feature|card|obj|entry|node|value)\b/i.test(
      js
    )
  ) {
    return true
  }
  if (jsI18nDictLooksBroken(js) && /\.(?:textContent|innerHTML|innerText)\s*=/.test(js)) {
    return true
  }
  return false
}

/**
 * HTML uses data-i18n, but JS looks up #hero-title / getElementById that are not in the markup.
 */
export function htmlJsI18nMismatch(html: string, js: string): boolean {
  if (!html.trim() || !js.trim()) return false
  const keys = extractDataI18nKeys(html)
  if (!keys.length) return false
  const htmlIds = extractHtmlIds(html)
  const jsIds = extractJsIdSelectors(js)
  const missing = jsIds.filter((id) => !htmlIds.has(id))
  if (missing.length === 0) return false
  const usesDataI18n = /\[data-i18n|data-i18n\s*=/i.test(js)
  if (usesDataI18n) return false
  return missing.some((id) =>
    /hero|title|subtitle|feature|cta|download|footer/i.test(id)
  )
}

export function formatI18nSanityHint(opts: { html?: string; js?: string }): string | null {
  const html = opts.html ?? ''
  const js = opts.js ?? ''
  if (!html.trim() && !js.trim()) return null
  const broken =
    jsI18nDictLooksBroken(js) ||
    jsAssignsNonStringToDom(js) ||
    htmlJsI18nMismatch(html, js)
  if (!broken) return null
  return I18N_HINT
}
