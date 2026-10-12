import { describe, expect, it } from 'vitest'
import { EMPTY_TRANSCRIPT, mergeSegmentPage } from './transcript'
import type { Segment } from './types'

const seg = (sequence: number, status: Segment['status'] = 'ready', text = `s${sequence}`): Segment => ({
  id: `seg-${sequence}`,
  sequence,
  start_ms: sequence * 5000,
  end_ms: sequence * 5000 + 5000,
  text,
  status,
})

describe('mergeSegmentPage', () => {
  it('appends only unseen sequences and keeps order', () => {
    let st = mergeSegmentPage(EMPTY_TRANSCRIPT, { items: [seg(0), seg(1)], next_after_sequence: 1, processing_lag_ms: 0 })
    // Overlapping page (duplicate seq 1 with different text must not replace the original), out of order.
    st = mergeSegmentPage(st, { items: [seg(3), seg(1, 'ready', 'DUP'), seg(2)], next_after_sequence: 3, processing_lag_ms: 0 })
    expect(st.segments.map((s) => s.sequence)).toEqual([0, 1, 2, 3])
    expect(st.segments[1].text).toBe('s1')
    expect(st.cursor).toBe(3)
  })

  it('keeps gap segments so the hole is visible', () => {
    const st = mergeSegmentPage(EMPTY_TRANSCRIPT, { items: [seg(0), seg(1, 'gap', ''), seg(2)], next_after_sequence: 2, processing_lag_ms: 0 })
    expect(st.segments.map((s) => s.status)).toEqual(['ready', 'gap', 'ready'])
  })

  it('never moves the cursor backwards and returns the same object when nothing changed', () => {
    const a = mergeSegmentPage(EMPTY_TRANSCRIPT, { items: [seg(0)], next_after_sequence: 4, processing_lag_ms: 0 })
    const b = mergeSegmentPage(a, { items: [], next_after_sequence: 2, processing_lag_ms: 0 })
    expect(b).toBe(a)
    expect(b.cursor).toBe(4)
  })
})
