import type { DiffLine } from './types'

/**
 * Line diff with up to `context` unchanged lines around each change (unified-diff style).
 * LCS on the changed middle only (common prefix/suffix stripped first), so big files with a small
 * edit stay cheap; falls back to "all removed / all added" if the middle is huge.
 */
export function lineDiff(before: string, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n')
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)

  const ops: DiffLine[] = []
  for (let i = 0; i < pre; i++) ops.push({ kind: ' ', text: a[i], line: i + 1 })
  if (am.length * bm.length <= 4_000_000) {
    const n = am.length
    const m = bm.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ kind: ' ', text: am[i], line: pre + i + 1 }); i++; j++
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ kind: '+', text: bm[j], line: pre + j + 1 }); j++
      } else {
        ops.push({ kind: '-', text: am[i], line: pre + i + 1 }); i++
      }
    }
  } else {
    am.forEach((t, k) => ops.push({ kind: '-', text: t, line: pre + k + 1 }))
    bm.forEach((t, k) => ops.push({ kind: '+', text: t, line: pre + k + 1 }))
  }
  for (let k = 0; k < suf; k++) ops.push({ kind: ' ', text: a[a.length - suf + k], line: a.length - suf + k + 1 })

  // keep only context around changes
  const keep = new Array(ops.length).fill(false)
  ops.forEach((o, k) => {
    if (o.kind !== ' ') for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < ops.length) keep[k + d] = true
  })
  const lines: DiffLine[] = []
  let gap = false
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (gap && lines.length) lines.push({ kind: ' ', text: '…', line: -1 })
      lines.push(o)
      gap = false
    } else gap = true
  })
  return { lines, added: ops.filter((o) => o.kind === '+').length, removed: ops.filter((o) => o.kind === '-').length }
}
