import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { qk, useTalks } from '../api/hooks'
import type { QuestionPublic } from '../api/types'
import { Badge, Button, Card, EmptyState, ErrorAlert, Spinner } from '../components/ui'
import { fmtClock } from '../lib/format'
import { useApi } from '../services'

export function SpeakerPage() {
  const { eventId = '' } = useParams()
  const api = useApi()
  const qc = useQueryClient()
  const talks = useTalks(eventId)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const questions = useQuery({
    queryKey: qk.speakerQuestions(eventId),
    queryFn: () => api.speakerQuestions(eventId),
    refetchInterval: 15_000,
  })
  const markRead = useMutation({
    mutationFn: (id: string) => api.markRead(id),
    onSuccess: (q) =>
      qc.setQueryData<QuestionPublic[]>(qk.speakerQuestions(eventId), (prev) => prev?.map((x) => (x.id === q.id ? q : x))),
  })

  const groups = new Map<string, QuestionPublic[]>()
  for (const q of questions.data ?? []) {
    if (unreadOnly && q.read_status === 'read') continue
    groups.set(q.talk_id, [...(groups.get(q.talk_id) ?? []), q])
  }
  const titleOf = (id: string) => talks.data?.find((t) => t.id === id)?.title ?? 'Predavanje'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Pitanja publike</h1>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Samo nepročitana
        </label>
      </div>
      {questions.isPending && <Spinner />}
      {questions.isError && <ErrorAlert error={questions.error} onRetry={() => questions.refetch()} />}
      {questions.isSuccess && groups.size === 0 && <EmptyState>Nema pitanja za prikaz.</EmptyState>}
      {markRead.isError && <ErrorAlert error={markRead.error} />}
      {[...groups.entries()].map(([talkId, list]) => (
        <Card key={talkId} title={titleOf(talkId)} actions={<Badge>{list.length}</Badge>}>
          <ol className="divide-y divide-slate-100">
            {[...list]
              .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
              .map((q) => (
                <li key={q.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className={`whitespace-pre-wrap break-words ${q.read_status === 'unread' ? 'font-medium' : 'text-slate-600'}`}>{q.text}</p>
                    <p className="text-xs text-slate-500">{fmtClock(q.submitted_at)}</p>
                  </div>
                  {q.read_status === 'unread' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => markRead.mutate(q.id)}
                      disabled={markRead.isPending && markRead.variables === q.id}
                    >
                      Označi kao pročitano
                    </Button>
                  ) : (
                    <Badge tone="green">Pročitano</Badge>
                  )}
                </li>
              ))}
          </ol>
        </Card>
      ))}
    </div>
  )
}
