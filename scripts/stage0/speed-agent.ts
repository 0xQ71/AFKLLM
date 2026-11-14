// Decode speed on agent-like work (not the short bench prompt): Russian reasoning over ~12K tokens of code, and a
// long code file. Compares MTP draft settings for the q38 profile. Thinking on, like the agent.
//   npx tsx scripts/stage0/speed-agent.ts
import { readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureServer, loadConfig, profiles } from '../../src/core/server'

const ROOT = join(__dirname, '..', '..')
const OUT = 'C:\\Models\\_bench\\speed-agent.jsonl'

function corpus(maxChars: number): string {
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n)) files.push(p)
    }
  }
  walk(join(ROOT, 'src', 'core'))
  let s = ''
  for (const f of files) {
    if (s.length > maxChars) break
    s += `\n// ===== ${f.slice(ROOT.length + 1)}\n` + readFileSync(f, 'utf8')
  }
  return s.slice(0, maxChars)
}

const PROMPTS = [
  { name: 'ru-reasoning@12K', max: 1200, msgs: (code: string) => [
    { role: 'user', content: code + '\n\nОбъясни по-русски, как в этом коде агент решает, когда сжимать контекст, ' +
      'и предложи два конкретных улучшения с примерами кода.' }] },
  { name: 'code-file', max: 1500, msgs: () => [
    { role: 'user', content: 'Write a complete single-file Python CLI todo app with argparse, JSON storage, ' +
      'add/list/done/remove commands, colored output and unit tests at the bottom. Only the code.' }] },
]

async function main() {
  const base = profiles(loadConfig()).q38
  const variants: Array<[string, Record<string, string>]> = process.argv[2] === 'n' ? [
    ['n2 p0', { 'spec-draft-n-max': '2' }],
    ['n5 p0', { 'spec-draft-n-max': '5' }],
  ] : [
    ['n3 p0 (current)', {}],
    ['n3 p0.6', { 'spec-draft-p-min': '0.6' }],
    ['n3 p0.8', { 'spec-draft-p-min': '0.8' }],
    ['n4 p0.7', { 'spec-draft-n-max': '4', 'spec-draft-p-min': '0.7' }],
  ]
  const code = corpus(40_000)
  for (const [name, extra] of variants) {
    const prof = { ...base, args: { ...base.args, ...extra } }
    const srv = await ensureServer(prof, loadConfig(), { port: 18350 })
    try {
      for (const p of PROMPTS) {
        const body = { messages: p.msgs(code), max_tokens: p.max, temperature: 0.6, top_p: 0.95, top_k: 20,
          chat_template_kwargs: { enable_thinking: true }, cache_prompt: false }
        const r = await fetch(`${srv.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const j = await r.json() as { timings: Record<string, number> }
        const t = j.timings
        const acc = t.draft_n ? t.draft_n_accepted / t.draft_n : 0
        const line = { variant: name, prompt: p.name, prompt_n: t.prompt_n, gen: t.predicted_n, tps: +t.predicted_per_second.toFixed(1), accept: +acc.toFixed(2) }
        console.log(JSON.stringify(line))
        appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), ...line }) + '\n')
      }
    } finally {
      srv.stop()
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}
void main()
