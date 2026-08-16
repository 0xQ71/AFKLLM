/**
 * Static checks so the agent cannot claim a language switcher works while
 * Features cards render `[object Object]` (object/array assigned to textContent).
 *
 * Nested `const i18n = { ru: { heroSubtitle: '…' }, en: { … } }` with string
 * leaves is valid. Keys may be unquoted identifiers, not only `'key'`.
 */

export const I18N_SANITY_PREFIX = 'I18N_SANITY:'

/** Full page on disk — JS↔HTML id/key matching before this is noise (JS-first landings). */
export function htmlReadyForI18nContract(html: string): boolean {
  const t = (html ?? '').trim()
  return /<!DOCTYPE\s+html|<html[\s>]/i.test(t) && /<\/html\s*>/i.test(t)
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

/** Buttons with data-lang / .lang-btn — a switcher exists without #langToggle. */
export function htmlHasLangSwitcher(html: string): boolean {
  if (!html.trim()) return false
  return (
    /data-lang\s*=\s*["'](?:en|ru)/i.test(html) ||
    /class\s*=\s*["'][^"']*lang-btn/i.test(html) ||
    /class\s*=\s*["'][^"']*lang-switcher/i.test(html)
  )
}

/** Key exists as a quoted string or as an object identifier (`heroSubtitle:`). */
export function jsHasI18nKey(js: string, key: string): boolean {
  if (!key.trim() || !js.trim()) return false
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`['"]${escaped}['"]`).test(js)) return true
  return new RegExp(`(?:^|[^\\w$])${escaped}\\s*:`).test(js)
}

export function missingI18nKeysInJs(html: string, js: string): string[] {
  const keys = extractDataI18nKeys(html)
  if (keys.length < 3 || !js.trim()) return []
  return keys.filter((k) => !jsHasI18nKey(js, k))
}

/**
 * True when HTML has data-i18n keys but JS contains almost none of them
 * (quoted or identifier). Partial name drift (ctaDownload vs heroDownload)
 * is not a loop-stop — nested string dict + dict[key] still works.
 */
export function htmlI18nKeysMissingFromJs(html: string, js: string): boolean {
  const keys = extractDataI18nKeys(html)
  if (keys.length < 3 || !js.trim()) return false
  const found = keys.filter((k) => jsHasI18nKey(js, k)).length
  return found < 2
}

/**
 * HTML uses data-i18n, but JS looks up #ids that are not in the markup.
 * data-lang / .lang-btn is a valid switcher — do not require #langToggle.
 */
export function htmlJsI18nMismatch(html: string, js: string): boolean {
  if (!html.trim() || !js.trim()) return false
  if (htmlI18nKeysMissingFromJs(html, js)) return true
  const keys = extractDataI18nKeys(html)
  const htmlIds = extractHtmlIds(html)
  const jsIds = extractJsIdSelectors(js)
  const langOk = htmlHasLangSwitcher(html)
  const missing = jsIds.filter((id) => {
    if (htmlIds.has(id)) return false
    if (langOk && /lang|i18n|toggle/i.test(id)) return false
    return true
  })
  if (missing.some((id) => /theme/i.test(id))) return true
  if (!langOk && missing.some((id) => /lang|i18n|toggle/i.test(id))) return true
  if (missing.length === 0) return false
  if (!keys.length) {
    return missing.some((id) => /hero|title|subtitle|feature|cta|download|footer|nav|menu/i.test(id))
  }
  return missing.some((id) =>
    /hero|title|subtitle|feature|cta|download|footer|nav|menu/i.test(id)
  )
}

/**
 * Dict *values* are objects `{ ru, en }` / `{ title, desc }` or selector arrays.
 * Nested `ru: { heroSubtitle: '…' }` (lang → string map) is valid.
 */
export function jsI18nDictLooksBroken(js: string): boolean {
  if (!js.trim()) return false
  if (/:\s*\[\s*['"]\[data-i18n=/i.test(js)) return true
  // Leaf object: featurePrivacy: { ru: '…', en: '…' } — not the lang root itself.
  if (
    /(?:^|[^\w$])(?!ru\b)(?!en\b)(\w+)\s*:\s*\{\s*['"]?(?:ru|en)\s*['"]?\s*:/i.test(js)
  ) {
    return true
  }
  if (
    /(?:^|[^\w$])(?!ru\b)(?!en\b)(\w+)\s*:\s*\{\s*['"]?(?:title|desc|text|label|subtitle)['"]?\s*:/i.test(
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

/** How many data-i18n elements have no visible fallback text. */
export function countEmptyDataI18nNodes(html: string): number {
  if (!html.trim()) return 0
  let empty = 0
  const re =
    /<([a-z][\w-]*)\b([^>]*?)\bdata-i18n\s*=\s*["']([^"']+)["']([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const tag = m[1]!
    const afterAttrs = m[4] ?? ''
    if (/\/\s*$/.test(afterAttrs) || /^(?:img|br|hr|input|meta|link)\b/i.test(tag)) {
      empty++
      continue
    }
    const openEnd = m.index + m[0].length
    const close = new RegExp(`</${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i')
    const rest = html.slice(openEnd)
    const cm = close.exec(rest)
    const inner = cm ? rest.slice(0, cm.index) : ''
    if (!inner.replace(/<!--[\s\S]*?-->/g, '').trim()) empty++
  }
  return empty
}

/** ≥3 empty data-i18n tags → page is blank until JS matches keys. */
export function htmlHasEmptyI18nShells(html: string): boolean {
  return countEmptyDataI18nNodes(html) >= 3
}

export function formatI18nSanityHint(opts: { html?: string; js?: string }): string | null {
  const html = opts.html ?? ''
  const js = opts.js ?? ''
  if (!html.trim() && !js.trim()) return null
  const htmlReady = htmlReadyForI18nContract(html)
  const parts: string[] = []
  if (htmlReady && htmlHasEmptyI18nShells(html)) {
    parts.push(
      `${I18N_SANITY_PREFIX} ${countEmptyDataI18nNodes(html)} data-i18n tags have no visible fallback text. ` +
        'HTML MUST contain the default-language copy inside the tags (JS only swaps on toggle). ' +
        'Fix index.html ONCE — do not rewrite js/main.js in a loop.'
    )
  }
  if (htmlReady && (jsI18nDictLooksBroken(js) || jsAssignsNonStringToDom(js))) {
    parts.push(
      `${I18N_SANITY_PREFIX} i18n *values* are objects/arrays assigned to textContent ([object Object]). ` +
        'Each translation must be a STRING. Nested ru/en maps of strings are OK. Fix js/main.js once — do not write tmp/check.js.'
    )
  }
  const missingKeys = missingI18nKeysInJs(html, js)
  const htmlKeys = extractDataI18nKeys(html)
  const foundKeys = htmlKeys.filter((k) => jsHasI18nKey(js, k)).length
  if (htmlReady && htmlKeys.length >= 3 && foundKeys < 2) {
    parts.push(
      `${I18N_SANITY_PREFIX} data-i18n keys missing from JS dict: ${missingKeys.slice(0, 8).join(', ')}. ` +
        'Keys may be identifiers (heroSubtitle:) not only quoted strings. Align HTML keys with js/main.js in ONE write. Do NOT node -e / tmp/check.js.'
    )
  }
  if (htmlReady && js.trim()) {
    const htmlIds = extractHtmlIds(html)
    const jsIds = extractJsIdSelectors(js)
    const langOk = htmlHasLangSwitcher(html)
    const missingIds = jsIds.filter((id) => !htmlIds.has(id))
    const badToggle = missingIds.filter((id) => /lang|i18n|toggle/i.test(id))
    if (!langOk && badToggle.length) {
      parts.push(
        `${I18N_SANITY_PREFIX} JS looks up #${badToggle[0]} but HTML has no such id. ` +
          'Put that id (or .lang-btn[data-lang]) on index.html ONCE. Do not rewrite js/main.js to chase missing markup.'
      )
    } else if (
      !parts.length &&
      htmlJsI18nMismatch(html, js) &&
      missingIds.length > 0
    ) {
      parts.push(
        `${I18N_SANITY_PREFIX} JS looks up #${missingIds[0]} but HTML has no such id. ` +
          'Add the id to index.html — do not rewrite JS. Do not invent check.js.'
      )
    }
  }
  if (!parts.length) return null
  return parts.join('\n')
}

/** Short closer / status line from the real hint — not a generic [object Object]. */
export function formatI18nCloserWhy(hint: string, uiLang: 'ru' | 'en'): string {
  const h = hint || ''
  if (/visible fallback|no visible fallback|empty data-i18n/i.test(h)) {
    return uiLang === 'ru'
      ? 'В HTML пустые data-i18n — нет видимого текста до совпадения ключей JS.'
      : 'HTML data-i18n tags are empty — nothing is visible until JS keys match.'
  }
  if (/values are objects|\[object Object\]/i.test(h)) {
    return uiLang === 'ru'
      ? 'i18n всё ещё подставляет объекты в DOM ([object Object]) — значения перевода должны быть строками.'
      : 'i18n still assigns objects to the DOM ([object Object]) — translation values must be strings.'
  }
  if (/keys missing/i.test(h)) {
    return uiLang === 'ru'
      ? 'Ключи data-i18n в HTML не совпадают со словарём в js/main.js.'
      : 'data-i18n keys in HTML do not match the JS dictionary.'
  }
  if (/looks up #|no such id/i.test(h)) {
    return uiLang === 'ru'
      ? 'JS ищет элемент по id, которого нет в HTML.'
      : 'JS looks up an id that is missing from HTML.'
  }
  const first = h.split('\n')[0]?.replace(/^I18N_SANITY:\s*/i, '').trim() ?? ''
  if (first) return first.slice(0, 220)
  return uiLang === 'ru'
    ? 'i18n ещё не согласован с HTML — не рапортуем успех.'
    : 'i18n is still not aligned with HTML — not reporting success.'
}

/** Invented i18n auditor the user never asked for. */
export function inventedI18nVerifierPath(relativePath: string, userText: string): boolean {
  const p = (relativePath ?? '').replace(/\\/g, '/').toLowerCase()
  if (!/(?:^|\/)(?:tmp\/)?check\.js$/.test(p) && !/i18n[-_]?check|key[-_]?check/.test(p)) {
    return false
  }
  if (/check\.js|tmp\/check|i18n[-_]?check/i.test(userText ?? '')) return false
  return true
}
