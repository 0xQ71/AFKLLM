// Tiny ANSI toolkit (no dependencies).
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY

const wrap = (open: string, close: string) => (s: string) => (NO_COLOR ? s : `\x1b[${open}m${s}\x1b[${close}m`)
const rgb = (r: number, g: number, b: number) => wrap(`38;2;${r};${g};${b}`, '39')

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  strike: wrap('9', '29'),
  inverse: wrap('7', '27'),
  red: rgb(255, 107, 128),
  green: rgb(78, 186, 101),
  yellow: rgb(255, 193, 7),
  orange: rgb(235, 129, 74),
  blue: rgb(117, 167, 255),
  purple: rgb(175, 135, 255),
  teal: rgb(72, 150, 140),
  gray: rgb(153, 153, 153),
  brand: rgb(32, 192, 184), // AFKLLM logo turquoise (#20c0b8)
  diffAddBg: (s: string) => (NO_COLOR ? s : `\x1b[48;2;34;92;43m${s}\x1b[49m`),
  diffDelBg: (s: string) => (NO_COLOR ? s : `\x1b[48;2;122;41;54m${s}\x1b[49m`),
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0 // combining
  if (cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!)
  return w
}

/** Hard-wrap plain text (no ANSI) into chunks of at most `width` columns. */
export function chunkPlain(s: string, width: number): string[] {
  if (width <= 0) return [s]
  const out: string[] = []
  let cur = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!)
    if (w + cw > width) { out.push(cur); cur = ''; w = 0 }
    cur += ch
    w += cw
  }
  out.push(cur)
  return out
}

/** Word-wrap text that may contain ANSI codes; continuation lines get `indent`. */
export function wordWrap(s: string, width: number, indent = ''): string[] {
  if (strWidth(s) <= width) return [s]
  const words = s.split(/(\s+)/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (strWidth(cur) + strWidth(w) > width && stripAnsi(cur).trim()) {
      lines.push(cur.replace(/\s+$/, ''))
      cur = indent + w.replace(/^\s+/, '')
      while (strWidth(cur) > width) {
        // a single huge token (URL, path): hard split on plain text
        const plain = stripAnsi(cur)
        lines.push(plain.slice(0, width))
        cur = indent + plain.slice(width)
      }
    } else cur += w
  }
  if (stripAnsi(cur).trim()) lines.push(cur)
  return lines
}

export const cols = () => Math.max(40, process.stdout.columns || 100)

/**
 * Terminal palette control (OSC 10/11; Windows Terminal, VS Code, most modern terminals; ignored elsewhere).
 * "black" = AFKLLM dark look: pure black background, white text, logo-turquoise accents.
 */
export type CliTheme = 'black' | 'default'
export const OSC = {
  setBg: (hex: string) => `\x1b]11;${hex}\x07`,
  setFg: (hex: string) => `\x1b]10;${hex}\x07`,
  reset: '\x1b]111\x07\x1b]110\x07',
}
export function applyTheme(t: CliTheme): void {
  if (NO_COLOR) return
  if (t === 'black') process.stdout.write(OSC.setBg('#000000') + OSC.setFg('#ffffff') + '\x1b[2J\x1b[H')
  else process.stdout.write(OSC.reset)
}

export const ESC = {
  clearLine: '\r\x1b[2K',
  clearDown: '\x1b[J',
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ''),
  down: (n: number) => (n > 0 ? `\x1b[${n}B` : ''),
  col: (n: number) => `\x1b[${n + 1}G`,
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
}
