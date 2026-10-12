// Public HTTP contract v1 (contracts/http-v1.md). Frontend models deliberately
// contain NO hidden-score fields (cv_baseline, expertise, relevance, depth,
// quality, bonus, score, rank). Responses pass through sanitize.ts, which copies
// only the fields declared here.

export type SegmentStatus = 'ready' | 'gap'
export interface Segment {
  id: string
  sequence: number
  start_ms: number
  end_ms: number
  text: string
  status: SegmentStatus
}

export type InterestSource = 'cv' | 'question' | 'declared'
export interface Interest {
  topic: string
  source: InterestSource
}

export type CvStatus = 'missing' | 'uploaded' | 'processing' | 'parsed' | 'failed' | 'removed'
export type ExpertiseStatus = 'N/A' | 'estimated'
export interface ProfilePublic {
  user_id: string
  cv_status: CvStatus
  expertise_status: ExpertiseStatus
  interests: Interest[]
  eligible_for_top5: boolean
}

export type ReadStatus = 'unread' | 'read'
export interface QuestionPublic {
  id: string
  talk_id: string
  text: string
  submitted_at: string
  read_status: ReadStatus
}

export interface Source {
  id: string
  title: string
  url: string
}

export interface CatchUp {
  cue: string
  summary: string
  source_segment_ids: string[]
  start_ms: number
  end_ms: number
}

export type RetrievalMode = 'web' | 'provided' | 'general'
export type Depth = 'simple' | 'standard' | 'advanced'
export interface Explanation {
  explanation: string
  example: string
  sources: Source[]
  retrieval_mode: RetrievalMode
}

export interface Me {
  user_id: string
  display_name: string
  roles: string[]
}

export interface EventSummary {
  id: string
  title: string
}
export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export type TalkStatus = 'scheduled' | 'live' | 'ended'
export interface Talk {
  id: string
  title: string
  speaker_name: string
  status: TalkStatus
}

export type RecordingMode = 'live' | 'replay'
export interface RecordingSession {
  recording_id: string
  mode: RecordingMode
  started_at: string
  sample_rate_hz: number
  chunk_seconds: number
}

export interface ChunkAccepted {
  sequence: number
  status: 'accepted'
}

export interface SegmentPage {
  items: Segment[]
  next_after_sequence: number
  processing_lag_ms: number
}

export interface Quota {
  used: number
  limit: number
  remaining: number
}

export interface QuestionCreated {
  question: QuestionPublic
  quota: Quota
}

export type RecipientKind = 'sponsor' | 'group'
export interface Opportunity {
  id: string
  recipient_id: string
  recipient_kind: RecipientKind
  title: string
  topics: string[]
}

export interface Consent {
  recipient_id: string
  allow_cv: boolean
  allow_questions: boolean
}

export interface Recommendation {
  participant_id: string
  display_name: string
  interests: Interest[]
  reasons: string[]
  questions: QuestionPublic[]
  cv_available: boolean
}

export interface TermCount {
  term: string
  count: number
}
export interface TopicCount {
  topic: string
  count: number
}
export interface Metrics {
  attendee_count: number
  cv_parsed_count: number
  na_count: number
  question_count: number
  catch_up_count: number
  requested_terms: TermCount[]
  interest_distribution: TopicCount[]
  share_count: number
}

export interface ApiErrorBody {
  error: { code: string; message: string; request_id: string }
}
