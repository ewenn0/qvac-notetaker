import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root in index.html')

// Surface otherwise-silent failures (e.g. unhandled rejections from IPC) into
// DevTools so a black window can't hide them again.
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
})

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
