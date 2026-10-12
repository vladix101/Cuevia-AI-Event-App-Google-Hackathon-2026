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
    `border-b-2 px-2 py-1.5 text-sm font-semibold transition-colors ${isActive ? 'border-spot text-spot' : 'border-transparent text-mute hover:text-ink'}`

  return (
    <div className="min-h-dvh">
      {mocks && (
        <Suspense fallback={null}>
          <DevBanner />
        </Suspense>
      )}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-panel focus:p-2">
        Preskoči na sadržaj
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-stage/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2">
          <Link to="/events" className="mr-3 inline-flex items-center gap-2 font-display text-2xl leading-none font-black tracking-tight [font-stretch:135%]">
            <span className="h-3.5 w-3.5 rounded-full bg-spot shadow-[0_0_14px_rgb(255_210_94/0.7)]" aria-hidden />
            Cuevia
          </Link>
          {(snap.status === 'recording' || snap.status === 'paused') && snap.talkId && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-alarm/50 bg-alarm/10 px-2.5 py-0.5 text-xs font-bold text-alarm" role="status">
              <span className={`h-2 w-2 rounded-full ${snap.status === 'recording' ? 'cue-light bg-alarm' : 'bg-faint'}`} aria-hidden />
              {snap.status === 'recording' ? 'Snima se' : 'Pauzirano'}
            </span>
          )}
          <nav
            aria-label="Glavna navigacija"
            className="-mx-2 order-last flex w-full items-center gap-1 overflow-x-auto whitespace-nowrap sm:order-none sm:mx-0 sm:w-auto sm:flex-1"
          >
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
          <span className="ml-auto hidden text-sm text-mute sm:inline">{me.data?.display_name}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto sm:ml-0"
            onClick={async () => {
              await auth.signOut()
              qc.clear()
            }}
          >
            Odjava
          </Button>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-6 pb-28">
        <Outlet />
      </main>
    </div>
  )
}
