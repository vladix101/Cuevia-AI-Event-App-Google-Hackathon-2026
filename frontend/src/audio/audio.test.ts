import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { Chunker } from './chunker'
import { StreamingResampler } from './resampler'
import { UploadQueue, type QueuedChunk } from './uploadQueue'
import { encodeWavPcm16 } from './wav'

describe('encodeWavPcm16', () => {
  it('writes a valid mono 16-bit PCM header and clamps samples', () => {
    const buf = encodeWavPcm16(Float32Array.from([0, 1, -1, 2]), 16000)
    const v = new DataView(buf)
    const str = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4))
    expect(str(0)).toBe('RIFF')
    expect(str(8)).toBe('WAVE')
    expect(str(12)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(str(36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(8)
    expect(buf.byteLength).toBe(44 + 8)
    expect(v.getInt16(46, true)).toBe(32767)
    expect(v.getInt16(48, true)).toBe(-32768)
    expect(v.getInt16(50, true)).toBe(32767) // clamped
  })
})

describe('StreamingResampler', () => {
  it('48k → 16k yields ~1/3 the samples across arbitrary block sizes', () => {
    const r = new StreamingResampler(48000, 16000)
    let out = 0
    for (const n of [128, 2048, 333, 4096, 1000]) out += r.process(new Float32Array(n).fill(0.5)).length
    const total = 128 + 2048 + 333 + 4096 + 1000
    expect(Math.abs(out - total / 3)).toBeLessThanOrEqual(2)
  })

  it('preserves a DC level after the filter settles', () => {
    const r = new StreamingResampler(44100, 16000)
    const y = r.process(new Float32Array(4410).fill(0.25))
    expect(y[y.length - 1]).toBeCloseTo(0.25, 2)
  })
})

describe('Chunker', () => {
  it('emits fixed-size chunks with monotonic sequences and ms timestamps', () => {
    const c = new Chunker(16000, 5)
    const chunks = c.push(new Float32Array(16000 * 12))
    expect(chunks.map((x) => [x.sequence, x.start_ms, x.end_ms])).toEqual([
      [0, 0, 5000],
      [1, 5000, 10000],
    ])
    const tail = c.flush()!
    expect([tail.sequence, tail.start_ms, tail.end_ms]).toEqual([2, 10000, 12000])
  })

  it('leaves a timeline gap after a pause instead of shifting later audio', () => {
    const c = new Chunker(16000, 5)
    c.push(new Float32Array(16000 * 5))
    c.jumpTo(20000)
    const [next] = c.push(new Float32Array(16000 * 5))
    expect([next.sequence, next.start_ms, next.end_ms]).toEqual([1, 20000, 25000])
  })

  it('drops a too-short tail', () => {
    const c = new Chunker(16000, 5)
    c.push(new Float32Array(100))
    expect(c.flush()).toBeNull()
  })
})

describe('UploadQueue', () => {
  const chunk = (sequence: number): QueuedChunk => ({ sequence, start_ms: sequence * 5000, end_ms: sequence * 5000 + 5000, blob: new Blob() })

  it('retries transient failures with the same sequence (idempotent) and keeps order', async () => {
    const seen: number[] = []
    let fails = 2
    const q = new UploadQueue({
      send: async (c) => {
        seen.push(c.sequence)
        if (c.sequence === 0 && fails-- > 0) throw new ApiError(503, 'UNAVAILABLE', 'down', null)
      },
      isRetryable: (e) => e instanceof ApiError && e.retryable,
      sleep: async () => {},
    })
    q.enqueue(chunk(0))
    q.enqueue(chunk(1))
    await q.drain()
    expect(seen).toEqual([0, 0, 0, 1])
    expect(q.state).toMatchObject({ sent: 2, dropped: 0, queued: 0 })
  })

  it('does not retry permanent 4xx failures', async () => {
    const send = vi.fn(async () => {
      throw new ApiError(400, 'BAD', 'bad', null)
    })
    const q = new UploadQueue({ send, isRetryable: (e) => e instanceof ApiError && e.retryable, sleep: async () => {} })
    q.enqueue(chunk(0))
    await q.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.state.dropped).toBe(1)
  })

  it('is bounded: drops the oldest waiting chunks when full', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sent: number[] = []
    const q = new UploadQueue({
      send: async (c) => {
        await gate
        sent.push(c.sequence)
      },
      isRetryable: () => true,
      maxQueued: 2,
      sleep: async () => {},
    })
    for (let i = 0; i < 6; i++) q.enqueue(chunk(i))
    release()
    await q.drain()
    // 0 was in flight; 1,2,3 were dropped as the waiting list exceeded 2.
    expect(sent).toEqual([0, 4, 5])
    expect(q.state.dropped).toBe(3)
  })
})
