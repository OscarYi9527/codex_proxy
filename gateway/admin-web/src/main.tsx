import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles.css'

const browserConsoleHash = window.location.hash.startsWith('#browser?')
  ? window.location.hash
  : null

const root = document.getElementById('root')
if (!root) throw new Error('Admin root element is missing')

if (browserConsoleHash) {
  window.location.replace(`/admin/full${browserConsoleHash}`)
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
