/**
 * From-scratch landing helpers: require write_file before apply on a missing
 * path; overwrites of a complete file are allowed.
 */

import {
  WRITE_FILE_REQUIRED_PREFIX,
  formatWriteFileRequiredError
} from '../../../../shared/writeFileRequired'

export { WRITE_FILE_REQUIRED_PREFIX, formatWriteFileRequiredError }

export const WRITE_ONCE_PREFIX = 'WRITE_ONCE:'

/** From-scratch: apply_diff/apply_patch before a complete write this turn. */
export function shouldRequireWriteFileForApply(opts: {
  fromScratch: boolean
  path: string
  completeWritesThisTurn: number
}): boolean {
  if (!opts.fromScratch) return false
  if (!isCappedLandingWritePath(opts.path)) return false
  return opts.completeWritesThisTurn <= 0
}

export function formatScratchWriteFileHint(): string {
  return 'Call write_file overwrite=true allow_full_rewrite=true with the COMPLETE file.'
}

export type LandingRewriteDecision = 'ok' | 'allow_recovery' | 'refuse'

export function landingSourceKind(
  relativePath: string
): 'html' | 'css' | 'js' | 'md' | null {
  const p = (relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (!p) return null
  if (/\.html?$/.test(p)) return 'html'
  if (/\.css$/.test(p)) return 'css'
  if (/\.(js|mjs|cjs)$/.test(p)) return 'js'
  if (/\.md$/.test(p)) return 'md'
  return null
}

export function isCappedLandingWritePath(relativePath: string): boolean {
  return landingSourceKind(relativePath) !== null
}

/** Overwrite of a complete landing file is allowed. */
export function shouldRefuseLandingRewrite(_opts: {
  path: string
  completeWritesThisTurn: number
  recoveryUsedOnPath: boolean
  sanityFailedOnThisPath: boolean
}): LandingRewriteDecision {
  return 'ok'
}

export function formatWriteOnceError(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/') || 'this file'
  return (
    `${WRITE_ONCE_PREFIX} already wrote complete "${p}". Do not rewrite. ` +
    'Next missing file with write_file NOW. Do not summarize or STOP until required files exist ' +
    'and (if asked) the dev server / preview succeeded.'
  )
}

export function isViteConfigPath(relativePath: string): boolean {
  return /(?:^|\/)vite\.config\.\w+$/i.test(
    (relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  )
}

/** Vanilla landing script (js/main.js). Not vite.config.js, not React JSX. */
export function isLandingPageScriptPath(relativePath: string): boolean {
  const p = (relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (!p || isViteConfigPath(p)) return false
  if (/\.(jsx|tsx)$/i.test(p)) return false
  return /(?:^|\/)(?:js\/)?main\.js$|(?:^|\/)app\.js$|(?:^|\/)js\/.+\.js$/.test(p)
}

/** User asked for Vite+React, or HTML already boots a .jsx entry. */
export function looksLikeViteReactTask(
  userText?: string,
  html?: string,
  writtenPath?: string
): boolean {
  const u = userText ?? ''
  if (/\bvite\b/i.test(u) && /\breact\b/i.test(u)) return true
  if (/vite\s*\+\s*react|react\s*\+\s*vite|react-игр/i.test(u)) return true
  if (/\.(jsx|tsx)$/i.test(writtenPath ?? '')) return true
  if (/<script[^>]+src=["'][^"']+\.(jsx|tsx)["']/i.test(html ?? '')) return true
  return false
}

/** Build Vite+React in this folder from scratch — not a surgical fix. */
export function looksLikeViteReactFromScratch(userText?: string): boolean {
  if (!looksLikeViteReactTask(userText)) return false
  const t = userText ?? ''
  return /с\s*нуля|from\s+scratch|собери|создай|scaffold|в корне (этой )?папк|in this folder/i.test(
    t
  )
}

export function userAskedViteReactPreview(userText?: string): boolean {
  const t = userText ?? ''
  return /npm\s+run\s+dev|vite\s+preview|открой\s+превью|open\s+(the\s+)?preview/i.test(t)
}

/** npm run / Vite / open localhost — not npm install. */
export function looksLikeDevOrPreviewCommand(command: string): boolean {
  const c = command ?? ''
  if (!c.trim()) return false
  if (/npm\s+install\b/i.test(c) && !/npm\s+run\s+/i.test(c)) return false
  return /npm\s+(run\s+)?(dev|start|preview)\b|npx\s+vite\b|(?:^|[;&]\s*)vite\b|Start-Process|start\s+https?:\/\//i.test(
    c
  )
}

/** Shell already opened the in-app browser (Vite Local: URL). */
export function shellResultOpenedPreview(content: string | undefined): boolean {
  const c = content ?? ''
  if (/PREVIEW_URL\s*:|PREVIEW_OK|opened in AFKLLM Browser/i.test(c)) return true
  return /Local:\s*https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(c) && /exit_code\s*=\s*0/i.test(c)
}

export type ViteReactScaffoldId =
  | 'package.json'
  | 'vite.config'
  | 'index.html'
  | 'entry'
  | 'app'

const VITE_REACT_SLOTS: Array<{ id: ViteReactScaffoldId; re: RegExp; hint: string }> = [
  {
    id: 'package.json',
    re: /(?:^|\/)package\.json$/i,
    hint: 'package.json (vite + react, scripts.dev)'
  },
  {
    id: 'vite.config',
    re: /(?:^|\/)vite\.config\.\w+$/i,
    hint: 'vite.config.js with @vitejs/plugin-react'
  },
  {
    id: 'index.html',
    re: /(?:^|\/)index\.html$/i,
    hint: 'index.html — empty #root + <script type="module" src="/src/main.jsx">'
  },
  {
    id: 'entry',
    re: /(?:^|\/)(?:src\/)?main\.(jsx|tsx)$/i,
    hint: 'src/main.jsx — ReactDOM.createRoot + import App'
  },
  {
    id: 'app',
    re: /(?:^|\/)(?:src\/)?App\.(jsx|tsx)$/i,
    hint: 'src/App.jsx — the actual UI / game'
  }
]

export function normalizeScaffoldPath(p: string): string {
  return (p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Pull file-like paths out of repoMap / list_directory text. */
export function collectPathsFromTreeText(text: string): string[] {
  const t = text ?? ''
  if (!t.trim()) return []
  const found = new Set<string>()
  const re =
    /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|html?|json|css|mjs|cjs))(?=$|[\s`'"),:\]])/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    found.add(normalizeScaffoldPath(m[1] ?? ''))
  }
  return [...found].filter(Boolean)
}

export function viteReactScaffoldMissing(paths: Iterable<string>): ViteReactScaffoldId[] {
  const list = [...paths].map(normalizeScaffoldPath)
  const missing: ViteReactScaffoldId[] = []
  for (const slot of VITE_REACT_SLOTS) {
    if (!list.some((p) => slot.re.test(p))) missing.push(slot.id)
  }
  return missing
}

export function formatViteReactScaffoldHint(missing: ViteReactScaffoldId[]): string {
  const hints = missing.map(
    (id) => VITE_REACT_SLOTS.find((s) => s.id === id)?.hint ?? id
  )
  return (
    'VITE_REACT_INCOMPLETE: do not stop, do not summarize, do not tick these steps done. ' +
    'Required files are still missing on disk:\n- ' +
    hints.join('\n- ') +
    '\nCall write_file NOW with the FULL real source. Never copy a [HISTORY_COMPACT] / [omitted] marker. ' +
    'After these files exist: npm install; npm run dev; use the printed Local: URL.'
  )
}

export function formatViteReactPreviewHint(): string {
  return (
    'VITE_REACT_INCOMPLETE: scaffold files are on disk but the in-app preview flag is not set. ' +
    'If a previous command already printed PREVIEW_URL / Local: http://127.0.0.1:… and exit_code=0, ' +
    'do NOT rerun npm. Write the closing summary as visible assistant text OUTSIDE <think>, then STOP. ' +
    'Otherwise one execute_terminal_command: npm install only if node_modules is missing, then npm run dev once.'
  )
}

/** JS landed first — missing HTML ids are expected, not a JS bug. */
export function formatLandingJsBeforeHtmlHint(): string {
  return (
    'LANDING_ORDER: index.html is not on disk yet. Missing #ids / data-i18n in markup are expected. ' +
    'Do NOT rewrite this JS file to "fix" selectors. Next: styles.css (if missing), then a complete index.html that uses those ids, then README.'
  )
}

/** CSS + HTML + JS each have at least one complete write this turn. */
export function landingBundleReady(completeWritesByPath: Map<string, number>): boolean {
  let html = false
  let css = false
  let js = false
  for (const [p, n] of completeWritesByPath) {
    if (n < 1) continue
    const k = landingSourceKind(p)
    if (k === 'html') html = true
    if (k === 'css') css = true
    if (k === 'js') js = true
  }
  return html && css && js
}
