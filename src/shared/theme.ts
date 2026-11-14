export type UiTheme =
  | 'auto'
  | 'classic'
  | 'light'
  | 'sepia'
  | 'dark'
  | 'deep-dark'
  | 'solarized-dark'

export type ResolvedUiTheme = Exclude<UiTheme, 'auto'>

export const UI_THEMES: UiTheme[] = [
  'auto',
  'classic',
  'light',
  'sepia',
  'dark',
  'deep-dark',
  'solarized-dark'
]

export const UI_THEME_LABELS: Record<UiTheme, string> = {
  auto: 'Auto',
  classic: 'Classic',
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark',
  'deep-dark': 'Deep Dark',
  'solarized-dark': 'Solarized Dark'
}

export function isUiTheme(v: unknown): v is UiTheme {
  return typeof v === 'string' && (UI_THEMES as string[]).includes(v)
}

/** Map legacy theme ids from older settings.json. */
export function migrateUiTheme(v: unknown): UiTheme {
  if (v === 'amoled') return 'deep-dark'
  if (isUiTheme(v)) return v
  if (v === 'black') return 'classic'
  if (v === 'white') return 'light'
  return 'classic'
}

export function resolveUiTheme(theme: UiTheme): ResolvedUiTheme {
  if (theme !== 'auto') return theme
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  }
  return 'classic'
}

export function monacoThemeId(theme: UiTheme): string {
  const resolved = resolveUiTheme(theme)
  switch (resolved) {
    case 'light':
      return 'afkllm-light'
    case 'sepia':
      return 'afkllm-sepia'
    case 'deep-dark':
      return 'afkllm-deep-dark'
    case 'solarized-dark':
      return 'afkllm-solarized-dark'
    case 'dark':
      return 'afkllm-dark'
    case 'classic':
    default:
      return 'afkllm-classic'
  }
}

export interface TerminalThemeColors {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  green: string
  brightGreen: string
}

const ACCENT = '#3794ff'
const ACCENT_DIM = '#2b6cb0'

export const TERMINAL_THEMES: Record<ResolvedUiTheme, TerminalThemeColors> = {
  classic: {
    background: '#181818',
    foreground: '#cccccc',
    cursor: ACCENT,
    selectionBackground: '#3794ff44',
    black: '#181818',
    green: ACCENT,
    brightGreen: ACCENT
  },
  light: {
    background: '#ffffff',
    foreground: '#1e1e1e',
    cursor: '#005fb8',
    selectionBackground: '#005fb844',
    black: '#ffffff',
    green: '#005fb8',
    brightGreen: '#005fb8'
  },
  sepia: {
    background: '#f4ecd8',
    foreground: '#5b4636',
    cursor: '#8b5a2b',
    selectionBackground: '#c4a57466',
    black: '#f4ecd8',
    green: '#6b8e23',
    brightGreen: '#556b2f'
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: ACCENT,
    selectionBackground: '#3794ff44',
    black: '#1e1e1e',
    green: ACCENT,
    brightGreen: ACCENT
  },
  'deep-dark': {
    background: '#000000',
    foreground: '#e4e4e4',
    cursor: ACCENT,
    selectionBackground: '#3794ff44',
    black: '#000000',
    green: ACCENT,
    brightGreen: ACCENT
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#268bd2',
    selectionBackground: '#073642aa',
    black: '#002b36',
    green: '#859900',
    brightGreen: '#586e75'
  }
}

export const WINDOW_BG: Record<ResolvedUiTheme, string> = {
  classic: '#181818',
  light: '#ffffff',
  sepia: '#f4ecd8',
  dark: '#1e1e1e',
  'deep-dark': '#000000',
  'solarized-dark': '#002b36'
}

export { ACCENT, ACCENT_DIM }

export function applyDocumentTheme(theme: UiTheme): void {
  if (typeof document === 'undefined') return
  const resolved = resolveUiTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-theme-pref', theme)
  const lightLike = resolved === 'light' || resolved === 'sepia'
  document.documentElement.style.colorScheme = lightLike ? 'light' : 'dark'
}
