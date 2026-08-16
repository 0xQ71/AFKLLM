import assert from 'node:assert/strict'
import { describe, it, after } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentToolRegistry } from '../src/main/agent/AgentToolRegistry'

describe('write_file smoke', () => {
  const root = path.join(os.tmpdir(), `afkllm-write-${Date.now()}`)
  const tools = new AgentToolRegistry({ projectRoot: root })

  after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates index.html on disk', async () => {
    const r = await tools.invoke({
      id: '1',
      name: 'write_file',
      arguments: {
        relative_path: 'index.html',
        content: '<!DOCTYPE html><html><body>AFKLLM</body></html>\n'
      }
    })
    assert.equal(r.ok, true, r.error ?? r.content)
    const body = await fs.readFile(path.join(root, 'index.html'), 'utf8')
    assert.match(body, /AFKLLM/)
    assert.ok(r.diffStat)
    assert.equal(r.diffStat.added, body.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length)
    assert.equal(r.diffStat.removed, 0)
  })

  it('creates nested path via mkdir', async () => {
    const r = await tools.invoke({
      id: '2',
      name: 'write_file',
      arguments: {
        relative_path: 'assets/logo.txt',
        content: 'AFKLLM\n'
      }
    })
    assert.equal(r.ok, true, r.error ?? r.content)
    const body = await fs.readFile(path.join(root, 'assets', 'logo.txt'), 'utf8')
    assert.equal(body.trim(), 'AFKLLM')
  })

  it('does not persist a truncated overwrite onto complete js/main.js', async () => {
    await fs.mkdir(path.join(root, 'js'), { recursive: true })
    const done =
      '(function () {\n  const state = { theme: "light" };\n' +
      '  function init() { document.body.dataset.theme = state.theme; }\n' +
      '  init();\n})();\n' +
      '// keep\n'.repeat(800)
    await fs.writeFile(path.join(root, 'js', 'main.js'), done, 'utf8')
    const r = await tools.invoke({
      id: '3',
      name: 'write_file',
      arguments: {
        relative_path: 'js/main.js',
        content: 'function themeToggle() {\n',
        overwrite: true
      }
    })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /FILE_COMPLETE/)
    assert.equal(await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'), done)
  })
})
