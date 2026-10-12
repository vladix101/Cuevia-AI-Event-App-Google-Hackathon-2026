export interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
}

/** Browser-side auth. Roles are never assigned here — they come from GET /me. */
export interface AuthBackend {
  readonly kind: 'firebase' | 'synthetic'
  readonly googleEnabled: boolean
  subscribe(cb: (user: AuthUser | null) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string, displayName: string): Promise<void>
  signInWithGoogle(): Promise<void>
  signOut(): Promise<void>
  getIdToken(forceRefresh: boolean): Promise<string | null>
}
