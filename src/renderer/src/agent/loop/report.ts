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
  if (opts.mutatingEditFailed) {
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
