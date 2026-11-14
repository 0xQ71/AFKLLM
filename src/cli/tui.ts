// Terminal plumbing: a redrawable "live area" at the bottom (spinner, input box, dialogs) under normal
// scrollback output, a raw-mode key parser, and a small multi-line line editor.
import { ESC, chunkPlain, cols, strWidth, stripAnsi } from './ansi'

const out = (s: string) => process.stdout.write(s)

function fit(row: string, width: number): string {
  if (strWidth(row) <= width) return row
  // truncate visible text; drop styling on the cut row to keep it simple and correct
  const plain = stripAnsi(row)
  return chunkPlain(plain, Math.max(1, width - 1))[0] + '…'
}

// Synchronized output (terminals that support it show a frame only when it is complete; others ignore it)
const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'

/**
 * The live area is redrawn in place: every frame is one write that overwrites the previous rows line by line
 * (each row clears only its own tail) instead of erasing the whole block first — erasing first is what made the
 * classic Windows console flicker. Identical frames are not written at all.
 */
export class Screen {
  private rows: string[] = []
  private cursor: { row: number; col: number } | null = null
  private drawnRows = 0
  private cursorRow = 0
  private lastFrame = ''

  /** Write permanent output above the live area. */
  print(text: string) {
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
    let s = SYNC_ON + ESC.hideCursor + this.toTop()
    s += lines.map((l) => l + '\x1b[0m\x1b[K').join('\n') + '\n'
    this.drawnRows = 0
    this.cursorRow = 0
    s += this.frame(true)
    out(s + SYNC_OFF)
  }

  setLive(rows: string[], cursor: { row: number; col: number } | null = null) {
    this.rows = rows
    this.cursor = cursor
    const f = this.frame(false)
    if (f) out(SYNC_ON + ESC.hideCursor + f + SYNC_OFF)
  }

  /** Remove the live area (before exit or handing the terminal to something else). */
  clearLive() {
    if (this.drawnRows) out(this.toTop() + '\x1b[J' + ESC.showCursor)
    this.rows = []
    this.cursor = null
    this.drawnRows = 0
    this.cursorRow = 0
    this.lastFrame = ''
  }

  private toTop(): string {
    return (this.drawnRows ? ESC.up(this.cursorRow) : '') + '\r'
  }

  /** Escape codes that draw the live rows from wherever the cursor is; '' when nothing changed. */
  private frame(force: boolean): string {
    const w = cols() - 1
    const rows = this.rows.map((r) => fit(r, w))
    const sig = `${w}\u0000${rows.join('\n')}\u0000${this.cursor ? `${this.cursor.row},${this.cursor.col}` : '-'}`
    if (!force && sig === this.lastFrame && this.drawnRows) return ''
    let s = force ? '' : this.toTop()
    if (!rows.length) {
      s += '\x1b[J'
      this.drawnRows = 0
      this.cursorRow = 0
    } else {
      s += rows.map((r) => r + '\x1b[0m\x1b[K').join('\n') + '\x1b[J'
      this.drawnRows = rows.length
      this.cursorRow = rows.length - 1
      if (this.cursor) {
        s += ESC.up(rows.length - 1 - this.cursor.row) + ESC.col(this.cursor.col) + ESC.showCursor
        this.cursorRow = this.cursor.row
      } else {
        s += '\r'
      }
    }
    this.lastFrame = sig
    return s
  }
}

// ---------------------------------------------------------------- keys

export interface Key {
  name: string // 'char' | 'paste' | 'enter' | 'newline' | 'backspace' | 'delete' | 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'tab' | 'shift-tab' | 'escape' | 'ctrl-a' ...
  text?: string
}

const SEQ: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[3~': 'delete', '\x1b[Z': 'shift-tab', '\x1b\r': 'newline', '\x1b\n': 'newline',
  '\x1b[1;5D': 'word-left', '\x1b[1;5C': 'word-right', '\x1bb': 'word-left', '\x1bf': 'word-right',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[13;2u': 'newline', '\x1b[27;2;13~': 'newline',
}

export class KeyParser {
  private pasting = false
  private paste = ''

  parse(data: string): Key[] {
    const keys: Key[] = []
    let i = 0
    // Unbracketed paste fallback: a multi-char chunk with a newline inside is text, not "submit".
    if (!this.pasting && data.length > 2 && !data.startsWith('\x1b') && /[\r\n]./.test(data)) {
      return [{ name: 'paste', text: data.replace(/\r\n?/g, '\n') }]
    }
    while (i < data.length) {
      if (this.pasting) {
        const end = data.indexOf('\x1b[201~', i)
        if (end < 0) { this.paste += data.slice(i); return keys }
        this.paste += data.slice(i, end)
        keys.push({ name: 'paste', text: this.paste.replace(/\r\n?/g, '\n') })
        this.pasting = false
        this.paste = ''
        i = end + 6
        continue
      }
      if (data.startsWith('\x1b[200~', i)) { this.pasting = true; i += 6; continue }
      const ch = data[i]
      if (ch === '\x1b') {
        let matched = ''
        for (const s of Object.keys(SEQ)) if (data.startsWith(s, i) && s.length > matched.length) matched = s
        if (matched) { keys.push({ name: SEQ[matched] }); i += matched.length; continue }
        // unknown CSI: skip it whole
        const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(data.slice(i))
        if (csi) { i += csi[0].length; continue }
        keys.push({ name: 'escape' })
        i++
        continue
      }
      const code = ch.charCodeAt(0)
      if (ch === '\r') keys.push({ name: 'enter' })
      else if (ch === '\n') keys.push({ name: 'newline' })
      else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' })
      else if (ch === '\t') keys.push({ name: 'tab' })
      else if (code < 32) keys.push({ name: `ctrl-${String.fromCharCode(code + 96)}` })
      else {
        // collect a run of printable chars
        let j = i
        while (j < data.length && data.charCodeAt(j) >= 32 && data[j] !== '\x7f' && data[j] !== '\x1b') j++
        keys.push({ name: 'char', text: data.slice(i, j) })
        i = j
        continue
      }
      i++
    }
    return keys
  }
}

// ---------------------------------------------------------------- line editor

export class LineEditor {
  value = ''
  pos = 0
  private history: string[] = []
  private histIdx = -1
  private draft = ''

  constructor(history: string[] = []) { this.history = history }

  get historyList() { return this.history }

  /** Forget the ↑/↓ history (the text being typed stays). */
  clearHistory() { this.history = []; this.histIdx = -1; this.draft = '' }

  set(v: string) { this.value = v; this.pos = v.length }

  /** Returns 'submit' when Enter was pressed on a non-continued line. */
  handle(k: Key): 'submit' | 'changed' | null {
    const v = this.value
    switch (k.name) {
      case 'char':
      case 'paste':
        this.value = v.slice(0, this.pos) + k.text + v.slice(this.pos)
        this.pos += k.text!.length
        return 'changed'
      case 'newline':
        this.value = v.slice(0, this.pos) + '\n' + v.slice(this.pos)
        this.pos++
        return 'changed'
      case 'enter':
        if (this.pos > 0 && v[this.pos - 1] === '\\') { // "\" + Enter = newline
          this.value = v.slice(0, this.pos - 1) + '\n' + v.slice(this.pos)
          return 'changed'
        }
        return 'submit'
      case 'backspace':
        if (this.pos > 0) { this.value = v.slice(0, this.pos - 1) + v.slice(this.pos); this.pos-- }
        return 'changed'
      case 'delete':
      case 'ctrl-d':
        if (this.pos < v.length) this.value = v.slice(0, this.pos) + v.slice(this.pos + 1)
        return 'changed'
      case 'left': this.pos = Math.max(0, this.pos - 1); return 'changed'
      case 'right': this.pos = Math.min(v.length, this.pos + 1); return 'changed'
      case 'home': case 'ctrl-a': this.pos = v.lastIndexOf('\n', this.pos - 1) + 1; return 'changed'
      case 'end': case 'ctrl-e': {
        const nl = v.indexOf('\n', this.pos)
        this.pos = nl < 0 ? v.length : nl
        return 'changed'
      }
      case 'word-left': {
        let p = this.pos
        while (p > 0 && /\s/.test(v[p - 1])) p--
        while (p > 0 && !/\s/.test(v[p - 1])) p--
        this.pos = p
        return 'changed'
      }
      case 'word-right': {
        let p = this.pos
        while (p < v.length && /\s/.test(v[p])) p++
        while (p < v.length && !/\s/.test(v[p])) p++
        this.pos = p
        return 'changed'
      }
      case 'ctrl-w': {
        let p = this.pos
        while (p > 0 && /\s/.test(v[p - 1])) p--
        while (p > 0 && !/\s/.test(v[p - 1])) p--
        this.value = v.slice(0, p) + v.slice(this.pos)
        this.pos = p
        return 'changed'
      }
      case 'ctrl-u': {
        const start = v.lastIndexOf('\n', this.pos - 1) + 1
        this.value = v.slice(0, start) + v.slice(this.pos)
        this.pos = start
        return 'changed'
      }
      case 'ctrl-k': {
        const nl = v.indexOf('\n', this.pos)
        this.value = v.slice(0, this.pos) + (nl < 0 ? '' : v.slice(nl))
        return 'changed'
      }
      case 'up': {
        const lineStart = v.lastIndexOf('\n', this.pos - 1) + 1
        if (lineStart > 0) { // move within multi-line input
          const col = this.pos - lineStart
          const prevStart = v.lastIndexOf('\n', lineStart - 2) + 1
          this.pos = Math.min(prevStart + col, lineStart - 1)
          return 'changed'
        }
        if (!this.history.length) return null
        if (this.histIdx < 0) { this.draft = v; this.histIdx = this.history.length }
        if (this.histIdx > 0) this.histIdx--
        this.set(this.history[this.histIdx])
        return 'changed'
      }
      case 'down': {
        const nl = v.indexOf('\n', this.pos)
        if (nl >= 0) {
          const lineStart = v.lastIndexOf('\n', this.pos - 1) + 1
          const col = this.pos - lineStart
          const nextEnd = v.indexOf('\n', nl + 1)
          this.pos = Math.min(nl + 1 + col, nextEnd < 0 ? v.length : nextEnd)
          return 'changed'
        }
        if (this.histIdx < 0) return null
        this.histIdx++
        if (this.histIdx >= this.history.length) { this.histIdx = -1; this.set(this.draft) } else this.set(this.history[this.histIdx])
        return 'changed'
      }
    }
    return null
  }

  commit(): string {
    const v = this.value
    if (v.trim() && this.history[this.history.length - 1] !== v) this.history.push(v)
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500)
    this.histIdx = -1
    this.value = ''
    this.pos = 0
    return v
  }

  /** Visual rows for the input (prefix "> " on the first row) and the cursor position inside them. */
  render(width: number, placeholder = ''): { rows: string[]; cursor: { row: number; col: number } } {
    const cw = Math.max(10, width - 2)
    if (!this.value) {
      return { rows: ['> ' + (placeholder ? `\x1b[2m${placeholder}\x1b[22m` : '')], cursor: { row: 0, col: 2 } }
    }
    const logical = this.value.split('\n')
    const rows: string[] = []
    let cursor = { row: 0, col: 2 }
    let offset = 0
    logical.forEach((line, li) => {
      const chunks = chunkPlain(line, cw)
      const startRow = rows.length
      chunks.forEach((ch, k) => rows.push((li === 0 && k === 0 ? '> ' : '  ') + ch))
      const lineEnd = offset + line.length
      if (this.pos >= offset && this.pos <= lineEnd) {
        const before = strWidth(line.slice(0, this.pos - offset))
        let r = Math.floor(before / cw)
        let col = before - r * cw
        if (r >= chunks.length) { r = chunks.length - 1; col = cw }
        cursor = { row: startRow + r, col: 2 + col }
      }
      offset = lineEnd + 1
    })
    return { rows, cursor }
  }
}

export function setupTerminal(onData: (s: string) => void): () => void {
  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  stdin.on('data', onData)
  stdin.resume()
  out(ESC.bracketedPasteOn)
  return () => {
    stdin.off('data', onData)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
    out(ESC.bracketedPasteOff + ESC.showCursor)
  }
}
