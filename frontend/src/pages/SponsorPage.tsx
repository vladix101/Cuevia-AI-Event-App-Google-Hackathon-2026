import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { qk } from '../api/hooks'
import type { Recommendation } from '../api/types'
import { Badge, Button, Card, EmptyState, ErrorAlert, Field, inputClass, Notice, Spinner } from '../components/ui'
import { fmtClock } from '../lib/format'
import { useApi } from '../services'

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function SponsorPage() {
  const { eventId = '' } = useParams()
  const api = useApi()
  const opps = useQuery({ queryKey: qk.opportunities(eventId), queryFn: () => api.opportunities(eventId) })
  const recs = useQuery({ queryKey: qk.recommendations(eventId), queryFn: () => api.recommendations(eventId) })
  const [selected, setSelected] = useState<string | null>(null)
  const current = recs.data?.find((r) => r.participant_id === selected) ?? null

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Sponzor / grupa</h1>
      <Card title="Prilike">
        {opps.isPending && <Spinner />}
        {opps.isError && <ErrorAlert error={opps.error} onRetry={() => opps.refetch()} />}
        {opps.data?.length === 0 && <EmptyState>Još nema prilika.</EmptyState>}
        <ul className="space-y-2">
          {opps.data?.map((o) => (
            <li key={o.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{o.title}</span>
                <Badge tone="blue">{o.recipient_kind === 'sponsor' ? 'Sponzor' : 'Grupa'}</Badge>
              </div>
              {o.topics.length > 0 && <p className="text-sm text-slate-600">{o.topics.join(', ')}</p>}
            </li>
          ))}
        </ul>
        <NewOpportunity eventId={eventId} />
      </Card>

      <Card title="Preporučeni učesnici">
        <Notice>
          Do pet učesnika po prilici, samo oni koji su dali saglasnost, nakon što organizator finalizuje liste. Preporuke su savetodavne — vi
          odlučujete koga kontaktirate.
        </Notice>
        <div className="mt-3">
          {recs.isPending && <Spinner />}
          {recs.isError && <ErrorAlert error={recs.error} onRetry={() => recs.refetch()} />}
          {recs.data?.length === 0 && <EmptyState>Još nema preporuka (liste možda nisu finalizovane).</EmptyState>}
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <ul className="space-y-2" aria-label="Lista preporuka">
            {recs.data?.map((r) => (
              <li key={r.participant_id}>
                <button
                  type="button"
                  aria-pressed={selected === r.participant_id}
                  onClick={() => setSelected(r.participant_id)}
                  className={`w-full rounded-lg border p-3 text-left ${selected === r.participant_id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <span className="font-medium">{r.display_name}</span>
                  <span className="block text-sm text-slate-600">{r.interests.map((i) => i.topic).slice(0, 4).join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
          {current && <RecommendationDetail eventId={eventId} rec={current} />}
        </div>
      </Card>
    </div>
  )
}

function NewOpportunity({ eventId }: { eventId: string }) {
  const api = useApi()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [topics, setTopics] = useState('')
  const [skills, setSkills] = useState('')
  const m = useMutation({
    mutationFn: () => api.createOpportunity(eventId, { title: title.trim(), topics: splitList(topics), required_skills: splitList(skills) }),
    onSuccess: () => {
      setTitle('')
      setTopics('')
      setSkills('')
      void qc.invalidateQueries({ queryKey: qk.opportunities(eventId) })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) m.mutate()
  }
  return (
    <form onSubmit={submit} className="mt-4 space-y-3 border-t border-slate-200 pt-4">
      <h3 className="font-semibold">Nova prilika</h3>
      <Field label="Naziv" htmlFor="opp-title">
        <input id="opp-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
      </Field>
      <Field label="Teme" htmlFor="opp-topics" hint="Odvojene zarezom">
        <input id="opp-topics" className={inputClass} value={topics} onChange={(e) => setTopics(e.target.value)} />
      </Field>
      <Field label="Potrebne veštine" htmlFor="opp-skills" hint="Odvojene zarezom">
        <input id="opp-skills" className={inputClass} value={skills} onChange={(e) => setSkills(e.target.value)} />
      </Field>
      <Button type="submit" disabled={m.isPending || !title.trim()}>
        {m.isPending ? 'Čuvanje…' : 'Objavi priliku'}
      </Button>
      {m.isSuccess && <p role="status" className="text-sm text-green-800">Prilika je objavljena.</p>}
      {m.isError && <ErrorAlert error={m.error} />}
    </form>
  )
}

function RecommendationDetail({ eventId, rec }: { eventId: string; rec: Recommendation }) {
  const api = useApi()
  const download = useMutation({
    mutationFn: () => api.participantCv(eventId, rec.participant_id),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cv-${rec.display_name.replace(/[^\p{L}\p{N}]+/gu, '-')}`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },
  })
  return (
    <article className="space-y-3 rounded-lg border border-slate-200 p-3" aria-label={`Detalji: ${rec.display_name}`}>
      <h3 className="text-lg font-semibold">{rec.display_name}</h3>
      {rec.interests.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {rec.interests.map((i) => (
            <li key={`${i.source}:${i.topic}`}>
              <Badge>{i.topic}</Badge>
            </li>
          ))}
        </ul>
      )}
      {rec.reasons.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Zašto je predložen/a</h4>
          <ul className="list-disc pl-5 text-sm">
            {rec.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-sm font-medium">Podeljena pitanja</h4>
        {rec.questions.length === 0 ? (
          <p className="text-sm text-slate-600">Učesnik nije podelio pitanja.</p>
        ) : (
          <ul className="space-y-2">
            {rec.questions.map((q) => (
              <li key={q.id} className="rounded bg-slate-50 p-2 text-sm">
                <p className="whitespace-pre-wrap break-words">{q.text}</p>
                <p className="text-xs text-slate-500">{fmtClock(q.submitted_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {rec.cv_available ? (
        <Button variant="secondary" onClick={() => download.mutate()} disabled={download.isPending}>
          {download.isPending ? 'Preuzimanje…' : 'Preuzmi CV'}
        </Button>
      ) : (
        <p className="text-sm text-slate-600">CV nije podeljen sa vama.</p>
      )}
      {download.isError && <ErrorAlert error={download.error} />}
    </article>
  )
}
