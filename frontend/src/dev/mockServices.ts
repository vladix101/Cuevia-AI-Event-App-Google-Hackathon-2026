// DEVELOPMENT-ONLY synthetic HTTP transport + auth. Enabled only with VITE_USE_MOCKS=true.
// Implements public contract v1 shapes in memory so screens can be built before the backend.
// It produces no model output: transcript/catch-up/explanations are labeled placeholder text.
import type { FetchLike } from '../api/client'
import type { AuthBackend, AuthUser } from '../auth/types'
import { fixtureEvents, fixtureOpportunities, fixtureTalks, SYNTHETIC_TAG, syntheticSentences } from './fixtures'

type Json = Record<string, unknown>

interface Seg {
  id: string
  sequence: number
  start_ms: number
  end_ms: number
  text: string
  status: 'ready' | 'gap'
}

export function createMockServices(apiBaseUrl: string): { auth: AuthBackend; fetchImpl: FetchLike } {
  const auth = createSyntheticAuth()
  return { auth, fetchImpl: createMockFetch(apiBaseUrl, () => auth.current()) }
}

function createSyntheticAuth(): AuthBackend & { current(): AuthUser | null } {
  const KEY = 'cuevia-dev-user'
  let user: AuthUser | null = null
  try {
    const raw = sessionStorage.getItem(KEY)
    user = raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    user = null
  }
  const ls = new Set<(u: AuthUser | null) => void>()
  const set = (u: AuthUser | null) => {
    user = u
    try {
      if (u) sessionStorage.setItem(KEY, JSON.stringify(u))
      else sessionStorage.removeItem(KEY)
    } catch {
      // storage unavailable: keep in memory only
    }
    ls.forEach((l) => l(u))
  }
  return {
    kind: 'synthetic',
    googleEnabled: false,
    current: () => user,
    subscribe(cb) {
      ls.add(cb)
      queueMicrotask(() => cb(user))
      return () => {
        ls.delete(cb)
      }
    },
    async signIn(email) {
      set({ uid: `dev-${email}`, email, displayName: `${SYNTHETIC_TAG} ${email.split('@')[0]}` })
    },
    async signUp(email, _pw, displayName) {
      set({ uid: `dev-${email}`, email, displayName: displayName || email })
    },
    async signInWithGoogle() {
      throw new Error('Google prijava nije dostupna u razvojnom režimu.')
    },
    async signOut() {
      set(null)
    },
    async getIdToken() {
      return user ? `synthetic-dev-token.${user.uid}` : null
    },
  }
}

function createMockFetch(apiBaseUrl: string, currentUser: () => AuthUser | null): FetchLike {
  const base = apiBaseUrl.replace(/\/+$/, '')
  let reqN = 0
  const profiles = new Map<string, { cv_status: string; declared: string[]; timer?: ReturnType<typeof setTimeout> }>()
  const questions: { id: string; talk_id: string; text: string; submitted_at: string; read_status: 'unread' | 'read'; owner: string }[] = []
  const idempotency = new Map<string, Json>()
  const recordings = new Map<string, { talkId: string; segments: Seg[]; stopped: boolean; pending: number }>()
  const opportunities = [...fixtureOpportunities]
  let finalized = false
  const termCounts = new Map<string, number>()
  let catchUps = 0

  const res = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const err = (status: number, code: string, message: string) =>
    res(status, { error: { code, message, request_id: `dev-req-${++reqN}` } })
  const profileOf = (eventId: string) => {
    let p = profiles.get(eventId)
    if (!p) profiles.set(eventId, (p = { cv_status: 'missing', declared: [] }))
    const parsed = p.cv_status === 'parsed'
    return {
      user_id: currentUser()?.uid ?? 'dev-user',
      cv_status: p.cv_status,
      expertise_status: parsed ? 'estimated' : 'N/A',
      interests: [
        ...(parsed ? [{ topic: 'vektorske baze', source: 'cv' }, { topic: 'Python', source: 'cv' }] : []),
        ...(questions.length ? [{ topic: 'pretraga', source: 'question' }] : []),
        ...p.declared.map((topic) => ({ topic, source: 'declared' })),
      ],
      eligible_for_top5: parsed,
    }
  }
  const quotaOf = (talkId: string, owner: string) => {
    const used = questions.filter((q) => q.talk_id === talkId && q.owner === owner).length
    return { used, limit: 3, remaining: Math.max(0, 3 - used) }
  }
  const publicQ = ({ owner: _o, ...q }: (typeof questions)[number]) => q

  return async (url, init) => {
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250))
    const user = currentUser()
    const authz = new Headers(init.headers).get('Authorization')
    if (!user || !authz?.startsWith('Bearer synthetic-dev-token')) return err(401, 'UNAUTHENTICATED', 'Niste prijavljeni.')
    const u = new URL(url)
    const path = u.href.slice(base.length).split('?')[0]
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : undefined
    const form = init.body instanceof FormData ? init.body : undefined
    const m = (re: RegExp) => path.match(re)
    let x: RegExpMatchArray | null

    if (method === 'GET' && path === '/me')
      return res(200, { user_id: user.uid, display_name: user.displayName ?? user.email, roles: ['attendee', 'speaker', 'sponsor', 'organizer'] })
    if (method === 'GET' && path === '/events') return res(200, { items: fixtureEvents, next_cursor: null })
    if ((x = m(/^\/events\/([^/]+)\/join$/)) && method === 'POST') return res(200, { joined: true })
    if ((x = m(/^\/events\/([^/]+)\/talks$/))) return res(200, { items: fixtureTalks[decodeURIComponent(x[1])] ?? [] })

    if ((x = m(/^\/events\/([^/]+)\/profile$/))) {
      const ev = decodeURIComponent(x[1])
      if (method === 'PATCH') {
        const list = (body?.declared_interests as string[]) ?? []
        profileOf(ev)
        profiles.get(ev)!.declared = list.slice(0, 20)
      }
      return res(200, profileOf(ev))
    }
    if ((x = m(/^\/events\/([^/]+)\/cv$/))) {
      const ev = decodeURIComponent(x[1])
      profileOf(ev)
      const p = profiles.get(ev)!
      if (method === 'DELETE') {
        clearTimeout(p.timer)
        p.cv_status = 'removed'
        return res(200, profileOf(ev))
      }
      const file = form?.get('file') as File | null
      if (!file) return err(400, 'VALIDATION_ERROR', 'Fajl nedostaje.')
      p.cv_status = 'processing'
      clearTimeout(p.timer)
      // Synthetic rule for testing the failure path: a file name containing "fail" fails parsing.
      p.timer = setTimeout(() => (p.cv_status = /fail/i.test(file.name) ? 'failed' : 'parsed'), 3000)
      return res(202, { cv_status: 'processing' })
    }

    if ((x = m(/^\/talks\/([^/]+)\/recordings$/)) && method === 'POST') {
      const id = `dev-rec-${Date.now().toString(36)}`
      recordings.set(id, { talkId: decodeURIComponent(x[1]), segments: [], stopped: false, pending: 0 })
      return res(200, { recording_id: id, mode: 'replay', started_at: new Date().toISOString(), sample_rate_hz: 16000, chunk_seconds: 5 })
    }
    if ((x = m(/^\/recordings\/([^/]+)\/chunks$/)) && method === 'POST') {
      const rec = recordings.get(decodeURIComponent(x[1]))
      if (!rec) return err(404, 'NOT_FOUND', 'Snimak ne postoji.')
      if (rec.stopped) return err(409, 'RECORDING_STOPPED', 'Snimak je zaustavljen.')
      const sequence = Number(form?.get('sequence'))
      const start_ms = Number(form?.get('start_ms'))
      const end_ms = Number(form?.get('end_ms'))
      if (!rec.segments.some((s) => s.sequence === sequence)) {
        rec.pending++
        setTimeout(() => {
          rec.pending--
          if (rec.segments.some((s) => s.sequence === sequence)) return
          const gap = sequence > 0 && sequence % 7 === 0
          rec.segments.push({
            id: `dev-seg-${sequence}`,
            sequence,
            start_ms,
            end_ms,
            status: gap ? 'gap' : 'ready',
            text: gap ? '' : `${SYNTHETIC_TAG} ${syntheticSentences[sequence % syntheticSentences.length]}`,
          })
        }, 1500)
      }
      return res(202, { sequence, status: 'accepted' })
    }
    if ((x = m(/^\/recordings\/([^/]+)\/segments$/))) {
      const rec = recordings.get(decodeURIComponent(x[1]))
      if (!rec) return err(404, 'NOT_FOUND', 'Snimak ne postoji.')
      const after = Number(u.searchParams.get('after_sequence') ?? -1)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const items = rec.segments.filter((s) => s.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, limit)
      return res(200, {
        items,
        next_after_sequence: items.length ? items[items.length - 1].sequence : after,
        processing_lag_ms: rec.pending * 1500,
      })
    }
    if ((x = m(/^\/recordings\/([^/]+)\/stop$/))) {
      const rec = recordings.get(decodeURIComponent(x[1]))
      if (rec) rec.stopped = true
      return res(200, { status: 'stopped' })
    }
    if ((x = m(/^\/recordings\/([^/]+)\/catch-up$/))) {
      const rec = recordings.get(decodeURIComponent(x[1]))
      const start_ms = Number(body?.start_ms ?? 0)
      const end_ms = Number(body?.end_ms ?? 0)
      const segs = (rec?.segments ?? []).filter((s) => s.status === 'ready' && s.end_ms > start_ms && s.start_ms < end_ms)
      if (!segs.length) return err(422, 'NO_TRANSCRIPT', 'U izabranom opsegu nema transkripta.')
      catchUps++
      return res(200, {
        cue: `${SYNTHETIC_TAG} Govornik je pričao o pretrazi vektora.`,
        summary: `${SYNTHETIC_TAG} Ovo je fiksni razvojni tekst, nije sažetak modela. Opseg pokriva ${segs.length} segment(a).`,
        source_segment_ids: segs.slice(-3).map((s) => s.id),
        start_ms,
        end_ms,
      })
    }
    if ((x = m(/^\/recordings\/([^/]+)\/explanations$/))) {
      const term = String(body?.selected_text ?? '')
      const depth = String(body?.depth ?? 'standard')
      termCounts.set(term.toLowerCase(), (termCounts.get(term.toLowerCase()) ?? 0) + 1)
      const web = term.length % 2 === 0
      return res(200, {
        explanation: `${SYNTHETIC_TAG} Fiksno objašnjenje za „${term}" (dubina: ${depth}). Nije generisano modelom.`,
        example: `${SYNTHETIC_TAG} Primer upotrebe pojma „${term}".`,
        sources: web ? [{ id: 'dev-src-1', title: `${SYNTHETIC_TAG} example.com (rezervisan domen)`, url: 'https://example.com/' }] : [],
        retrieval_mode: web ? 'web' : 'general',
      })
    }

    if ((x = m(/^\/talks\/([^/]+)\/question-quota$/))) return res(200, quotaOf(decodeURIComponent(x[1]), user.uid))
    if ((x = m(/^\/talks\/([^/]+)\/questions$/))) {
      const talkId = decodeURIComponent(x[1])
      if (method === 'GET')
        return res(200, { items: questions.filter((q) => q.talk_id === talkId && q.owner === user.uid).map(publicQ) })
      const key = `${user.uid}:${talkId}:${String(body?.client_request_id)}`
      const prior = idempotency.get(key)
      if (prior) return res(201, prior)
      const text = String(body?.text ?? '').trim()
      if (!text) return err(400, 'VALIDATION_ERROR', 'Pitanje je prazno.')
      if (quotaOf(talkId, user.uid).remaining <= 0)
        return err(409, 'QUESTION_LIMIT_REACHED', 'Iskoristili ste sva pitanja za ovo predavanje.')
      const q = { id: `dev-q-${questions.length + 1}`, talk_id: talkId, text, submitted_at: new Date().toISOString(), read_status: 'unread' as const, owner: user.uid }
      questions.push(q)
      const result = { question: publicQ(q), quota: quotaOf(talkId, user.uid) }
      idempotency.set(key, result)
      return res(201, result)
    }

    if ((x = m(/^\/speaker\/events\/([^/]+)\/questions$/))) return res(200, { items: questions.map(publicQ) })
    if ((x = m(/^\/speaker\/questions\/([^/]+)$/)) && method === 'PATCH') {
      const q = questions.find((qq) => qq.id === decodeURIComponent(x![1]))
      if (!q) return err(404, 'NOT_FOUND', 'Pitanje ne postoji.')
      q.read_status = 'read'
      return res(200, publicQ(q))
    }

    if ((x = m(/^\/events\/([^/]+)\/opportunities$/))) return res(200, { items: opportunities })
    if ((x = m(/^\/sponsor\/events\/([^/]+)\/opportunities$/)) && method === 'POST') {
      const id = `dev-opp-${opportunities.length + 1}`
      opportunities.push({ id, recipient_id: 'dev-sponsor-1', recipient_kind: 'sponsor', title: String(body?.title), topics: (body?.topics as string[]) ?? [] })
      return res(201, { id })
    }
    if ((x = m(/^\/events\/([^/]+)\/consents\/([^/]+)$/)) && method === 'PUT')
      return res(200, { recipient_id: decodeURIComponent(x[2]), allow_cv: !!body?.allow_cv, allow_questions: !!body?.allow_questions })
    if ((x = m(/^\/sponsor\/events\/([^/]+)\/recommendations$/))) {
      if (!finalized) return res(200, { items: [] })
      return res(200, {
        items: [
          {
            participant_id: 'dev-participant-1',
            display_name: `${SYNTHETIC_TAG} Demo Učesnik`,
            interests: [{ topic: 'vektorske baze', source: 'cv' }],
            reasons: [`${SYNTHETIC_TAG} Fiksni razlog za razvoj.`],
            questions: questions.slice(0, 2).map(publicQ),
            cv_available: true,
          },
        ],
      })
    }
    if ((x = m(/^\/sponsor\/events\/([^/]+)\/participants\/([^/]+)\/cv$/)))
      return new Response(`${SYNTHETIC_TAG} Ovo nije stvarni CV.`, { status: 200, headers: { 'Content-Type': 'text/plain' } })

    if ((x = m(/^\/organizer\/talks\/([^/]+)\/transcript-source$/))) return res(200, { configured: true })
    if ((x = m(/^\/organizer\/events\/([^/]+)\/finalize-shortlists$/))) {
      finalized = true
      return res(200, { snapshot_id: `dev-snapshot-${Date.now().toString(36)}`, status: 'finalized' })
    }
    if ((x = m(/^\/organizer\/events\/([^/]+)\/metrics$/))) {
      // Counts derived from this browser's in-memory synthetic state only.
      const ps = [...profiles.values()]
      const parsed = ps.filter((p) => p.cv_status === 'parsed').length
      return res(200, {
        attendee_count: ps.length,
        cv_parsed_count: parsed,
        na_count: ps.length - parsed,
        question_count: questions.length,
        catch_up_count: catchUps,
        requested_terms: [...termCounts.entries()].map(([term, count]) => ({ term, count })),
        interest_distribution: ps.flatMap((p) => p.declared).reduce<{ topic: string; count: number }[]>((acc, t) => {
          const e = acc.find((a) => a.topic === t)
          if (e) e.count++
          else acc.push({ topic: t, count: 1 })
          return acc
        }, []),
        share_count: 0,
      })
    }
    return err(404, 'NOT_FOUND', `Mock ruta ne postoji: ${method} ${path}`)
  }
}
