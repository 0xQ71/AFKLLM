// DeepSeek Harness slash commands for private, fully local image generation:
//   /image [WxH] [seed=N] <prompt>   the prompt goes as written straight to AFKLLM's image generator (afk api on this
//                                    PC, MCP tool generate_image = Qwen-Image 2.1 in ComfyUI, with the GPU swap), not
//                                    through the language model: nothing rewritten, nothing refused, no model tokens.
//   /image-clean                     deletes every picture made with /image, their Windows "Recent" shortcuts and any
//                                    leftover copies in ComfyUI's output folder.
// Privacy: the prompt is not written to the Harness session log (recordInput: false), not shown in the afk api console
// (private flag), not stored inside the PNG (afk strips the metadata) and no copy stays in ComfyUI's output folder.
// Nothing leaves the PC: the only connection is to 127.0.0.1. Pictures go to outDir (default ~/.afkllm/private-images,
// outside the Pictures library, OneDrive and the Photos gallery) and open in the default viewer unless open: false.
// The agent keeps its own generate_image tool for images it needs during a task (UI, sprites); that path is unchanged.
// Mount: cordis.patch.yml row { id: image-command-afkllm, name: dsh-image-afkllm }.
// Config: { baseURL } (default http://127.0.0.1:18300, env AFKLLM_URL), { outDir }, { open } (default true).

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'image-command-afkllm'
export const inject = ['commands']

const USAGE = 'Использование: /image [ШИРИНАxВЫСОТА] [seed=N] промпт на английском (размер 256-2048, кратно 16; по умолчанию 1024x1024)'

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

function openFile(path) {
  try {
    const p = spawn('cmd.exe', ['/c', 'start', '', path], { detached: true, stdio: 'ignore', windowsHide: true })
    p.on('error', () => {})
    p.unref()
  } catch { /* the path is in the message anyway */ }
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

  const image = async ({ rawInput, signal }) => {
    const a = parseInput(rawInput ?? '')
    if (!a.prompt) return { kind: 'error', text: USAGE }
    if ([a.width, a.height].some((v) => v < 256 || v > 2048 || v % 16)) return { kind: 'error', text: `Размер ${a.width}x${a.height} не подходит. ${USAGE}` }
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, `img-${stamp()}.png`)
    const t0 = Date.now()
    let r
    try {
      r = await callTool(baseURL, 'generate_image', {
        prompt: a.prompt, file_path: file, width: a.width, height: a.height, private: true,
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
    // the result text (logged by the session) carries no prompt: size, seed, time, path
    return { kind: 'success', text: `Готово за ${secs} с: ${file} (${a.width}x${a.height}${seed ? `, seed ${seed}` : ''})${open ? ', открыто в просмотрщике' : ''}. Удалить все: /image-clean` }
  }

  const clean = async ({ rawInput }) => {
    if ((rawInput ?? '').trim()) return { kind: 'error', text: 'Использование: /image-clean (без аргументов)' }
    const pics = removeFiles(outDir, (f) => /\.png$/i.test(f))
    const comfy = removeFiles(join(homedir(), '.afkllm', 'comfy-output'), (f) => /^afk_.*\.png$/i.test(f))
    const recent = removeFiles(join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent'),
      (f) => /^img-\d{8}-\d{6}\.png\.lnk$/i.test(f) || /^private-images\.lnk$/i.test(f))
    return {
      kind: 'success',
      text: `Удалено: картинок ${pics} (${outDir}), копий ComfyUI ${comfy}, ярлыков «Недавние» ${recent}. ` +
        'Сессию с командами удалите в списке сессий Harness (промпты в её лог не записывались).',
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
      description: 'Удалить все картинки /image, их ярлыки «Недавние» и копии ComfyUI',
      recordInput: false,
      handler: clean,
    })
  }, 'image-command-afkllm')
}
