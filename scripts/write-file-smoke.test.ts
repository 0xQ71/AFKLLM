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

  it('refuses write_file without content and compact FILE_COMPLETE stubs', async () => {
    const missing = await tools.invoke({
      id: 'empty-1',
      name: 'write_file',
      arguments: { relative_path: 'index.html' }
    })
    assert.equal(missing.ok, false)
    assert.match(missing.error ?? '', /EMPTY_WRITE/)
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep-me\n', 'utf8')
    const stub = await tools.invoke({
      id: 'empty-2',
      name: 'write_file',
      arguments: {
        relative_path: 'keep.txt',
        content: 'FILE_COMPLETE on disk, 12 lines — do not rewrite'
      }
    })
    assert.equal(stub.ok, false)
    assert.match(stub.error ?? '', /EMPTY_WRITE/)
    assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep-me\n')
    const omitted = await tools.invoke({
      id: 'empty-3',
      name: 'write_file',
      arguments: {
        relative_path: 'styles.css',
        content: '[omitted — file on disk, 400 chars]'
      }
    })
    assert.equal(omitted.ok, false)
    assert.match(omitted.error ?? '', /EMPTY_WRITE/)
    const compact = await tools.invoke({
      id: 'empty-4',
      name: 'write_file',
      arguments: {
        relative_path: 'src/App.jsx',
        content:
          '[HISTORY_COMPACT] This is NOT file contents (already on disk). The real file is already saved.'
      }
    })
    assert.equal(compact.ok, false)
    assert.match(compact.error ?? '', /EMPTY_WRITE/)
  })
})
