import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiClient, type FetchLike } from './api/client'
import { startBrowserCapture } from './audio/capture'
import { RecordingController } from './audio/recorder'
import { createFirebaseAuth } from './auth/firebase'
import type { AuthBackend } from './auth/types'
import { App } from './App'
import { config } from './config'
import './index.css'
import { createEmitter, type Services } from './services'

async function bootstrap(): Promise<Services> {
  let auth: AuthBackend
  let fetchImpl: FetchLike
  // Static env check: when VITE_USE_MOCKS is not "true" this branch (and src/dev/) is dropped from the bundle.
  if (import.meta.env.VITE_USE_MOCKS === 'true' && config.useMocks) {
    const dev = await import('./dev/mockServices')
    const m = dev.createMockServices(config.apiBaseUrl)
    auth = m.auth
    fetchImpl = m.fetchImpl
  } else {
    auth = createFirebaseAuth(config)
    fetchImpl = (url, init) => window.fetch(url, init)
  }
  const sessionExpired = createEmitter()
  const api = new ApiClient(config.apiBaseUrl, fetchImpl, {
    getIdToken: (force) => auth.getIdToken(force),
    onUnauthenticated: () => sessionExpired.emit(),
  })
  const recorder = new RecordingController({ api, startCapture: startBrowserCapture })
  return { api, auth, recorder, mocks: config.useMocks, sessionExpired }
}

const root = createRoot(document.getElementById('root')!)
bootstrap().then(
  (services) =>
    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    ),
  (e: unknown) =>
    root.render(
      <main className="mx-auto max-w-lg p-6">
        <h1 className="text-xl font-semibold">Cuevia nije podešena</h1>
        <p className="mt-2 text-slate-700">{e instanceof Error ? e.message : String(e)}</p>
      </main>,
    ),
)
