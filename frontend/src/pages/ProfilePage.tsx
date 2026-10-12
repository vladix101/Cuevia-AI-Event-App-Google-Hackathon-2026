import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { qk, useProfile } from '../api/hooks'
import type { Consent, InterestSource, Opportunity, ProfilePublic } from '../api/types'
import { CvPanel } from '../components/CvPanel'
import { Badge, Button, Card, EmptyState, ErrorAlert, Field, inputClass, Notice, Spinner } from '../components/ui'
import { useApi } from '../services'

const SOURCE_LABEL: Record<InterestSource, string> = { cv: 'iz CV-a', question: 'iz pitanja', declared: 'uneli ste' }

export function ProfilePage() {
  const { eventId = '' } = useParams()
  const profile = useProfile(eventId)
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Profil</h1>
      {profile.isPending && <Spinner />}
      {profile.isError && <ErrorAlert error={profile.error} onRetry={() => profile.refetch()} />}
      {profile.data && (
        <>
          <Card title="CV">
            <CvPanel eventId={eventId} profile={profile.data} />
          </Card>
          <Card title="Interesovanja">
            <Interests eventId={eventId} profile={profile.data} />
          </Card>
          <Card title="Deljenje sa sponzorima i grupama">
            <ConsentPanel eventId={eventId} />
          </Card>
        </>
      )}
    </div>
  )
}

function Interests({ eventId, profile }: { eventId: string; profile: ProfilePublic }) {
  const api = useApi()
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const declared = profile.interests.filter((i) => i.source === 'declared').map((i) => i.topic)
  const save = useMutation({
    mutationFn: (list: string[]) => api.setDeclaredInterests(eventId, list),
    onSuccess: (p) => qc.setQueryData(qk.profile(eventId), p),
  })
  const add = (e: FormEvent) => {
    e.preventDefault()
    const t = draft.trim()
    if (!t || declared.some((d) => d.toLowerCase() === t.toLowerCase())) return setDraft('')
    save.mutate([...declared, t], { onSuccess: () => setDraft('') })
  }
  const derived = profile.interests.filter((i) => i.source !== 'declared')

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">
        Teme izvedene iz vašeg CV-a i pitanja, plus teme koje sami unesete. Ne prikazujemo ocene niti rang.
      </p>
      {profile.interests.length === 0 && <EmptyState>Još nema interesovanja.</EmptyState>}
      {derived.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Izvedena interesovanja">
          {derived.map((i) => (
            <li key={`${i.source}:${i.topic}`} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm">
              {i.topic} <span className="text-xs text-slate-600">· {SOURCE_LABEL[i.source]}</span>
            </li>
          ))}
        </ul>
      )}
      {declared.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Vaša interesovanja">
          {declared.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pr-1 pl-3 text-sm text-brand-900">
              {t}
              <button
                type="button"
                className="rounded-full px-2 hover:bg-brand-100"
                aria-label={`Ukloni interesovanje ${t}`}
                disabled={save.isPending}
                onClick={() => save.mutate(declared.filter((d) => d !== t))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <div className="flex-1">
          <Field label="Dodaj interesovanje" htmlFor="new-interest">
            <input id="new-interest" className={inputClass} value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" className="self-end" disabled={save.isPending || !draft.trim()}>
          Dodaj
        </Button>
      </form>
      {save.isError && <ErrorAlert error={save.error} />}
    </div>
  )
}

function ConsentPanel({ eventId }: { eventId: string }) {
  const api = useApi()
  const opps = useQuery({ queryKey: qk.opportunities(eventId), queryFn: () => api.opportunities(eventId) })
  if (opps.isPending) return <Spinner />
  if (opps.isError) return <ErrorAlert error={opps.error} onRetry={() => opps.refetch()} />

  const byRecipient = new Map<string, Opportunity[]>()
  for (const o of opps.data) byRecipient.set(o.recipient_id, [...(byRecipient.get(o.recipient_id) ?? []), o])

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">
        Svaki sponzor ili grupa vidi vaš CV i vaša pitanja samo ako im to ovde izričito dozvolite. Saglasnost možete promeniti u bilo kom
        trenutku; ljudi, ne sistem, odlučuju koga kontaktiraju.
      </p>
      {byRecipient.size === 0 && <EmptyState>Još nema objavljenih prilika na ovom događaju.</EmptyState>}
      <ul className="space-y-3">
        {[...byRecipient.entries()].map(([rid, list]) => (
          <li key={rid}>
            <ConsentRow eventId={eventId} recipientId={rid} opportunities={list} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConsentRow({ eventId, recipientId, opportunities }: { eventId: string; recipientId: string; opportunities: Opportunity[] }) {
  const api = useApi()
  const qc = useQueryClient()
  // v1 has no GET for consents: we only know what was saved in this session.
  const saved = qc.getQueryData<Consent>(qk.consent(eventId, recipientId))
  const [allowCv, setAllowCv] = useState(saved?.allow_cv ?? false)
  const [allowQ, setAllowQ] = useState(saved?.allow_questions ?? false)
  const save = useMutation({
    mutationFn: () => api.setConsent(eventId, recipientId, allowCv, allowQ),
    onSuccess: (c) => qc.setQueryData(qk.consent(eventId, recipientId), c),
  })
  const current = save.data ?? saved
  const dirty = !current || current.allow_cv !== allowCv || current.allow_questions !== allowQ
  const kind = opportunities[0].recipient_kind === 'sponsor' ? 'Sponzor' : 'Grupa'
  const base = `consent-${recipientId}`

  return (
    <fieldset className="rounded-lg border border-slate-200 p-3">
      <legend className="px-1 text-sm font-semibold">
        <Badge tone="blue">{kind}</Badge>
      </legend>
      <ul className="mb-2 space-y-1 text-sm">
        {opportunities.map((o) => (
          <li key={o.id}>
            <span className="font-medium">{o.title}</span>
            {o.topics.length > 0 && <span className="text-slate-600"> — {o.topics.join(', ')}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
        <label htmlFor={`${base}-cv`} className="flex min-h-11 items-center gap-2">
          <input id={`${base}-cv`} type="checkbox" className="h-5 w-5" checked={allowCv} onChange={(e) => setAllowCv(e.target.checked)} />
          Dozvoli uvid u CV
        </label>
        <label htmlFor={`${base}-q`} className="flex min-h-11 items-center gap-2">
          <input id={`${base}-q`} type="checkbox" className="h-5 w-5" checked={allowQ} onChange={(e) => setAllowQ(e.target.checked)} />
          Dozvoli uvid u moja pitanja
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
          {save.isPending ? 'Čuvanje…' : 'Sačuvaj saglasnost'}
        </Button>
        <span className="text-xs text-slate-600" role="status">
          {current
            ? `Sačuvano: CV ${current.allow_cv ? 'da' : 'ne'}, pitanja ${current.allow_questions ? 'da' : 'ne'}`
            : 'Izbor još nije sačuvan u ovoj sesiji.'}
        </span>
      </div>
      {save.isError && (
        <div className="mt-2">
          <ErrorAlert error={save.error} />
        </div>
      )}
      {!current && (
        <div className="mt-2">
          <Notice>Prethodno sačuvani izbor nije prikazan (API v1 nema čitanje saglasnosti). Čuvanjem ga zamenjujete.</Notice>
        </div>
      )}
    </fieldset>
  )
}
