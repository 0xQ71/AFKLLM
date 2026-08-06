import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import {
  pruneCheckpointsKeepingLatest,
  type AgentCheckpoint
} from '../src/shared/checkpoints'
import {
  decodeMcpToolName,
  encodeMcpToolName,
  mcpInputSchemaToParameters,
  sanitizeMcpServers
} from '../src/shared/mcp'
import { chatRootKey, fsSafeRootKey } from '../src/shared/workspace'

describe('chatRootKey / fsSafeRootKey', () => {
  it('normalizes windows paths for map keys', () => {
    assert.equal(chatRootKey('D:\\CocosLoc\\AFKLLM'), 'd:/cocosloc/afkllm')
    assert.equal(chatRootKey('D:/CocosLoc/AFKLLM/'), 'd:/cocosloc/afkllm')
  })

  it('produces a single filesystem-safe segment without colon', () => {
    const safe = fsSafeRootKey('D:\\CocosLoc\\AFKLLM')
    assert.equal(safe, 'd_cocosloc_afkllm')
    assert.equal(safe.includes(':'), false)
    assert.equal(safe.includes('/'), false)
    assert.equal(safe.includes('\\'), false)
    // path.join must not treat it as absolute / drive-relative
    const joined = join('C:\\Users\\iron\\AppData\\Roaming\\afkllm', 'checkpoints', safe)
    assert.match(joined.replace(/\\/g, '/'), /\/checkpoints\/d_cocosloc_afkllm$/i)
  })

  it('keeps __none__', () => {
    assert.equal(fsSafeRootKey(''), '__none__')
  })
})

describe('encodeMcpToolName / decodeMcpToolName', () => {
  it('round-trips server id and tool name', () => {
    const mangled = encodeMcpToolName('fs-local', 'read_file')
    assert.equal(mangled, 'mcp__fs-local__read_file')
    assert.deepEqual(decodeMcpToolName(mangled), {
      serverId: 'fs-local',
      toolName: 'read_file'
    })
  })

  it('sanitizes odd characters', () => {
    const mangled = encodeMcpToolName('my server!', 'tool.name')
    assert.match(mangled, /^mcp__my_server___tool_name$/)
    assert.ok(decodeMcpToolName(mangled))
  })

  it('returns null for non-mcp names', () => {
    assert.equal(decodeMcpToolName('read_file'), null)
    assert.equal(decodeMcpToolName('mcp__only'), null)
  })
})

describe('mcpInputSchemaToParameters', () => {
  it('keeps type properties required', () => {
    const p = mcpInputSchemaToParameters({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false
    })
    assert.equal(p.type, 'object')
    assert.ok(p.properties)
    assert.deepEqual(p.required, ['q'])
    assert.equal(p.$schema, undefined)
  })

  it('defaults empty schema', () => {
    const p = mcpInputSchemaToParameters(null)
    assert.equal(p.type, 'object')
  })
})

describe('sanitizeMcpServers', () => {
  it('filters and normalizes rows', () => {
    const out = sanitizeMcpServers([
      {
        id: 'a',
        name: 'A',
        enabled: true,
        command: 'npx',
        args: ['-y', 'foo']
      },
      { id: 'a', name: 'dup', enabled: false, command: 'x' },
      null,
      { enabled: 'yes', command: 1 }
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0]!.id, 'a')
    assert.equal(out[0]!.enabled, true)
    assert.deepEqual(out[0]!.args, ['-y', 'foo'])
    assert.equal(out[1]!.enabled, false)
  })
})

describe('pruneCheckpointsKeepingLatest', () => {
  it('keeps last N per session', () => {
    const mk = (sessionId: string, i: number): AgentCheckpoint => ({
      id: `${sessionId}-${i}`,
      sessionId,
      createdAt: i,
      messageId: `m${i}`,
      label: 't',
      files: []
    })
    const kept = pruneCheckpointsKeepingLatest(
      [mk('s1', 1), mk('s1', 2), mk('s1', 3), mk('s2', 10)],
      2
    )
    assert.equal(kept.filter((c) => c.sessionId === 's1').length, 2)
    assert.ok(kept.some((c) => c.id === 's1-2'))
    assert.ok(kept.some((c) => c.id === 's1-3'))
    assert.ok(kept.some((c) => c.id === 's2-10'))
  })
})
