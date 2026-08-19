export type EvidenceKind =
  | 'write_ok'
  | 'mkdir_ok'
  | 'patch_ok'
  | 'shell_ok'
  | 'shell_fail'
  | 'verify_ok'
  | 'verify_fail'
  | 'preview_ok'
  | 'search_ok'

export interface StepEvidence {
  kind: EvidenceKind
  tool: string
  ok: boolean
  path?: string
  command?: string
  exitCode?: number
  at: number
}

export function recordEvidence(
  log: StepEvidence[],
  entry: Omit<StepEvidence, 'at'>
): StepEvidence[] {
  return [...log, { ...entry, at: Date.now() }]
}

export function evidenceFromTool(opts: {
  name: string
  ok: boolean
  path?: string
  command?: string
  content?: string
}): Omit<StepEvidence, 'at'> | null {
  const { name, ok, path, command, content } = opts
  if (name === 'write_file') {
    return { kind: 'write_ok', tool: name, ok, path }
  }
  if (name === 'apply_patch' || name === 'apply_diff') {
    return { kind: 'patch_ok', tool: name, ok, path }
  }
  if (name === 'web_search') {
    return { kind: 'search_ok', tool: name, ok }
  }
  if (name === 'verify_project') {
    return {
      kind: ok ? 'verify_ok' : 'verify_fail',
      tool: name,
      ok,
      command,
      exitCode: parseExitCode(content)
    }
  }
  if (name === 'execute_terminal_command') {
    const exit = parseExitCode(content)
    const preview = /PREVIEW_URL|PREVIEW_OK|Opened .*preview|AFKLLM Browser/i.test(content ?? '')
    if (preview && ok) {
      return { kind: 'preview_ok', tool: name, ok: true, command }
    }
    return {
      kind: ok && (exit === 0 || exit == null) ? 'shell_ok' : 'shell_fail',
      tool: name,
      ok,
      command,
      exitCode: exit
    }
  }
  if (name === 'create_directory') {
    return { kind: ok ? 'mkdir_ok' : 'shell_fail', tool: name, ok, path }
  }
  if (name === 'delete_file' || name === 'generate_image') {
    return { kind: ok ? 'write_ok' : 'shell_fail', tool: name, ok, path }
  }
  return null
}

/** Real compile argv — not `where cl.exe` / Get-Command. */
export function looksLikeCompileShellCommand(command: string): boolean {
  const c = command ?? ''
  if (!c.trim()) return false
  if (
    /\bwhere(?:\.exe)?\b|\bGet-Command\b|\bTest-Path\b/i.test(c) &&
    !/\b(?:g\+\+|gcc|cl(?:\.exe)?)\s+[-/]|\bjavac\s+\S/i.test(c)
  ) {
    return false
  }
  return (
    /\bg\+\+\s|\bgcc\s+-|\bclang(?:\+\+)?\s|\bjavac\s+\S|\bcargo\s+build|\bgo\s+build|\bdotnet\s+build|\bnpm\s+run\s+build|\bmvn\s|\bgradle\s|\bcmake\s/i.test(
      c
    ) || /\bcl(?:\.exe)?\s+(\/|\S)/i.test(c)
  )
}

function parseExitCode(content?: string): number | undefined {
  if (!content) return undefined
  const m = content.match(/exit_code=(-?\d+)/i)
  if (!m) return undefined
  return Number(m[1])
}

/** A plan row may close only when evidence matches that row — never “any tool succeeded”. */
export function evidenceSupportsStep(stepText: string, log: StepEvidence[]): boolean {
  const t = stepText.toLowerCase()
  const okWrites = log.filter(
    (e) => e.ok && (e.kind === 'write_ok' || e.kind === 'patch_ok')
  )
  const okShell = log.filter(
    (e) => e.ok && (e.kind === 'shell_ok' || e.kind === 'verify_ok' || e.kind === 'preview_ok')
  )
  const okSearch = log.filter((e) => e.ok && e.kind === 'search_ok')
  const okMkdir = log.filter((e) => e.ok && e.kind === 'mkdir_ok')

  // Closing prose is not a tool step — never tick from go mod / a random shell.
  if (
    /оформить\s+итог|итоговую\s+сводк|кратк\w+\s+заключен|closing summary|напиши\s+заключен/i.test(
      t
    )
  ) {
    return false
  }

  if (
    /web_search|поиск\s+в\s+интернет|искать\s+в\s+интернет|search\s+the\s+web|актуальн\w+\s+верси|найти\s+.*lts|погод|weather/i.test(
      t
    )
  ) {
    return okSearch.length > 0
  }
  if (/go\.mod|go\s+mod|инициализир\w*\s+модул/i.test(t)) {
    return (
      okShell.some((e) => /go\s+mod/i.test(e.command ?? '')) ||
      okWrites.some((e) => /go\.mod$/i.test((e.path ?? '').replace(/\\/g, '/')))
    )
  }
  if (
    /pytest|junit|cargo\s+test|go\s+test|dotnet\s+test|npm\s+test|node\s+--test/i.test(t) ||
    /(?:запустить|прогнать|run)\s+(?:the\s+)?(?:тесты|тест|tests?)(?=$|[^\p{L}])/iu.test(t) ||
    /(?:^|[^\p{L}])тесты(?:$|[^\p{L}])/iu.test(t)
  ) {
    return okShell.some((e) =>
      /test|pytest|gradle test|mvn .*test|cargo test|go test|dotnet test/i.test(
        e.command ?? ''
      )
    )
  }
  // "скриптами для dev и build" on a package.json row is NOT cargo/mvn compile.
  if (
    !/package\.json/i.test(t) &&
    /сборк|собрать|compile|javac|g\+\+|clang|\bcl\b|gcc |mvn |gradle |cmake|cargo build|go build|dotnet build|npm run build/i.test(
      t
    )
  ) {
    return okShell.some((e) => looksLikeCompileShellCommand(e.command ?? ''))
  }
  if (/открыть|превью|preview|browser|браузер|start-process/i.test(t)) {
    return okShell.some((e) => e.kind === 'preview_ok')
  }
  if (
    /curl\s+-I|страница\s+загрузил|без\s+ошибок\s+загруз/i.test(t) ||
    (/\bcurl\b|\binvoke-webrequest\b|\biwr\b/i.test(t) && /localhost|127\.0\.0\.1/i.test(t))
  ) {
    return okShell.some((e) => e.kind === 'preview_ok')
  }
  if (
    /заменить|исправить|починить|поправ(?:ить|ь)|править\s+логик|fix\s|replace |patch /i.test(t) &&
    !/запустить|go\s+run|node\s+test/i.test(t)
  ) {
    const codeWrites = okWrites.filter((e) =>
      /\.(html?|css|jsx?|mjs|cjs|tsx?|py|java|cs|go|rs|c|cpp|h|kt)$/i.test(e.path ?? '')
    )
    if (codeWrites.length === 0) return false
    const named = t.match(
      /[\w./\\-]+\.(html?|css|js|ts|tsx|jsx|py|java|cs|go|rs|c|cpp|h|kt)/i
    )
    if (named) {
      const want = named[0]!.replace(/\\/g, '/').toLowerCase()
      return codeWrites.some((e) =>
        (e.path ?? '').replace(/\\/g, '/').toLowerCase().endsWith(want)
      )
    }
    return true
  }
  // "Confirm exit code is 0 and output contains expected top words" is a
  // verify row, not a second compile — a successful go run / python ticks it.
  if (
    /confirm\s+(exit|output|stdout|результат)|exit\s+code|код\s+возврата|output\s+contains|вывод\s+содержит|expected\s+top/i.test(
      t
    ) ||
    (/^(confirm|verify|validate)\b/i.test(t) && /exit|output|stdout|вывод|код/i.test(t))
  ) {
    const runShell = okShell.filter((e) => !/go\s+mod\b/i.test(e.command ?? ''))
    return runShell.length > 0
  }
  if (/(?:^|[^\p{L}])запустить|(?:^|[^\p{L}])run(?:$|[^\p{L}])|выполнить|go\s+run|через\s+terminal/iu.test(t)) {
    const runShell = okShell.filter((e) => !/go\s+mod\b/i.test(e.command ?? ''))
    if (runShell.length === 0) return false
    if (/go\s+run/i.test(t)) {
      return runShell.some((e) => /go\s+run/i.test(e.command ?? ''))
    }
    if (/node\s+test/i.test(t)) {
      return runShell.some((e) => /node\s+test/i.test(e.command ?? ''))
    }
    if (/npm\s+run\s+dev|\bvite\b|dev[- ]server|превью\s+игр/i.test(t)) {
      return (
        runShell.some((e) => /npm\s+run\s+dev|\bvite\b/i.test(e.command ?? '')) ||
        okShell.some((e) => e.kind === 'preview_ok')
      )
    }
    return runShell.length > 0
  }
  const namedFile = t.match(
    /[\w./\\-]+\.(html?|css|js|ts|tsx|jsx|py|java|cs|go|rs|c|cpp|h|kt|json|xml|toml|md|svg|mod)/i
  )
  if (
    /папк|folder|mkdir|каталог|директор/i.test(t) &&
    !namedFile
  ) {
    return okMkdir.length > 0
  }
  if (okWrites.length === 0) return false

  const pathHit = okWrites.some((e) => {
    const p = (e.path ?? '').replace(/\\/g, '/').toLowerCase()
    if (!p) return false
    const base = p.split('/').pop() ?? p
    return t.includes(p) || t.includes(base) || (base.includes('.') && t.includes(base.split('.')[0]!))
  })
  if (pathHit) return true

  if (namedFile) {
    const want = namedFile[0]!.replace(/\\/g, '/').toLowerCase()
    return okWrites.some((e) =>
      (e.path ?? '').replace(/\\/g, '/').toLowerCase().endsWith(want)
    )
  }
  if (/переключ|toggle|theme|тем[аые]|i18n|switcher|навбар|navbar/i.test(t)) {
    return okWrites.some((e) => /\.(html?|css|jsx?|mjs|cjs)$/i.test(e.path ?? ''))
  }
  return false
}

export function lastVerifyOk(log: StepEvidence[]): boolean {
  const v = [...log].reverse().find((e) => e.kind === 'verify_ok' || e.kind === 'verify_fail')
  return v?.kind === 'verify_ok' && v.ok
}

/** Skip recording self-generated refusals (TOOL_LOOP / MISSING_PATH / cached reads). */
export function maybeRecordToolEvidence(
  log: StepEvidence[],
  synthetic: boolean,
  tool: Parameters<typeof evidenceFromTool>[0]
): StepEvidence[] {
  if (synthetic) return log
  const ev = evidenceFromTool(tool)
  return ev ? recordEvidence(log, ev) : log
}

/** A later successful shell/preview/verify supersedes an earlier fail. */
export function laterSuccessAfterFail(log: StepEvidence[]): boolean {
  let lastFailAt = -1
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!
    if (e.kind === 'shell_fail' || e.kind === 'verify_fail') lastFailAt = i
  }
  if (lastFailAt < 0) return false
  return log.slice(lastFailAt + 1).some(
    (e) => e.ok && (e.kind === 'shell_ok' || e.kind === 'preview_ok' || e.kind === 'verify_ok')
  )
}
