import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>
)
