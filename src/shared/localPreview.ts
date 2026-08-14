/**
 * Detect local preview URLs from terminal / serve commands for in-app browser.
 * Static HTML → file:// workspace. Vite/dev servers → real localhost URLs.
 * Only the AFKLLM LLM API port is treated as a mistaken "site" when opened via Chrome.
 */

const LOCAL_HOST =
  '(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\])'

/** Strip agent/PTY echo lines (`> command`) so Start-Process URLs are not treated as servers. */
export function stripShellEchoLines(text: string): string {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/^[ \t]*>[ \t].*$/gm, '')
}

/**
 * Prefer Vite "Local:" line, then any http(s) local URL.
 * Labeled server lines always win (Vite on any port, including 8080).
 * Bare URLs on denyPorts are ignored — usually LLM API / echoed Chrome mistakes.
 */
export function extractLocalPreviewUrl(
  text: string,
  opts?: { denyPorts?: number[] }
): string | null {
  if (!text) return null
  const plain = stripShellEchoLines(
    text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  )

  const strongLabeled =
    plain.match(
      new RegExp(
        `(?:Local|Network|➜\\s*Local|started server on|Serving(?:\\s+HTTP)?|Available on)\\s*[:\\s]+(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`,
        'i'
      )
    ) ??
    plain.match(
      new RegExp(`(?:Local|Network):\\s*(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`, 'i')
    )

  if (strongLabeled?.[1]) {
    return normalizePreviewUrl(strongLabeled[1])
  }

  // Weak labels (llama-server also prints "listening on") — still respect denyPorts.
  const weakLabeled = plain.match(
    new RegExp(
      `listening on\\s*[:\\s]*(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`,
      'i'
    )
  )
  if (weakLabeled?.[1]) {
    const url = normalizePreviewUrl(weakLabeled[1])
    if (isDeniedLocalPreviewUrl(url, opts?.denyPorts)) return null
    return url
  }

  const bare = plain.match(
    new RegExp(`(https?://${LOCAL_HOST}(?::\\d+)?(?:/[^\\s"'\\]\\)]*)?)`, 'i')
  )
  const raw = bare?.[1] ?? null
  if (!raw) return null
  const url = normalizePreviewUrl(raw)
  // Unlabeled bare localhost on the LLM port → ignore (not a Vite "Local:" line).
  if (isDeniedLocalPreviewUrl(url, opts?.denyPorts)) return null
  return url
}

/** Rewrite bind-all hosts so the guest webview can load. */
export function normalizePreviewUrl(url: string): string {
  let u = url.trim().replace(/[.,;:]+$/, '')
  u = u.replace(/^https?:\/\/0\.0\.0\.0(?=[:/]|$)/i, 'http://127.0.0.1')
  u = u.replace(/^https?:\/\/\[::\](?=[:/]|$)/i, 'http://127.0.0.1')
  u = u.replace(/^https?:\/\/\[::1\](?=[:/]|$)/i, 'http://127.0.0.1')
  return u
}

/** True when URL is the AFKLLM LLM/API listen port (not a labeled Vite preview). */
export function isDeniedLocalPreviewUrl(
  url: string,
  denyPorts: number[] = [8080]
): boolean {
  if (!url || denyPorts.length === 0) return false
  try {
    const u = new URL(url)
    if (!/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) return false
    const port = u.port
      ? Number(u.port)
      : u.protocol === 'https:'
        ? 443
        : 80
    return denyPorts.includes(port)
  } catch {
    return false
  }
}

/** Absolute filesystem path → file:// URL for the in-app Browser. */
export function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
  if (normalized.startsWith('/')) return `file://${normalized}`
  return `file:///${normalized}`
}

/** Extract http(s)://localhost… from a Start-Process / browser open command. */
export function extractHttpUrlFromOpenCommand(command: string): string | null {
  const m = String(command ?? '').match(
    /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`]*)?)/i
  )
  return m?.[1] ? normalizePreviewUrl(m[1]) : null
}

/**
 * Best-effort HTML relative path from an open/preview shell command.
 * Defaults to index.html when the command is clearly a file preview open.
 */
export function extractOpenHtmlRelativePath(command: string, cwdRel = '.'): string {
  const c = String(command ?? '')
  const cwd = String(cwdRel ?? '.').replace(/\\/g, '/').replace(/\/+$/, '')
  const joinRel = (file: string): string => {
    const f = file.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!cwd || cwd === '.' || cwd === './') return f
    if (/^[a-zA-Z]:\//.test(f) || f.startsWith('/')) return f
    return `${cwd}/${f}`.replace(/\/+/g, '/')
  }

  const quoted = c.match(
    /(?:Start-Process|Invoke-Item|xdg-open|open)\s+(?:-FilePath\s+)?["']([^"']+\.html?)["']/i
  )
  if (quoted?.[1]) {
    const p = quoted[1].replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) return p
    return joinRel(p)
  }

  const bare = c.match(
    /(?:Start-Process|Invoke-Item|xdg-open|open)\s+(?:-FilePath\s+)?(?:Resolve-Path\s+)?\.?\\?\/?([\w./\\-]+\.html?)/i
  )
  if (bare?.[1]) return joinRel(bare[1])

  const wd = c.match(/-WorkingDirectory\s+["']([^"']+)["']/i)
  if (wd?.[1] && /\.html?\b/i.test(c)) {
    return joinRel('index.html')
  }

  return joinRel('index.html')
}

export type BrowserOpenKind =
  | { kind: 'workspace_html' }
  | { kind: 'local_http'; url: string }
  | { kind: 'llm_mistake'; url: string }

/**
 * Classify Start-Process / browser open intents:
 * - workspace .html file → file:// in AFKLLM Browser
 * - localhost Vite/dev URL (non-LLM port) → open that http URL
 * - localhost LLM API port → mistaken llama UI; use workspace HTML instead
 */
export function classifyBrowserOpenCommand(
  command: string,
  llmPorts: number[] = [8080]
): BrowserOpenKind | null {
  const c = command.trim()
  if (!c) return null

  const httpUrl = extractHttpUrlFromOpenCommand(c)
  if (httpUrl) {
    if (isDeniedLocalPreviewUrl(httpUrl, llmPorts)) {
      return { kind: 'llm_mistake', url: httpUrl }
    }
    // Chrome/Edge/Start-Process → Vite / preview server
    if (
      /\b(chrome|msedge|firefox)(?:\.exe)?\b/i.test(c) ||
      /Start-Process\b/i.test(c) ||
      /xdg-open|Invoke-Item|webbrowser/i.test(c)
    ) {
      return { kind: 'local_http', url: httpUrl }
    }
  }

  if (looksLikeOpenHtmlFileCommand(c)) {
    return { kind: 'workspace_html' }
  }
  return null
}

/** Open a local .html file (not an http URL). */
export function looksLikeOpenHtmlFileCommand(cmd: string): boolean {
  const c = cmd.trim()
  if (!c) return false
  if (extractHttpUrlFromOpenCommand(c)) return false
  return (
    /Start-Process\s+.*\.html?/i.test(c) ||
    /webbrowser/i.test(c) ||
    /xdg-open|open\s+.*\.html|Invoke-Item\s+.*\.html/i.test(c) ||
    (/\.html?\b/i.test(c) &&
      /Start-Process|Invoke-Item|explorer\.exe|cmd\s*\/c\s*start/i.test(c))
  )
}

/**
 * True when the shell command is a preview/open that AFKLLM should intercept
 * (workspace HTML, local http preview, or LLM-port mistake).
 */
export function looksLikeOpenHtmlCommand(cmd: string): boolean {
  return classifyBrowserOpenCommand(cmd) != null
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
