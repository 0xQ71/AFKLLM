/** Language-aware “is this file body finished?” — not HTML-only `</html>`. */

function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

function bracesBalanced(text: string): boolean {
  let curly = 0
  let round = 0
  let square = 0
  let inStr: string | null = null
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '{') curly++
    else if (c === '}') curly--
    else if (c === '(') round++
    else if (c === ')') round--
    else if (c === '[') square++
    else if (c === ']') square--
    if (curly < 0 || round < 0 || square < 0) return false
  }
  return curly === 0 && round === 0 && square === 0
}

function looksLikeHtml(text: string): boolean {
  return /<!DOCTYPE\s+html|<html[\s>]/i.test(text)
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim()
    if (t) return t
  }
  return ''
}

/**
 * True when the buffer looks like a finished source file for `relativePath`.
 * Without a path: HTML needs `</html>`; other languages use brace/JSON/Python heuristics.
 */
export function contentLooksStructurallyComplete(
  content: string,
  relativePath = ''
): boolean {
  const t = content.trim()
  if (!t) return false
  const ext = extOf(relativePath)

  if (ext === '.html' || ext === '.htm' || (!ext && looksLikeHtml(t))) {
    return /<\/html\s*>/i.test(t)
  }
  if (ext === '.json' || ext === '.jsonc') {
    try {
      JSON.parse(t.replace(/^\s*\/\/[^\n]*\n/gm, ''))
      return true
    } catch {
      return false
    }
  }
  if (ext === '.py') {
    const last = lastNonEmptyLine(t)
    if (/:$/.test(last)) return false
    if (/\b(pass|return|raise|break|continue)\b/.test(last)) return true
    return !t.endsWith('\\') && t.length > 8
  }
  if (
    [
      '.java',
      '.kt',
      '.cs',
      '.go',
      '.rs',
      '.c',
      '.cc',
      '.cpp',
      '.cxx',
      '.h',
      '.hh',
      '.hpp',
      '.hxx',
      '.m',
      '.mm',
      '.swift',
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.mjs',
      '.cjs'
    ].includes(ext)
  ) {
    return bracesBalanced(t) && !/[,\\]$/.test(lastNonEmptyLine(t))
  }
  if (looksLikeHtml(t)) return /<\/html\s*>/i.test(t)
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t)
      return true
    } catch {
      /* fall through */
    }
  }
  if (/[{([]/.test(t)) return bracesBalanced(t)
  return t.length > 0 && !/[,\\]$/.test(lastNonEmptyLine(t))
}
