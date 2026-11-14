import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CodeApp from './code/CodeApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { I18nProvider } from './i18n/I18nProvider'
import './index.css'
import { initQueueManager } from './llm/queueManager'

initQueueManager({
  enqueue: (req) => window.api.llm.enqueue(req),
  onStream: (cb) => window.api.llm.onStream(cb),
  cancelAll: async () => {
    await window.api.llm.cancelAll()
  }
})

// Ctrl+Shift+U switches between the new shell and the classic UI (works in both)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'u') {
    try { localStorage.setItem('afk.ui', isLegacyUi() ? 'new' : 'legacy') } catch { /* ignore */ }
    location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        {isLegacyUi() ? <App /> : <CodeApp />}
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>
)

/** The new shell (agent core in the main process) is the default; "Classic UI" keeps the old app. */
function isLegacyUi(): boolean {
  try {
    if (new URLSearchParams(location.search).get('ui') === 'legacy') return true
    return localStorage.getItem('afk.ui') === 'legacy'
  } catch {
    return false
  }
}
