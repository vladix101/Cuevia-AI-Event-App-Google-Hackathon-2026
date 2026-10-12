// Whitelist-copy every response into the public types. Unknown fields (including
// anything that looks like a private score) are dropped, never stored.
import type {
  CatchUp,
  ChunkAccepted,
  Consent,
  EventSummary,
  Explanation,
  Interest,
  Me,
  Metrics,
  Opportunity,
  Page,
  ProfilePublic,
  QuestionCreated,
  QuestionPublic,
  Quota,
  Recommendation,
  RecordingSession,
  Segment,
  SegmentPage,
  Source,
  Talk,
} from './types'

export class ContractError extends Error {
  constructor(message: string) {
    super(`Odgovor servera ne odgovara ugovoru v1: ${message}`)
    this.name = 'ContractError'
  }
}

type Obj = Record<string, unknown>

function obj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ContractError(`${what} nije objekat`)
  return v as Obj
}
function str(o: Obj, k: string): string {
  const v = o[k]
  if (typeof v !== 'string') throw new ContractError(`polje ${k} nije string`)
  return v
}
function strOrNull(o: Obj, k: string): string | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new ContractError(`polje ${k} nije string`)
  return v
}
function int(o: Obj, k: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(`polje ${k} nije broj`)
  return Math.trunc(v)
}
function bool(o: Obj, k: string): boolean {
  const v = o[k]
  if (typeof v !== 'boolean') throw new ContractError(`polje ${k} nije boolean`)
  return v
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = str(o, k)
  if (!(allowed as readonly string[]).includes(v)) throw new ContractError(`polje ${k} ima nepoznatu vrednost`)
  return v as T
}
function arr<T>(o: Obj, k: string, map: (v: unknown) => T): T[] {
  const v = o[k]
  if (!Array.isArray(v)) throw new ContractError(`polje ${k} nije niz`)
  return v.map(map)
}
function strings(o: Obj, k: string): string[] {
  return arr(o, k, (v) => {
    if (typeof v !== 'string') throw new ContractError(`${k} sadrži ne-string`)
    return v
  })
}

export function segment(v: unknown): Segment {
  const o = obj(v, 'segment')
  return {
    id: str(o, 'id'),
    sequence: int(o, 'sequence'),
    start_ms: int(o, 'start_ms'),
    end_ms: int(o, 'end_ms'),
    text: typeof o.text === 'string' ? o.text : '',
    status: oneOf(o, 'status', ['ready', 'gap'] as const),
  }
}

export function interest(v: unknown): Interest {
  const o = obj(v, 'interest')
  return { topic: str(o, 'topic'), source: oneOf(o, 'source', ['cv', 'question', 'declared'] as const) }
}

export function profile(v: unknown): ProfilePublic {
  const o = obj(v, 'profile')
  return {
    user_id: str(o, 'user_id'),
    cv_status: oneOf(o, 'cv_status', ['missing', 'uploaded', 'processing', 'parsed', 'failed', 'removed'] as const),
    expertise_status: oneOf(o, 'expertise_status', ['N/A', 'estimated'] as const),
    interests: arr(o, 'interests', interest),
    eligible_for_top5: bool(o, 'eligible_for_top5'),
  }
}

export function question(v: unknown): QuestionPublic {
  const o = obj(v, 'question')
  return {
    id: str(o, 'id'),
    talk_id: str(o, 'talk_id'),
    text: str(o, 'text'),
    submitted_at: str(o, 'submitted_at'),
    read_status: oneOf(o, 'read_status', ['unread', 'read'] as const),
  }
}

export function source(v: unknown): Source {
  const o = obj(v, 'source')
  return { id: str(o, 'id'), title: str(o, 'title'), url: str(o, 'url') }
}

export function catchUp(v: unknown): CatchUp {
  const o = obj(v, 'catch-up')
  return {
    cue: str(o, 'cue'),
    summary: str(o, 'summary'),
    source_segment_ids: strings(o, 'source_segment_ids'),
    start_ms: int(o, 'start_ms'),
    end_ms: int(o, 'end_ms'),
  }
}

export function explanation(v: unknown): Explanation {
  const o = obj(v, 'explanation')
  return {
    explanation: str(o, 'explanation'),
    example: typeof o.example === 'string' ? o.example : '',
    sources: arr(o, 'sources', source),
    retrieval_mode: oneOf(o, 'retrieval_mode', ['web', 'provided', 'general'] as const),
  }
}

export function me(v: unknown): Me {
  const o = obj(v, 'me')
  return { user_id: str(o, 'user_id'), display_name: str(o, 'display_name'), roles: strings(o, 'roles') }
}

export function eventsPage(v: unknown): Page<EventSummary> {
  const o = obj(v, 'events')
  return {
    items: arr(o, 'items', (e) => {
      const x = obj(e, 'event')
      return { id: str(x, 'id'), title: str(x, 'title') }
    }),
    next_cursor: strOrNull(o, 'next_cursor'),
  }
}

export function talks(v: unknown): Talk[] {
  const o = obj(v, 'talks')
  return arr(o, 'items', (t) => {
    const x = obj(t, 'talk')
    return {
      id: str(x, 'id'),
      title: str(x, 'title'),
      speaker_name: str(x, 'speaker_name'),
      status: oneOf(x, 'status', ['scheduled', 'live', 'ended'] as const),
    }
  })
}

export function recordingSession(v: unknown): RecordingSession {
  const o = obj(v, 'recording')
  const session: RecordingSession = {
    recording_id: str(o, 'recording_id'),
    mode: oneOf(o, 'mode', ['live', 'replay'] as const),
    started_at: str(o, 'started_at'),
    sample_rate_hz: int(o, 'sample_rate_hz'),
    chunk_seconds: int(o, 'chunk_seconds'),
  }
  if (session.sample_rate_hz < 8000 || session.sample_rate_hz > 48000) throw new ContractError('sample_rate_hz van opsega')
  if (session.chunk_seconds < 1 || session.chunk_seconds > 60) throw new ContractError('chunk_seconds van opsega')
  return session
}

export function chunkAccepted(v: unknown): ChunkAccepted {
  const o = obj(v, 'chunk')
  return { sequence: int(o, 'sequence'), status: oneOf(o, 'status', ['accepted'] as const) }
}

export function segmentPage(v: unknown): SegmentPage {
  const o = obj(v, 'segments')
  return {
    items: arr(o, 'items', segment),
    next_after_sequence: int(o, 'next_after_sequence'),
    processing_lag_ms: int(o, 'processing_lag_ms'),
  }
}

export function quota(v: unknown): Quota {
  const o = obj(v, 'quota')
  return { used: int(o, 'used'), limit: int(o, 'limit'), remaining: int(o, 'remaining') }
}

export function questions(v: unknown): QuestionPublic[] {
  return arr(obj(v, 'questions'), 'items', question)
}

export function questionCreated(v: unknown): QuestionCreated {
  const o = obj(v, 'question-created')
  return { question: question(o.question), quota: quota(o.quota) }
}

export function opportunities(v: unknown): Opportunity[] {
  return arr(obj(v, 'opportunities'), 'items', (e) => {
    const x = obj(e, 'opportunity')
    return {
      id: str(x, 'id'),
      recipient_id: str(x, 'recipient_id'),
      recipient_kind: oneOf(x, 'recipient_kind', ['sponsor', 'group'] as const),
      title: str(x, 'title'),
      topics: strings(x, 'topics'),
    }
  })
}

export function consent(v: unknown): Consent {
  const o = obj(v, 'consent')
  return { recipient_id: str(o, 'recipient_id'), allow_cv: bool(o, 'allow_cv'), allow_questions: bool(o, 'allow_questions') }
}

export function recommendations(v: unknown): Recommendation[] {
  return arr(obj(v, 'recommendations'), 'items', (e) => {
    const x = obj(e, 'recommendation')
    return {
      participant_id: str(x, 'participant_id'),
      display_name: str(x, 'display_name'),
      interests: arr(x, 'interests', interest),
      reasons: strings(x, 'reasons'),
      questions: arr(x, 'questions', question),
      cv_available: bool(x, 'cv_available'),
    }
  })
}

export function metrics(v: unknown): Metrics {
  const o = obj(v, 'metrics')
  return {
    attendee_count: int(o, 'attendee_count'),
    cv_parsed_count: int(o, 'cv_parsed_count'),
    na_count: int(o, 'na_count'),
    question_count: int(o, 'question_count'),
    catch_up_count: int(o, 'catch_up_count'),
    requested_terms: arr(o, 'requested_terms', (e) => {
      const x = obj(e, 'term')
      return { term: str(x, 'term'), count: int(x, 'count') }
    }),
    interest_distribution: arr(o, 'interest_distribution', (e) => {
      const x = obj(e, 'topic')
      return { topic: str(x, 'topic'), count: int(x, 'count') }
    }),
    share_count: int(o, 'share_count'),
  }
}

export function idOnly(v: unknown): { id: string } {
  return { id: str(obj(v, 'id'), 'id') }
}

/** Only http(s) URLs are rendered as clickable links. */
export function safeExternalUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}
