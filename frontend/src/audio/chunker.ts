export interface PcmChunk {
  sequence: number
  start_ms: number
  end_ms: number
  samples: Float32Array
}

/**
 * Accumulates mono samples at the backend-mandated rate and emits fixed-length
 * chunks of `chunkSeconds`. Timestamps are recording-relative milliseconds
 * derived from sample counts; a pause leaves a gap via `jumpTo`.
 */
export class Chunker {
  private readonly sampleRate: number
  private readonly chunkSamples: number
  private readonly buf: Float32Array
  private fill = 0
  private nextSequence: number
  private timelineSamples = 0
  private chunkStartSamples = 0

  constructor(sampleRate: number, chunkSeconds: number, firstSequence = 0) {
    this.sampleRate = sampleRate
    this.chunkSamples = Math.round(sampleRate * chunkSeconds)
    this.buf = new Float32Array(this.chunkSamples)
    this.nextSequence = firstSequence
  }

  push(samples: Float32Array): PcmChunk[] {
    const out: PcmChunk[] = []
    let i = 0
    while (i < samples.length) {
      if (this.fill === 0) this.chunkStartSamples = this.timelineSamples
      const n = Math.min(this.chunkSamples - this.fill, samples.length - i)
      this.buf.set(samples.subarray(i, i + n), this.fill)
      this.fill += n
      this.timelineSamples += n
      i += n
      if (this.fill === this.chunkSamples) out.push(this.take())
    }
    return out
  }

  /** Emit whatever is buffered (on pause/stop) if it is at least `minMs` long. */
  flush(minMs = 300): PcmChunk | null {
    if (this.fill === 0) return null
    if ((this.fill / this.sampleRate) * 1000 < minMs) {
      this.fill = 0
      return null
    }
    return this.take()
  }

  /** Move the timeline forward (after a pause) so the next chunk starts at `ms`. */
  jumpTo(ms: number) {
    const target = Math.round((ms / 1000) * this.sampleRate)
    if (this.fill === 0 && target > this.timelineSamples) this.timelineSamples = target
  }

  get elapsedMs(): number {
    return Math.round((this.timelineSamples / this.sampleRate) * 1000)
  }

  private take(): PcmChunk {
    const toMs = (s: number) => Math.round((s / this.sampleRate) * 1000)
    const chunk: PcmChunk = {
      sequence: this.nextSequence++,
      start_ms: toMs(this.chunkStartSamples),
      end_ms: toMs(this.chunkStartSamples + this.fill),
      samples: this.buf.slice(0, this.fill),
    }
    this.fill = 0
    return chunk
  }
}
