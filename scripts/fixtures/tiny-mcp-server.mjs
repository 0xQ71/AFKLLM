/**
 * Minimal stdio MCP server for live smoke tests.
 * Tools: ping(msg) → pong:msg
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'afkllm-tiny', version: '1.0.0' })

server.registerTool(
  'ping',
  {
    description: 'Echo ping for AFKLLM MCP smoke',
    inputSchema: { msg: z.string() }
  },
  async ({ msg }) => ({
    content: [{ type: 'text', text: `pong:${msg}` }]
  })
)

const transport = new StdioServerTransport()
await server.connect(transport)
