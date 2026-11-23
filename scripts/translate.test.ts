// Offline translator plumbing (src/core/translate.ts) against a fake mt-server, and the /image prompt translation
// helper of harness/dsh-image-afkllm. No models needed: run with `npm run test:translate`.
// The real worker (scripts/mt-server.py) is checked by scripts\mt-setup.cmd's self-test.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { startLanProxy } from '../src/core/server'
import { TranslatorWorker, translateRoutes, translatorMissing, type TranslatorConfig } from '../src/core/translate'
// @ts-expect-error plain JS plugin without type declarations
import { apply as applyImage, hasCyrillic, toEnglish } from '../harness/dsh-image-afkllm/index.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const servers: Server[] = []
after(() => { for (const s of servers) s.close() })

function listen(s: Server): Promise<number> {
  servers.push(s)
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
}

/** A stand-in for mt-server.py: echoes "<to>:<text>" and records what it got. */
async function fakeWorker() {
  const seen: { url: string; body: string }[] = []
  const port = await listen(createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/health') return res.end('{"ok":true}')
      if (req.url === '/forget') return res.end('{"ok":true}')
      const to = new URL(req.url ?? '/', 'http://x').searchParams.get('to')
      res.end(JSON.stringify((JSON.parse(body) as string[]).map((t) => ({ translations: [{ text: `${to}:${t}`, to }] }))))
    })
  }))
  return { port, seen }
}

const cfg = (port: number): TranslatorConfig => ({ python: 'nope.exe', scripts: ['nope.py'], models: { 'en-ru': 'nope' }, port, threads: 1 })

test('translatorMissing names what is not installed', () => {
  const miss = translatorMissing(cfg(1))
  assert.deepEqual(miss, ['nope.exe', 'nope.py', 'nope'])
})

test('afk api forwards the Bing-protocol request to the worker, query included, and /translate/forget', async () => {
  const w = await fakeWorker()
  const proxy = await startLanProxy({ listenPort: 0, upstreamPort: 1, routes: translateRoutes(new TranslatorWorker(cfg(w.port))) })
  try {
    const base = `http://127.0.0.1:${proxy.port}`
    const r = await fetch(`${base}/translate/translatetext?to=ru&isEnterpriseClient=false`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(['Hello']),
    })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), [{ translations: [{ text: 'ru:Hello', to: 'ru' }] }])
    assert.ok(w.seen.some((s) => s.url === '/translate/translatetext?to=ru&isEnterpriseClient=false' && s.body === '["Hello"]'))
    const f = await fetch(`${base}/translate/forget`, { method: 'POST' })
    assert.equal(f.status, 200)
    assert.ok(w.seen.some((s) => s.url === '/forget'))
  } finally {
    proxy.stop()
  }
})

test('not installed and not running → 503 with the reason, nothing started', async () => {
  const proxy = await startLanProxy({ listenPort: 0, upstreamPort: 1, routes: translateRoutes(new TranslatorWorker(cfg(9))) })
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/translate/translatetext?to=ru`, { method: 'POST', body: '["x"]' })
    assert.equal(r.status, 503)
    assert.match((await r.json() as { error: string }).error, /mt-setup/)
    // forget never starts the worker
    const f = await fetch(`http://127.0.0.1:${proxy.port}/translate/forget`, { method: 'POST' })
    assert.deepEqual(await f.json(), { ok: true, running: false })
  } finally {
    proxy.stop()
  }
})

test('/image: Russian prompts go through ru→en, English ones are left alone', async () => {
  assert.equal(hasCyrillic('рассвет над озером'), true)
  assert.equal(hasCyrillic('a lighthouse at dusk'), false)
  const calls: string[] = []
  const post = async (_base: string, path: string, payload: string[]) => {
    calls.push(path)
    return [{ translations: [{ text: `EN(${payload[0]})` }] }]
  }
  assert.equal(await toEnglish('http://127.0.0.1:1', 'a lighthouse at dusk', undefined, post), 'a lighthouse at dusk')
  assert.equal(calls.length, 0)
  assert.equal(await toEnglish('http://127.0.0.1:1', 'маяк на закате', undefined, post), 'EN(маяк на закате)')
  assert.deepEqual(calls, ['/translate/translatetext?from=ru&to=en'])
  await assert.rejects(toEnglish('http://127.0.0.1:1', 'маяк', undefined, async () => [{ translations: [{ text: ' ' }] }]), /пустой/)
})

test('/image handler: Russian prompt → English to the generator, the translation (not the typed text) in the reply', async () => {
  const got: { path: string; body: string }[] = []
  const port = await listen(createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      got.push({ path: req.url ?? '', body })
      if ((req.url ?? '').startsWith('/translate/translatetext')) {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify([{ translations: [{ text: 'lighthouse at sunset', to: 'en' }] }]))
      }
      if ((req.url ?? '').startsWith('/translate/forget')) return res.end('{"ok":true}')
      // /mcp tools/call → SSE with the result
      res.setHeader('content-type', 'text/event-stream')
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'saved, seed 7' }] } })}\n\n`)
    })
  }))
  const out = mkdtempSync(join(tmpdir(), 'afk-img-'))
  try {
    const cmds: Record<string, (i: { rawInput: string; agent?: unknown }) => Promise<{ kind: string; text: string }>> = {}
    const ctx = { effect: (gen: () => Generator) => { for (const _ of gen()) { /* registrations */ } }, commands: { register: (c: { name: string; handler: never }) => { cmds[c.name] = c.handler; return () => {} } } }
    const comfyOut = join(out, 'comfy'); mkdirSync(comfyOut)
    applyImage(ctx, { baseURL: `http://127.0.0.1:${port}`, outDir: join(out, 'pics'), comfyOutDir: comfyOut, open: false })
    const chatA = { session: { id: 'session-aaa' } }, chatB = { session: { id: 'session-bbb' } }
    const r = await cmds.image({ rawInput: '512x512 маяк на закате', agent: chatA })
    assert.equal(r.kind, 'success', r.text)
    assert.match(r.text, /Промпт для модели \(перевод\): lighthouse at sunset/)
    assert.doesNotMatch(r.text, /маяк/)
    const mcp = got.find((g) => g.path.startsWith('/mcp'))!
    assert.equal(JSON.parse(mcp.body).params.arguments.prompt, 'lighthouse at sunset')
    // an English prompt is passed as is and not echoed
    const r2 = await cmds.image({ rawInput: 'a red fox', agent: chatB })
    assert.doesNotMatch(r2.text, /Промпт для модели/)
    assert.equal(got.filter((g) => g.path.startsWith('/translate/translatetext')).length, 1)
    // /image-clean does not touch the translator (it holds no prompts and no chat's data)
    // the fake generator does not write files: put this chat's picture, the other chat's and ComfyUI copies in place
    writeFileSync(join(out, 'pics', 'chat-aaa', 'img-1.png'), 'x')
    writeFileSync(join(out, 'pics', 'chat-bbb', 'img-2.png'), 'x')
    writeFileSync(join(comfyOut, 'afk_chat-aaa_img-1_00001_.png'), 'x')
    writeFileSync(join(comfyOut, 'afk_chat-bbb_img-2_00001_.png'), 'x')
    const before = got.length
    const c = await cmds['image-clean']({ rawInput: '', agent: chatA })
    assert.equal(c.kind, 'success')
    assert.match(c.text, /картинок 1, копий ComfyUI 1/)
    assert.equal(got.length, before)
    assert.equal(existsSync(join(out, 'pics', 'chat-aaa')), false)
    assert.equal(existsSync(join(out, 'pics', 'chat-bbb', 'img-2.png')), true)
    assert.equal(existsSync(join(comfyOut, 'afk_chat-bbb_img-2_00001_.png')), true)
    const all = await cmds['image-clean']({ rawInput: 'all', agent: chatA })
    assert.match(all.text, /во всех чатах: картинок 1 \(.*\), копий ComfyUI 1/)
    assert.equal(existsSync(join(out, 'pics', 'chat-bbb')), false)
    assert.equal((await cmds['image-clean']({ rawInput: 'everything', agent: chatA })).kind, 'error')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('ComfyUI copy is named after the chat folder and the file', async () => {
  const { comfyPrefix } = await import('../src/core/imagegen')
  assert.equal(comfyPrefix(join(tmpdir(), 'private-images', 'chat-e5fb', 'img-20261123-221500.png')), 'afk_chat-e5fb_img-20261123-221500')
  assert.equal(comfyPrefix(join(tmpdir(), 'assets', 'hero bg.png')), 'afk_assets_hero_bg')
})
