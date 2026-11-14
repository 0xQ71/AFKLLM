/** Workspace search / CRUD types shared by main + renderer. */

export interface WorkspaceSearchMatch {
  path: string
  line: number
  text: string
}

export interface WorkspaceSearchResult {
  ok: boolean
  matches: WorkspaceSearchMatch[]
  error?: string
}

/** Normalize workspace path for map keys (case-insensitive on Windows). */
export function chatRootKey(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || '__none__'
}

/**
 * Single path segment safe under userData (checkpoints, context-index).
 * Windows rejects `:` in directory names; path.join also mishandles `d:/…`.
 */
export function fsSafeRootKey(root: string): string {
  const key = chatRootKey(root)
  if (key === '__none__') return key
  const safe = key
    .replace(/[:/\\<>|"?*\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return safe || 'root'
}
