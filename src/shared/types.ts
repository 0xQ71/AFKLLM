/** Shared types across Main / Preload / Renderer */

export type QueuePriority = 'HIGH' | 'NORMAL' | 'LOW'

export interface LLMCompletionRequest {
  id: string
  priority: QueuePriority
  /** OpenAI-compatible chat / completions payload */
  endpoint: '/v1/completions' | '/v1/chat/completions'
  body: Record<string, unknown>
  /** Soft timeout in ms (default 30_000). Use 0 for no timeout. */
  timeoutMs?: number
}

export interface LLMStreamChunk {
  id: string
  /** Incremental text from the assistant */
  token?: string
  /** Incremental tool-call argument fragments */
  toolCallDelta?: {
    index: number
    id?: string
    name?: string
    arguments?: string
  }
  done?: boolean
  error?: string
  usage?: LLMUsage
  timings?: LLMTimings
}

export interface LLMUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** llama.cpp / llama-server generation timings (final SSE chunk). */
export interface LLMTimings {
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
  cache_n?: number
}

export interface LLMCompletionResult {
  id: string
  text: string
  usage?: LLMUsage
  timings?: LLMTimings
  aborted?: boolean
  error?: string
  /** OpenAI-style tool calls when the model requests tools */
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finishReason?: string
}

export type AgentToolName =
  | 'read_file'
  | 'write_file'
  | 'apply_diff'
  | 'apply_patch'
  | 'explore_subagent'
  | 'list_directory'
  | 'search_codebase'
  | 'web_search'
  | 'execute_terminal_command'
  | 'read_terminal'
  | 'delete_file'
  | 'create_directory'

export interface AgentToolCall {
  id: string
  /** Built-in AgentToolName or mangled MCP tool `mcp__{serverId}__{tool}` */
  name: string
  arguments: Record<string, unknown>
}

export interface AgentEditReview {
  path: string
  status: 'pending' | 'accepted' | 'rejected'
}

export interface AgentToolResult {
  id: string
  name: string
  ok: boolean
  content: string
  error?: string
  /** True when UI confirmation is required before execution */
  needsConfirmation?: boolean
  /** Present after a successful write/apply_diff/apply_patch — UI can Accept/Reject (undo) */
  editReview?: AgentEditReview
}

export interface FimContext {
  prefix: string
  suffix: string
  languageId: string
  filePath?: string
}

export interface InlineEditRequest {
  instruction: string
  selectedCode: string
  filePath: string
  surroundingContext: string
  languageId: string
}

export interface SearchReplaceBlock {
  search: string
  replace: string
}

export interface DiffPreviewPayload {
  original: string
  modified: string
  languageId: string
  filePath: string
  blocks: SearchReplaceBlock[]
  applied: number
  failed: Array<{ index: number; reason: string }>
}

/** JSON Schema descriptors exposed to the LLM agent loop */
export const AGENT_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read a file relative to the project root. Optionally pass start_line/end_line (1-based inclusive) to read a slice.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string', description: 'Path relative to workspace root' },
          start_line: {
            type: 'integer',
            description: 'Optional 1-based start line (inclusive). Omit to read from the start.'
          },
          end_line: {
            type: 'integer',
            description: 'Optional 1-based end line (inclusive). Omit to read through EOF.'
          }
        },
        required: ['relative_path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        'Create a NEW file, or append to an existing one (append=true). ALWAYS set relative_path FIRST (e.g. "index.html", "styles.css") then content. Will REFUSE to overwrite a non-empty existing file — use append=true to continue writing, or apply_patch / apply_diff to edit. Prefer ≤1500 chars of code per call. Paths relative to project root only. Do NOT use overwrite=true to "fix" or answer a correction — patch instead.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Required. File path relative to workspace root, e.g. index.html or src/app.js'
          },
          content: { type: 'string' },
          append: {
            type: 'boolean',
            description: 'If true, append content instead of overwriting. Required to continue a truncated/incomplete file.'
          },
          overwrite: {
            type: 'boolean',
            description:
              'Only when the user explicitly asked to replace the entire file. Never for bugfixes/corrections — use apply_patch. Default false.'
          }
        },
        required: ['relative_path', 'content']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_patch',
      description:
        'Preferred edit tool for one or many file changes. Pass a Codex-style patch: *** Begin Patch / *** Add File: path / *** Update File: path with @@ hunks (-/+/space lines) / *** Delete File: path / *** End Patch. Use apply_diff only for a single unique search→replace. Prefer apply_patch over rewriting whole files.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Full *** Begin Patch … *** End Patch text'
          }
        },
        required: ['patch']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_diff',
      description:
        'Simple fallback edit: replace one exact unique search_block with replace_block. Prefer apply_patch for multi-hunk or multi-file edits. On failure: read_file, copy a shorter unique substring, retry.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string' },
          search_block: {
            type: 'string',
            description: 'Exact unique substring from the current file (copy from read_file)'
          },
          replace_block: { type: 'string' }
        },
        required: ['relative_path', 'search_block', 'replace_block']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'explore_subagent',
      description:
        'Spawn a short read-only research subagent (read_file / list_directory / search_codebase / web_search only). Use when you need to map the repo or answer “where is X” before editing. Returns a concise bullet report. Do not use for making edits.',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'What to find out'
          },
          focus_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional relative paths to prioritize'
          }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files and folders under dir_path (ignores node_modules, .git, dist).',
      parameters: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: 'Relative directory path, default "."' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_codebase',
      description: 'Ripgrep-like text search across the project.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string', description: 'Optional glob filter e.g. **/*.{ts,tsx}' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        'Search the public web without an API key (DuckDuckGo + Bing + Brave + Wikipedia + Stack Overflow + HN). Use for docs, errors, APIs, library versions, or facts not in the repo. Returns titles, URLs, snippets. Prefer search_codebase for local project code.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (be specific: library name + error + language)'
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (default 8, max 12)'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a file relative to the project root. Prefer this over shell rm.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string' }
        },
        required: ['relative_path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_directory',
      description: 'Create a directory (and parents) relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string' }
        },
        required: ['relative_path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_terminal_command',
      description:
        'Run ONE shell command in the IDE terminal (PowerShell on Windows). Do NOT use bash && — use the cwd arg for directories, or `;` to chain. On TERMINAL_ERROR, fix from ERROR_FOCUS. If you see PROCESS_ENDED, the user closed the app — do not rewrite or relaunch.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Single command, e.g. javac Calculator.java — not "cd foo && javac …" (use cwd instead)'
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to project root (preferred over cd … &&)'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_terminal',
      description:
        'Read the recent output from the IDE Terminal panel (scrollback). Use after a failed command or when the user ran something manually — fix based on the real error text, do not guess.',
      parameters: {
        type: 'object',
        properties: {
          max_chars: {
            type: 'number',
            description: 'Max characters to return from the end of the scrollback (default 8000)'
          }
        }
      }
    }
  }
] as const
