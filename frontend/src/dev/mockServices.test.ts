import { describe, expect, it } from 'vitest'
import { ApiClient, isApiError } from '../api/client'
import { createMockServices } from './mockServices'

// Runs the synthetic transport through the REAL client + sanitizers, proving the
// fixtures stay identical in shape to public contract v1.
describe('dev mock transport conforms to contract v1', () => {
  it('serves core flows through the strict sanitizers', async () => {
    const { auth, fetchImpl } = createMockServices('http://mock/api/v1')
    await auth.signIn('dev@example.com', 'x')
    const api = new ApiClient('http://mock/api/v1', fetchImpl, { getIdToken: (f) => auth.getIdToken(f), onUnauthenticated: () => {} })

    expect((await api.me()).roles.length).toBeGreaterThan(0)
    const ev = (await api.events()).items[0].id
    await api.joinEvent(ev)
    const talk = (await api.talks(ev))[0].id
    expect((await api.profile(ev)).expertise_status).toBe('N/A')

    const a = await api.askQuestion(talk, 'Prvo?', 'req-1')
    const again = await api.askQuestion(talk, 'Prvo?', 'req-1') // idempotent retry
    expect(again.question.id).toBe(a.question.id)
    expect(again.quota.used).toBe(1)
    await api.askQuestion(talk, 'Drugo?', 'req-2')
    await api.askQuestion(talk, 'Treće?', 'req-3')
    const err = await api.askQuestion(talk, 'Četvrto?', 'req-4').catch((e) => e)
    expect(isApiError(err, 'QUESTION_LIMIT_REACHED')).toBe(true)
    expect(err.status).toBe(409)

    const rec = await api.startRecording(talk)
    expect(rec.mode).toBe('replay') // mock never claims to be live
    const page = await api.segments(rec.recording_id, -1)
    expect(page.items).toEqual([])
    expect(await api.metrics(ev)).toMatchObject({ question_count: 3 })
  }, 20_000)
})
