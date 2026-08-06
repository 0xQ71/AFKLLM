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
})
