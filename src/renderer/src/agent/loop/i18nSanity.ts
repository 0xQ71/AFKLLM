/**
 * Static checks so the agent cannot claim a language switcher works while
 * Features cards render `[object Object]` (object/array assigned to textContent).
 */

export const I18N_SANITY_PREFIX = 'I18N_SANITY:'

const I18N_HINT =
  `${I18N_SANITY_PREFIX} do NOT claim the language switcher works. ` +
  'i18n values MUST be strings. getElementById / #id MUST match an id in the HTML ' +
  '(langToggle vs lang-toggle is a no-op click). Every data-i18n key MUST exist in the JS dict. ' +
  'Never assign objects/arrays to textContent (that renders "[object Object]").'

/**
 * HTML uses data-i18n, but JS looks up #ids that are not in the markup.
 * Do not skip this just because the script also queries [data-i18n].
 */
export function htmlJsI18nMismatch(html: string, js: string): boolean {
  if (!html.trim() || !js.trim()) return false
  const keys = extractDataI18nKeys(html)
  const htmlIds = extractHtmlIds(html)
  const jsIds = extractJsIdSelectors(js)
  const missing = jsIds.filter((id) => !htmlIds.has(id))
  if (missing.some((id) => /lang|i18n|toggle|theme/i.test(id))) return true
  if (htmlI18nKeysMissingFromJs(html, js)) return true
  if (missing.length === 0) return false
  if (!keys.length) {
    return missing.some((id) => /hero|title|subtitle|feature|cta|download|footer|nav|menu/i.test(id))
  }
  return missing.some((id) =>
    /hero|title|subtitle|feature|cta|download|footer|lang|nav|menu|toggle/i.test(id)
  )
}

/** True when most HTML data-i18n keys never appear as quoted strings in JS. */
export function htmlI18nKeysMissingFromJs(html: string, js: string): boolean {
  const keys = extractDataI18nKeys(html)
  if (keys.length < 3 || !js.trim()) return false
  let hit = 0
  for (const k of keys) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`['"]${escaped}['"]`).test(js)) hit++
  }
  return hit < keys.length / 2
}

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
