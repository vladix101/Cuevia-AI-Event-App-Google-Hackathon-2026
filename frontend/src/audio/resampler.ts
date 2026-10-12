/**
 * Streaming mono resampler. When downsampling it first applies a windowed-sinc
 * low-pass FIR (anti-aliasing), then linear interpolation. Filter history and
 * the fractional read position are carried across calls so chunk boundaries
 * stay continuous.
 */
export class StreamingResampler {
  readonly inRate: number
  readonly outRate: number
  private readonly step: number
  private readonly taps: Float32Array | null
  private history: Float32Array
  /** Read position in the filtered stream; index -1 refers to `prev`. */
  private pos = 0
  private prev = 0
  private hasPrev = false

  constructor(inRate: number, outRate: number) {
    if (inRate <= 0 || outRate <= 0) throw new Error('invalid sample rate')
    this.inRate = inRate
    this.outRate = outRate
    this.step = inRate / outRate
    this.taps = outRate < inRate ? lowPassTaps(31, ((0.5 * outRate) / inRate) * 0.9) : null
    this.history = new Float32Array(this.taps ? this.taps.length - 1 : 0)
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice()
    if (input.length === 0) return new Float32Array(0)
    const x = this.filter(input)
    const at = (i: number) => (i < 0 ? this.prev : x[i])
    const out: number[] = []
    let p = this.hasPrev ? this.pos : 0
    while (p <= x.length - 1) {
      const i = Math.floor(p)
      const frac = p - i
      const a = at(i)
      const b = frac === 0 ? a : at(i + 1)
      out.push(a + (b - a) * frac)
      p += this.step
    }
    this.prev = x[x.length - 1]
    this.hasPrev = true
    this.pos = p - x.length
    return Float32Array.from(out)
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps
    if (!taps) return input
    const h = this.history
    const full = new Float32Array(h.length + input.length)
    full.set(h, 0)
    full.set(input, h.length)
    const out = new Float32Array(input.length)
    for (let n = 0; n < input.length; n++) {
      let acc = 0
      for (let k = 0; k < taps.length; k++) acc += taps[k] * full[n + k]
      out[n] = acc
    }
    this.history = full.slice(full.length - h.length)
    return out
  }
}

function lowPassTaps(n: number, cutoff: number): Float32Array {
  const taps = new Float32Array(n)
  const m = (n - 1) / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t = i - m
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t)
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)) // Hamming window
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < n; i++) taps[i] /= sum
  return taps
}
