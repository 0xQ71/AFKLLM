/** Shared types for context engine (repo map + @codebase + BM25 index). */

export interface RepoMapSnapshot {
  text: string
  fileCount: number
  dirCount: number
}

export interface CodebaseQueryHit {
  path: string
  line: number
  preview: string
}

export interface CodebaseQueryResult {
  text: string
  hits: number
  files: string[]
  /** bm25 = disk index; scan = legacy walk */
  source?: 'bm25' | 'scan'
}

export interface ContextIndexStatus {
  state: 'idle' | 'building' | 'ready' | 'error'
  fileCount: number
  chunkCount: number
  builtAt: number | null
  error?: string
}

export interface ProjectRulesSnapshot {
  text: string
  files: string[]
  error?: string
}
