import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { ApiClient, type FetchLike } from '../api/client'
import type { AudioCapture, CaptureOptions } from '../audio/capture'
import { RecordingController } from '../audio/recorder'
import type { AuthBackend } from '../auth/types'
import { App, makeQueryClient } from '../App'
import { createEmitter, type Services } from '../services'

export const BASE = 'http://api.test/api/v1'

export type Route = (req: { method: string; path: string; body: unknown; init: RequestInit }) => Response | Promise<Response> | undefined

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const apiError = (status: number, code: string, message = code) =>
  json(status, { error: { code, message, request_id: 'req-test' } })

/** Test-only fake HTTP transport: routes are tried in order; unmatched → 404. */
export function fakeFetch(routes: Route[]) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fn: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET'
    const path = url.slice(BASE.length)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ method, path, body })
    for (const r of routes) {
      const out = await r({ method, path, body, init })
      if (out) return out
    }
    return apiError(404, 'NOT_FOUND')
  }
  return { fn, calls }
}

export function signedInAuth(): AuthBackend {
  return {
    kind: 'synthetic',
    googleEnabled: false,
    subscribe(cb) {
      cb({ uid: 'u1', email: 'test@example.com', displayName: 'Test' })
      return () => {}
    },
    signIn: async () => {},
    signUp: async () => {},
    signInWithGoogle: async () => {},
    signOut: async () => {},
    getIdToken: async () => 'test-token',
  }
}

export function fakeCapture() {
  const stop = vi.fn(async () => {})
  let opts: CaptureOptions | null = null
  const start = vi.fn(async (o: CaptureOptions): Promise<AudioCapture> => {
    opts = o
    return { sampleRate: 16000, stop }
  })
  return { start, stop, feed: (f: Float32Array) => opts?.onFrames(f) }
}

export function makeServices(fetchImpl: FetchLike, capture = fakeCapture()): Services & { capture: ReturnType<typeof fakeCapture> } {
  const auth = signedInAuth()
  const api = new ApiClient(BASE, fetchImpl, { getIdToken: (f) => auth.getIdToken(f), onUnauthenticated: () => {} })
  const recorder = new RecordingController({ api, startCapture: capture.start })
  return { api, auth, recorder, mocks: false, sessionExpired: createEmitter(), capture }
}

export function renderAt(path: string, services: Services) {
  window.history.pushState({}, '', path)
  return render(<App services={services} queryClient={makeQueryClient()} />)
}

export const ME = { user_id: 'u1', display_name: 'Test Attendee', roles: ['attendee'] }
export const TALKS = { items: [{ id: 't1', title: 'Predavanje 1', speaker_name: 'Govornik', status: 'live' }] }
