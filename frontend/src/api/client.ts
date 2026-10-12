import * as s from './sanitize'
import type { Depth } from './types'

/** fetch-compatible transport. Real runtime uses window.fetch; src/dev/ may supply a synthetic one. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface TokenSource {
  /** Returns a Firebase ID token; forceRefresh after a 401. Null if signed out. */
  getIdToken(forceRefresh: boolean): Promise<string | null>
  /** Called when the backend still rejects a freshly refreshed token. */
  onUnauthenticated(): void
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null
  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
  /** Network failures and 408/429/5xx are safe to retry for idempotent requests. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code)
}

interface RequestOpts {
  json?: unknown
  form?: FormData
  signal?: AbortSignal
}

const enc = encodeURIComponent

export class ApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly tokens: TokenSource

  constructor(baseUrl: string, fetchImpl: FetchLike, tokens: TokenSource) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.tokens = tokens
  }

  /** Raw authenticated request; retries once with a refreshed token on 401. */
  async raw(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    let res = await this.send(method, path, opts, false)
    if (res.status === 401) {
      res = await this.send(method, path, opts, true)
      if (res.status === 401) {
        this.tokens.onUnauthenticated()
      }
    }
    if (!res.ok) throw await toApiError(res)
    return res
  }

  private async send(method: string, path: string, opts: RequestOpts, forceRefresh: boolean): Promise<Response> {
    const token = await this.tokens.getIdToken(forceRefresh)
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Niste prijavljeni.', null)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    let body: BodyInit | undefined
    if (opts.form) body = opts.form
    else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    try {
      return await this.fetchImpl(this.baseUrl + path, { method, headers, body, signal: opts.signal })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      throw new ApiError(0, 'NETWORK_ERROR', 'Nema veze sa serverom.', null)
    }
  }

  private async json<T>(method: string, path: string, map: (v: unknown) => T, opts?: RequestOpts): Promise<T> {
    const res = await this.raw(method, path, opts)
    return map(await res.json())
  }

  // ---- identity & events
  me = () => this.json('GET', '/me', s.me)
  events = (cursor?: string | null) =>
    this.json('GET', `/events${cursor ? `?cursor=${enc(cursor)}` : ''}`, s.eventsPage)
  joinEvent = (eventId: string) => this.json('POST', `/events/${enc(eventId)}/join`, () => ({ joined: true as const }))
  talks = (eventId: string) => this.json('GET', `/events/${enc(eventId)}/talks`, s.talks)

  // ---- profile & CV
  profile = (eventId: string) => this.json('GET', `/events/${enc(eventId)}/profile`, s.profile)
  uploadCv = (eventId: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return this.json('POST', `/events/${enc(eventId)}/cv`, (v) => {
      const o = v as { cv_status?: unknown }
      return { cv_status: o?.cv_status === 'processing' ? ('processing' as const) : ('uploaded' as const) }
    }, { form })
  }
  removeCv = (eventId: string) => this.json('DELETE', `/events/${enc(eventId)}/cv`, s.profile)
  setDeclaredInterests = (eventId: string, declared_interests: string[]) =>
    this.json('PATCH', `/events/${enc(eventId)}/profile`, s.profile, { json: { declared_interests } })

  // ---- recordings & transcript
  startRecording = (talkId: string) => this.json('POST', `/talks/${enc(talkId)}/recordings`, s.recordingSession)
  uploadChunk = (recordingId: string, chunk: { blob: Blob; sequence: number; start_ms: number; end_ms: number }, signal?: AbortSignal) => {
    const form = new FormData()
    form.append('file', chunk.blob, `chunk-${String(chunk.sequence).padStart(6, '0')}.wav`)
    form.append('sequence', String(chunk.sequence))
    form.append('start_ms', String(chunk.start_ms))
    form.append('end_ms', String(chunk.end_ms))
    return this.json('POST', `/recordings/${enc(recordingId)}/chunks`, s.chunkAccepted, { form, signal })
  }
  segments = (recordingId: string, afterSequence: number, limit = 50) =>
    this.json('GET', `/recordings/${enc(recordingId)}/segments?after_sequence=${afterSequence}&limit=${limit}`, s.segmentPage)
  stopRecording = (recordingId: string) =>
    this.json('POST', `/recordings/${enc(recordingId)}/stop`, () => ({ status: 'stopped' as const }))
  catchUp = (recordingId: string, start_ms: number, end_ms: number) =>
    this.json('POST', `/recordings/${enc(recordingId)}/catch-up`, s.catchUp, { json: { start_ms, end_ms } })
  explain = (recordingId: string, selected_text: string, segment_id: string, depth: Depth) =>
    this.json('POST', `/recordings/${enc(recordingId)}/explanations`, s.explanation, {
      json: { selected_text, segment_id, depth },
    })

  // ---- questions
  questionQuota = (talkId: string) => this.json('GET', `/talks/${enc(talkId)}/question-quota`, s.quota)
  myQuestions = (talkId: string) => this.json('GET', `/talks/${enc(talkId)}/questions`, s.questions)
  askQuestion = (talkId: string, text: string, client_request_id: string) =>
    this.json('POST', `/talks/${enc(talkId)}/questions`, s.questionCreated, { json: { text, client_request_id } })

  // ---- speaker
  speakerQuestions = (eventId: string) => this.json('GET', `/speaker/events/${enc(eventId)}/questions`, s.questions)
  markRead = (questionId: string) =>
    this.json('PATCH', `/speaker/questions/${enc(questionId)}`, s.question, { json: { read_status: 'read' } })

  // ---- sharing & sponsors
  opportunities = (eventId: string) => this.json('GET', `/events/${enc(eventId)}/opportunities`, s.opportunities)
  createOpportunity = (eventId: string, body: { title: string; topics: string[]; required_skills: string[] }) =>
    this.json('POST', `/sponsor/events/${enc(eventId)}/opportunities`, s.idOnly, { json: body })
  setConsent = (eventId: string, recipientId: string, allow_cv: boolean, allow_questions: boolean) =>
    this.json('PUT', `/events/${enc(eventId)}/consents/${enc(recipientId)}`, s.consent, { json: { allow_cv, allow_questions } })
  recommendations = (eventId: string) => this.json('GET', `/sponsor/events/${enc(eventId)}/recommendations`, s.recommendations)
  participantCv = async (eventId: string, participantId: string): Promise<Blob> => {
    const res = await this.raw('GET', `/sponsor/events/${enc(eventId)}/participants/${enc(participantId)}/cv`)
    return res.blob()
  }

  // ---- organizer
  setTranscriptSource = (talkId: string, recording_id: string) =>
    this.json('POST', `/organizer/talks/${enc(talkId)}/transcript-source`, () => ({ configured: true as const }), {
      json: { recording_id },
    })
  finalizeShortlists = (eventId: string) =>
    this.json('POST', `/organizer/events/${enc(eventId)}/finalize-shortlists`, (v) => {
      const o = v as { snapshot_id?: unknown; status?: unknown }
      if (typeof o?.snapshot_id !== 'string') throw new s.ContractError('snapshot_id nedostaje')
      return { snapshot_id: o.snapshot_id, status: 'finalized' as const }
    })
  metrics = (eventId: string) => this.json('GET', `/organizer/events/${enc(eventId)}/metrics`, s.metrics)
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`
  let message = `Greška servera (${res.status}).`
  let requestId: string | null = null
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown; request_id?: unknown } }
    if (body?.error) {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.message === 'string') message = body.error.message
      if (typeof body.error.request_id === 'string') requestId = body.error.request_id
    }
  } catch {
    // non-JSON error body: keep generic message
  }
  return new ApiError(res.status, code, message, requestId)
}
