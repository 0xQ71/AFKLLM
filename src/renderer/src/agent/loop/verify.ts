import type { VerifyMode } from '../../../../shared/projectStack'
import type { StepEvidence } from './evidence'

export function shouldVerifyAfterEdits(opts: {
  mutatingEditOk: boolean
  userAskedTestOrBuild: boolean
  alreadyVerified: boolean
}): boolean {
  if (opts.alreadyVerified) return false
  if (opts.userAskedTestOrBuild) return true
  return opts.mutatingEditOk
}

export function userAskedVerify(userText: string): boolean {
  return /тест|test|сборк|build|compile|lint|pytest|javac|mvn|gradle|cargo test|go test|dotnet test|npm test/i.test(
    userText
  )
}

export function formatVerifyNudge(mode: VerifyMode, lang: 'ru' | string): string {
  return lang === 'ru'
    ? `Перед «готово» вызови verify_project с mode=${mode} (или execute_terminal_command с командой стека). Не утверждай успех без exit_code=0.`
    : `Before claiming done, call verify_project mode=${mode} (or execute_terminal_command with the stack command). Do not claim success without exit_code=0.`
}

export function inferredVerifyMode(userText: string): VerifyMode {
  if (/lint|eslint|clippy|ruff/i.test(userText)) return 'lint'
  if (/тест|test|pytest/i.test(userText)) return 'test'
  if (/запуск|run|start/i.test(userText)) return 'run'
  return 'build'
}

export function verifyAlreadyRan(log: StepEvidence[]): boolean {
  return log.some((e) => e.kind === 'verify_ok' || e.kind === 'verify_fail' ||
    (e.kind === 'shell_ok' && /test|build|compile/i.test(e.command ?? '')))
}
