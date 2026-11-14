import { isHostWorkDoneCloser, preferUserFacingCloser, stripLeakedToolMarkup } from '../agentPure'
import type { StepEvidence } from './evidence'
import { lastVerifyOk, laterSuccessAfterFail } from './evidence'

export function honestClosingNote(opts: {
  mutatingEditOk: boolean
  mutatingEditFailed: boolean
  lastFail?: string
  evidence: StepEvidence[]
  previewOpened: boolean
  claimsVisualOk: boolean
  lang: 'ru' | string
}): string | null {
  const { lang } = opts
  const ru = lang === 'ru'
  if (opts.mutatingEditFailed && !opts.mutatingEditOk) {
    return ru
      ? `Правка не применилась${opts.lastFail ? ` (${opts.lastFail})` : ''}. Задача не выполнена — не рапортуем успех.`
      : `Edit did not apply${opts.lastFail ? ` (${opts.lastFail})` : ''}. Task not completed — not reporting success.`
  }
  const failedShell = [...opts.evidence].reverse().find((e) => e.kind === 'shell_fail' || e.kind === 'verify_fail')
  if (failedShell && !lastVerifyOk(opts.evidence) && !laterSuccessAfterFail(opts.evidence)) {
    const code = failedShell.exitCode
    const codeBit =
      typeof code === 'number' && Number.isFinite(code) ? ` (exit_code=${code})` : ''
    return ru
      ? `Последняя команда завершилась с ошибкой${codeBit}. Нельзя считать задачу выполненной.`
      : `Last command failed${codeBit}. Do not report the task as done.`
  }
  if (opts.claimsVisualOk && !opts.previewOpened) {
    return ru
      ? 'Визуально страница не проверялась (нет инструмента DOM/скриншота). Не утверждай «визуально проверено».'
      : 'Page was not visually inspected (no DOM/screenshot tool). Do not claim visual verification.'
  }
  return null
}

export function closerMentionsPreview(text: string): boolean {
  return /превью\s+открыт|preview is open in the app/i.test(text ?? '')
}

/** Mid-turn "next I will compile / run / fix" — not a user-facing closer. */
export function isNextActionNarration(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (isHostWorkDoneCloser(t)) return false
  return (
    /now I (need to|will|should) (run|start|call|execute|write|compile|launch|fix)|let me (start|run|call|write|compile|fix)|I(?:['’]ll| will) (now )?(run|start|compile|fix)|going to run|I need to (compile|run|launch|execute|fix)/i.test(
      t
    ) ||
    /The (?:test )?file (?:is |was )(?:created|ready).{0,80}(?:compile|run|launch)/i.test(t) ||
    /I forgot (to )?(add|import)|forgot to add (the )?import|I'll fix (this|it)|Need to (fix|add the import|continue with)/i.test(
      t
    ) ||
    /теперь нужно запустить|теперь запущу|сейчас нужно запустить|сейчас надо запустить/i.test(t) ||
    /файл создан.{0,80}(запуст|забыл|исправ)/i.test(t) ||
    /теперь запускаю|сейчас запущу|сейчас запускаю|осталось запустить|сейчас вызову|начну с npm|запускаю (npm|vite|dev[- ]сервер)/i.test(
      t
    ) ||
    /забыл (добавить|импорт)|нужно исправить это|исправлю это|заметка:\s*забыл/i.test(t)
  )
}

export function closerLooksLikeHangOrLoop(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return (
    /<\s*tool_call\b|<\s*function\s*=/i.test(t) ||
    /TOOL_LOOP|SHELL_TIMEOUT|зависает|timed?\s*out/i.test(t)
  )
}

function looksLikeViteOrNpmApp(paths: string[]): boolean {
  return paths.some((p) =>
    /(?:^|\/)package\.json$|(?:^|\/)vite\.config\.|(?:^|\/)src\/App\.(jsx|tsx)$/i.test(
      p.replace(/\\/g, '/')
    )
  )
}

/** Host-authored closer when preview/files succeeded but the model never wrote one. */
export function fallbackWorkDoneCloser(opts: {
  lang: 'ru' | string
  paths: string[]
  previewOpened: boolean
  /** Successful program run with real stdout — do not claim this without evidence. */
  cliVerified?: boolean
}): string {
  const ru = opts.lang === 'ru'
  const files = opts.paths
    .map((p) => p.replace(/\\/g, '/'))
    .filter(Boolean)
    .slice(0, 12)
  const fileBit = files.length
    ? ru
      ? `Файлы: ${files.join(', ')}.`
      : `Files: ${files.join(', ')}.`
    : ru
      ? 'Файлы записаны.'
      : 'Files were written.'
  let previewBit: string
  if (opts.previewOpened) {
    previewBit = looksLikeViteOrNpmApp(opts.paths)
      ? ru
        ? ' Превью открыто в приложении — вкладка Browser (npm run dev).'
        : ' Preview is open in the app Browser tab (npm run dev).'
      : ru
        ? ' Превью открыто в приложении — вкладка Browser.'
        : ' Preview is open in the app Browser tab.'
  } else if (opts.cliVerified) {
    previewBit = ru
      ? ' Программа записана и запущена — вывод в чипе терминала.'
      : ' Program written and run — see the terminal chip.'
  } else if (looksLikeCliPaths(opts.paths)) {
    previewBit = ''
  } else {
    previewBit = ru
      ? ' Можно открыть превью через npm run dev.'
      : ' Open the preview with npm run dev.'
  }
  return `${fileBit}${previewBit}`.trim()
}

function looksLikeCliPaths(paths: string[]): boolean {
  return paths.some((p) => /\.(go|py|java|cs|rs|c|cc|cpp|kt)$/i.test(p.replace(/\\/g, '/')))
}

function closerMentionsCliRun(text: string): boolean {
  return /чипе терминала|terminal chip|stdout|топ-?\s*10|top-?\s*10|программ[аыу].{0,48}запущ|вывод терминала/i.test(
    text ?? ''
  )
}

/**
 * Prefer a real model closer; if it is status chatter, leftover "I'll fix/run",
 * or omits the open preview / CLI evidence, replace it with the host fallback.
 */
export function resolveTurnCloser(opts: {
  lastClosingText: string
  lang: 'ru' | string
  paths: string[]
  previewOpened: boolean
  cliVerified?: boolean
}): string {
  const stripped = stripLeakedToolMarkup(opts.lastClosingText ?? '')
  const existing = preferUserFacingCloser(
    stripped,
    opts.lang === 'ru' ? 'ru' : 'en'
  ).trim()
  const usable =
    existing.length >= 48 &&
    !/^[↻⏹]/.test(existing) &&
    !isNextActionNarration(existing) &&
    !closerLooksLikeHangOrLoop(existing) &&
    (!opts.previewOpened || closerMentionsPreview(existing)) &&
    (!opts.cliVerified || closerMentionsCliRun(existing) || isHostWorkDoneCloser(existing))
  if (usable) return existing
  return fallbackWorkDoneCloser(opts)
}
