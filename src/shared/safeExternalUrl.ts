/** Allow only browser/OS-safe schemes for shell.openExternal and markdown links. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(raw: string): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  try {
    const u = new URL(s)
    return SAFE_PROTOCOLS.has(u.protocol.toLowerCase())
  } catch {
    return false
  }
}
