import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { qk } from '../api/hooks'
import { Button, Card, EmptyState, ErrorAlert, Spinner } from '../components/ui'
import { useApi } from '../services'

export function EventsPage() {
  const api = useApi()
  const nav = useNavigate()
  const events = useInfiniteQuery({
    queryKey: qk.events,
    queryFn: ({ pageParam }) => api.events(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  })
  const join = useMutation({
    mutationFn: (eventId: string) => api.joinEvent(eventId),
    onSuccess: (_d, eventId) => nav(`/events/${eventId}/cv`),
  })

  const items = events.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Događaji</h1>
      {events.isPending && <Spinner />}
      {events.isError && <ErrorAlert error={events.error} onRetry={() => events.refetch()} />}
      {events.isSuccess && items.length === 0 && <EmptyState>Trenutno nema dostupnih događaja.</EmptyState>}
      <ul className="space-y-3">
        {items.map((e) => (
          <li key={e.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{e.title}</h2>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => nav(`/events/${e.id}`)}>
                    Otvori
                  </Button>
                  <Button onClick={() => join.mutate(e.id)} disabled={join.isPending && join.variables === e.id}>
                    {join.isPending && join.variables === e.id ? 'Pridruživanje…' : 'Pridruži se'}
                  </Button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {join.isError && <ErrorAlert error={join.error} />}
      {events.hasNextPage && (
        <Button variant="secondary" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
          Učitaj još
        </Button>
      )}
    </div>
  )
}
