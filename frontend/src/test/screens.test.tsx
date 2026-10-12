import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, fakeFetch, json, makeServices, ME, renderAt, TALKS, type Route } from './harness'

const base: Route[] = [
  ({ path }) => (path === '/me' ? json(200, ME) : undefined),
  ({ path }) => (path === '/events/e1/talks' ? json(200, TALKS) : undefined),
]

const profileRoute = (p: Record<string, unknown>): Route => ({ path }) =>
  path === '/events/e1/profile' ? json(200, p) : undefined

const PROFILE_NA = { user_id: 'u1', cv_status: 'missing', expertise_status: 'N/A', interests: [], eligible_for_top5: false }

describe('CV states and N/A availability', () => {
  it('missing CV shows N/A, not eligible, and offers skipping', async () => {
    const { fn } = fakeFetch([...base, profileRoute(PROFILE_NA)])
    renderAt('/events/e1/cv', makeServices(fn))
    expect(await screen.findByText(/N\/A — nema obrađenog CV-a/)).toBeInTheDocument()
    expect(screen.getByText('Niste u izboru za preporuke')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Preskoči za sada' })).toHaveAttribute('href', '/events/e1')
  })

  it('failed CV explains that all talk features still work', async () => {
    const { fn } = fakeFetch([...base, profileRoute({ ...PROFILE_NA, cv_status: 'failed' })])
    renderAt('/events/e1/profile', makeServices(fn))
    expect(await screen.findByText('Obrada CV-a nije uspela')).toBeInTheDocument()
    expect(screen.getByText(/sve funkcije praćenja predavanja i dalje rade/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ukloni CV' })).toBeEnabled()
  })

  it('attendee without CV can use transcript, catch-up, explanations and questions', async () => {
    const { fn } = fakeFetch([...base, profileRoute(PROFILE_NA)])
    renderAt('/events/e1/talks/t1', makeServices(fn))
    expect(await screen.findByRole('button', { name: /Pokreni transkripciju/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Izgubio sam nit/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Postavi pitanje' })).toBeEnabled()
  })
})

describe('no hidden scores in attendee view', () => {
  it('ignores private fields even if a server leaks them', async () => {
    const leaky = {
      user_id: 'u1',
      cv_status: 'parsed',
      expertise_status: 'estimated',
      interests: [{ topic: 'Rust', source: 'cv', score: 93 }],
      eligible_for_top5: true,
      cv_baseline: 81,
      expertise: 87,
      rank: 4,
    }
    const { fn } = fakeFetch([...base, profileRoute(leaky), ({ path }) => (path === '/events/e1/opportunities' ? json(200, { items: [] }) : undefined)])
    const { container } = renderAt('/events/e1/profile', makeServices(fn))
    expect(await screen.findByText('Procenjena (savetodavno)')).toBeInTheDocument()
    await screen.findByText('Rust')
    const text = container.textContent ?? ''
    for (const n of ['93', '81', '87']) expect(text).not.toContain(n)
    // No score-like label followed by a number anywhere (the privacy disclaimer itself is fine).
    expect(text).not.toMatch(/(rang|rank|score|ocena|stručnost|expertise|relevan\w*|dubina)\s*[:#]?\s*\d/i)
  })
})

describe('question drawer', () => {
  const Q = (id: string, text: string) => ({ id, talk_id: 't1', text, submitted_at: '2026-10-10T10:00:00Z', read_status: 'unread' })

  it('reuses client_request_id on retry and never deletes text on failure', async () => {
    let posts = 0
    const ids: string[] = []
    const { fn } = fakeFetch([
      ...base,
      ({ path }) => (path === '/talks/t1/question-quota' ? json(200, { used: 0, limit: 3, remaining: 3 }) : undefined),
      ({ path, method }) => (path === '/talks/t1/questions' && method === 'GET' ? json(200, { items: [] }) : undefined),
      ({ path, method, body }) => {
        if (path !== '/talks/t1/questions' || method !== 'POST') return
        ids.push((body as { client_request_id: string }).client_request_id)
        if (++posts === 1) return apiError(503, 'UNAVAILABLE', 'Server privremeno nedostupan')
        return json(201, { question: Q('q1', 'Kako radi HNSW?'), quota: { used: 1, limit: 3, remaining: 2 } })
      },
    ])
    const user = userEvent.setup()
    renderAt('/events/e1/talks/t1', makeServices(fn))
    await user.click(await screen.findByRole('button', { name: 'Postavi pitanje' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('0/3 pitanja')
    const box = within(dialog).getByLabelText('Vaše pitanje')
    await user.type(box, 'Kako radi HNSW?')
    await user.click(within(dialog).getByRole('button', { name: 'Pošalji' }))
    expect(await within(dialog).findByText(/Slanje nije uspelo/)).toBeInTheDocument()
    expect(box).toHaveValue('Kako radi HNSW?')

    await user.click(within(dialog).getByRole('button', { name: 'Pošalji ponovo' }))
    await within(dialog).findByText('Kako radi HNSW?', { selector: 'p' })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(box).toHaveValue('')
    expect(within(dialog).getByText('1/3 pitanja')).toBeInTheDocument()
    // No AI reply / suggestion UI in the drawer.
    expect(within(dialog).queryByText(/odgovor modela|predlog|kviz/i)).toBeNull()
  })

  it('handles 409 QUESTION_LIMIT_REACHED without losing the text', async () => {
    let quota = { used: 2, limit: 3, remaining: 1 }
    const { fn } = fakeFetch([
      ...base,
      ({ path }) => (path === '/talks/t1/question-quota' ? json(200, quota) : undefined),
      ({ path, method }) =>
        path === '/talks/t1/questions' && method === 'GET' ? json(200, { items: [Q('a', 'Prvo'), Q('b', 'Drugo')] }) : undefined,
      ({ path, method }) => {
        if (path !== '/talks/t1/questions' || method !== 'POST') return
        quota = { used: 3, limit: 3, remaining: 0 } // another device used the last slot
        return apiError(409, 'QUESTION_LIMIT_REACHED', 'Limit')
      },
    ])
    const user = userEvent.setup()
    renderAt('/events/e1/talks/t1', makeServices(fn))
    await user.click(await screen.findByRole('button', { name: 'Postavi pitanje' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('2/3 pitanja')
    const box = within(dialog).getByLabelText('Vaše pitanje')
    await user.type(box, 'Treće pitanje')
    await user.click(within(dialog).getByRole('button', { name: 'Pošalji' }))
    expect(await within(dialog).findByText(/Iskoristili ste sva 3 pitanja/)).toBeInTheDocument()
    expect(box).toHaveValue('Treće pitanje')
    await within(dialog).findByText('3/3 pitanja')
    expect(within(dialog).getByRole('button', { name: 'Pošalji' })).toBeDisabled()
  })
})

describe('recording persists across drawers', () => {
  it('keeps the microphone running while question / catch-up / explanation drawers open and close', async () => {
    const { fn, calls } = fakeFetch([
      ...base,
      ({ path }) => (path === '/talks/t1/question-quota' ? json(200, { used: 0, limit: 3, remaining: 3 }) : undefined),
      ({ path, method }) => (path === '/talks/t1/questions' && method === 'GET' ? json(200, { items: [] }) : undefined),
      ({ path }) =>
        path === '/talks/t1/recordings'
          ? json(200, { recording_id: 'r1', mode: 'live', started_at: '2026-10-10T10:00:00Z', sample_rate_hz: 16000, chunk_seconds: 1 })
          : undefined,
      ({ path }) => (path === '/recordings/r1/chunks' ? json(202, { sequence: 0, status: 'accepted' }) : undefined),
      ({ path }) =>
        path.startsWith('/recordings/r1/segments')
          ? json(200, {
              items: [{ id: 's0', sequence: 0, start_ms: 0, end_ms: 1000, text: 'Prvi segment o indeksima.', status: 'ready' }],
              next_after_sequence: 0,
              processing_lag_ms: 0,
            })
          : undefined,
    ])
    const services = makeServices(fn)
    const user = userEvent.setup()
    renderAt('/events/e1/talks/t1', services)

    await user.click(await screen.findByRole('button', { name: /Pokreni transkripciju/ }))
    await screen.findByText('Snima se', { selector: 'span.font-semibold' })
    expect(services.capture.start).toHaveBeenCalledTimes(1)
    services.capture.feed(new Float32Array(16000)) // one full 1 s chunk
    await waitFor(() => expect(calls.some((c) => c.path === '/recordings/r1/chunks')).toBe(true))
    await screen.findByText('Prvi segment o indeksima.')

    await user.click(screen.getByRole('button', { name: 'Postavi pitanje' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /Izgubio sam nit/ }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Objasni pojam' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    expect(services.recorder.getSnapshot().status).toBe('recording')
    expect(services.capture.stop).not.toHaveBeenCalled()
    expect(services.capture.start).toHaveBeenCalledTimes(1)

    const chunkCall = calls.find((c) => c.path === '/recordings/r1/chunks')!
    const form = chunkCall.body as FormData
    expect(form.get('sequence')).toBe('0')
    expect(form.get('start_ms')).toBe('0')
    expect(form.get('end_ms')).toBe('1000')
    expect((form.get('file') as File).type).toBe('audio/wav')
  })
})
