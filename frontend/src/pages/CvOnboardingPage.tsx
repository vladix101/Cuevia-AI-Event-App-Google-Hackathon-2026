import { Link, useParams } from 'react-router-dom'
import { useProfile } from '../api/hooks'
import { CvPanel } from '../components/CvPanel'
import { Card, ErrorAlert, Spinner } from '../components/ui'

/** Optional step right after joining an event. Skipping is always allowed. */
export function CvOnboardingPage() {
  const { eventId = '' } = useParams()
  const profile = useProfile(eventId)
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Želite li da dodate CV?</h1>
      <p className="text-slate-700">
        CV je opcion. Bez njega i dalje imate transkript, „Izgubio sam nit", objašnjenja pojmova i pitanja govorniku. CV vam samo
        omogućava da, uz vašu saglasnost, budete predloženi sponzorima.
      </p>
      <Card>
        {profile.isPending && <Spinner />}
        {profile.isError && <ErrorAlert error={profile.error} onRetry={() => profile.refetch()} />}
        {profile.data && <CvPanel eventId={eventId} profile={profile.data} />}
      </Card>
      <div className="flex justify-end">
        <Link
          to={`/events/${eventId}`}
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 font-medium hover:bg-slate-50"
        >
          {profile.data?.cv_status === 'missing' ? 'Preskoči za sada' : 'Nastavi na predavanja'}
        </Link>
      </div>
    </div>
  )
}
