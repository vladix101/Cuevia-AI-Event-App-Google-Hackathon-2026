import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type Auth,
} from 'firebase/auth'
import type { AppConfig } from '../config'
import type { AuthBackend, AuthUser } from './types'

export class FirebaseConfigError extends Error {}

export function createFirebaseAuth(cfg: AppConfig): AuthBackend {
  const f = cfg.firebase
  if (!f.apiKey || !f.authDomain || !f.projectId || !f.appId) {
    throw new FirebaseConfigError(
      'Firebase nije podešen. Popunite VITE_FIREBASE_* vrednosti u frontend/.env.local (vidi .env.example).',
    )
  }
  const app: FirebaseApp = initializeApp(f)
  const auth: Auth = getAuth(app)
  const toUser = (u: { uid: string; email: string | null; displayName: string | null } | null): AuthUser | null =>
    u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null

  return {
    kind: 'firebase',
    googleEnabled: cfg.googleSignIn,
    subscribe(cb) {
      // onIdTokenChanged also fires on token refresh / revocation.
      return onIdTokenChanged(auth, (u) => cb(toUser(u)))
    },
    async signIn(email, password) {
      await signInWithEmailAndPassword(auth, email, password)
    },
    async signUp(email, password, displayName) {
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      if (displayName.trim()) await updateProfile(cred.user, { displayName: displayName.trim() })
      await cred.user.getIdToken(true)
    },
    async signInWithGoogle() {
      if (!cfg.googleSignIn) throw new Error('Google prijava nije omogućena.')
      await signInWithPopup(auth, new GoogleAuthProvider())
    },
    async signOut() {
      await signOut(auth)
    },
    async getIdToken(forceRefresh) {
      const u = auth.currentUser
      return u ? u.getIdToken(forceRefresh) : null
    },
  }
}

const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Pogrešan e-mail ili lozinka.',
  'auth/invalid-email': 'Neispravan e-mail.',
  'auth/email-already-in-use': 'Nalog sa ovim e-mailom već postoji.',
  'auth/weak-password': 'Lozinka mora imati najmanje 6 karaktera.',
  'auth/too-many-requests': 'Previše pokušaja. Pokušajte ponovo kasnije.',
  'auth/network-request-failed': 'Nema mrežne veze.',
  'auth/popup-closed-by-user': 'Prozor za prijavu je zatvoren.',
}

export function authErrorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code
  if (code && MESSAGES[code]) return MESSAGES[code]
  return e instanceof Error ? e.message : 'Prijava nije uspela.'
}
