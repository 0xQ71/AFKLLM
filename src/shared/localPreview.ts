/**
 * Detect local preview URLs from terminal / serve commands for in-app browser.
 */

const LOCAL_HOST =
  '(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\])'

/** Prefer Vite "Local:" line, then any http(s) local URL. */
export function extractLocalPreviewUrl(text: string): string | null {
  if (!text) return null
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')

  const labeled =
    plain.match(
      new RegExp(
        `(?:Local|Network|➜\\s*Local|listening on|started server on|Serving|Available on)\\s*[:\\s]+(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`,
        'i'
      )
    ) ??
    plain.match(
      new RegExp(`(?:Local|Network):\\s*(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`, 'i')
    )

  const bare = plain.match(
    new RegExp(`(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`, 'i')
  )

  const raw = labeled?.[1] ?? bare?.[1] ?? null
  if (!raw) return null
  return normalizePreviewUrl(raw)
}

/** Rewrite bind-all hosts so the guest webview can load. */
export function normalizePreviewUrl(url: string): string {
  let u = url.trim().replace(/[.,;:]+$/, '')
  u = u.replace(/^https?:\/\/0\.0\.0\.0(?=[:/]|$)/i, 'http://127.0.0.1')
  u = u.replace(/^https?:\/\/\[::\](?=[:/]|$)/i, 'http://127.0.0.1')
  u = u.replace(/^https?:\/\/\[::1\](?=[:/]|$)/i, 'http://127.0.0.1')
  return u
}

/** Heuristic: command likely starts a local HTTP preview. */
export function looksLikeLocalServerCommand(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  return (
    /\b(vite|next(\s+dev)?|nuxt|astro|remix|webpack-dev-server|vite-node)\b/i.test(c) ||
    /\bnpm\s+(run\s+)?(dev|start|serve|preview)\b/i.test(c) ||
    /\bpnpm\s+(run\s+)?(dev|start|serve|preview)\b/i.test(c) ||
    /\byarn\s+(run\s+)?(dev|start|serve|preview)\b/i.test(c) ||
    /\bnpx\s+(serve|http-server|live-server|vite)\b/i.test(c) ||
    /\bpython(?:3)?\s+-m\s+http\.server\b/i.test(c) ||
    /\b(flask|uvicorn|django|gunicorn)\b/i.test(c) ||
    /\bphp\s+-S\b/i.test(c) ||
    /\blive-server\b/i.test(c) ||
    /\bhttp-server\b/i.test(c)
  )
}
