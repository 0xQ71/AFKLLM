import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type {
  LspDefinitionResult,
  LspDocumentSymbol,
  LspDocumentSymbolsResult,
  LspHoverResult,
  LspLocation,
  LspReferencesResult,
  LspStatus
} from '../../shared/lsp'

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.next',
  'coverage',
  '.cache',
  'bin',
  'models',
  '.cursor'
])

const MAX_FILE_BYTES = 400_000
const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** In-process TS LanguageService for definition / hover / refs. */
export class TsLanguageService {
  private root = ''
  private service: ts.LanguageService | null = null
  private versions = new Map<string, number>()
  private fileNames: string[] = []
  /** Unsaved editor buffers keyed by normalized absolute path. */
  private overlays = new Map<string, string>()
  private options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false
  }

  setRoot(root: string): void {
    this.root = resolve(root)
    this.disposeService()
    this.versions.clear()
    this.overlays.clear()
    this.fileNames = []
  }

  invalidate(_paths: string[] = []): void {
    // Drop disk-backed cache; keep open-buffer overlays.
    this.disposeService()
    this.fileNames = []
  }

  /** Push open-editor text so hover/def use buffer, not stale disk. */
  setOverlay(relPath: string, content: string | null): void {
    const abs = this.toAbs(relPath)
    if (!abs) return
    const key = this.norm(abs)
    if (content == null) {
      this.overlays.delete(key)
    } else {
      this.overlays.set(key, content)
    }
    this.versions.set(key, (this.versions.get(key) ?? 1) + 1)
  }

  getStatus(): LspStatus {
    return {
      root: this.root || null,
      ready: Boolean(this.root),
      fileCount: this.fileNames.length
    }
  }

  ensureReady(): void {
    if (!this.root) return
    if (this.service) return
    this.rebuild()
  }

  getDefinitionAt(
    relPath: string,
    line: number,
    column: number
  ): LspDefinitionResult {
    try {
      this.ensureReady()
      if (!this.service) {
        return { ok: false, locations: [], error: 'LSP not ready' }
      }
      const fileName = this.toAbs(relPath)
      if (!fileName) {
        return { ok: false, locations: [], error: 'Invalid path' }
      }
      this.touchFile(fileName)
      const pos = this.offsetOf(fileName, line, column)
      if (pos == null) {
        return { ok: false, locations: [], error: 'Position out of range' }
      }
      const defs =
        this.service.getDefinitionAtPosition(fileName, pos) ??
        this.service.getTypeDefinitionAtPosition(fileName, pos) ??
        []
      const locations: LspLocation[] = []
      for (const d of defs) {
        const loc = this.defToLocation(d)
        if (loc) locations.push(loc)
      }
      return { ok: true, locations }
    } catch (e) {
      return {
        ok: false,
        locations: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  getHoverAt(
    relPath: string,
    line: number,
    column: number,
    content?: string
  ): LspHoverResult {
    try {
      this.ensureReady()
      if (!this.service) {
        return { ok: false, error: 'LSP not ready' }
      }
      const fileName = this.toAbs(relPath)
      if (!fileName) return { ok: false, error: 'Invalid path' }
      if (typeof content === 'string') {
        this.setOverlay(relPath, content)
      }
      this.touchFile(fileName)
      const pos = this.offsetOf(fileName, line, column)
      if (pos == null) return { ok: false, error: 'Position out of range' }
      const info = this.service.getQuickInfoAtPosition(fileName, pos)
      if (!info) return { ok: true, contents: undefined }
      const parts = [
        ts.displayPartsToString(info.displayParts),
        info.documentation?.length
          ? ts.displayPartsToString(info.documentation)
          : '',
        info.tags?.length
          ? info.tags
              .map((t) =>
                `@${t.name}${t.text?.length ? ' — ' + ts.displayPartsToString(t.text) : ''}`
              )
              .join('\n')
          : ''
      ].filter(Boolean)
      return { ok: true, contents: parts.join('\n\n') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  getReferencesAt(
    relPath: string,
    line: number,
    column: number
  ): LspReferencesResult {
    try {
      this.ensureReady()
      if (!this.service) {
        return { ok: false, locations: [], error: 'LSP not ready' }
      }
      const fileName = this.toAbs(relPath)
      if (!fileName) {
        return { ok: false, locations: [], error: 'Invalid path' }
      }
      this.touchFile(fileName)
      const pos = this.offsetOf(fileName, line, column)
      if (pos == null) {
        return { ok: false, locations: [], error: 'Position out of range' }
      }
      const refs =
        this.service.getReferencesAtPosition(fileName, pos) ?? []
      const locations: LspLocation[] = []
      for (const r of refs) {
        const loc = this.refToLocation(r)
        if (loc) locations.push(loc)
      }
      return { ok: true, locations }
    } catch (e) {
      return {
        ok: false,
        locations: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  getDocumentSymbols(relPath: string): LspDocumentSymbolsResult {
    try {
      this.ensureReady()
      if (!this.service) {
        return { ok: false, symbols: [], error: 'LSP not ready' }
      }
      const fileName = this.toAbs(relPath)
      if (!fileName) {
        return { ok: false, symbols: [], error: 'Invalid path' }
      }
      this.touchFile(fileName)
      const nav = this.service.getNavigationTree(fileName)
      if (!nav) return { ok: true, symbols: [] }
      const symbols: LspDocumentSymbol[] = []
      const walk = (node: ts.NavigationTree, depth: number): void => {
        const kind = String(node.kind || '')
        const skipRoot =
          depth === 0 &&
          (kind === 'script' || kind === 'module' || node.text === '<unknown>')
        if (!skipRoot && node.nameSpan) {
          const loc = this.spanToLocation(fileName, node.nameSpan)
          if (loc) {
            symbols.push({
              name: node.text || '(anonymous)',
              kind: kind || 'unknown',
              line: loc.line,
              column: loc.column,
              endLine: loc.endLine,
              endColumn: loc.endColumn,
              depth: Math.max(0, depth - 1)
            })
          }
        }
        for (const child of node.childItems ?? []) {
          walk(child, depth + 1)
        }
      }
      walk(nav, 0)
      return { ok: true, symbols }
    } catch (e) {
      return {
        ok: false,
        symbols: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  private rebuild(): void {
    this.loadTsconfig()
    this.fileNames = this.collectFiles()
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: (fileName) =>
        String(this.versions.get(this.norm(fileName)) ?? 1),
      getScriptSnapshot: (fileName) => {
        try {
          const overlay = this.overlays.get(this.norm(fileName))
          if (overlay != null) return ts.ScriptSnapshot.fromString(overlay)
          const st = statSync(fileName)
          if (st.size > MAX_FILE_BYTES) return undefined
          const text = readFileSync(fileName, 'utf8')
          return ts.ScriptSnapshot.fromString(text)
        } catch {
          return undefined
        }
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath
    }
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  private loadTsconfig(): void {
    const configPath = ts.findConfigFile(
      this.root,
      ts.sys.fileExists,
      'tsconfig.json'
    )
    if (!configPath) return
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (read.error) return

    const refs = (read.config?.references ?? []) as Array<{ path?: string }>
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(configPath)
    )

    // Solution-style root (files: [] + references) — load leaf projects.
    if (parsed.fileNames.length === 0 && refs.length > 0) {
      const allFiles: string[] = []
      let merged: ts.CompilerOptions = { ...this.options }
      for (const ref of refs) {
        if (!ref.path) continue
        const refConfig = resolve(dirname(configPath), ref.path)
        const refPath = existsSync(refConfig)
          ? refConfig
          : existsSync(refConfig + '.json')
            ? refConfig + '.json'
            : null
        if (!refPath) continue
        const refRead = ts.readConfigFile(refPath, ts.sys.readFile)
        if (refRead.error) continue
        const refParsed = ts.parseJsonConfigFileContent(
          refRead.config,
          ts.sys,
          dirname(refPath)
        )
        merged = {
          ...merged,
          ...refParsed.options,
          allowJs: true,
          skipLibCheck: true,
          jsx: refParsed.options.jsx ?? ts.JsxEmit.ReactJSX
        }
        for (const f of refParsed.fileNames) {
          try {
            if (statSync(f).size <= MAX_FILE_BYTES) allFiles.push(f)
          } catch {
            /* skip */
          }
        }
      }
      this.options = merged
      if (allFiles.length) this.fileNames = allFiles
      return
    }

    this.options = {
      ...parsed.options,
      allowJs: true,
      skipLibCheck: true
    }
    if (parsed.fileNames.length) {
      this.fileNames = parsed.fileNames.filter((f) => {
        try {
          return statSync(f).size <= MAX_FILE_BYTES
        } catch {
          return false
        }
      })
    }
  }

  private collectFiles(): string[] {
    if (this.fileNames.length) return this.fileNames
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 10 || out.length >= 4_000) return
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (IGNORED.has(name) || name.startsWith('.')) continue
        const abs = join(dir, name)
        let st
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(abs, depth + 1)
        } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
          const ext = name.includes('.')
            ? name.slice(name.lastIndexOf('.')).toLowerCase()
            : ''
          if (SCRIPT_EXTS.has(ext)) out.push(abs)
        }
      }
    }
    walk(this.root, 0)
    return out
  }

  private touchFile(abs: string): void {
    const key = this.norm(abs)
    if (!this.fileNames.includes(abs) && !this.fileNames.some((f) => this.norm(f) === key)) {
      this.fileNames = [...this.fileNames, abs]
    }
    this.versions.set(key, (this.versions.get(key) ?? 1) + 1)
  }

  private offsetOf(
    fileName: string,
    line: number,
    column: number
  ): number | null {
    const overlay = this.overlays.get(this.norm(fileName))
    let text: string | undefined = overlay
    if (text == null) {
      try {
        text = readFileSync(fileName, 'utf8')
      } catch {
        return null
      }
    }
    const snap = this.service?.getProgram()?.getSourceFile(fileName)
    const sf =
      snap && snap.text === text
        ? snap
        : ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    try {
      return sf.getPositionOfLineAndCharacter(
        Math.max(0, line - 1),
        Math.max(0, column - 1)
      )
    } catch {
      return null
    }
  }

  private defToLocation(d: ts.DefinitionInfo): LspLocation | null {
    return this.spanInFile(d.fileName, d.textSpan)
  }

  private refToLocation(r: ts.ReferenceEntry): LspLocation | null {
    return this.spanInFile(r.fileName, r.textSpan)
  }

  private spanToLocation(
    absFile: string,
    span: ts.TextSpan
  ): LspLocation | null {
    return this.spanInFile(absFile, span)
  }

  private spanInFile(file: string, span: ts.TextSpan): LspLocation | null {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const start = sf.getLineAndCharacterOfPosition(span.start)
    const end = sf.getLineAndCharacterOfPosition(span.start + span.length)
    const rel = relative(this.root, file).split(sep).join('/')
    if (rel.startsWith('..')) return null
    return {
      path: rel,
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1
    }
  }

  private toAbs(relPath: string): string | null {
    if (!this.root) return null
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    const abs = resolve(this.root, cleaned)
    if (!abs.startsWith(this.root) && abs.toLowerCase() !== this.root.toLowerCase()) {
      if (!abs.toLowerCase().startsWith(this.root.toLowerCase())) return null
    }
    return abs
  }

  private norm(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase()
  }

  private disposeService(): void {
    this.service?.dispose()
    this.service = null
  }
}

/** Smoke: cross-file definition without Electron. */
export async function smokeDefinitionFixture(): Promise<LspLocation[]> {
  const os = await import('node:os')
  const path = await import('node:path')
  const fsp = await import('node:fs/promises')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'afkllm-lsp-'))
  try {
    await fsp.writeFile(
      path.join(dir, 'lib.ts'),
      'export function greet(name: string): string {\n  return name\n}\n',
      'utf8'
    )
    await fsp.writeFile(
      path.join(dir, 'main.ts'),
      "import { greet } from './lib'\nconst x = greet('hi')\n",
      'utf8'
    )
    const svc = new TsLanguageService()
    svc.setRoot(dir)
    const res = svc.getDefinitionAt('main.ts', 2, 11)
    return res.locations
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/** Smoke: refs + outline without Electron. */
export async function smokeReferencesAndOutlineFixture(): Promise<{
  refs: number
  symbols: number
}> {
  const os = await import('node:os')
  const path = await import('node:path')
  const fsp = await import('node:fs/promises')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'afkllm-lsp-ref-'))
  try {
    await fsp.writeFile(
      path.join(dir, 'lib.ts'),
      'export function greet(name: string): string {\n  return name\n}\n',
      'utf8'
    )
    await fsp.writeFile(
      path.join(dir, 'main.ts'),
      "import { greet } from './lib'\nconst x = greet('hi')\nconst y = greet('yo')\n",
      'utf8'
    )
    const svc = new TsLanguageService()
    svc.setRoot(dir)
    const refs = svc.getReferencesAt('main.ts', 2, 11)
    const symbols = svc.getDocumentSymbols('lib.ts')
    return {
      refs: refs.locations.length,
      symbols: symbols.symbols.length
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

export function pathExists(p: string): boolean {
  return existsSync(p)
}
