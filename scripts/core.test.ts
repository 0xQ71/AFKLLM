// Model-free checks for the headless core and CLI plumbing: tools, permissions, diff, key parsing,
// and a full agent loop against a scripted fake llama-server.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Agent, parseArgs, recoverTextToolCalls } from '../src/core/agent'
import { lineDiff } from '../src/core/diff'
import { LlmClient } from '../src/core/llm'
import { PermissionPolicy, dangerousReason } from '../src/core/permissions'
import { BackgroundJobs } from '../src/core/shell'
import { ALL_TOOLS, toolByName, type ToolContext } from '../src/core/tools'
import type { AgentEvent, ToolOutcome } from '../src/core/types'
import { KeyParser, LineEditor } from '../src/cli/tui'

const dir = mkdtempSync(join(tmpdir(), 'afk-core-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function ctx(): ToolContext {
  return { cwd: dir, readState: new Map(), todos: [], bg: new BackgroundJobs(join(dir, '.afkllm', 'bg')) }
}

async function call(name: string, args: Record<string, unknown>, c = ctx()): Promise<ToolOutcome> {
  const p = await toolByName(name)!.plan(args, c)
  return 'execute' in p ? p.execute() : p
}

test('Write → Read → Edit keeps CRLF and requires a prior Read', async () => {
  const c = ctx()
  writeFileSync(join(dir, 'a.txt'), 'one\r\ntwo\r\nthree\r\n')
  const blind = await call('Edit', { file_path: 'a.txt', old_string: 'two', new_string: 'TWO' }, c)
  assert.equal(blind.ok, false)
  assert.match(blind.output, /not Read it/)
  const r = await call('Read', { file_path: 'a.txt' }, c)
  assert.ok(r.ok)
  assert.match(r.output, /2\ttwo/)
  const e = await call('Edit', { file_path: 'a.txt', old_string: 'two', new_string: 'TWO' }, c)
  assert.ok(e.ok, e.output)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n')
  assert.equal(e.diff?.added, 1)
  assert.equal(e.diff?.removed, 1)
})

test('Edit: ambiguous match refused, loose whitespace match accepted', async () => {
  const c = ctx()
  writeFileSync(join(dir, 'b.ts'), 'function f() {\n    return 1\n}\nfunction g() {\n    return 1\n}\n')
  await call('Read', { file_path: 'b.ts' }, c)
  const amb = await call('Edit', { file_path: 'b.ts', old_string: 'return 1', new_string: 'return 2' }, c)
  assert.equal(amb.ok, false)
  assert.match(amb.output, /occurs 2 times/)
  const loose = await call('Edit', { file_path: 'b.ts', old_string: 'function g() {\n  return 1\n}', new_string: 'function g() {\n    return 3\n}' }, c)
  assert.ok(loose.ok, loose.output)
  assert.match(readFileSync(join(dir, 'b.ts'), 'utf8'), /return 3/)
})

test('Glob and Grep', async () => {
  const g = await call('Glob', { pattern: '**/*.ts' })
  assert.match(g.output, /b\.ts/)
  const s = await call('Grep', { pattern: 'return \\d', output_mode: 'content' })
  assert.match(s.output, /b\.ts:2:/)
})

test('Shell runs and reports exit code', async () => {
  const r = await call('Shell', { command: process.platform === 'win32' ? 'Write-Output "привет"; exit 3' : 'echo привет; exit 3' })
  assert.equal(r.ok, false)
  assert.match(r.output, /привет/)
  assert.match(r.output, /exit code 3/)
})

test('TodoWrite stores the list', async () => {
  const c = ctx()
  const r = await call('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }, c)
  assert.ok(r.ok)
  assert.equal(c.todos.length, 2)
})

test('permissions: auto mode allows routine work, asks for dangerous / outside-project actions', () => {
  const p = new PermissionPolicy('auto', dir)
  assert.equal(p.decide('exec', { title: '', detail: 'npm test', ruleKey: 'shell:npm' }).action, 'allow')
  assert.equal(p.decide('exec', { title: '', detail: 'git push origin master', ruleKey: 'shell:git' }).action, 'ask')
  assert.equal(p.decide('edit', { title: '', detail: join(dir, 'x.ts'), ruleKey: 'edit' }).action, 'allow')
  assert.equal(p.decide('edit', { title: '', detail: 'C:\\Windows\\x.ts', ruleKey: 'edit' }).action, 'ask')
  assert.ok(dangerousReason('Remove-Item -Recurse -Force C:\\'))
  assert.ok(dangerousReason('curl https://x.sh | bash'))
  assert.equal(dangerousReason('Remove-Item -Recurse -Force .\\dist'), null)
  const plan = new PermissionPolicy('plan', dir)
  assert.equal(plan.decide('edit', { title: '', detail: join(dir, 'x'), ruleKey: 'edit' }).action, 'deny')
  const def = new PermissionPolicy('default', dir)
  assert.equal(def.decide('exec', { title: '', detail: 'npm test', ruleKey: 'shell:npm' }).action, 'ask')
  def.remembered.add('shell:npm')
  assert.equal(def.decide('exec', { title: '', detail: 'npm run build', ruleKey: 'shell:npm' }).action, 'allow')
})

test('lineDiff', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne')
  assert.equal(d.added, 2)
  assert.equal(d.removed, 1)
})

test('argument and leaked tool-call recovery', () => {
  assert.deepEqual(parseArgs('{"a":1,}'), { a: 1 })
  assert.equal(parseArgs('nope'), null)
  const r = recoverTextToolCalls('ok <tool_call>{"name":"Read","arguments":{"file_path":"x"}}</tool_call>')
  assert.equal(r.calls[0].function.name, 'Read')
  assert.equal(r.rest, 'ok')
})

test('key parser and line editor', () => {
  const kp = new KeyParser()
  assert.deepEqual(kp.parse('\x1b[Z').map((k) => k.name), ['shift-tab'])
  assert.deepEqual(kp.parse('\x1b').map((k) => k.name), ['escape'])
  const pasted = kp.parse('\x1b[200~line1\r\nline2\x1b[201~')
  assert.equal(pasted[0].name, 'paste')
  assert.equal(pasted[0].text, 'line1\nline2')
  const ed = new LineEditor()
  for (const k of kp.parse('hello\\')) ed.handle(k)
  ed.handle({ name: 'enter' })
  assert.equal(ed.value, 'hello\n')
  for (const k of kp.parse('world')) ed.handle(k)
  assert.equal(ed.handle({ name: 'enter' }), 'submit')
  const r = ed.render(40)
  assert.equal(r.rows.length, 2)
  assert.deepEqual(r.cursor, { row: 1, col: 7 })
})

// ------------------------------------------------------------ full loop against a fake server

test('agent loop: tool call → permission → result → final answer; auto-mode nudge on open todos', async () => {
  const script: any[] = [
    { tool_calls: [{ id: 't1', name: 'TodoWrite', args: { todos: [{ content: 'make file', status: 'in_progress' }] } }] },
    { reasoning: 'I should write the file.', tool_calls: [{ id: 't2', name: 'Write', args: { file_path: 'out.txt', content: 'hi' } }] },
    { content: 'Done.' }, // stops with an open todo → auto mode nudges
    { tool_calls: [{ id: 't3', name: 'TodoWrite', args: { todos: [{ content: 'make file', status: 'completed' }] } }] },
    { content: 'All done.' },
  ]
  const seen: any[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url === '/props') { res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 }, model_path: 'fake.gguf' })); return }
      seen.push(JSON.parse(body))
      const step = script.shift() ?? { content: 'extra' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      if (step.reasoning) chunk({ choices: [{ delta: { reasoning_content: step.reasoning } }] })
      if (step.content) for (const part of step.content.match(/.{1,3}/g)) chunk({ choices: [{ delta: { content: part } }] })
      ;(step.tool_calls ?? []).forEach((tc: any, i: number) => {
        chunk({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: { name: tc.name, arguments: '' } }] } }] })
        chunk({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args) } }] } }] })
      })
      chunk({ choices: [{ delta: {}, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 }, timings: { predicted_per_second: 50, cache_n: 90 } })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as any).port
  try {
    const llm = new LlmClient(`http://127.0.0.1:${port}`)
    await llm.probe()
    assert.equal(llm.ctxSize, 8192)
    const events: AgentEvent[] = []
    const asked: string[] = []
    const agent = new Agent({
      cwd: dir, llm, mode: 'auto', emit: (e) => events.push(e),
      ask: async (r) => { asked.push(r.tool); return { allow: true } },
    })
    await agent.run('make out.txt')
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'hi')
    assert.deepEqual(asked, [], 'auto mode should not ask for an in-project write')
    assert.ok(events.some((e) => e.type === 'notice' && /todo/.test(e.message)), 'auto-mode nudge expected')
    const done = events.filter((e) => e.type === 'done')
    assert.deepEqual(done.map((d: any) => d.reason), ['end'])
    // the system prompt (KV prefix) must be byte-identical across every request
    const sys = seen.map((b) => b.messages[0].content)
    assert.ok(sys.every((s) => s === sys[0]))
    // thinking is always requested, and the previous step's reasoning is sent back (interleaved thinking)
    assert.ok(seen.every((b) => b.chat_template_kwargs?.enable_thinking === true))
    assert.ok(seen[2].messages.some((m: any) => m.role === 'assistant' && m.reasoning_content === 'I should write the file.'))
    // every assistant tool_call is answered by a tool message
    const last = seen[seen.length - 1].messages
    const ids = last.filter((m: any) => m.tool_calls).flatMap((m: any) => m.tool_calls.map((t: any) => t.id))
    assert.deepEqual(ids, last.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id))
    agent.dispose()
  } finally {
    srv.close()
  }
})

test('tool list is stable', () => {
  assert.deepEqual(ALL_TOOLS.map((t) => t.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Shell', 'TodoWrite', 'Task', 'Screenshot'])
})

test('Read shows images only when the model has vision', async () => {
  // 1x1 PNG
  writeFileSync(join(dir, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const blind = await call('Read', { file_path: 'dot.png' })
  assert.equal(blind.ok, false)
  assert.match(blind.output, /no vision/)
  const seeing = await call('Read', { file_path: 'dot.png' }, { ...ctx(), vision: true })
  assert.ok(seeing.ok, seeing.output)
  assert.equal(seeing.images?.length, 1)
  assert.equal(seeing.images?.[0].mime, 'image/png')
})

test('compaction keeps the recent tail verbatim and lists files touched', async () => {
  const calls: unknown[] = []
  const llm = {
    ctxSize: 4000, modelName: 'fake',
    complete: async (req: unknown) => {
      calls.push(req)
      return { content: 'SUMMARY OF OLD WORK', reasoning: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5 } }
    },
    countTokens: async () => 321,
  }
  const agent = new Agent({ cwd: dir, llm: llm as never, emit: () => {} })
  const big = 'x'.repeat(2400)
  const tc = (id: string, name: string, file: string) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify({ file_path: file }) } })
  const a = agent as unknown as { messages: unknown[]; readState: Map<string, number> }
  a.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'build the thing' },
    { role: 'assistant', content: null, tool_calls: [tc('1', 'Read', 'old.txt')] },
    { role: 'tool', tool_call_id: '1', name: 'Read', content: big },
    { role: 'assistant', content: null, tool_calls: [tc('2', 'Edit', 'old.txt')] },
    { role: 'tool', tool_call_id: '2', name: 'Edit', content: big },
    { role: 'assistant', content: null, tool_calls: [tc('3', 'Read', 'new.txt')] },
    { role: 'tool', tool_call_id: '3', name: 'Read', content: 'fresh file body' },
    { role: 'assistant', content: 'working on new.txt now' },
  ]
  a.readState.set(join(dir, 'old.txt'), 1)
  a.readState.set(join(dir, 'new.txt'), 2)
  await agent.compact()
  const m = a.messages as { role: string; content: string }[]
  assert.equal(m[0].content, 'sys')
  assert.match(m[1].content, /SUMMARY OF OLD WORK/)
  assert.match(m[1].content, /old\.txt/)                 // exact file list survives
  assert.ok(m.some((x) => x.content === 'fresh file body')) // recent tool result kept verbatim
  assert.equal(m.at(-1)?.content, 'working on new.txt now')
  assert.notEqual(m[2].role, 'tool')                       // kept part never starts mid tool results
  assert.ok(a.readState.has(join(dir, 'new.txt')))          // still "read": no forced re-Read
  assert.ok(!a.readState.has(join(dir, 'old.txt')))
  agent.dispose()
})

test('loop guards: repetition, code in thinking, identical re-reads', async () => {
  const { repetitionLoop, codeInThinking, CallRepeats } = await import('../src/core/guards')
  // degenerate loop
  assert.ok(repetitionLoop('Let me check the file again to be sure.\n'.repeat(40)))
  assert.ok(repetitionLoop('intro text '.repeat(10) + 'and then and then and then and then '.repeat(30)))
  // legit: HTML table with repeated rows, normal prose, separators
  const html = Array.from({ length: 60 }, (_, i) => `<tr><td class="px-4 py-2 border">row ${i}</td></tr>\n<td class="px-4 py-2 border">${i * 3}</td>`).join('\n')
  assert.equal(repetitionLoop(html), null)
  assert.equal(repetitionLoop('='.repeat(2000)), null)
  assert.equal(repetitionLoop(Array.from({ length: 80 }, (_, i) => `Step ${i}: look at module ${i * 7} and decide.`).join('\n')), null)
  // code in thinking
  assert.equal(codeInThinking('I will write a file.\n```js\nconst a = 1\n```'), false)
  assert.equal(codeInThinking('plan\n```js\n' + 'line();\n'.repeat(90) + '```'), true)
  // identical calls
  const r = new CallRepeats()
  assert.equal(r.record('Glob', '{"pattern":"*"}', 'a\nb'), 1)
  r.record('Read', '{"file_path":"x"}', 'other')
  assert.equal(r.record('Glob', '{"pattern":"*"}', 'a\nb'), 2)
  assert.equal(r.record('Glob', '{"pattern":"*"}', 'a\nb'), 3)
  assert.equal(r.record('Glob', '{"pattern":"*"}', 'a\nb\nc'), 1) // different result = not a repeat
  // Read of an unchanged file with the same range is answered from context
  const c = { ...ctx(), readSeen: new Map<string, string>() }
  writeFileSync(join(dir, 'same.txt'), 'hello\nworld\n')
  const first = await call('Read', { file_path: 'same.txt' }, c)
  assert.match(first.output, /hello/)
  const again = await call('Read', { file_path: 'same.txt' }, c)
  assert.match(again.output, /has not changed/)
  const range = await call('Read', { file_path: 'same.txt', offset: 2 }, c) // other range: real read
  assert.match(range.output, /world/)
})

test('the agent stays inside the project: reads outside ask, even in auto mode', () => {
  const pol = new PermissionPolicy('auto', dir)
  assert.equal(pol.decide('read', { title: 'Read', detail: join(dir, 'a.txt'), ruleKey: 'read-outside' }).action, 'allow')
  const out = pol.decide('read', { title: 'Read', detail: String.raw`C:\Windows\win.ini`, ruleKey: 'read-outside' })
  assert.equal(out.action, 'ask')
  pol.remembered.add('read-outside')
  assert.equal(pol.decide('read', { title: 'Read', detail: String.raw`C:\Windows\win.ini`, ruleKey: 'read-outside' }).action, 'allow')
})

test('LAN proxy rewrites reasoning_effort high to xhigh', async () => {
  const { startLanProxy } = await import('../src/core/server')
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const up = (upstream.address() as { port: number }).port
  const proxy = await startLanProxy({ listenHost: '127.0.0.1', listenPort: 0, upstreamPort: up })
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'q',
        reasoning_effort: 'high',
        reasoning: { effort: 'high' },
        chat_template_kwargs: { reasoning_effort: 'max' },
        messages: [],
      }),
    })
    const j = await r.json() as {
      reasoning_effort: string
      reasoning: { effort: string }
      chat_template_kwargs: { reasoning_effort: string }
    }
    assert.equal(j.reasoning_effort, 'xhigh')
    assert.equal(j.reasoning.effort, 'xhigh')
    assert.equal(j.chat_template_kwargs.reasoning_effort, 'xhigh')
  } finally {
    proxy.stop()
    upstream.close()
  }
})

test('harness proxy fills missing sampling, keeps client values, and waits while the GPU is swapped', async () => {
  const { startLanProxy } = await import('../src/core/server')
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const up = (upstream.address() as { port: number }).port
  let open!: () => void
  let gate: Promise<void> | null = new Promise<void>((r) => { open = r })
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1', listenPort: 0, upstreamPort: up,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
    gate: () => gate ?? Promise.resolve(),
  })
  try {
    let answered = false
    const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'q', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] }),
    }).then(async (r) => { answered = true; return await r.json() as Record<string, unknown> })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(answered, false, 'held while the gate is closed')
    gate = null
    open()
    const j = await pending
    assert.equal(j.temperature, 0.2)
    assert.equal(j.top_k, 20)
    assert.equal(j.min_p, 0)
    assert.equal(j.top_p, 0.95)
    // other endpoints pass through untouched
    const raw = await fetch(`http://127.0.0.1:${proxy.port}/slots/0?action=save`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"filename":"x.bin"}',
    })
    assert.equal(await raw.text(), '{"filename":"x.bin"}')
  } finally {
    proxy.stop()
    upstream.close()
  }
})

test('proxy turns WebP images into PNG (llama-server cannot decode WebP)', async () => {
  const { webpToPng } = await import('../src/core/server')
  const { createCanvas } = await import('@napi-rs/canvas')
  const c = createCanvas(8, 8)
  const g = c.getContext('2d')
  g.fillStyle = 'rgba(255,0,0,0.5)'
  g.fillRect(0, 0, 8, 8)
  const webp = c.toBuffer('image/webp').toString('base64')
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: `data:image/webp;base64,${webp}` } }] }],
  }))
  const out = JSON.parse((await webpToPng(body)).toString('utf8'))
  const url: string = out.messages[0].content[1].image_url.url
  assert.match(url, /^data:image\/png;base64,/)
  assert.equal(Buffer.from(url.split(',')[1], 'base64').subarray(1, 4).toString('latin1'), 'PNG')
  const plain = Buffer.from('{"messages":[{"role":"user","content":"hi"}]}')
  assert.equal(await webpToPng(plain), plain)
})

test('harness MCP: tools are listed and generate_image returns the picture as image content', async () => {
  const { startLanProxy } = await import('../src/core/server')
  const { mcpRoute } = await import('../src/core/harness')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const progress: string[] = []
  let sink: ((m: string) => void) | undefined
  const route = mcpRoute({
    vision: true,
    setImageProgress: (fn) => { sink = fn },
    generateImage: async (req) => {
      sink?.('sampling · step 1/25')
      mkdirSync(join(req.out, '..'), { recursive: true })
      writeFileSync(req.out, png)
      return { path: req.out, width: 1, height: 1, seconds: 1, seed: 7 }
    },
    log: (m) => progress.push(m),
  })
  const proxy = await startLanProxy({ listenHost: '127.0.0.1', listenPort: 0, upstreamPort: 1, routes: { '/mcp': route } })
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxy.port}/mcp`)))
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('generate_image') && names.includes('web_search'), names.join(','))
    const out = join(dir, 'art', 'hero.png')
    const r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a red knight sprite', file_path: out } }) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean
    }
    assert.notEqual(r.isError, true, JSON.stringify(r.content).slice(0, 300))
    assert.match(r.content[0].text ?? '', /hero\.png/)
    const img = r.content.find((c) => c.type === 'image')
    assert.equal(img?.mimeType, 'image/png')
    assert.equal(img?.data, png.toString('base64'))
    assert.deepEqual(readFileSync(out), png)
    assert.ok(progress.some((m) => /step 1\/25/.test(m)), progress.join(' | '))
    const bad = await client.callTool({ name: 'nope', arguments: {} }) as { isError?: boolean }
    assert.equal(bad.isError, true)
  } finally {
    await client.close().catch(() => {})
    proxy.stop()
  }
})

test('dangerous working folders are recognised', async () => {
  const { dangerousFolder } = await import('../src/core/workspace')
  const { homedir } = await import('node:os')
  assert.ok(dangerousFolder('C:/'))
  assert.ok(dangerousFolder(homedir()))
  assert.ok(dangerousFolder(join(homedir(), 'Desktop')))
  assert.equal(dangerousFolder(join(homedir(), 'Desktop', 'proj')), null)
  assert.equal(dangerousFolder(join(__dirname, '..')), null) // this repository
})

test('web search: Yahoo results are parsed and unwrapped (saved page)', async () => {
  const { parseYahoo, unwrapYahoo, formatSearch } = await import('../src/core/web')
  const hits = parseYahoo(readFileSync(join(__dirname, 'fixtures', 'yahoo-search.html'), 'utf8'))
  assert.equal(hits.length, 7)
  assert.equal(hits[0].url, 'https://docs.godotengine.org/en/stable/classes/class_audiostreamwav.html')
  assert.match(hits[0].title, /^AudioStreamWAV/)
  assert.match(hits[0].snippet, /PCM/)
  assert.ok(hits.every((h) => /^https:\/\//.test(h.url) && !/yahoo\.com/.test(h.url)))
  assert.equal(unwrapYahoo('https://r.search.yahoo.com/_ylt=x/RV=2/RU=https%3a%2f%2fexample.com%2fa%3fb%3d1/RK=2/RS=y-'), 'https://example.com/a?b=1')
  const text = formatSearch({ query: 'q', hits: [{ title: 't', url: 'https://e.com', snippet: 's', sources: ['yahoo'], score: 1 }], engines: { yahoo: 1 }, failed: { duckduckgo: 'HTTP 202' }, offline: false }, 'web_fetch')
  assert.match(text, /not answering now: duckduckgo/)
  assert.match(text, /with web_fetch before/)
})

test('harness search: /mcp?exclude hides tools, /search validates, the dsh provider plugin maps the JSON', async () => {
  const { startLanProxy } = await import('../src/core/server')
  const { mcpRoute, searchRoute } = await import('../src/core/harness')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const proxy = await startLanProxy({ listenHost: '127.0.0.1', listenPort: 0, upstreamPort: 1, routes: { '/mcp': mcpRoute({ vision: true }), '/search': searchRoute() } })
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxy.port}/mcp?exclude=web_search`)))
    const names = (await client.listTools()).tools.map((t) => t.name)
    assert.ok(names.includes('screenshot') && !names.includes('web_search'), names.join(','))
    assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/search?q=`)).status, 400)
  } finally {
    await client.close().catch(() => {})
    proxy.stop()
  }

  // the provider plugin against a canned /search answer
  const canned = createServer((req, res) => {
    assert.match(req.url ?? '', /^\/search\?q=godot\+timer&limit=5$/)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sources: [{ url: 'https://docs.godotengine.org/t', title: 'Timer', snippet: 'wait_time' }, { url: '' }], engines: { yahoo: 7, readthedocs: 4 }, failed: { duckduckgo: 'HTTP 202' }, offline: false }))
  })
  await new Promise<void>((r) => canned.listen(0, '127.0.0.1', () => r()))
  try {
    const plugin = await import('../harness/dsh-web-search-afkllm/index.js')
    let provider: any
    plugin.apply({ web: { registerSearchProvider: (p: unknown) => { provider = p } } }, { baseURL: `http://127.0.0.1:${(canned.address() as { port: number }).port}` })
    assert.equal(provider.id, 'afkllm')
    assert.equal(provider.available(), true)
    const r = await provider.search({ query: 'godot timer', maxResults: 5 })
    assert.deepEqual(r.sources, [{ url: 'https://docs.godotengine.org/t', title: 'Timer', snippet: 'wait_time' }])
    assert.match(r.content, /^1 results \(engines: yahoo 7, readthedocs 4\); not answering now: duckduckgo\./)
  } finally {
    canned.close()
  }
})

test('afk api model switch: onChat sees the requested model before the request goes on, sampling follows the profile', async () => {
  const { startLanProxy, profileForModel, BUILTIN_PROFILES } = await import('../src/core/server')
  // a profile name, a .gguf path (the first profile using that file), or nothing
  assert.equal(profileForModel('q38-160k', BUILTIN_PROFILES), 'q38-160k')
  assert.equal(profileForModel(BUILTIN_PROFILES.q38.model.toUpperCase(), BUILTIN_PROFILES), 'q38')
  assert.equal(profileForModel('gpt-4o', BUILTIN_PROFILES), undefined)
  assert.equal(profileForModel(undefined, BUILTIN_PROFILES), undefined)

  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  let sampling = { temperature: 0.6 }
  const seen: (string | undefined)[] = []
  const proxy = await startLanProxy({
    listenHost: '127.0.0.1', listenPort: 0, upstreamPort: (upstream.address() as { port: number }).port,
    sampling: () => sampling,
    onChat: async (m) => {
      seen.push(m)
      if (m === 'boom') throw new Error('model file not found')
      if (m === 'other') { await new Promise((r) => setTimeout(r, 50)); sampling = { temperature: 1.0 } }
    },
  })
  const post = (model: string) => fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  try {
    assert.equal(((await (await post('q38')).json()) as { temperature: number }).temperature, 0.6)
    assert.equal(((await (await post('other')).json()) as { temperature: number }).temperature, 1.0, 'sampling read after the switch')
    const bad = await post('boom')
    assert.equal(bad.status, 503)
    assert.match(((await bad.json()) as { error: { message: string } }).error.message, /not found/)
    assert.deepEqual(seen, ['q38', 'other', 'boom'])
  } finally {
    proxy.stop()
    upstream.close()
  }
})

test('CLI input history lives in memory only and /clear-history empties it', () => {
  const ed = new LineEditor()
  ed.set('first prompt'); ed.commit()
  ed.set('second prompt'); ed.commit()
  assert.deepEqual(ed.historyList, ['first prompt', 'second prompt'])
  ed.clearHistory()
  assert.deepEqual(ed.historyList, [])
  const src = readFileSync(join(__dirname, '..', 'src', 'cli', 'app.ts'), 'utf8')
  assert.doesNotMatch(src, /writeFileSync\([^)]*HISTORY/, 'history is never written to disk')
  assert.match(src, /case 'clear-history'/)
})

test('harness MCP images=path: generate_image returns the path and a read_image hint, no inline picture', async () => {
  const { startLanProxy } = await import('../src/core/server')
  const { mcpRoute } = await import('../src/core/harness')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const route = mcpRoute({
    vision: true,
    generateImage: async (req) => { mkdirSync(join(req.out, '..'), { recursive: true }); writeFileSync(req.out, png); return { path: req.out, width: 1, height: 1, seconds: 1, seed: 1 } },
  })
  const proxy = await startLanProxy({ listenHost: '127.0.0.1', listenPort: 0, upstreamPort: 1, routes: { '/mcp': route } })
  const client = new Client({ name: 'test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxy.port}/mcp?exclude=web_search&images=path`)))
    const out = join(dir, 'art', 'elephant.png')
    const r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'an elephant, realistic photo', file_path: out } }) as { content: { type: string; text?: string }[]; isError?: boolean }
    assert.notEqual(r.isError, true, JSON.stringify(r.content).slice(0, 300))
    assert.equal(r.content.filter((c) => c.type === 'image').length, 0)
    const text = r.content.map((c) => c.text ?? '').join('\n')
    assert.match(text, /elephant\.png/)
    assert.match(text, /read_image/)
    assert.deepEqual(readFileSync(out), png)
  } finally {
    await client.close().catch(() => {})
    proxy.stop()
  }
})
