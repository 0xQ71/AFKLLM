/**
 * Live MCP: spawn tiny stdio server via McpManager, list tools, call ping.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpManager } from '../src/main/mcp/McpManager.ts'
import { encodeMcpToolName } from '../src/shared/mcp.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'scripts', 'fixtures', 'tiny-mcp-server.mjs')

describe('McpManager live', () => {
  it('connects, lists tools, and calls ping', async () => {
    const mgr = new McpManager()
    mgr.setCwd(root)
    try {
      await mgr.applyConfig([
        {
          id: 'tiny',
          name: 'Tiny',
          enabled: true,
          command: process.execPath,
          args: [fixture]
        }
      ])

      const status = mgr.getStatus()
      assert.equal(status.length, 1)
      assert.equal(status[0]!.state, 'connected', status[0]!.error ?? 'not connected')
      assert.ok((status[0]!.toolCount ?? 0) >= 1)

      const tools = mgr.listOpenAiTools()
      const ping = tools.find((t) => t.function.name.includes('ping'))
      assert.ok(ping, `tools: ${tools.map((t) => t.function.name).join(', ')}`)

      const mangled = encodeMcpToolName('tiny', 'ping')
      const result = await mgr.callTool(mangled, { msg: 'afk' }, 'call-1')
      assert.equal(result.ok, true, result.error)
      assert.match(result.content, /pong:afk/)
    } finally {
      await mgr.dispose()
    }
  })
})
