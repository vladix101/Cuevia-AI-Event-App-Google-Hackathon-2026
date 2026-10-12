export interface PublicEnv {
  VITE_API_BASE_URL?: string
  VITE_USE_MOCKS?: string
  VITE_FIREBASE_API_KEY?: string
  VITE_FIREBASE_AUTH_DOMAIN?: string
  VITE_FIREBASE_PROJECT_ID?: string
  VITE_FIREBASE_APP_ID?: string
  VITE_FIREBASE_STORAGE_BUCKET?: string
  VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  VITE_FIREBASE_GOOGLE_ENABLED?: string
}

/** Mocks are opt-in only: anything other than the exact string "true" means real backend. */
export function resolveUseMocks(env: PublicEnv): boolean {
  return env.VITE_USE_MOCKS === 'true'
}

export function resolveConfig(env: PublicEnv) {
  return {
    apiBaseUrl: env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1',
    useMocks: resolveUseMocks(env),
    googleSignIn: env.VITE_FIREBASE_GOOGLE_ENABLED === 'true',
    firebase: {
      apiKey: env.VITE_FIREBASE_API_KEY ?? '',
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
      projectId: env.VITE_FIREBASE_PROJECT_ID ?? '',
      appId: env.VITE_FIREBASE_APP_ID ?? '',
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || undefined,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
    },
  }
}

export type AppConfig = ReturnType<typeof resolveConfig>
export const config: AppConfig = resolveConfig(import.meta.env as PublicEnv)
