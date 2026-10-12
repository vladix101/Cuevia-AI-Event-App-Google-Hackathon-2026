import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ApiError } from './api/client'
import { Layout } from './components/Layout'
import { Spinner } from './components/ui'
import { CvOnboardingPage } from './pages/CvOnboardingPage'
import { EventHomePage } from './pages/EventHomePage'
import { EventsPage } from './pages/EventsPage'
import { LoginPage } from './pages/LoginPage'
import { ProfilePage } from './pages/ProfilePage'
import { SpeakerPage } from './pages/SpeakerPage'
import { TalkPage } from './pages/TalkPage'
import { AuthStateProvider, ServicesProvider, useAuthState, useServices, type Services } from './services'

// Role-specific screens (Recharts etc.) load on demand to keep the attendee bundle small.
const OrganizerPage = lazy(() => import('./pages/OrganizerPage').then((m) => ({ default: m.OrganizerPage })))
const SponsorPage = lazy(() => import('./pages/SponsorPage').then((m) => ({ default: m.SponsorPage })))

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
}

export function App({ services, queryClient }: { services: Services; queryClient?: QueryClient }) {
  const [qc] = useState(() => queryClient ?? makeQueryClient())
  return (
    <ServicesProvider services={services}>
      <QueryClientProvider client={qc}>
        <AuthStateProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthStateProvider>
      </QueryClientProvider>
    </ServicesProvider>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/events" replace />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:eventId" element={<EventHomePage />} />
        <Route path="/events/:eventId/cv" element={<CvOnboardingPage />} />
        <Route path="/events/:eventId/profile" element={<ProfilePage />} />
        <Route path="/events/:eventId/talks/:talkId" element={<TalkPage />} />
        <Route path="/speaker/events/:eventId" element={<SpeakerPage />} />
        <Route path="/sponsor/events/:eventId" element={<Suspense fallback={<Spinner />}><SponsorPage /></Suspense>} />
        <Route path="/organizer/events/:eventId" element={<Suspense fallback={<Spinner />}><OrganizerPage /></Suspense>} />
        <Route path="*" element={<p className="p-4">Stranica ne postoji.</p>} />
      </Route>
    </Routes>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuthState()
  const { recorder } = useServices()
  const loc = useLocation()
  useEffect(() => {
    // Signing out (or an expired session) must not leave the microphone running.
    if (auth.status === 'signedOut') void recorder.stop()
  }, [auth.status, recorder])
  if (auth.status === 'loading') return <Spinner />
  if (auth.status === 'signedOut')
    return <Navigate to="/login" replace state={{ from: loc.pathname, expired: auth.expired }} />
  return <>{children}</>
}
