import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import {
  DEFAULT_UI_LANGUAGE,
  isUiLanguage,
  type UiLanguage
} from '../../../shared/i18n'
import { translate, type MessageKey } from './messages'

interface I18nContextValue {
  lang: UiLanguage
  setLang: (lang: UiLanguage) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<UiLanguage>(DEFAULT_UI_LANGUAGE)

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      if (isUiLanguage(s.uiLanguage)) setLangState(s.uiLanguage)
    })
    return window.api.settings.onChanged((s) => {
      if (isUiLanguage(s.uiLanguage)) setLangState(s.uiLanguage)
    })
  }, [])

  const setLang = useCallback((next: UiLanguage) => {
    setLangState(next)
    void window.api.settings.save({ uiLanguage: next })
  }, [])

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n requires I18nProvider')
  return ctx
}
