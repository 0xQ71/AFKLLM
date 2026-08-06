import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { AgentToolResult } from '../../shared/types'
import {
  decodeMcpToolName,
  encodeMcpToolName,
  mcpInputSchemaToParameters,
  type McpOpenAiTool,
  type McpServerConfig,
  type McpServerStatus
} from '../../shared/mcp'

interface LiveServer {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport
  tools: McpOpenAiTool[]
  /** MCP name keyed by mangled OpenAI name */
  toolMap: Map<string, string>
  state: McpServerStatus['state']
  error?: string
}

/** Stdio MCP servers → agent tools. */
export class McpManager {
  private servers = new Map<string, LiveServer>()
  private configs: McpServerConfig[] = []
  private cwd: string | undefined
  private onChanged?: () => void

  setOnChanged(cb: (() => void) | undefined): void {
    this.onChanged = cb
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  getStatus(): McpServerStatus[] {
    return this.configs.map((cfg) => {
      const live = this.servers.get(cfg.id)
      return {
        id: cfg.id,
        name: cfg.name,
        enabled: cfg.enabled,
        state: live?.state ?? (cfg.enabled ? 'stopped' : 'stopped'),
        error: live?.error,
        toolCount: live?.tools.length ?? 0
      }
    })
  }

  listOpenAiTools(): McpOpenAiTool[] {
    const out: McpOpenAiTool[] = []
    for (const live of this.servers.values()) {
      if (live.state === 'connected') out.push(...live.tools)
    }
    return out
  }

  async applyConfig(configs: McpServerConfig[]): Promise<void> {
    this.configs = configs
    const wanted = new Set(
      configs.filter((c) => c.enabled && c.command.trim()).map((c) => c.id)
    )

    for (const id of [...this.servers.keys()]) {
      if (!wanted.has(id)) {
        await this.stopServer(id)
      }
    }

    for (const cfg of configs) {
      if (!cfg.enabled || !cfg.command.trim()) continue
      const live = this.servers.get(cfg.id)
      const same =
        live &&
        live.config.command === cfg.command &&
        JSON.stringify(live.config.args) === JSON.stringify(cfg.args) &&
        JSON.stringify(live.config.env ?? {}) === JSON.stringify(cfg.env ?? {})
      if (same && live.state === 'connected') {
        live.config = cfg
        continue
      }
      await this.stopServer(cfg.id)
      await this.startServer(cfg)
    }

    this.onChanged?.()
  }

  async dispose(): Promise<void> {
    for (const id of [...this.servers.keys()]) {
      await this.stopServer(id)
    }
  }

  async callTool(
    mangledName: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<AgentToolResult> {
    const decoded = decodeMcpToolName(mangledName)
    if (!decoded) {
      return {
        id: callId,
        name: mangledName,
        ok: false,
        content: '',
        error: `Invalid MCP tool name: ${mangledName}`
      }
    }
    const live = this.servers.get(decoded.serverId)
    if (!live || live.state !== 'connected') {
      return {
        id: callId,
        name: mangledName,
        ok: false,
        content: '',
        error: `MCP server not connected: ${decoded.serverId}`
      }
    }
    const realName = live.toolMap.get(mangledName) ?? decoded.toolName
    try {
      const result = await live.client.callTool({
        name: realName,
        arguments: args
      })
      const text = formatMcpToolResult(result)
      const isError = Boolean((result as { isError?: boolean }).isError)
      return {
        id: callId,
        name: mangledName,
        ok: !isError,
        content: text,
        error: isError ? text.slice(0, 400) : undefined
      }
    } catch (err) {
      return {
        id: callId,
        name: mangledName,
        ok: false,
        content: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async startServer(cfg: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: {
        ...processEnvSafe(),
        ...(cfg.env ?? {})
      },
      stderr: 'pipe',
      cwd: this.cwd
    })

    const client = new Client(
      { name: 'afkllm', version: '0.1.0-20260807' },
      { capabilities: {} }
    )

    const live: LiveServer = {
      config: cfg,
      client,
      transport,
      tools: [],
      toolMap: new Map(),
      state: 'starting'
    }
    this.servers.set(cfg.id, live)

    try {
      await client.connect(transport)
      const listed = await client.listTools()
      const tools: McpOpenAiTool[] = []
      const toolMap = new Map<string, string>()
      for (const t of listed.tools ?? []) {
        const mangled = encodeMcpToolName(cfg.id, t.name)
        toolMap.set(mangled, t.name)
        tools.push({
          type: 'function',
          function: {
            name: mangled,
            description: `[MCP:${cfg.name}] ${t.description ?? t.name}`.slice(
              0,
              500
            ),
            parameters: mcpInputSchemaToParameters(t.inputSchema)
          }
        })
      }
      live.tools = tools
      live.toolMap = toolMap
      live.state = 'connected'
      live.error = undefined
    } catch (err) {
      live.state = 'error'
      live.error = err instanceof Error ? err.message : String(err)
      try {
        await client.close()
      } catch {
        /* */
      }
      try {
        await transport.close()
      } catch {
        /* */
      }
    }
  }

  private async stopServer(id: string): Promise<void> {
    const live = this.servers.get(id)
    if (!live) return
    this.servers.delete(id)
    try {
      await live.client.close()
    } catch {
      /* */
    }
    try {
      await live.transport.close()
    } catch {
      /* */
    }
  }
}

function processEnvSafe(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) out[k] = v
  }
  return out
}

function formatMcpToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '')
  const r = result as {
    content?: Array<{ type?: string; text?: string }>
    structuredContent?: unknown
  }
  const parts: string[] = []
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      else if (c) parts.push(JSON.stringify(c))
    }
  }
  if (r.structuredContent != null) {
    try {
      parts.push(JSON.stringify(r.structuredContent, null, 2))
    } catch {
      /* */
    }
  }
  const text = parts.join('\n').trim()
  return text || JSON.stringify(result).slice(0, 8_000)
}
