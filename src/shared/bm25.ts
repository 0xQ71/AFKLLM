/**
 * Minimal Okapi BM25 for in-process codebase retrieval (pure).
 */

export interface Bm25Doc {
  id: string
  tf: Map<string, number> | Record<string, number>
  dl: number
}

export interface Bm25CorpusStats {
  docCount: number
  avgDl: number
  df: Map<string, number> | Record<string, number>
}

export interface Bm25Hit {
  id: string
  score: number
}

const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75

/** Lowercase alphanumeric / path-ish tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

export function buildTermFreqs(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  return tf
}

function getTf(doc: Bm25Doc, term: string): number {
  if (doc.tf instanceof Map) return doc.tf.get(term) ?? 0
  return (doc.tf as Record<string, number>)[term] ?? 0
}

function getDf(stats: Bm25CorpusStats, term: string): number {
  if (stats.df instanceof Map) return stats.df.get(term) ?? 0
  return (stats.df as Record<string, number>)[term] ?? 0
}

/** IDF with +1 smoothing (avoids negative for rare terms). */
export function idf(docCount: number, df: number): number {
  const N = Math.max(1, docCount)
  const n = Math.max(0, df)
  return Math.log(1 + (N - n + 0.5) / (n + 0.5))
}

export function bm25Score(
  queryTerms: string[],
  doc: Bm25Doc,
  stats: Bm25CorpusStats,
  k1 = DEFAULT_K1,
  b = DEFAULT_B
): number {
  if (queryTerms.length === 0 || stats.docCount === 0) return 0
  const avgDl = stats.avgDl > 0 ? stats.avgDl : 1
  let score = 0
  const seen = new Set<string>()
  for (const term of queryTerms) {
    if (seen.has(term)) continue
    seen.add(term)
    const f = getTf(doc, term)
    if (f <= 0) continue
    const termIdf = idf(stats.docCount, getDf(stats, term))
    const denom = f + k1 * (1 - b + (b * doc.dl) / avgDl)
    score += termIdf * ((f * (k1 + 1)) / denom)
  }
  return score
}

/** Top-K by score desc. */
export function rankBm25(
  queryTerms: string[],
  docs: Bm25Doc[],
  stats: Bm25CorpusStats,
  topK = 24
): Bm25Hit[] {
  const terms = queryTerms.filter(Boolean)
  if (terms.length === 0 || docs.length === 0) return []
  const hits: Bm25Hit[] = []
  for (const doc of docs) {
    const score = bm25Score(terms, doc, stats)
    if (score > 0) hits.push({ id: doc.id, score })
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits.slice(0, topK)
}

export function buildCorpusStats(docs: Bm25Doc[]): Bm25CorpusStats {
  const df = new Map<string, number>()
  let totalDl = 0
  for (const doc of docs) {
    totalDl += doc.dl
    const terms =
      doc.tf instanceof Map
        ? doc.tf.keys()
        : Object.keys(doc.tf as Record<string, number>)
    for (const t of terms) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  return {
    docCount: docs.length,
    avgDl: docs.length ? totalDl / docs.length : 0,
    df
  }
}

/** Overlapping line chunks. */
export function chunkLines(
  text: string,
  chunkLinesCount = 100,
  overlap = 10
): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length === 0) return []
  const out: Array<{ startLine: number; endLine: number; text: string }> = []
  const step = Math.max(1, chunkLinesCount - overlap)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkLinesCount)
    const slice = lines.slice(start, end)
    out.push({
      startLine: start + 1,
      endLine: end,
      text: slice.join('\n')
    })
    if (end >= lines.length) break
  }
  return out
}
