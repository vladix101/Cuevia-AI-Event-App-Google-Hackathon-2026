import { Link, useParams } from 'react-router-dom'
import { useProfile, useTalks } from '../api/hooks'
import type { TalkStatus } from '../api/types'
import { ProfileStatus } from '../components/CvPanel'
import { Badge, Card, EmptyState, ErrorAlert, Spinner } from '../components/ui'

const TALK_STATUS: Record<TalkStatus, { text: string; tone: 'green' | 'slate' | 'amber' }> = {
  live: { text: 'U toku', tone: 'green' },
  scheduled: { text: 'Zakazano', tone: 'amber' },
  ended: { text: 'Završeno', tone: 'slate' },
}

export function EventHomePage() {
  const { eventId = '' } = useParams()
  const talks = useTalks(eventId)
  const profile = useProfile(eventId)

  return (
    <div className="space-y-4">
      <Card
        title="Vaš profil"
        actions={
          <Link to={`/events/${eventId}/profile`} className="text-sm font-medium text-brand-700 underline">
            Uredi CV, interesovanja i deljenje
          </Link>
        }
      >
        {profile.isPending && <Spinner />}
        {profile.isError && <ErrorAlert error={profile.error} onRetry={() => profile.refetch()} />}
        {profile.data && <ProfileStatus profile={profile.data} />}
      </Card>

      <h1 className="text-2xl font-bold">Predavanja</h1>
      {talks.isPending && <Spinner />}
      {talks.isError && <ErrorAlert error={talks.error} onRetry={() => talks.refetch()} />}
      {talks.data?.length === 0 && <EmptyState>Za ovaj događaj još nema predavanja.</EmptyState>}
      <ul className="space-y-3">
        {talks.data?.map((t) => (
          <li key={t.id}>
            <Link
              to={`/events/${eventId}/talks/${t.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-600"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{t.title}</h2>
                  <p className="text-sm text-slate-600">{t.speaker_name}</p>
                </div>
                <Badge tone={TALK_STATUS[t.status].tone}>{TALK_STATUS[t.status].text}</Badge>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
