import type { ReactNode } from 'react'
import { isSafeExternalUrl } from '../../../shared/safeExternalUrl'

export function MarkdownBody({
  content,
  streaming
}: {
  content: string
  streaming?: boolean
}): React.JSX.Element {
  const blocks = splitBlocks(content)
  return (
    <div className="space-y-2 break-words text-[13px] leading-relaxed text-ink-soft">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
      {streaming && <span className="stream-caret" aria-hidden />}
    </div>
  )
}

type MdBlock =
  | { type: 'code'; lang?: string; code: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'h'; level: 1 | 2 | 3; text: string }
  | { type: 'p'; text: string }

function splitBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || undefined
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        code.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      out.push({ type: 'code', lang, code: code.join('\n') })
      continue
    }

    if (/^#{1,3}\s+\S/.test(line)) {
      const m = line.match(/^(#{1,3})\s+(.*)$/)!
      out.push({
        type: 'h',
        level: Math.min(3, m[1]!.length) as 1 | 2 | 3,
        text: m[2]!.trim()
      })
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ''))
        i++
      }
      out.push({ type: 'ul', items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      out.push({ type: 'ol', items })
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.startsWith('```') &&
      !/^#{1,3}\s+/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i++
    }
    out.push({ type: 'p', text: para.join('\n') })
  }
  return out.length ? out : [{ type: 'p', text: src }]
}

function Block({ block }: { block: MdBlock }): React.JSX.Element {
  if (block.type === 'code') {
    return (
      <pre className="overflow-x-auto rounded-lg border border-ink-line/60 bg-ink-900/80 px-3 py-2 font-mono text-[12px] text-ink-bright">
        <code>{block.code}</code>
      </pre>
    )
  }
  if (block.type === 'h') {
    const cls =
      block.level === 1
        ? 'text-[15px] font-semibold text-ink-bright'
        : block.level === 2
          ? 'text-[14px] font-semibold text-ink-bright'
          : 'text-[13px] font-medium text-ink-bright'
    return <div className={cls}>{inlineMd(block.text)}</div>
  }
  if (block.type === 'ul') {
    return (
      <ul className="list-disc space-y-0.5 pl-5">
        {block.items.map((it, i) => (
          <li key={i}>{inlineMd(it)}</li>
        ))}
      </ul>
    )
  }
  if (block.type === 'ol') {
    return (
      <ol className="list-decimal space-y-0.5 pl-5">
        {block.items.map((it, i) => (
          <li key={i}>{inlineMd(it)}</li>
        ))}
      </ol>
    )
  }
  return (
    <p className="m-0 whitespace-pre-wrap">{inlineMd(block.text)}</p>
  )
}

function inlineMd(text: string): ReactNode {
  // `code`, **bold**, *italic*, [label](url)
  const parts: ReactNode[] = []
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-ink-900 px-1 py-0.5 font-mono text-[12px] text-ink-bright"
        >
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink-bright">
          {tok.slice(2, -2)}
        </strong>
      )
    } else if (tok.startsWith('*')) {
      parts.push(
        <em key={key++} className="italic">
          {tok.slice(1, -1)}
        </em>
      )
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (lm) {
        const href = lm[2]!
        if (isSafeExternalUrl(href)) {
          parts.push(
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-signal underline-offset-2 hover:underline"
            >
              {lm[1]}
            </a>
          )
        } else {
          parts.push(
            <span key={key++} className="text-ink-soft">
              {lm[1]}
            </span>
          )
        }
      } else parts.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length ? parts : text
}
