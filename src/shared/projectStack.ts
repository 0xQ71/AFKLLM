export type StackId =
  | 'node'
  | 'python'
  | 'java-maven'
  | 'java-gradle'
  | 'dotnet'
  | 'go'
  | 'rust'
  | 'cmake'
  | 'make'
  | 'html'

export type VerifyMode = 'build' | 'test' | 'lint' | 'run'

export interface ProjectStack {
  id: StackId
  label: string
  markers: string[]
  build?: string
  test?: string
  lint?: string
  run?: string
  sourceGlobs: string[]
  ignoreDirs: string[]
}

export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'coverage',
  '.cache',
  'target',
  'build',
  '.gradle',
  'bin',
  'obj',
  'vendor',
  '__pycache__',
  '.venv',
  'cmake-build-debug',
  'cmake-build-release'
] as const

export const STACK_CATALOG: ProjectStack[] = [
  {
    id: 'node',
    label: 'Node.js / TypeScript',
    markers: ['package.json'],
    build: 'npx --no-install tsc --noEmit -p tsconfig.json',
    test: 'npm test',
    lint: 'npx --no-install eslint .',
    run: 'npm start',
    sourceGlobs: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'python',
    label: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    test: 'python -m pytest -q',
    lint: 'python -m ruff check .',
    run: 'python -m',
    sourceGlobs: ['**/*.py'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'java-maven',
    label: 'Java (Maven)',
    markers: ['pom.xml'],
    build: 'mvn -q -DskipTests compile',
    test: 'mvn -q test',
    sourceGlobs: ['**/*.java'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'java-gradle',
    label: 'Java (Gradle)',
    markers: ['build.gradle', 'build.gradle.kts'],
    build: 'gradle compileJava -q',
    test: 'gradle test -q',
    sourceGlobs: ['**/*.java', '**/*.kt'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'dotnet',
    label: 'C# / .NET',
    markers: ['.csproj', '.sln'],
    build: 'dotnet build --nologo -v q',
    test: 'dotnet test --nologo -v q',
    sourceGlobs: ['**/*.cs'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'go',
    label: 'Go',
    markers: ['go.mod'],
    build: 'go build ./...',
    test: 'go test ./...',
    sourceGlobs: ['**/*.go'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'rust',
    label: 'Rust',
    markers: ['Cargo.toml'],
    build: 'cargo build --quiet',
    test: 'cargo test --quiet',
    lint: 'cargo clippy --quiet -- -D warnings',
    sourceGlobs: ['**/*.rs'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'cmake',
    label: 'C / C++ (CMake)',
    markers: ['CMakeLists.txt'],
    build: 'cmake --build build',
    test: 'ctest --test-dir build --output-on-failure',
    sourceGlobs: ['**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'make',
    label: 'Make',
    markers: ['Makefile', 'makefile'],
    build: 'make',
    test: 'make test',
    sourceGlobs: ['**/*.{c,cc,cpp,h,py,sh}'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  },
  {
    id: 'html',
    label: 'Static HTML',
    markers: ['index.html'],
    // No build/test/lint — verify_project does a one-shot entry check instead.
    sourceGlobs: ['**/*.{html,css,js}'],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS]
  }
]

const EXT_MARKERS = new Set(['.csproj', '.sln'])

export function markerMatches(fileName: string, marker: string): boolean {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName
  if (marker.startsWith('.')) {
    return base.toLowerCase().endsWith(marker.toLowerCase())
  }
  return base.toLowerCase() === marker.toLowerCase()
}

/** Detect stacks from a list of relative file paths (and optional package.json body). */
export function detectStacks(
  files: string[],
  opts?: { packageJson?: string | null }
): ProjectStack[] {
  const names = files.map((f) => f.replace(/\\/g, '/'))
  const hit: ProjectStack[] = []
  for (const stack of STACK_CATALOG) {
    const matched = stack.markers.some((m) =>
      names.some((n) => markerMatches(n, m) || (EXT_MARKERS.has(m) && n.toLowerCase().endsWith(m)))
    )
    if (!matched) continue
    if (stack.id === 'node') {
      hit.push(refineNodeStack(stack, opts?.packageJson ?? null))
      continue
    }
    hit.push(stack)
  }
  return hit
}

function nodeRunCommand(scripts: Record<string, string>): string | undefined {
  if (String(scripts.dev ?? '').trim()) return 'npm run dev'
  if (String(scripts.start ?? '').trim()) return 'npm start'
  return undefined
}

function refineNodeStack(base: ProjectStack, pkgRaw: string | null): ProjectStack {
  if (!pkgRaw) return base
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    const run = nodeRunCommand(scripts)
    return {
      ...base,
      test: scripts.test ? 'npm test' : base.test,
      lint: scripts.lint ? 'npm run lint' : base.lint,
      build: scripts.build ? 'npm run build' : base.build,
      ...(run ? { run } : { run: undefined })
    }
  } catch {
    return base
  }
}

export function commandForMode(stack: ProjectStack, mode: VerifyMode): string | null {
  const cmd = stack[mode]
  return cmd && cmd.trim() ? cmd : null
}

export function formatStackPromptSection(stacks: ProjectStack[]): string {
  if (stacks.length === 0) {
    return (
      'Project stack: unknown (no pom.xml / package.json / go.mod / Cargo.toml / CMakeLists.txt / ' +
      '*.csproj / requirements.txt / Makefile / index.html at repo root). ' +
      'Discover the stack with list_directory, then verify with the language’s real compiler/tests. ' +
      'Do not claim done without a command that exited 0.'
    )
  }
  const lines = stacks.map((s) => {
    if (s.id === 'html') {
      return (
        `- ${s.label} (${s.markers.join(', ')}) — no build/test. ` +
        `Verify ONCE: confirm index.html exists (verify_project) or Start-Process (Resolve-Path .\\index.html). ` +
        `FORBIDDEN: Get-ChildItem -Recurse, repeated Test-Path, Test-Path -And chains.`
      )
    }
    const cmds = (
      [
        s.build && `build: ${s.build}`,
        s.test && `test: ${s.test}`,
        s.lint && `lint: ${s.lint}`,
        s.run && `run: ${s.run}`
      ] as Array<string | false | undefined>
    ).filter(Boolean)
    return `- ${s.label} (${s.markers.join(', ')})${cmds.length ? ` — ${cmds.join('; ')}` : ' — no standard verify command'}`
  })
  const hasCompiler = stacks.some((s) => Boolean(s.build || s.test || s.lint || s.run))
  return (
    'Detected project stack(s):\n' +
    lines.join('\n') +
    (hasCompiler
      ? '\nUse verify_project (build/test/lint) ONCE or execute_terminal_command with these commands. ' +
        'Never claim tests/build passed unless the latest command returned exit_code=0. ' +
        'Do not recurse the whole tree to "verify".'
      : '\nNo compiler/tests for this stack — one preview/open is enough. Do not spam shell checks.')
  )
}
