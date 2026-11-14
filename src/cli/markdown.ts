// Line-at-a-time Markdown → ANSI, enough for agent replies: headings, bullets, bold/italic/code, fences, quotes.
import { c } from './ansi'

export class MarkdownLines {
  private inFence = false

  reset() { this.inFence = false }

  render(line: string): string {
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      this.inFence = !this.inFence
      return c.dim(line)
    }
    if (this.inFence) return c.blue(line)

    let m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) return c.bold(inline(m[2]))
    m = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    if (m) return `${m[1]}• ${inline(m[3])}`
    m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line)
    if (m) return `${m[1]}${m[2]} ${inline(m[3])}`
    m = /^>\s?(.*)$/.exec(line)
    if (m) return c.dim('▎ ') + c.italic(inline(m[1]))
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return c.dim('─'.repeat(40))
    return inline(line)
  }
}

export function inline(s: string): string {
  // protect code spans first
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => c.bold(a ?? b))
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, (_m, pre, a) => pre + c.italic(a))
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, t, u) => `${c.underline(t)} ${c.dim(`(${u})`)}`)
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => c.blue(codes[Number(i)]))
}
