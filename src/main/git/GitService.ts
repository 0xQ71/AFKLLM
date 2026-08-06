import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  GitCommitDetail,
  GitCommitNode,
  GitDiff,
  GitFileChange,
  GitOkResult,
  GitStatus
} from '../../shared/git'
import { isStagedChange, isUnstagedChange } from '../../shared/git'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 8_000

export class GitService {
  private root = ''

  setRoot(root: string): void {
    this.root = root
  }

  getRoot(): string {
    return this.root
  }

  async status(): Promise<GitStatus> {
    const empty: GitStatus = {
      available: false,
      branch: null,
      ahead: null,
      behind: null,
      files: [],
      stagedCount: 0,
      unstagedCount: 0
    }
    if (!this.root) return empty

    try {
      const inside = await this.git(['rev-parse', '--is-inside-work-tree'])
      if (inside.stdout.trim() !== 'true') return empty
    } catch {
      return empty
    }

    let branch: string | null = null
    try {
      branch = (await this.git(['branch', '--show-current'])).stdout.trim() || null
      if (!branch) {
        branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null
        if (branch === 'HEAD') branch = 'DETACHED'
      }
    } catch {
      branch = null
    }

    let ahead: number | null = null
    let behind: number | null = null
    try {
      const ab = (await this.git(['rev-list', '--left-right', '--count', '@{u}...HEAD'])).stdout
        .trim()
        .split(/\s+/)
      if (ab.length >= 2) {
        behind = Number(ab[0]) || 0
        ahead = Number(ab[1]) || 0
      }
    } catch {
      // no upstream
    }

    try {
      const porcelain = (await this.git(['status', '--porcelain=v1', '-u'])).stdout
      const files = parsePorcelain(porcelain)
      let stagedCount = 0
      let unstagedCount = 0
      for (const f of files) {
        if (isStagedChange(f)) stagedCount++
        if (isUnstagedChange(f)) unstagedCount++
      }

      return {
        available: true,
        branch,
        ahead,
        behind,
        files,
        stagedCount,
        unstagedCount
      }
    } catch {
      return empty
    }
  }

  async diff(relativePath: string, staged = false): Promise<GitDiff> {
    const path = normalizeRel(relativePath)
    if (!this.root || !path) {
      return { path, staged, oldText: '', newText: '', error: 'No project root' }
    }

    try {
      const st = await this.status()
      const file = st.files.find((f) => f.path === path)
      const untracked = file?.indexStatus === '?' && file.workTreeStatus === '?'

      if (staged) {
        // index vs HEAD
        if (file?.indexStatus === 'D') {
          const oldText = await this.tryShow('HEAD', path)
          return { path, staged: true, oldText, newText: '' }
        }
        const oldText = await this.tryShow('HEAD', path)
        const newText = await this.tryShow(':0', path)
        return { path, staged: true, oldText, newText }
      }

      // worktree vs index (or HEAD if untracked)
      if (untracked) {
        const newText = await this.readWorktree(path)
        return { path, staged: false, oldText: '', newText }
      }
      if (file?.workTreeStatus === 'D') {
        const oldText =
          (await this.tryShow(':0', path)) || (await this.tryShow('HEAD', path))
        return { path, staged: false, oldText, newText: '' }
      }
      const oldText =
        (await this.tryShow(':0', path)) || (await this.tryShow('HEAD', path))
      let newText = ''
      try {
        newText = await this.readWorktree(path)
      } catch {
        newText = ''
      }
      return { path, staged: false, oldText, newText }
    } catch (err) {
      return {
        path,
        staged,
        oldText: '',
        newText: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async stage(paths: string[]): Promise<GitOkResult> {
    const list = paths.map(normalizeRel).filter(Boolean)
    if (!list.length) return { ok: false, error: 'No paths' }
    try {
      await this.git(['add', '--', ...list])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async unstage(paths: string[]): Promise<GitOkResult> {
    const list = paths.map(normalizeRel).filter(Boolean)
    if (!list.length) return { ok: false, error: 'No paths' }
    try {
      await this.git(['restore', '--staged', '--', ...list])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async stageAll(): Promise<GitOkResult> {
    try {
      await this.git(['add', '-A'])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async unstageAll(): Promise<GitOkResult> {
    try {
      await this.git(['restore', '--staged', ':/'])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async commit(message: string): Promise<GitOkResult> {
    const msg = message.trim()
    if (!msg) return { ok: false, error: 'Empty commit message' }
    try {
      await this.git(['commit', '-m', msg])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async fetch(): Promise<GitOkResult> {
    try {
      await this.git(['fetch', '--prune'], 60_000)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async pull(): Promise<GitOkResult> {
    try {
      await this.git(['pull', '--ff-only'], 60_000)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async push(): Promise<GitOkResult> {
    try {
      await this.git(['push'], 60_000)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  async log(limit = 40): Promise<GitCommitNode[]> {
    if (!this.root) return []
    try {
      const n = Math.max(1, Math.min(limit, 100))
      // NUL-separated fields after optional graph prefix (ends at first TAB)
      const { stdout } = await this.git([
        '-c',
        'core.quotepath=false',
        'log',
        '--graph',
        `--pretty=format:%x09%H%x00%h%x00%P%x00%s%x00%an%x00%ad`,
        '--date=short',
        `-n${n}`
      ])
      return parseLog(stdout)
    } catch {
      return []
    }
  }

  async show(hash: string): Promise<GitCommitDetail> {
    const empty: GitCommitDetail = {
      hash,
      shortHash: hash.slice(0, 7),
      subject: '',
      body: '',
      author: '',
      date: '',
      patch: ''
    }
    if (!this.root || !hash) return { ...empty, error: 'Missing hash' }
    try {
      const meta = (
        await this.git([
          'show',
          '-s',
          '--format=%H%n%h%n%s%n%b%n--ENDBODY--%n%an%n%ad',
          '--date=iso-strict',
          hash
        ])
      ).stdout
      const lines = meta.split(/\r?\n/)
      const full = lines[0] ?? hash
      const short = lines[1] ?? hash.slice(0, 7)
      const subject = lines[2] ?? ''
      let i = 3
      const bodyLines: string[] = []
      while (i < lines.length && lines[i] !== '--ENDBODY--') {
        bodyLines.push(lines[i]!)
        i++
      }
      i++ // skip marker
      const author = lines[i++] ?? ''
      const date = lines[i++] ?? ''
      const patch = (await this.git(['show', '--format=', '--patch', '--stat', hash])).stdout
      return {
        hash: full,
        shortHash: short,
        subject,
        body: bodyLines.join('\n').trim(),
        author,
        date,
        patch
      }
    } catch (err) {
      return { ...empty, error: errMsg(err) }
    }
  }

  private async git(
    args: string[],
    timeoutMs = TIMEOUT_MS
  ): Promise<{ stdout: string; stderr: string }> {
    if (!this.root) throw new Error('No git root')
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.root,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf8'
      })
      return { stdout: String(stdout), stderr: String(stderr) }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const msg = (e.stderr || e.stdout || e.message || String(err)).trim()
      throw new Error(msg || 'git failed')
    }
  }

  private async readWorktree(rel: string): Promise<string> {
    return readFile(join(this.root, rel), 'utf8')
  }

  private async tryShow(rev: string, rel: string): Promise<string> {
    try {
      const spec = rev === ':0' ? `:0:${rel}` : `${rev}:${rel}`
      return (await this.git(['show', spec])).stdout
    } catch {
      return ''
    }
  }
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parsePorcelain(text: string): GitFileChange[] {
  const out: GitFileChange[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.length < 3) continue
    const indexStatus = raw[0] ?? ' '
    const workTreeStatus = raw[1] ?? ' '
    let rest = raw.slice(3)
    // rename/copy: "R  old -> new" or "R100 old -> new" already sliced past XY+space
    if (rest.includes(' -> ')) {
      const parts = rest.split(' -> ')
      rest = parts[parts.length - 1]!.trim()
    }
    // quoted paths
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1).replace(/\\([\\"ntr])/g, (_, c: string) => {
        if (c === 'n') return '\n'
        if (c === 't') return '\t'
        if (c === 'r') return '\r'
        return c
      })
    }
    out.push({
      path: normalizeRel(rest),
      indexStatus,
      workTreeStatus
    })
  }
  return out
}

function parseLog(stdout: string): GitCommitNode[] {
  const nodes: GitCommitNode[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('\t')) continue
    const tab = line.indexOf('\t')
    const graph = line.slice(0, tab).trimEnd()
    const fields = line.slice(tab + 1).split('\0')
    if (fields.length < 6) continue
    const [hash, shortHash, parents, subject, author, date] = fields
    if (!hash) continue
    nodes.push({
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      parents: (parents || '').split(' ').filter(Boolean),
      subject: subject || '',
      author: author || '',
      date: date || '',
      graph
    })
  }
  return nodes
}
