// DeepSeek Harness: "read the screen and solve it" for tests, quizzes and game quests.
//   Hotkey (default Ctrl+Alt+S), pressed anywhere, e.g. in a game: the window in front is captured and goes to the
//     Harness chat as an ordinary user message with the picture and the task "read it, solve it, answer first".
//     The answer appears in that chat as usual and, shortened, in a Windows notification, so a game need not be left.
//     The chat is the one used last (where you last sent a message or typed /screen).
//   /screen [question]  from Harness: the window you were in before switching to Harness (the one right behind it).
//   /screen status      hotkey state, thinking level and which chat it sends to.
//   /screen effort low|medium|high|chat   thinking level for screenshots (kept in ~/.afkllm/screen.json);
//   /screen high [question]               this one screenshot at another level.
// Thinking level: a screenshot turn runs at its own level (default low: AFKLLM caps the thinking at 2K tokens, an answer
// in ~5-18 s), then the chat gets its own level back. "chat" leaves the chat's level alone. Measured 2026-11-27 on test /
// quest screenshots: without the cap the level hardly changes the time (5-13 s), but a tricky quest took 9-176 s.
// The picture is stored like a pasted image (Harness attachment store of that chat); the temporary PNG is deleted.
// Capture: capture.ps1 (Windows PowerShell + GDI): the screen area of the window, or the window drawing itself when
// it is behind Harness. Exclusive-fullscreen games may give a black picture: run them borderless/windowed.
// Nothing leaves the PC: the picture goes only to the chat's model (AFKLLM on 127.0.0.1).
// Mount: cordis.patch.yml row { id: screen-afkllm, name: dsh-screen-afkllm, config: { hotkey, prompt, notify, effort } }.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const name = 'screen-afkllm'
export const inject = ['commands', 'attachments']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'capture.ps1')
const SKIP = 'DeepSeek Harness'
const APP_ID = 'com.deepseek.dsh'
const SETTINGS = join(homedir(), '.afkllm', 'screen.json')

export const DEFAULT_PROMPT =
  'На скриншоте — задание с экрана: тест, вопрос, викторина, квест или головоломка. Прочитай весь текст на картинке ' +
  'и реши. Первой строкой дай итог: «Ответ: …» (для вариантов — буква или номер и текст варианта; если вопросов ' +
  'несколько — ответ на каждый). Потом коротко объясни. Если нужного факта не знаешь — поищи в интернете. Если текст ' +
  'не разобрать или задания нет — скажи, что видно на экране. Файлы проекта не трогай.'

const MODS = { ctrl: 2, control: 2, alt: 1, shift: 4, win: 8 }

const EFFORTS = {
  low: 'low', l: 'low', 'низкий': 'low', 'быстро': 'low',
  medium: 'medium', m: 'medium', 'средний': 'medium',
  high: 'high', h: 'high', 'высокий': 'high', 'подробно': 'high',
  chat: 'chat', 'чат': 'chat',
}
export const EFFORT_LABEL = { low: 'low (быстро)', medium: 'medium', high: 'high (дольше)', chat: 'как в чате' }

/** "low" / "низкий" / … → low | medium | high | chat; undefined if the word is no level. */
export function parseEffort(word) {
  return EFFORTS[String(word ?? '').trim().toLowerCase()]
}

/**
 * /screen arguments: "status", "effort [level]", or "[level] [question]".
 * → { cmd: 'status' } | { cmd: 'effort', effort?, bad? } | { cmd: 'shot', effort?, question }
 */
export function parseArgs(raw) {
  const arg = String(raw ?? '').trim()
  if (/^(status|статус)$/i.test(arg)) return { cmd: 'status' }
  const m = /^(effort|уровень)(?:\s+(\S+))?\s*$/i.exec(arg)
  if (m) return m[2] === undefined ? { cmd: 'effort' } : parseEffort(m[2]) ? { cmd: 'effort', effort: parseEffort(m[2]) } : { cmd: 'effort', bad: m[2] }
  const [first, ...rest] = arg.split(/\s+/)
  const effort = parseEffort(first)
  return effort ? { cmd: 'shot', effort, question: rest.join(' ') } : { cmd: 'shot', question: arg }
}

/** "Ctrl+Alt+S" → { mods, vk, label }; throws on an unknown key or no modifier. */
export function parseHotkey(s) {
  let mods = 0
  let vk = 0
  for (const part of String(s).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    const f = /^f([1-9]|1\d|2[0-4])$/.exec(part)
    if (part in MODS) mods |= MODS[part]
    else if (f) vk = 0x6f + Number(f[1])
    else if (/^[a-z0-9]$/.test(part)) vk = part.toUpperCase().charCodeAt(0)
    else throw new Error(`неизвестная клавиша «${part}» в «${s}»`)
  }
  if (!vk) throw new Error(`в «${s}» нет основной клавиши`)
  if (!mods && !(vk >= 0x70 && vk <= 0x87)) throw new Error(`«${s}»: нужен модификатор (Ctrl/Alt/Shift/Win) или клавиша F1-F24`)
  return { mods, vk, label: String(s).split('+').map((p) => p.trim()).join('+') }
}

/** The text that goes with the picture. */
export function buildText({ title, process, how, dark }, question, prompt = DEFAULT_PROMPT) {
  const where = [title && `«${title}»`, process && `(${process})`].filter(Boolean).join(' ')
  const lines = [`[Скриншот${how === 'hotkey' ? ' по горячей клавише' : ''}${where ? `: окно ${where}` : ''}]`, prompt]
  if (question?.trim()) lines.push(`Вопрос пользователя: ${question.trim()}`)
  if (dark) lines.push('(Картинка почти чёрная: окно, похоже, не отдало изображение. Скажи об этом пользователю.)')
  return lines.join('\n')
}

/** First answer line for a notification: "Ответ: ..." when present, else the start of the text. */
export function answerSnippet(text, max = 180) {
  const plain = String(text ?? '').replace(/[#*`_>|]/g, '').trim()
  const line = plain.split(/\r?\n/).find((l) => /^\s*ответ\s*[:：]/i.test(l)) ?? plain
  const one = line.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * A screenshot turn at its own thinking level (agent.model.select: this chat only, the default for new chats stays).
 * Per chat { prev, ours, waiting }: waiting = the chat was busy, so the level is set when its current turn ends (the
 * screenshot turn comes next); otherwise the chat's own level comes back when the screenshot turn ends, unless the
 * user picked another one meanwhile.
 */
export function createLevels() {
  const chats = new Map()
  const same = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
  const select = (agent, sel) => { try { agent.model.select(sel) } catch { /* the chat keeps its level */ } }
  return {
    use(agent, level) {
      if (!level || level === 'chat' || typeof agent?.model?.current !== 'function') return
      const cur = agent.model.current()
      if (!cur) return
      const st = chats.get(agent.session)
      if (!st && cur.reasoningEffort === level) return
      const ours = { provider: cur.provider, model: cur.model, reasoningEffort: level }
      const waiting = st ? st.waiting : agent.status === 'running'
      chats.set(agent.session, { prev: st ? st.prev : cur, ours, waiting })
      if (!waiting) select(agent, ours)
    },
    turnEnded(session, agent) {
      const st = chats.get(session)
      if (!st) return
      if (!agent) { chats.delete(session); return }
      if (st.waiting) { st.waiting = false; select(agent, st.ours); return }
      chats.delete(session)
      if (same(agent.model.current(), st.ours)) select(agent, st.prev)
    },
  }
}

const xmlEsc = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

function toast(title, body) {
  if (process.platform !== 'win32') return
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual></toast>`
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml.replaceAll("'", "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('\n')
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', detached: true })
    p.on('error', () => {})
    p.unref()
  } catch { /* no notification, nothing else breaks */ }
}

const psArgs = (args) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT, ...args]

/** One capture of the window behind Harness. */
function captureOnce(outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', psArgs(['-Mode', 'once', '-OutDir', outDir, '-Skip', SKIP]), { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('error', reject)
    p.on('close', () => {
      const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      try { resolve(JSON.parse(line)) } catch { reject(new Error((err || out || 'нет ответа').trim().slice(0, 300))) }
    })
  })
}

export function apply(ctx, config = {}) {
  const opt = {
    hotkey: config.hotkey === false ? null : (config.hotkey ?? 'Ctrl+Alt+S'),
    prompt: config.prompt ?? DEFAULT_PROMPT,
    notify: config.notify !== false,
  }
  /** screenshot thinking level: /screen effort (screen.json) > config.effort > low */
  let effort = parseEffort(config.effort) ?? 'low'
  try { effort = parseEffort(JSON.parse(readFileSync(SETTINGS, 'utf8')).effort) ?? effort } catch { /* no file yet */ }
  const saveEffort = (e) => {
    effort = e
    try { mkdirSync(dirname(SETTINGS), { recursive: true }); writeFileSync(SETTINGS, JSON.stringify({ effort: e }, null, 2)) } catch { /* kept for this run */ }
  }
  const levels = createLevels()
  const outDir = join(tmpdir(), 'afkllm-screen')
  /** live top-level agents (one per open chat) */
  const agents = new Set()
  /** the chat the hotkey sends to: where the user last sent something */
  let target = null
  /** sessions waiting for an answer to a screenshot, for the notification */
  const pending = new Set()
  const lastText = new WeakMap()
  let hotkeyState = opt.hotkey ? 'запускается' : 'выключена в настройках'

  const isSub = (agent) => agent?.session?.header?.origin === 'subagent'
  const agentOf = (session) => [...agents].find((a) => a.session === session)

  ctx.on('agent/created', ({ agent }) => { if (agent && !isSub(agent)) { agents.add(agent); target ??= agent } })
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent)
    if (target === agent) target = [...agents].pop() ?? null
  })
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      const a = agentOf(session)
      if (a) target = a
    } else if (event?.type === 'assistant/message') {
      const t = (event.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
      if (t) lastText.set(session, t)
    }
    if (event?.type === 'turn/end') levels.turnEnded(session, agentOf(session))
    if (event?.type === 'turn/end' && pending.has(session)) {
      pending.delete(session)
      if (!opt.notify) return
      const kind = event.data?.kind ?? event.data?.end?.kind
      if (kind === 'aborted') return
      toast(kind === 'error' ? 'Скриншот: ошибка' : 'Скриншот: готово', answerSnippet(lastText.get(session)) || 'Ответ в чате Harness.')
    }
  })

  /** Picture file → this chat's attachment store → a user message that starts the turn. */
  const send = async (agent, cap, question, how, level = effort) => {
    let data
    try { data = readFileSync(cap.path) } finally { try { rmSync(cap.path, { force: true }) } catch { /* temp dir */ } }
    const [ref] = await ctx.attachments.saveImages([{ data, mediaType: 'image/png' }])
    const text = buildText({ ...cap, how }, question, opt.prompt)
    pending.add(agent.session)
    levels.use(agent, level)
    agent.followup(Object.freeze({
      role: 'user', id: randomUUID(), source: { kind: 'user' },
      content: [{ type: 'text', text }, { type: 'image', attachment: ref }],
    }))
  }

  // --- the hotkey: a hidden helper process that lives as long as Harness
  if (opt.hotkey && process.platform === 'win32') {
    ctx.effect(() => {
      let hk
      try { hk = parseHotkey(opt.hotkey) } catch (e) { hotkeyState = `ошибка настройки: ${e.message}`; return () => {} }
      mkdirSync(outDir, { recursive: true })
      let child = null
      let stopped = false
      const start = () => {
        child = spawn('powershell.exe', psArgs(['-Mode', 'hotkey', '-Mods', String(hk.mods), '-Vk', String(hk.vk),
          '-OutDir', outDir, '-ParentPid', String(process.pid), '-Skip', SKIP]), { windowsHide: true })
        child.on('error', (e) => { hotkeyState = `не запустилась: ${e.message}` })
        child.stderr.on('data', () => {})
        createInterface({ input: child.stdout }).on('line', async (line) => {
          let m
          try { m = JSON.parse(line) } catch { return }
          if (m.ready) { hotkeyState = `${hk.label} работает`; return }
          if (m.error === 'hotkey') { hotkeyState = `${hk.label} занята другой программой (${m.detail}); поменяйте hotkey в cordis.patch.yml`; return }
          if (m.error) { toast('Скриншот не получился', String(m.detail ?? m.error)); return }
          const agent = target && agents.has(target) ? target : null
          if (!agent) {
            try { rmSync(m.path, { force: true }) } catch { /* temp */ }
            toast('Скриншот: нет чата', 'Откройте чат в Harness и отправьте в нём любое сообщение или /screen, затем снова нажмите клавишу.')
            return
          }
          try {
            await send(agent, m, '', 'hotkey')
            if (opt.notify) toast('Скриншот отправлен', `${m.title || m.process || 'окно'} — модель читает и решает (${EFFORT_LABEL[effort]}), ответ придёт сюда и в чат.`)
          } catch (e) {
            toast('Скриншот не отправлен', e.message)
          }
        })
        child.on('exit', (code) => {
          if (stopped) return
          if (!/занята|ошибка/.test(hotkeyState)) hotkeyState = `помощник завершился (код ${code})`
        })
      }
      start()
      return () => { stopped = true; try { child?.kill() } catch { /* gone */ } }
    })
  } else if (opt.hotkey) {
    hotkeyState = 'только в Windows'
  }

  // --- /screen
  const screen = async ({ rawInput, agent }) => {
    const a = parseArgs(rawInput)
    if (agent && !isSub(agent)) { agents.add(agent); target = agent }
    if (a.cmd === 'status') {
      return { kind: 'success', text: `Горячая клавиша: ${hotkeyState}. Уровень размышлений для скринов: ${EFFORT_LABEL[effort]}. Скрины по клавише идут в этот чат (последний, где вы писали).` }
    }
    if (a.cmd === 'effort') {
      if (a.bad) return { kind: 'error', text: `«${a.bad}» — не уровень. Варианты: low, medium, high, chat (как в чате).` }
      if (a.effort) saveEffort(a.effort)
      return { kind: 'success', text: `Уровень размышлений для скринов: ${EFFORT_LABEL[effort]}${a.effort ? ' (сохранён)' : ''}. low — быстрый ответ (размышление до ~2K токенов), medium — до ~4K, high — без ограничения, chat — уровень этого чата. Разово: /screen high [вопрос].` }
    }
    if (process.platform !== 'win32') return { kind: 'error', text: 'Захват экрана сделан только для Windows.' }
    if (!agent) return { kind: 'error', text: 'Нет чата для скриншота.' }
    mkdirSync(outDir, { recursive: true })
    let cap
    try { cap = await captureOnce(outDir) } catch (e) { return { kind: 'error', text: `Скриншот не получился: ${e.message}` } }
    if (cap.error === 'no-window') return { kind: 'error', text: 'Кроме Harness нет открытых окон: откройте тест или игру и повторите (или нажмите горячую клавишу прямо в ней).' }
    if (cap.error) return { kind: 'error', text: `Скриншот не получился: ${cap.detail ?? cap.error}` }
    try { await send(agent, cap, a.question, 'command', a.effort ?? effort) } catch (e) { return { kind: 'error', text: `Скриншот снят, но не отправлен: ${e.message}` } }
    return { kind: 'success', text: `Снято окно «${cap.title || cap.process}» (${cap.width}x${cap.height})${cap.dark ? ', картинка почти чёрная' : ''}, уровень ${EFFORT_LABEL[a.effort ?? effort]}. Горячая клавиша: ${hotkeyState}.` }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'screen',
      description: 'Скриншот окна за Harness: модель читает задание и отвечает (из игры — горячая клавиша, по умолчанию Ctrl+Alt+S)',
      input: { hint: '[low|medium|high] [вопрос] | effort <уровень> | status' },
      handler: screen,
    })
  }, 'screen-afkllm')
}
