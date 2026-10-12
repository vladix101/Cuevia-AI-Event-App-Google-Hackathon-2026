import { useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { hasRole, useMe } from '../api/hooks'
import { useRecorder, useServices } from '../services'
import { Button } from './ui'
import { lazy, Suspense } from 'react'

// Only loaded in mock mode; the import is tree-shaken from production builds.
const DevBanner =
  import.meta.env.VITE_USE_MOCKS === 'true' ? lazy(() => import('../dev/DevBanner')) : () => null

export function Layout() {
  const { auth, mocks } = useServices()
  const qc = useQueryClient()
  const me = useMe()
  const { eventId } = useParams()
  const { snap } = useRecorder()
  const roles = me.data?.roles

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-2 py-1 text-sm ${isActive ? 'bg-brand-100 text-brand-900 font-medium' : 'text-slate-700 hover:bg-slate-100'}`

  return (
    <div className="min-h-dvh">
      {mocks && (
        <Suspense fallback={null}>
          <DevBanner />
        </Suspense>
      )}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">
        Preskoči na sadržaj
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2">
          <Link to="/events" className="mr-2 text-lg font-bold text-brand-700">
            Cuevia
          </Link>
          {(snap.status === 'recording' || snap.status === 'paused') && snap.talkId && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800" role="status">
              <span className={`h-2 w-2 rounded-full ${snap.status === 'recording' ? 'animate-pulse bg-red-600' : 'bg-slate-400'}`} aria-hidden />
              {snap.status === 'recording' ? 'Snima se' : 'Pauzirano'}
            </span>
          )}
          <nav aria-label="Glavna navigacija" className="flex flex-1 flex-wrap items-center gap-1">
            {eventId && (
              <>
                <NavLink to={`/events/${eventId}`} end className={navCls}>
                  Predavanja
                </NavLink>
                <NavLink to={`/events/${eventId}/profile`} className={navCls}>
                  Profil
                </NavLink>
                {hasRole(roles, 'speaker') && (
                  <NavLink to={`/speaker/events/${eventId}`} className={navCls}>
                    Govornik
                  </NavLink>
                )}
                {hasRole(roles, 'sponsor') && (
                  <NavLink to={`/sponsor/events/${eventId}`} className={navCls}>
                    Sponzor
                  </NavLink>
                )}
                {hasRole(roles, 'organizer') && (
                  <NavLink to={`/organizer/events/${eventId}`} className={navCls}>
                    Organizator
                  </NavLink>
                )}
              </>
            )}
          </nav>
          <span className="hidden text-sm text-slate-600 sm:inline">{me.data?.display_name}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await auth.signOut()
              qc.clear()
            }}
          >
            Odjava
          </Button>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-4 pb-28">
        <Outlet />
      </main>
    </div>
  )
}
