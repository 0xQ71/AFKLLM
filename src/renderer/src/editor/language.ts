/**
 * Monaco language id for a path.
 * Use `typescript` / `javascript` for TSX/JSX so the built-in ts.worker
 * (hover, squiggles, completions) attaches — `typescriptreact` is a VS Code id,
 * not a Monaco worker language.
 */
export function languageIdFromPath(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : ''
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.htm': 'html',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.xml': 'xml',
    '.sql': 'sql',
    '.sh': 'shell',
    '.ps1': 'powershell',
    '.toml': 'ini'
  }
  return map[ext] ?? 'plaintext'
}
