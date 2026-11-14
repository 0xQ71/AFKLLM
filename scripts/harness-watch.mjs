// Live view of a DeepSeek Harness session: what the agent thinks and does, todo progress, context, compaction, speed.
//   node scripts/harness-watch.mjs [project-substring | session-id] [--log <headless stderr file | folder>] [--from-start] [--en]
// The model thinks in English; its reasoning is shown in Russian through the anonymous Bing translator that DeepSeek
// Harness' own reasoning translation uses (the text leaves this PC). --en shows the original.
// Without arguments it follows the most recently active session. --log streams the reasoning live from a headless run's
// stderr (the session file only gets a step's reasoning when the step ends).
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const logArg = opt('--log')
let logFile = logArg
const fromStart = argv.includes('--from-start') && (argv.splice(argv.indexOf('--from-start'), 1), true)
const english = argv.includes('--en') && (argv.splice(argv.indexOf('--en'), 1), true)
const filter = argv[0]
const SESSIONS = join(homedir(), '.dsh', 'sessions')
const LLAMA_LOG = join(homedir(), '.afkllm', 'logs', 'llama-server-18301.log')

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`
const dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), bold = c('1'), magenta = c('35')
const cols = () => Math.max(60, (process.stdout.columns || 120) - 2)
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
// Output goes through one queue so translated reasoning (async) stays in order with everything else.
const rawLog = console.log
let printQ = Promise.resolve()
console.log = (...a) => { printQ = printQ.then(() => rawLog(...a)) }
const BING = 'https://edge.microsoft.com/translate/translatetext?to=ru&isEnterpriseClient=false'
async function toRussian(text) {
  if (english || !/[a-z]{3}/i.test(text)) return text
  // the endpoint takes ~4000 characters per request: split on line breaks
  const parts = []
  let chunk = ''
  for (const line of text.split('\n')) { if ((chunk + line).length > 3500 && chunk) { parts.push(chunk); chunk = '' } chunk += (chunk ? '\n' : '') + line }
  if (chunk) parts.push(chunk)
  const out = []
  for (const part of parts) {
    try {
      const r = await fetch(BING, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([part]), signal: AbortSignal.timeout(10000) })
      const j = await r.json()
      out.push(j?.[0]?.translations?.[0]?.text ?? part)
    } catch { out.push(part) }
  }
  return out.join('\n')
}
const thought = (text, prefix = '🧠 ') => {
  printQ = printQ.then(async () => {
    const ru = await toRussian(text)
    ru.split('\n').filter((l) => l.trim()).forEach((l, i) => rawLog(dim((i ? '   ' : prefix) + l)))
  })
}
// The agent's own words (messages, a command's description) are shown in Russian too when it wrote them in English;
// code blocks inside a message stay as they are.
const isEnglish = (s) => (s.match(/[a-z]/gi) || []).length > 3 * (s.match(/[а-яё]/gi) || []).length + 3
const say = (text, render) => {
  printQ = printQ.then(async () => {
    if (!isEnglish(text)) return rawLog(render(text))
    const parts = text.split(/(```[\s\S]*?```)/)
    const out = []
    for (const p of parts) out.push(p.startsWith('```') ? p : await toRussian(p))
    rawLog(render(out.join('')))
  })
}
const hm = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин` }

function findSession() {
  let best = null, t = 0
  if (!existsSync(SESSIONS)) return null
  for (const d of readdirSync(SESSIONS)) {
    let subs = []
    try { subs = readdirSync(join(SESSIONS, d)) } catch { continue }
    for (const s of subs) {
      const f = join(SESSIONS, d, s, 'session.v4.jsonl.zstd')
      if (filter && !(d + s).includes(filter)) continue
      if (!existsSync(f)) continue
      const m = statSync(f).mtimeMs
      if (m > t) { t = m; best = f }
    }
  }
  return best
}

// The session file is a series of independent zstd frames, appended as the session runs.
let offset = 0, buf = Buffer.alloc(0)
function readNewEvents(file) {
  const size = statSync(file).size
  if (size <= offset) return []
  const fd = openSync(file, 'r')
  const chunk = Buffer.alloc(size - offset)
  readSync(fd, chunk, 0, chunk.length, offset)
  closeSync(fd)
  const b = Buffer.concat([buf, chunk])
  offset = size
  const starts = []
  for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) starts.push(i)
  starts.push(b.length)
  const out = []
  let consumed = 0
  for (let k = 0; k < starts.length - 1; k++) {
    try {
      for (const l of zstdDecompressSync(b.subarray(starts[k], starts[k + 1])).toString('utf8').split('\n')) if (l) out.push(JSON.parse(l))
      consumed = starts[k + 1]
    } catch { if (k === starts.length - 2) break }  // the last frame may still be half-written: retry it next tick
  }
  buf = b.subarray(consumed)
  return out
}

const callNames = new Map()
const st = { active: 0, started: 0, steps: 0, ctx: 0, window: 0, compactions: 0, prunes: 0, todos: [], tools: 0, errors: 0, lastEvent: 0, title: '' }
const toolArgs = (name, a) => {
  try { a = JSON.parse(a) } catch { return clip(a, 160) }
  if (a.command) return clip(a.command, 200)
  if (a.file_path || a.path) return (a.file_path || a.path) + (a.old_string ? '  (правка)' : '')
  if (a.pattern) return a.pattern
  if (a.prompt) return clip(a.prompt, 160)
  if (a.url) return a.url
  if (a.query) return a.query
  return clip(JSON.stringify(a), 160)
}

function show(e, live) {
  const d = e.data ?? {}
  // working time: gaps between events up to 20 min count (a long thinking step or build), longer ones are pauses
  // active time: gaps between events, capped at 20 min (idle) and never negative (events of another session / clock skew)
  if (e.time && st.lastEvent) st.active += Math.max(0, Math.min(e.time - st.lastEvent, 20 * 60000))
  st.lastEvent = e.time ?? st.lastEvent
  switch (e.type) {
    case 'session': st.started = e.createdAt; console.log(bold(`сессия ${e.id}`) + dim(`  ${e.cwd}`)); break
    case 'request/context': st.window = d.contextWindow; break
    case 'session/title': st.title = d.title; break
    case 'user/message': {
      const t = (d.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join(' ')
      if (!/^<system|^\[/.test(t)) console.log('\n' + magenta('👤 ' + clip(t, cols() * 2)))
      break
    }
    case 'step/start': st.steps++; break
    case 'assistant/message': {
      const u = d.usage ?? {}
      st.ctx = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0)
      for (const p of d.message?.content ?? []) {
        if (p.type === 'reasoning' && !logFile) thought(clip(p.text, cols() * 3))
        if (p.type === 'text' && p.text.trim()) say(p.text.trim(), (t) => '\n' + bold('💬 ') + t + '\n')
      }
      break
    }
    case 'tool/call': {
      st.tools++; callNames.set(d.callId, d.name)
      let desc = ''
      try { desc = JSON.parse(d.arguments).description ?? '' } catch {}
      // a command with a description: the description (in Russian) is the title, the command itself dim below
      if (desc) say(desc, (t) => cyan(`🔧 ${d.name}`) + ' ' + t + '\n' + dim('   $ ' + toolArgs(d.name, d.arguments)))
      else console.log(cyan(`🔧 ${d.name}`) + ' ' + toolArgs(d.name, d.arguments))
      break
    }
    case 'tool/result': {
      const m = d.message ?? {}
      const text = (m.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
      const imgs = (m.content ?? []).filter((x) => x.type === 'image').length
      const tool = callNames.get(m.toolCallId ?? m.source?.callId) ?? ''
      if (m.isError) { st.errors++; console.log(red('   ✗ ' + clip(text, cols()))) }
      else if (/web_search$/.test(tool)) {
        // the search itself: header (which engines answered) and the top links
        const lines = text.split('\n')
        console.log(green('   🔎 ' + clip(lines[0].replace(/^Search: /, ''), cols() - 6)))
        for (let i = 0; i < lines.length; i++) {
          const t = /^(\d+)\. (.*)$/.exec(lines[i])
          if (t && Number(t[1]) <= 6) console.log('      ' + t[1] + '. ' + clip(t[2], 70) + dim('  ' + (lines[i + 1] ?? '').trim()))
        }
        const down = lines.find((l) => l.startsWith('(not answering now'))
        if (down) console.log(dim('      ' + down))
      } else if (/web_fetch$/.test(tool)) console.log(green('   🌐 ') + dim(clip(text, cols() - 6)))
      else console.log(dim('   → ' + clip(text.split('\n').filter(Boolean).slice(0, 2).join(' ⏎ '), cols() - 6) + (imgs ? `  [картинок: ${imgs}]` : '')))
      break
    }
    case 'todo/write': {
      st.todos = d.todos ?? []
      const done = st.todos.filter((t) => t.status === 'completed').length
      console.log(yellow(`📋 план ${done}/${st.todos.length}`))
      for (const t of st.todos) console.log('   ' + (t.status === 'completed' ? green('✔ ') : t.status === 'in_progress' ? yellow('▶ ') : dim('· ')) + (t.status === 'pending' ? dim(t.content) : t.content))
      break
    }
    case 'compaction/start': console.log(yellow('🗜  компакт контекста…')); break
    case 'compaction/end': st.compactions++; console.log(yellow(`🗜  компакт #${st.compactions} готов`)); break
    case 'compaction/prune': st.prunes++; if (live) console.log(dim(`✂  подрезан старый результат инструмента (${d.shadowedTokenCount ?? '?'} ток.)`)); break
    case 'llm/retry': console.log(red('↻ повтор запроса к модели: ' + clip(JSON.stringify(d), 200))); break
  }
}

function speed() {
  try {
    const t = readFileSync(LLAMA_LOG, 'utf8').slice(-20000).match(/\s+eval time =.*?([\d.]+) tokens per second/g)
    return t ? t.at(-1).match(/([\d.]+) tokens per second/)[1] + ' ток/с' : ''
  } catch { return '' }
}

function status() {
  const done = st.todos.filter((t) => t.status === 'completed').length, total = st.todos.length
  const now = st.todos.find((t) => t.status === 'in_progress')?.content
  const idleNow = st.lastEvent ? Date.now() - st.lastEvent : 0
  const el = st.active + Math.min(idleNow, 20 * 60000)
  let eta = ''
  if (done > 0 && total > done) eta = ` · осталось ~${hm((el / done) * (total - done))} (по темпу пунктов плана)`
  const idle = idleNow
  return bold(`── шаг ${st.steps} · план ${done}/${total}${eta} · контекст ${(st.ctx / 1000).toFixed(1)}K/${(st.window / 1000).toFixed(0)}K · компактов ${st.compactions} · инструментов ${st.tools}${st.errors ? ` (ошибок ${st.errors})` : ''} · в работе ${hm(el)} · ${speed()}`) +
    (now ? '\n   ' + yellow('▶ ' + now) : '') + (idle > 120000 ? dim(`  (последнее событие ${hm(idle)} назад: модель думает или работает инструмент)`) : '')
}

// --log: stream the "dsh: reasoning:" lines of a headless run as they arrive
let logOff = 0, inReasoning = false
// --log may be a folder: follow the newest .err / .log file in it (each headless run writes a new one)
function pickLog() {
  if (!logArg || !existsSync(logArg) || !statSync(logArg).isDirectory()) return
  let best = null, t = 0
  for (const f of readdirSync(logArg)) if (/\.(err|log)$/.test(f)) { const m = statSync(join(logArg, f)).mtimeMs; if (m > t) { t = m; best = join(logArg, f) } }
  if (best && best !== logFile) { logFile = best; logOff = Math.max(0, statSync(best).size - 4000); console.log(dim(`(лог: ${best})`)) }
}
function tailLog() {
  pickLog()
  if (!logFile || !existsSync(logFile) || statSync(logFile).isDirectory()) return
  const size = statSync(logFile).size
  if (size < logOff) logOff = 0
  if (size === logOff) return
  const fd = openSync(logFile, 'r'), b = Buffer.alloc(size - logOff)
  readSync(fd, b, 0, b.length, logOff); closeSync(fd)
  const text = b.toString('utf8'), nl = text.lastIndexOf('\n')
  if (nl < 0) return
  logOff += Buffer.byteLength(text.slice(0, nl + 1))
  // reasoning lines of this tick are translated together (one request), then printed in order
  let para = []
  const flush = () => { if (para.length) thought(para.join('\n')); para = [] }
  for (const l of text.slice(0, nl).split('\n')) {
    if (l.startsWith('dsh: reasoning:')) { flush(); inReasoning = true; const r = l.slice(15).trim(); if (r) para.push(r); continue }
    if (l.startsWith('dsh:')) { flush(); inReasoning = false; console.log(red(l)); continue }
    if (inReasoning && l.trim()) para.push(l)
  }
  flush()
}

let file = null, lastStatus = 0
function tick() {
  const f = findSession()
  if (!f) { process.stdout.write(dim('\rжду сессию Harness…')); return }
  if (f !== file) {
    file = f; offset = 0; buf = Buffer.alloc(0)
    // a new session starts from zero: steps, plan, time and context are its own
    Object.assign(st, { active: 0, started: 0, steps: 0, ctx: 0, window: 0, compactions: 0, prunes: 0, todos: [], tools: 0, errors: 0, lastEvent: 0, title: '' })
    const first = readNewEvents(f)
    // catch up quietly unless --from-start, then show the plan and where it is
    for (const e of first) {
      if (fromStart) show(e, false)
      else if (['session', 'request/context', 'session/title', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'compaction/end', 'compaction/prune', 'todo/write'].includes(e.type)) {
        const log = console.log; console.log = () => {}; show(e, false); console.log = log
      }
    }
    if (!fromStart) {
      console.log(bold(`сессия ${st.title ? '«' + st.title + '»' : ''}`) + dim(`  ${f}`))
      if (st.todos.length) show({ type: 'todo/write', data: { todos: st.todos } }, false)
      for (const e of first.slice(-12)) if (['tool/call', 'tool/result'].includes(e.type)) show(e, false)
      if (logFile && existsSync(logFile) && !statSync(logFile).isDirectory()) logOff = Math.max(0, statSync(logFile).size - 4000)
    }
    console.log(status()); lastStatus = Date.now()
    return
  }
  tailLog()
  for (const e of readNewEvents(f)) show(e, true)
  if (Date.now() - lastStatus > 60000) { console.log(status()); lastStatus = Date.now() }
}
process.stdout.write('\x1b]0;Harness — ход работы агента\x07')
tick()
setInterval(tick, 2000)
