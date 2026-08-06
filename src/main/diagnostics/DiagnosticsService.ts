import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  parseEslintJson,
  parseTscOutput,
  type DiagnosticItem,
  type DiagnosticsSnapshot
} from '../../shared/diagnostics'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 60_000

export class DiagnosticsService {
  private root = ''
  private running = false
  private last: DiagnosticsSnapshot = {
    items: [],
    updatedAt: 0,
    note: 'Not run yet'
  }
  private timer: ReturnType<typeof setTimeout> | null = null
  private onChange: ((snap: DiagnosticsSnapshot) => void) | null = null

  setRoot(root: string): void {
    this.root = root
  }

  setOnChange(cb: ((snap: DiagnosticsSnapshot) => void) | null): void {
    this.onChange = cb
  }

  getLast(): DiagnosticsSnapshot {
    return { ...this.last, items: [...this.last.items] }
  }

  /** Debounced auto-run after workspace file changes. */
  schedule(delayMs = 1_500): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.run()
    }, delayMs)
  }

  async run(): Promise<DiagnosticsSnapshot> {
    if (!this.root) {
      this.last = {
        items: [],
        note: 'No workspace open',
        updatedAt: Date.now()
      }
      this.onChange?.(this.getLast())
      return this.getLast()
    }
    if (this.running) return this.getLast()
    this.running = true
    this.last = { ...this.last, running: true }
    this.onChange?.(this.getLast())

    try {
      const items: DiagnosticItem[] = []
      const notes: string[] = []

      const tscItems = await this.runTsc()
      if (tscItems === null) notes.push('tsc not found')
      else items.push(...tscItems)

      const eslintItems = await this.runEslint()
      if (eslintItems === null) notes.push('eslint not found / no config')
      else items.push(...eslintItems)

      const note =
        items.length === 0 && notes.length === 2
          ? 'No tsc/eslint in project'
          : items.length === 0 && notes.length > 0
            ? notes.join(' · ')
            : items.length === 0
              ? 'No tsc/eslint issues'
              : undefined

      this.last = {
        items,
        note,
        running: false,
        updatedAt: Date.now()
      }
    } catch (e) {
      this.last = {
        items: [],
        note: e instanceof Error ? e.message : String(e),
        running: false,
        updatedAt: Date.now()
      }
    } finally {
      this.running = false
    }
    this.onChange?.(this.getLast())
    return this.getLast()
  }

  private bin(name: string): string | null {
    const base = join(this.root, 'node_modules', '.bin')
    const win = process.platform === 'win32'
    const candidates = win
      ? [join(base, `${name}.cmd`), join(base, `${name}.exe`), join(base, name)]
      : [join(base, name)]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return null
  }

  private async runTsc(): Promise<DiagnosticItem[] | null> {
    const tscBin = this.bin('tsc')
    const configs = await this.findTsconfigs()
    if (!tscBin && configs.length === 0) return null

    const all: DiagnosticItem[] = []
    const targets = configs.length > 0 ? configs : ['tsconfig.json']
    let attempted = false

    for (const cfg of targets.slice(0, 3)) {
      const cfgPath = join(this.root, cfg)
      if (!existsSync(cfgPath)) continue
      attempted = true
      const args = ['-p', cfg, '--noEmit', '--pretty', 'false']
      try {
        const { stdout, stderr } = tscBin
          ? await execFileAsync(tscBin, args, {
              cwd: this.root,
              timeout: TIMEOUT_MS,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
              shell: process.platform === 'win32'
            })
          : await execFileAsync(
              process.platform === 'win32' ? 'npx.cmd' : 'npx',
              ['--no-install', 'tsc', ...args],
              {
                cwd: this.root,
                timeout: TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024,
                windowsHide: true,
                shell: true
              }
            )
        all.push(...parseTscOutput(`${stdout}\n${stderr}`, this.root))
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string }
        const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
        if (text.trim()) {
          all.push(...parseTscOutput(text, this.root))
        }
      }
    }

    if (!attempted && !tscBin) return null
    return all
  }

  private async findTsconfigs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root)
      const configs = entries.filter((n) => /^tsconfig(\..+)?\.json$/i.test(n))
      const usable: string[] = []
      for (const name of configs) {
        // Skip solution-style roots (files: [] + references only) — tsc -p them is noisy.
        if (name === 'tsconfig.json') {
          try {
            const raw = await fs.readFile(join(this.root, name), 'utf8')
            const json = JSON.parse(raw) as {
              files?: unknown[]
              include?: unknown[]
              references?: unknown[]
            }
            const emptyFiles = Array.isArray(json.files) && json.files.length === 0
            const noInclude = !json.include || (Array.isArray(json.include) && json.include.length === 0)
            if (emptyFiles && noInclude && Array.isArray(json.references) && json.references.length > 0) {
              continue
            }
          } catch {
            /* keep */
          }
        }
        usable.push(name)
      }
      return usable.sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  private async hasEslintConfig(): Promise<boolean> {
    const names = [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml'
    ]
    for (const n of names) {
      if (existsSync(join(this.root, n))) return true
    }
    try {
      const pkg = JSON.parse(
        await fs.readFile(join(this.root, 'package.json'), 'utf8')
      ) as { eslintConfig?: unknown }
      if (pkg.eslintConfig) return true
    } catch {
      /* ignore */
    }
    return false
  }

  private async runEslint(): Promise<DiagnosticItem[] | null> {
    if (!(await this.hasEslintConfig())) return null
    const eslintBin = this.bin('eslint')
    if (!eslintBin) return null

    try {
      const { stdout } = await execFileAsync(
        eslintBin,
        ['.', '-f', 'json', '--max-warnings', '99999'],
        {
          cwd: this.root,
          timeout: TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          shell: process.platform === 'win32'
        }
      )
      return parseEslintJson(stdout || '[]', this.root)
    } catch (e: unknown) {
      const err = e as { stdout?: string }
      if (err.stdout?.trim()) {
        return parseEslintJson(err.stdout, this.root)
      }
      return []
    }
  }
}
