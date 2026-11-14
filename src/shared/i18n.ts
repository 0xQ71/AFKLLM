/** UI language codes and helpers (shared main + renderer). */

export type UiLanguage = 'en' | 'ru'

export const UI_LANGUAGES: UiLanguage[] = ['en', 'ru']

export function isUiLanguage(v: unknown): v is UiLanguage {
  return v === 'en' || v === 'ru'
}

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en'
