import type { VerifyMode, ProjectStack } from '../../../../shared/projectStack'
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

/**
 * «запусти для теста» / playtest — open the app, not `npm test`.
 * Must run before the «запусти … тест» verify regex.
 */
export function looksLikePlaytestAsk(userText: string): boolean {
  const t = userText ?? ''
  if (!t.trim()) return false
  if (/\b(npm|pnpm|yarn)\s+test\b|\bcargo\s+test\b|\bgo\s+test\b|\bpytest\b|\bmvn\s+test\b/i.test(t)) {
    return false
  }
  return (
    /(?:запусти|открой|запуск|run|start|open).{0,48}(?:для\s+теста|на\s+тест|поигра|playtest|try\s+(?:it|out)|посмотреть)/i.test(
      t
    ) ||
    (/для\s+теста\b/i.test(t) &&
      /(?:запусти|открой|dev|превью|preview|сервер|vite|npm\s+run)/i.test(t))
  )
}

/**
 * Explicit ask to run build/tests — not casual wording like «после сборки открой».
 * Bare «сборк» / «build» used to fire a verify nudge on every landing-page prompt.
 */
export function userAskedVerify(userText: string): boolean {
  const t = userText
  if (looksLikePlaytestAsk(t)) return false
  if (
    /\b(npm|pnpm|yarn)\s+test\b|\bcargo\s+test\b|\bgo\s+test\b|\bpytest\b|\bmvn\s+test\b|\bdotnet\s+test\b|\bgradle(?:w)?\s+test\b|\bmake\s+(?:test|check)\b/i.test(
      t
    )
  ) {
    return true
  }
  if (
    /\b(npm|pnpm|yarn)\s+run\s+build\b|\bmvn\s+(?:compile|package|verify)\b|\btsc\s+--noEmit\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bmake\s+all\b/i.test(
      t
    )
  ) {
    return true
  }
  if (
    /(?:проверь|прогони|запусти)\s+.{0,48}(?:тест|сборк|lint|билд)/i.test(t) ||
    /(?:run|execute|please\s+run)\s+(?:the\s+)?(?:tests?|build|lint)\b/i.test(t) ||
    /\b(?:verify|validate)\s+(?:the\s+)?(?:build|tests?|project)\b/i.test(t)
  ) {
    return true
  }
  if (
    /\b(?:unit\s+)?tests?\b/i.test(t) &&
    /(?:запуст|прогон|проверь|run|execute|прогон)/i.test(t)
  ) {
    return true
  }
  return false
}

/** True when at least one detected stack has a real build/test/lint/run command. */
export function stackSupportsVerify(stacks: ProjectStack[]): boolean {
  return stacks.some((s) => Boolean(s.build || s.test || s.lint || s.run))
}

/** HTML-only / no-compiler projects must not get a build/test nudge. */
export function shouldNudgeVerify(opts: {
  userText: string
  stacks: ProjectStack[]
}): boolean {
  if (!userAskedVerify(opts.userText)) return false
  if (!stackSupportsVerify(opts.stacks)) return false
  return true
}

export function formatVerifyNudge(mode: VerifyMode, lang: 'ru' | string): string {
  return lang === 'ru'
    ? `Перед «готово» вызови verify_project с mode=${mode} ОДИН раз (или одну стековую команду в execute_terminal_command). Не утверждай успех без exit_code=0. Не делай Get-ChildItem -Recurse и не спамь Test-Path.`
    : `Before claiming done, call verify_project mode=${mode} ONCE (or one stack command via execute_terminal_command). Do not claim success without exit_code=0. Do not Get-ChildItem -Recurse or spam Test-Path.`
}

export function inferredVerifyMode(userText: string): VerifyMode {
  if (looksLikePlaytestAsk(userText)) return 'run'
  if (/lint|eslint|clippy|ruff/i.test(userText)) return 'lint'
  if (/тест|test|pytest/i.test(userText)) return 'test'
  if (/запуск|run|start/i.test(userText) && !/лендинг|landing|сайт|site|html/i.test(userText)) {
    return 'run'
  }
  return 'build'
}

export function verifyAlreadyRan(log: StepEvidence[]): boolean {
  return log.some(
    (e) =>
      e.kind === 'verify_ok' ||
      e.kind === 'verify_fail' ||
      (e.kind === 'shell_ok' && /test|build|compile|verify_project/i.test(e.command ?? ''))
  )
}
