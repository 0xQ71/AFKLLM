export type EvidenceKind =
  | 'write_ok'
  | 'patch_ok'
  | 'shell_ok'
  | 'shell_fail'
  | 'verify_ok'
  | 'verify_fail'
  | 'preview_ok'

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
    const preview = /PREVIEW_URL|Opened .*preview|AFKLLM Browser/i.test(content ?? '')
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
  if (name === 'create_directory' || name === 'delete_file' || name === 'generate_image') {
    return { kind: ok ? 'write_ok' : 'shell_fail', tool: name, ok, path }
  }
  return null
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

  if (/тест|test|pytest|junit|cargo test|go test|dotnet test/i.test(t)) {
    return okShell.some((e) =>
      /test|pytest|gradle test|mvn .*test|cargo test|go test|dotnet test/i.test(
        e.command ?? ''
      )
    )
  }
  if (/сборк|build|compile|javac|mvn|gradle|cmake|cargo build|go build|dotnet build/i.test(t)) {
    return okShell.some((e) =>
      /build|compile|javac|mvn|gradle|cmake|cargo|go build|dotnet/i.test(e.command ?? '')
    )
  }
  if (/открыть|превью|preview|browser|браузер|start-process/i.test(t)) {
    return okShell.some((e) => e.kind === 'preview_ok')
  }
  if (okWrites.length === 0) return false

  const pathHit = okWrites.some((e) => {
    const p = (e.path ?? '').replace(/\\/g, '/').toLowerCase()
    if (!p) return false
    const base = p.split('/').pop() ?? p
    return t.includes(p) || t.includes(base) || (base.includes('.') && t.includes(base.split('.')[0]!))
  })
  if (pathHit) return true

  const namedFile = t.match(
    /[\w./\\-]+\.(html?|css|js|ts|tsx|jsx|py|java|cs|go|rs|c|cpp|h|kt|json|xml|toml|md)/i
  )
  if (namedFile) {
    const want = namedFile[0]!.replace(/\\/g, '/').toLowerCase()
    return okWrites.some((e) =>
      (e.path ?? '').replace(/\\/g, '/').toLowerCase().endsWith(want)
    )
  }
  if (/напис|write|созда|правк|исправ|edit|fix|добав|patch|измен/i.test(t)) {
    return okWrites.some((e) => e.ok)
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
