import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import type { Depth, RetrievalMode } from '../api/types'
import { useApi } from '../services'
import { Badge, Button, Drawer, ErrorAlert, ExternalLink, inputClass, Spinner } from './ui'

const DEPTHS: { key: Depth; label: string }[] = [
  { key: 'simple', label: 'Jednostavno' },
  { key: 'standard', label: 'Standardno' },
  { key: 'advanced', label: 'Napredno' },
]

const MODE: Record<RetrievalMode, { text: string; tone: 'green' | 'blue' | 'amber' }> = {
  web: { text: 'Sa izvorima sa interneta', tone: 'green' },
  provided: { text: 'Iz materijala događaja', tone: 'blue' },
  general: { text: 'Opšte znanje modela — bez web izvora', tone: 'amber' },
}

export function ExplanationDrawer({
  recordingId,
  initialTerm,
  segmentId,
  open,
  onOpenChange,
}: {
  recordingId: string | null
  initialTerm: string
  segmentId: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const api = useApi()
  const [term, setTerm] = useState(initialTerm)
  const [draft, setDraft] = useState(initialTerm)
  const [depth, setDepth] = useState<Depth>('standard')

  useEffect(() => {
    if (open) {
      setTerm(initialTerm)
      setDraft(initialTerm)
    }
  }, [open, initialTerm])

  const enabled = open && !!recordingId && !!segmentId && term.trim().length > 0
  const q = useQuery({
    queryKey: ['explain', recordingId, segmentId, term, depth],
    queryFn: () => api.explain(recordingId!, term.trim(), segmentId!, depth),
    enabled,
    staleTime: Infinity,
    retry: false,
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTerm(draft.trim())
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Objašnjenje pojma" description="Prilagođeno vama i kontekstu predavanja.">
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="term-input" className="sr-only">
          Pojam
        </label>
        <input
          id="term-input"
          className={inputClass}
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Označite ili upišite pojam"
        />
        <Button type="submit" disabled={!draft.trim()}>
          Objasni
        </Button>
      </form>
      <div role="radiogroup" aria-label="Dubina objašnjenja" className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
        {DEPTHS.map((d) => (
          <button
            key={d.key}
            type="button"
            role="radio"
            aria-checked={depth === d.key}
            onClick={() => setDepth(d.key)}
            className={`min-h-10 rounded-md text-sm ${depth === d.key ? 'bg-white font-semibold shadow-sm' : 'text-slate-700'}`}
          >
            {d.label}
          </button>
        ))}
      </div>
      {!segmentId && <p className="mt-3 text-sm text-slate-600">Objašnjenje zahteva bar jedan segment transkripta kao kontekst.</p>}
      <div className="mt-4" aria-live="polite">
        {q.isFetching && <Spinner label="Pripremam objašnjenje…" />}
        {q.isError && <ErrorAlert error={q.error} onRetry={() => q.refetch()} />}
        {q.data && !q.isFetching && (
          <article className="space-y-3">
            <Badge tone={MODE[q.data.retrieval_mode].tone}>{MODE[q.data.retrieval_mode].text}</Badge>
            <h3 className="text-lg font-semibold">{term}</h3>
            <p className="leading-relaxed whitespace-pre-wrap">{q.data.explanation}</p>
            {q.data.example && (
              <div className="rounded-lg bg-slate-50 p-3">
                <h4 className="text-sm font-medium text-slate-700">Primer</h4>
                <p className="whitespace-pre-wrap">{q.data.example}</p>
              </div>
            )}
            {q.data.sources.length > 0 ? (
              <div>
                <h4 className="text-sm font-medium">Izvori</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {q.data.sources.map((s) => (
                    <li key={s.id}>
                      <ExternalLink href={s.url}>{s.title || s.url}</ExternalLink>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-slate-600">Nema izvora za ovo objašnjenje. Proverite ključne tvrdnje samostalno.</p>
            )}
          </article>
        )}
      </div>
    </Drawer>
  )
}
