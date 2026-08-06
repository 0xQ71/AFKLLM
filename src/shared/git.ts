/** Git porcelain / SCM types shared by main + renderer. */

export interface GitFileChange {
  path: string
  /** Index (staging area) status char from porcelain XY */
  indexStatus: string
  /** Work tree status char from porcelain XY */
  workTreeStatus: string
}

export interface GitStatus {
  available: boolean
  branch: string | null
  ahead: number | null
  behind: number | null
  files: GitFileChange[]
  stagedCount: number
  unstagedCount: number
}

export interface GitDiff {
  path: string
  staged: boolean
  oldText: string
  newText: string
  error?: string
}

export interface GitCommitNode {
  hash: string
  shortHash: string
  parents: string[]
  subject: string
  author: string
  date: string
  /** ASCII graph prefix from `git log --graph` */
  graph: string
}

export interface GitCommitDetail {
  hash: string
  shortHash: string
  subject: string
  body: string
  author: string
  date: string
  patch: string
  error?: string
}

export interface GitOkResult {
  ok: boolean
  error?: string
}

export function isStagedChange(f: GitFileChange): boolean {
  return f.indexStatus !== ' ' && f.indexStatus !== '?'
}

export function isUnstagedChange(f: GitFileChange): boolean {
  if (f.indexStatus === '?' && f.workTreeStatus === '?') return true
  return f.workTreeStatus !== ' '
}

export function changeLetter(f: GitFileChange, prefer: 'index' | 'worktree'): string {
  const c = prefer === 'index' ? f.indexStatus : f.workTreeStatus
  if (c === '?' || (f.indexStatus === '?' && f.workTreeStatus === '?')) return '?'
  if (c === ' ') {
    const other = prefer === 'index' ? f.workTreeStatus : f.indexStatus
    return other === ' ' ? 'M' : other
  }
  return c
}
