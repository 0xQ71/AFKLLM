/** MCP server config + tool name helpers (no API keys; stdio only). */

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  env?: Record<string, string>
}

export type McpServerState = 'stopped' | 'starting' | 'connected' | 'error'

export interface McpServerStatus {
  id: string
  name: string
  enabled: boolean
  state: McpServerState
  error?: string
  toolCount: number
}

export interface McpOpenAiTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function encodeMcpToolName(serverId: string, toolName: string): string {
  const sid = serverId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
  const tn = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return `mcp__${sid}__${tn}`
}

export function decodeMcpToolName(
  mangled: string
): { serverId: string; toolName: string } | null {
  if (!mangled.startsWith('mcp__')) return null
  const rest = mangled.slice('mcp__'.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  const serverId = rest.slice(0, idx)
  const toolName = rest.slice(idx + 2)
  if (!serverId || !toolName) return null
  return { serverId, toolName }
}

/**
 * Map MCP JSON Schema → OpenAI function parameters.
 * Strips keywords that confuse many local models.
 */
export function mcpInputSchemaToParameters(
  schema: unknown
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  const src = schema as Record<string, unknown>
  const out: Record<string, unknown> = {
    type: src.type ?? 'object',
    properties:
      src.properties && typeof src.properties === 'object' ? src.properties : {}
  }
  if (Array.isArray(src.required)) out.required = src.required
  if (typeof src.description === 'string') out.description = src.description
  // Drop $schema, additionalProperties quirks, unevaluated*, etc.
  return out
}

export function sanitizeMcpServers(input: unknown): McpServerConfig[] {
  if (!Array.isArray(input)) return []
  const out: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const row of input) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    let id = String(r.id ?? '').trim()
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    }
    if (seen.has(id)) continue
    seen.add(id)
    const name = String(r.name ?? id).trim() || id
    const command = String(r.command ?? '').trim()
    const args = Array.isArray(r.args)
      ? r.args.map(String)
      : typeof r.args === 'string'
        ? String(r.args)
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : []
    let env: Record<string, string> | undefined
    if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
      env = {}
      for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (k) env[k] = String(v ?? '')
      }
    }
    out.push({
      id,
      name,
      enabled: r.enabled === true,
      command,
      args,
      ...(env ? { env } : {})
    })
  }
  return out.slice(0, 32)
}
