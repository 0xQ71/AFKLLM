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
  /** Override llama-server URL (coresident vision on port+2). Default = chat. */
  baseUrl?: string
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
  | 'generate_image'
  | 'verify_project'
  | 'get_diagnostics'

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
  /** Relative workspace path for tools that create/touch a file (e.g. generate_image) */
  filePath?: string
  /** Honest disk +/- vs the file before this tool wrote (not the model's dump). */
  diffStat?: { added: number; removed: number }
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
        'Read a file relative to the project root. DEFAULT: omit start_line/end_line and read the WHOLE file in one call — that is the fast path. ' +
        'Only if the result says truncated=true, use its STRUCTURE MAP line numbers to request one exact range. Never guess line numbers and never read the same file in small slices.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string', description: 'Path relative to workspace root' },
          start_line: {
            type: 'integer',
            description:
              'Optional 1-based start line (inclusive). Omit for a whole-file read. Only use with a line number taken from a STRUCTURE MAP of a truncated read.'
          },
          end_line: {
            type: 'integer',
            description:
              'Optional 1-based end line (inclusive). Omit for a whole-file read.'
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
        'Create or update a file. ALWAYS set relative_path FIRST (e.g. "index.html", "styles.css") then content. ' +
        'NEW / missing file: write the full body. ' +
        'EXISTING file: prefer apply_diff / apply_patch. ' +
        'EXISTING small files: overwrite=true only when appropriate. ' +
        'EXISTING large file: apply_patch / apply_diff, or append=true to continue a truncated write. ' +
        'Paths relative to project root only.',
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
            description: 'If true, append content instead of overwriting. Use to continue a truncated/incomplete file.'
          },
          overwrite: {
            type: 'boolean',
            description:
              'Replace the entire existing file. Prefer apply_diff/apply_patch. Default false.'
          },
          allow_full_rewrite: {
            type: 'boolean',
            description:
              'Permit overwriting a complete existing file after two failed patches or an explicit user rewrite request. Default false.'
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
        'Edit files with a Codex-style patch: *** Begin Patch / *** Update File: path with @@ hunks / *** End Patch. ' +
        'Prefer this or apply_diff over a full write_file rewrite of an existing file. ' +
        'If hunks fail, the apply model retries automatically; do not loop read_file.',
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
        'Targeted edit: replace one unique search_block with replace_block, or pass instruction for the apply model. ' +
        'Pass replace_all=true to replace every occurrence (global rename). ' +
        'Preferred for existing complete HTML (theme/FAQ/CSS tweaks). On fuzzy miss the coresident apply model runs once — do NOT re-read or full-rewrite.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string' },
          search_block: {
            type: 'string',
            description: 'Exact unique substring from the current file (optional if instruction is set)'
          },
          replace_block: { type: 'string' },
          replace_all: {
            type: 'boolean',
            description:
              'Replace every occurrence of search_block (use for global renames). Default false requires a unique match.'
          },
          instruction: {
            type: 'string',
            description:
              'Natural-language edit intent for the apply model (e.g. "darken Bootstrap accordion buttons"). Use when search_block is hard to copy exactly.'
          }
        },
        required: ['relative_path']
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
        'Run ONE shell command in the IDE terminal (PowerShell on Windows). Do NOT use bash && — use the cwd arg for directories, or `;` to chain. On TERMINAL_ERROR / nonzero exit_code, fix from ERROR_FOCUS. PROCESS_ENDED means the user closed a GUI or hit Ctrl+C — do not rewrite or relaunch.',
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
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description:
        'Generate a PNG with local stable-diffusion.cpp (text-to-image). Unloads chat VRAM, generates, restores chat. ' +
        'After success: do NOT read_file or edit the image — only report the path. Photos are never read as text (vision attach only for user images).',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Positive text prompt for the image (keep focused; do not paste large code/context)'
          },
          relative_path: {
            type: 'string',
            description: 'Optional output path relative to project root (e.g. generated/hero.png)'
          },
          negative_prompt: {
            type: 'string',
            description:
              'Optional extra negative prompt (merged with Settings). Prefer “no text / no letters” in the positive prompt for UI art — FLUX cannot spell words.'
          },
          width: { type: 'integer', description: 'Width in pixels (default from settings)' },
          height: { type: 'integer', description: 'Height in pixels (default from settings)' },
          steps: { type: 'integer', description: 'Denoising steps (default from settings)' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'verify_project',
      description:
        'Run ONE stack build/test/lint/run command (Maven/Gradle/CMake/dotnet/Go/Cargo/npm/pytest/Make). ' +
        'Static HTML: one-shot entry check (index.html) — not a recursive tree scan. ' +
        'Prefer this over guessing shell. Non-zero exit / missing entry is a failure — do not claim success.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['build', 'test', 'lint', 'run'],
            description: 'Which verification to run (default build)'
          },
          command: {
            type: 'string',
            description: 'Optional explicit command; otherwise the stack default is used'
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to project root'
          }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description:
        'Return the latest IDE diagnostics (tsc/eslint and similar). Read-only. Use after edits to see compiler/linter issues.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
] as const
