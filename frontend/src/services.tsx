import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ApiClient } from './api/client'
import type { RecordingController } from './audio/recorder'
import type { AuthBackend, AuthUser } from './auth/types'

export interface Services {
  api: ApiClient
  auth: AuthBackend
  recorder: RecordingController
  /** True only when the synthetic src/dev transport is active. */
  mocks: boolean
  /** Fires when the backend rejects even a freshly refreshed token. */
  sessionExpired: { subscribe(cb: () => void): () => void }
}

const ServicesCtx = createContext<Services | null>(null)

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesCtx.Provider value={services}>{children}</ServicesCtx.Provider>
}

export function useServices(): Services {
  const s = useContext(ServicesCtx)
  if (!s) throw new Error('ServicesProvider missing')
  return s
}

export const useApi = () => useServices().api

export function useRecorder() {
  const { recorder } = useServices()
  const snap = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot)
  return { recorder, snap }
}

export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'signedOut'; user: null; expired: boolean }
  | { status: 'signedIn'; user: AuthUser }

const AuthCtx = createContext<AuthState | null>(null)

export function AuthStateProvider({ children }: { children: ReactNode }) {
  return <AuthCtx.Provider value={useAuthSubscription()}>{children}</AuthCtx.Provider>
}

export function useAuthState(): AuthState {
  const s = useContext(AuthCtx)
  if (!s) throw new Error('AuthStateProvider missing')
  return s
}

function useAuthSubscription(): AuthState {
  const { auth, sessionExpired } = useServices()
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null })
  useEffect(() => {
    let expired = false
    const offExpired = sessionExpired.subscribe(() => {
      expired = true
      void auth.signOut()
    })
    const offAuth = auth.subscribe((user) => {
      setState(user ? { status: 'signedIn', user } : { status: 'signedOut', user: null, expired })
      if (user) expired = false
    })
    return () => {
      offExpired()
      offAuth()
    }
  }, [auth, sessionExpired])
  return state
}

export function createEmitter() {
  const ls = new Set<() => void>()
  return {
    subscribe(cb: () => void) {
      ls.add(cb)
      return () => {
        ls.delete(cb)
      }
    },
    emit() {
      ls.forEach((l) => l())
    },
  }
}
