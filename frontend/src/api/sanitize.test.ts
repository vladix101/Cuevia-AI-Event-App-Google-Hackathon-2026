import { describe, expect, it } from 'vitest'
import * as s from './sanitize'

const HIDDEN = ['cv_baseline', 'expertise', 'relevance', 'depth', 'quality', 'bonus', 'score', 'scores', 'rank']

function hasHidden(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasHidden)
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => HIDDEN.includes(k) || hasHidden(x))
  return false
}

describe('sanitizers drop private fields', () => {
  it('profile keeps only public fields', () => {
    const p = s.profile({
      user_id: 'u',
      cv_status: 'parsed',
      expertise_status: 'estimated',
      interests: [{ topic: 'ML', source: 'cv', score: 9 }],
      eligible_for_top5: true,
      cv_baseline: 77,
      expertise: { ML: 88 },
      rank: 1,
    })
    expect(p).toEqual({
      user_id: 'u',
      cv_status: 'parsed',
      expertise_status: 'estimated',
      interests: [{ topic: 'ML', source: 'cv' }],
      eligible_for_top5: true,
    })
    expect(hasHidden(p)).toBe(false)
  })

  it('question / created / recommendations strip ratings', () => {
    const q = { id: 'q', talk_id: 't', text: 'x', submitted_at: '2026-01-01T00:00:00Z', read_status: 'unread', relevance: 8, expertise: 7, depth: 6, quality: 'good' }
    expect(hasHidden(s.question(q))).toBe(false)
    expect(hasHidden(s.questionCreated({ question: q, quota: { used: 1, limit: 3, remaining: 2, bonus: 1 } }))).toBe(false)
    const recs = s.recommendations({
      items: [{ participant_id: 'p', display_name: 'P', interests: [], reasons: ['r'], questions: [q], cv_available: true, score: 0.9, rank: 2 }],
    })
    expect(hasHidden(recs)).toBe(false)
  })

  it('rejects contract violations instead of guessing', () => {
    expect(() => s.profile({ user_id: 'u', cv_status: 'weird', expertise_status: 'N/A', interests: [], eligible_for_top5: false })).toThrow(s.ContractError)
    expect(() => s.recordingSession({ recording_id: 'r', mode: 'live', started_at: 'x', sample_rate_hz: 2, chunk_seconds: 5 })).toThrow()
  })

  it('only allows http(s) links', () => {
    expect(s.safeExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(s.safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(s.safeExternalUrl('data:text/html,hi')).toBeNull()
    expect(s.safeExternalUrl('not a url')).toBeNull()
  })
})
