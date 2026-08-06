/** Shared DTOs for TS/JS language features (definition / hover). */

export interface LspPosition {
  /** 1-based */
  line: number
  /** 1-based */
  column: number
}

export interface LspLocation {
  /** Workspace-relative path with forward slashes */
  path: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface LspDefinitionResult {
  ok: boolean
  locations: LspLocation[]
  error?: string
}

export interface LspHoverResult {
  ok: boolean
  contents?: string
  error?: string
}

export interface LspReferencesResult {
  ok: boolean
  locations: LspLocation[]
  error?: string
}

export interface LspDocumentSymbol {
  name: string
  kind: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  /** Nesting depth for outline indent */
  depth: number
}

export interface LspDocumentSymbolsResult {
  ok: boolean
  symbols: LspDocumentSymbol[]
  error?: string
}

export interface LspStatus {
  root: string | null
  ready: boolean
  fileCount: number
}
