// DeepSeek Harness slash commands for private, fully local image generation:
//   /image [WxH] [seed=N] <prompt>   the prompt goes as written straight to AFKLLM's image generator (afk api on this
//                                    PC, MCP tool generate_image = Qwen-Image 2.1 in ComfyUI, with the GPU swap), not
//                                    through the language model: nothing rewritten, nothing refused, no model tokens.
//                                    A prompt in Russian is first translated to English on this PC (afk api offline
//                                    translator, CPU): Qwen-Image follows English prompts much better. The English
//                                    text is shown in the command's reply (user's choice, 2026-11-23), so it is in
//                                    that chat's session file until the chat is deleted in Harness; the translator
//                                    itself does not cache it.
//   /image-clean                     deletes the pictures made with /image in THIS chat (each chat has its own folder
//                                    outDir/chat-<session id>), their Windows "Recent" shortcuts and ComfyUI copies
//                                    named after them; other chats' pictures are not touched.
//   /image-clean all                 the same for every chat, plus pictures from before per-chat folders and any
//                                    ComfyUI leftovers. The translator keeps no prompts, so it is not involved.
// Traces avoided up front: outDir is marked "not content indexed" (no Windows Search entries); opening the picture
// through its default app adds no "Recent" item (checked 2026-11-23 with Windows Photo Viewer); a "Recent" shortcut
// made by opening the file from Explorer is what /image-clean removes. Explorer's thumbnail cache (thumbcache_*.db)
// is shared by all pictures and locked while Explorer runs: it is not touched (entries age out).
// Privacy: the typed prompt is not written to the Harness session log (recordInput: false; only the English
// translation of a Russian prompt is, in the reply, see above), not shown in the afk api console
// (private flag), not stored inside the PNG (afk strips the metadata) and no copy stays in ComfyUI's output folder.
// Nothing leaves the PC: the only connection is to 127.0.0.1. Pictures go to outDir (default ~/.afkllm/private-images,
// outside the Pictures library, OneDrive and the Photos gallery) and open in the default viewer unless open: false.
// The agent keeps its own generate_image tool for images it needs during a task (UI, sprites); that path is unchanged.
// Mount: cordis.patch.yml row { id: image-command-afkllm, name: dsh-image-afkllm }.
// Config: { baseURL } (default http://127.0.0.1:18300, env AFKLLM_URL), { outDir }, { open } (default true),
//         { translate } (default true: Russian prompts → English before generation).

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'image-command-afkllm'
export const inject = ['commands']

const USAGE = 'Использование: /image [ШИРИНАxВЫСОТА] [seed=N] промпт (по-русски или по-английски; размер 256-2048, кратно 16; по умолчанию 1024x1024)'

/** `/image 1024x1536 seed=7 a lighthouse at dusk` → { width, height, seed, prompt } */
export function parseInput(raw) {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const out = { width: 1024, height: 1024, seed: undefined, prompt: '' }
  while (words.length) {
    const w = words[0]
    const size = /^(\d{3,4})[xх×](\d{3,4})$/i.exec(w)
    const seed = /^seed=(\d+)$/i.exec(w)
    if (size) { out.width = Number(size[1]); out.height = Number(size[2]); words.shift() }
    else if (seed) { out.seed = Number(seed[1]); words.shift() }
    else break
  }
  out.prompt = words.join(' ')
  return out
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** One MCP tools/call over Streamable HTTP (stateless afk api /mcp); the answer is an SSE stream ending in the result. */
function callTool(baseURL, toolName, args, signal) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }))
    const url = new URL('/mcp?images=path', baseURL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return reject(new Error(`отказ: ${url.origin} — не этот ПК`))
    // no client timeout: an image takes 1-3 min (the language model leaves the GPU and comes back)
    const req = request(url, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': body.length },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) return reject(new Error(`afk api /mcp ответил HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
        // SSE: "data: {json}" lines; plain JSON when the server answers without a stream
        const msgs = text.trimStart().startsWith('{') ? [text] : text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
        for (const m of msgs.reverse()) {
          let j
          try { j = JSON.parse(m) } catch { continue }
          if (j.id !== 1) continue
          if (j.error) return reject(new Error(j.error.message ?? JSON.stringify(j.error)))
          return resolve(j.result)
        }
        reject(new Error(`afk api /mcp: в ответе нет результата: ${text.slice(0, 300)}`))
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** POST JSON to afk api on this PC (no timeout: the translator may need a few seconds to start). */
function postJson(baseURL, path, payload, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseURL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return reject(new Error(`отказ: ${url.origin} — не этот ПК`))
    const body = Buffer.from(JSON.stringify(payload))
    const req = request(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let j
        try { j = JSON.parse(text) } catch { return reject(new Error(`HTTP ${res.statusCode}`)) }
        if (res.statusCode !== 200) return reject(new Error(j?.error ?? `HTTP ${res.statusCode}`))
        resolve(j)
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

export const hasCyrillic = (s) => /[Ѐ-ӿ]/.test(s)

/** Russian → English through afk api's offline translator; the text never leaves 127.0.0.1 and is not cached. */
export async function toEnglish(baseURL, prompt, signal, post = postJson) {
  if (!hasCyrillic(prompt)) return prompt
  const j = await post(baseURL, '/translate/translatetext?from=ru&to=en', [prompt], signal)
  const text = j?.[0]?.translations?.[0]?.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('переводчик вернул пустой ответ')
  return text
}

function openFile(path) {
  try {
    const p = spawn('cmd.exe', ['/c', 'start', '', path], { detached: true, stdio: 'ignore', windowsHide: true })
    p.on('error', () => {})
    p.unref()
  } catch { /* the path is in the message anyway */ }
}

/** The folder of one chat's pictures: `chat-<session id>` (filesystem-safe). */
export function chatFolder(agent) {
  const id = String(agent?.session?.id ?? 'unknown').replace(/^session-/, '').replace(/[^\w.-]/g, '_').slice(0, 80)
  return `chat-${id}`
}

function listDir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** Delete matching files in dir; returns how many. */
function removeFiles(dir, match) {
  let n = 0
  let names = []
  try { names = readdirSync(dir) } catch { return 0 }
  for (const f of names) {
    if (!match(f)) continue
    try { rmSync(join(dir, f), { force: true, recursive: true }); n++ } catch { /* in use: reported by the count */ }
  }
  return n
}

export function apply(ctx, config = {}) {
  const baseURL = config.baseURL ?? process.env.AFKLLM_URL ?? 'http://127.0.0.1:18300'
  const outDir = config.outDir ?? join(homedir(), '.afkllm', 'private-images')
  const open = config.open !== false
  const translate = config.translate !== false

  const recentDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent')
  const comfyOut = config.comfyOutDir ?? join(homedir(), '.afkllm', 'comfy-output')
  // keep the pictures out of the Windows Search index (file names and image properties would land in its database);
  // files and chat folders created inside inherit the "not content indexed" attribute
  let indexOff = false
  const noIndex = () => {
    if (indexOff || process.platform !== 'win32') return
    indexOff = true
    try { spawn('attrib.exe', ['+I', outDir], { stdio: 'ignore', windowsHide: true }).on('error', () => {}) } catch { /* best effort */ }
  }

  const image = async ({ rawInput, signal, agent }) => {
    const a = parseInput(rawInput ?? '')
    if (!a.prompt) return { kind: 'error', text: USAGE }
    if ([a.width, a.height].some((v) => v < 256 || v > 2048 || v % 16)) return { kind: 'error', text: `Размер ${a.width}x${a.height} не подходит. ${USAGE}` }
    // one folder per chat, so /image-clean can delete exactly this chat's pictures
    mkdirSync(outDir, { recursive: true })
    noIndex()
    const dir = join(outDir, chatFolder(agent))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `img-${stamp()}.png`)
    const t0 = Date.now()
    let prompt
    try {
      prompt = translate ? await toEnglish(baseURL, a.prompt, signal) : a.prompt
    } catch (e) {
      if (signal?.aborted) return { kind: 'error', text: 'Генерация отменена.' }
      // the reason only: never the prompt (the result text goes to the session log)
      return { kind: 'error', text: `Не получилось перевести промпт на английский: ${e.message}. Напишите промпт по-английски или запустите scripts\\mt-setup.cmd.` }
    }
    let r
    try {
      r = await callTool(baseURL, 'generate_image', {
        prompt, file_path: file, width: a.width, height: a.height, private: true,
        ...(a.seed !== undefined ? { seed: a.seed } : {}),
      }, signal)
    } catch (e) {
      if (signal?.aborted) return { kind: 'error', text: 'Генерация отменена.' }
      return { kind: 'error', text: `Не получилось: ${e.message}. Работает ли окно "AFKLLM: прокси" (afk api)?` }
    }
    if (r?.isError) {
      const msg = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      return { kind: 'error', text: `Генератор вернул ошибку: ${msg || 'без текста'}` }
    }
    const seed = /seed (\d+)/.exec((r?.content ?? []).map((c) => c.text ?? '').join(' '))?.[1]
    if (open) openFile(file)
    const secs = Math.round((Date.now() - t0) / 1000)
    // the result text is logged by the session: size, seed, time, path, and the English prompt only when it was a
    // translation (the typed prompt itself is never echoed)
    const translated = prompt !== a.prompt ? `\nПромпт для модели (перевод): ${prompt}` : ''
    return { kind: 'success', text: `Готово за ${secs} с: ${file} (${a.width}x${a.height}${seed ? `, seed ${seed}` : ''})${open ? ', открыто в просмотрщике' : ''}. Удалить картинки этого чата: /image-clean${translated}` }
  }

  // /image-clean      this chat's pictures (its folder) and their "Recent" shortcuts; other chats are not touched
  // /image-clean all  every chat's pictures, pictures from before per-chat folders, ComfyUI leftovers, all shortcuts
  // The translator is not touched: it never keeps Russian → English (prompt) translations, and its English → Russian
  // cache holds no chat's data (Harness stores each chat's reasoning translations inside that chat).
  const clean = async ({ rawInput, agent }) => {
    const arg = (rawInput ?? '').trim().toLowerCase()
    if (arg && arg !== 'all') return { kind: 'error', text: 'Использование: /image-clean (картинки этого чата) или /image-clean all (все)' }
    if (arg === 'all') {
      let pics = 0
      for (const d of listDir(outDir)) {
        const p = join(outDir, d)
        // pictures from before per-chat folders lie in outDir itself
        if (/\.png$/i.test(d)) { pics += removeFiles(outDir, (f) => f === d); continue }
        if (!/^chat-/.test(d)) continue
        pics += removeFiles(p, (f) => /\.png$/i.test(f))
        try { rmSync(p, { recursive: true, force: true }) } catch { /* in use */ }
      }
      const comfy = removeFiles(comfyOut, (f) => /^afk_.*\.png$/i.test(f))
      const recent = removeFiles(recentDir, (f) => /^img-\d{8}-\d{6}\.png\.lnk$/i.test(f) || /^private-images\.lnk$/i.test(f) || /^chat-[\w.-]+\.lnk$/i.test(f))
      return {
        kind: 'success',
        text: `Удалено во всех чатах: картинок ${pics} (${outDir}), копий ComfyUI ${comfy}, ярлыков «Недавние» ${recent}. ` +
          'Переведённые промпты из ответов /image остаются в своих чатах: удалите их в списке сессий Harness.',
      }
    }
    const folder = chatFolder(agent)
    const dir = join(outDir, folder)
    const names = listDir(dir).filter((f) => /\.png$/i.test(f))
    const pics = removeFiles(dir, (f) => /\.png$/i.test(f))
    try { if (!listDir(dir).length) rmSync(dir, { recursive: true, force: true }) } catch { /* in use */ }
    const own = new Set(names.map((n) => `${n}.lnk`.toLowerCase()))
    const recent = removeFiles(recentDir, (f) => own.has(f.toLowerCase()) || f.toLowerCase() === `${folder}.lnk`.toLowerCase())
    // ComfyUI's copy is named afk_<chat folder>_<file> by afk api (normally deleted right away; left only by a crash)
    const comfy = removeFiles(comfyOut, (f) => f.toLowerCase().startsWith(`afk_${folder}_`.toLowerCase()) && /\.png$/i.test(f))
    return {
      kind: 'success',
      text: `Удалено в этом чате: картинок ${pics}, копий ComfyUI ${comfy}, ярлыков «Недавние» ${recent}. Картинки других чатов не тронуты ` +
        '(все сразу: /image-clean all). Переведённые промпты из ответов /image остаются в чате: удалите его в списке сессий Harness.',
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'image',
      description: 'Картинка по промпту как есть, без языковой модели, локально (Qwen-Image через afk api)',
      input: { hint: '[1024x1024] [seed=N] <prompt>' },
      // the prompt is not written to the session log
      recordInput: false,
      handler: image,
    })
    yield ctx.commands.register({
      name: 'image-clean',
      description: 'Удалить картинки /image этого чата, их копии ComfyUI и ярлыки «Недавние» (all: всех чатов)',
      input: { hint: '[all]' },
      recordInput: false,
      handler: clean,
    })
  }, 'image-command-afkllm')
}
