// Loop guards for long unattended runs. Local models fail in a few recurring ways (seen in stage 0 and in the
// reference videos): text that repeats itself until the token limit, whole files written inside the thinking
// block instead of with Write/Edit, and the same tool call made over and over. These are cheap, pure checks;
// agent.ts decides what to do when one fires.

/**
 * Degenerate repetition: one line (12+ chars) repeated 6+ times that fills 35%+ of the recent text, or the tail
 * repeating a block 4+ times back-to-back. Legit code with repeated lines (HTML rows, imports) stays well below that.
 */
export function repetitionLoop(text: string): string | null {
  const recent = text.slice(-6000)
  if (recent.length < 600) return null
  const counts = new Map<string, number>()
  for (const raw of recent.split('\n')) {
    const line = raw.trim()
    if (line.length < 12 || /^[-=*_`#|+\s.]+$/.test(line)) continue // separators, fences, table rules
    const n = (counts.get(line) ?? 0) + 1
    counts.set(line, n)
    if (n >= 6 && n * line.length >= recent.length * 0.35) return `the line "${line.slice(0, 80)}" repeated ${n} times`
  }
  // a block repeating back-to-back at the very end (no newlines needed): "abcabcabcabc"
  for (let size = 20; size <= 400; size += size < 100 ? 5 : 25) {
    if (recent.length < size * 4) break
    const unit = recent.slice(-size)
    if (new Set(unit.replace(/\s/g, '')).size < 4) continue // "=====", "-----", spaces: not a loop
    let reps = 1
    while (reps < 6 && recent.slice(-(size * (reps + 1)), -(size * reps)) === unit) reps++
    if (reps >= 4) return `the same ${size}-character block repeated ${reps} times`
  }
  return null
}

/** The model is writing files in its thinking instead of calling tools. */
export function codeInThinking(reasoning: string): boolean {
  let inFence = false
  let codeLines = 0
  for (const line of reasoning.split('\n')) {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; continue }
    if (inFence) codeLines++
  }
  return codeLines >= 80
}

/** Tracks identical tool calls with identical results. */
export class CallRepeats {
  private recent: string[] = []

  /** Returns how many times this exact call + result was seen in the last 10 calls (including this one). */
  record(name: string, args: string, output: string): number {
    const sig = `${name}\u0000${args}\u0000${hash(output)}`
    this.recent.push(sig)
    if (this.recent.length > 10) this.recent.shift()
    return this.recent.filter((s) => s === sig).length
  }

  reset() { this.recent = [] }
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36) + ':' + s.length
}
