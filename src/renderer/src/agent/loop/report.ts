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

/** Mid-turn "next I will npm install / run dev" — not a user-facing closer. */
export function isNextActionNarration(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return (
    /now I (need to|will|should) (run|start|call|execute|write)|let me (start|run|call|write)|I(?:['’]ll| will) (now )?(run|start)|going to run/i.test(
      t
    ) ||
    /теперь запускаю|сейчас запущу|сейчас запускаю|осталось запустить|сейчас вызову|начну с npm|запускаю (npm|vite|dev[- ]сервер)/i.test(
      t
    )
  )
}

/** Host-authored closer when preview/files succeeded but the model never wrote one. */
export function fallbackWorkDoneCloser(opts: {
  lang: 'ru' | string
  paths: string[]
  previewOpened: boolean
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
  const previewBit = opts.previewOpened
    ? ru
      ? ' Превью открыто в приложении — вкладка Browser (npm run dev).'
      : ' Preview is open in the app Browser tab (npm run dev).'
    : looksLikeCliPaths(opts.paths)
      ? ru
        ? ' Программа записана и запущена — вывод в чипе терминала.'
        : ' Program written and run — see the terminal chip.'
      : ru
        ? ' Можно открыть превью через npm run dev.'
        : ' Open the preview with npm run dev.'
  return `${fileBit}${previewBit}`.trim()
}

function looksLikeCliPaths(paths: string[]): boolean {
  return paths.some((p) => /\.(go|py|java|cs|rs|c|cc|cpp|kt)$/i.test(p.replace(/\\/g, '/')))
}

/**
 * Prefer a real model closer; if it is status chatter or omits the open preview,
 * replace it with the host fallback so the chat cannot end on files_changed only.
 */
export function resolveTurnCloser(opts: {
  lastClosingText: string
  lang: 'ru' | string
  paths: string[]
  previewOpened: boolean
}): string {
  const existing = (opts.lastClosingText ?? '').trim()
  const usable =
    existing.length >= 48 &&
    !/^[↻⏹]/.test(existing) &&
    !isNextActionNarration(existing) &&
    (!opts.previewOpened || closerMentionsPreview(existing))
  if (usable) return existing
  return fallbackWorkDoneCloser(opts)
}
