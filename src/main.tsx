import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App.tsx'

// Application Android/TV : forcer la mise en page "bureau" (comme Windows et le web).
if (Capacitor.isNativePlatform()) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=1600')
}

const CHUNK_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
]
const RECOVERY_FLAG = 'iptv-chunk-reload'

function isChunkLoadFailure(reason: unknown) {
  const message =
    reason instanceof Error
      ? `${reason.message} ${reason.cause instanceof Error ? reason.cause.message : String(reason.cause ?? '')}`
      : String(reason ?? '')
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.toLowerCase().includes(pattern))
}

// Un nouveau build renomme les fichiers (assets/mpegts-<hash>.js) : si l'index servi par le
// navigateur est plus ancien que les fichiers réellement présents sur le disque, le chargement
// dynamique échoue. On recharge une seule fois pour repartir sur des fichiers cohérents.
function recoverFromStaleChunk(reason: unknown) {
  if (!isChunkLoadFailure(reason)) return
  if (sessionStorage.getItem(RECOVERY_FLAG) === '1') return
  sessionStorage.setItem(RECOVERY_FLAG, '1')
  const url = new URL(window.location.href)
  url.searchParams.set('v', Date.now().toString())
  window.location.replace(url.toString())
}

window.addEventListener('error', (event) => {
  const target = event.target as (HTMLElement & { src?: string; href?: string }) | null
  if (target?.tagName === 'SCRIPT' || target?.tagName === 'LINK') {
    recoverFromStaleChunk(target.src ?? target.href ?? 'script')
  } else if (event.error) {
    recoverFromStaleChunk(event.error)
  }
})
window.addEventListener('unhandledrejection', (event) => {
  recoverFromStaleChunk(event.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)