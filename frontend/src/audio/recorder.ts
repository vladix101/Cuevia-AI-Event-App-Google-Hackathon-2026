import { ApiError } from '../api/client'
import type { RecordingSession } from '../api/types'
import type { AudioCapture, StartCapture } from './capture'
import { Chunker, type PcmChunk } from './chunker'
import { StreamingResampler } from './resampler'
import { UploadQueue, type UploadQueueState } from './uploadQueue'
import { encodeWavPcm16 } from './wav'

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error'

export interface RecorderSnapshot {
  status: RecorderStatus
  talkId: string | null
  session: RecordingSession | null
  error: string | null
  upload: UploadQueueState
  elapsedMs: number
}

export interface RecorderApi {
  startRecording(talkId: string): Promise<RecordingSession>
  uploadChunk(recordingId: string, c: { blob: Blob; sequence: number; start_ms: number; end_ms: number }): Promise<unknown>
  stopRecording(recordingId: string): Promise<unknown>
}

export interface RecorderDeps {
  api: RecorderApi
  startCapture: StartCapture
  now?: () => number
}

const EMPTY_UPLOAD: UploadQueueState = { queued: 0, sent: 0, dropped: 0, lastError: null }

/**
 * App-level recording session. It lives outside React components so opening
 * drawers, changing screens or re-rendering never interrupts the microphone.
 */
export class RecordingController {
  private readonly deps: RecorderDeps
  private readonly now: () => number
  private snap: RecorderSnapshot = { status: 'idle', talkId: null, session: null, error: null, upload: EMPTY_UPLOAD, elapsedMs: 0 }
  private listeners = new Set<() => void>()
  private capture: AudioCapture | null = null
  private resampler: StreamingResampler | null = null
  private chunker: Chunker | null = null
  private queue: UploadQueue | null = null
  private startedAtLocal = 0
  private lastTick = 0
  private wakeLock: { release(): Promise<void> } | null = null

  constructor(deps: RecorderDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => performance.now())
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  getSnapshot = () => this.snap

  get isActive() {
    return ['starting', 'recording', 'paused', 'stopping'].includes(this.snap.status)
  }

  /** Create a new recording for `talkId` and start the microphone. */
  async start(talkId: string): Promise<void> {
    if (this.isActive) {
      if (this.snap.talkId === talkId) return
      throw new Error('Snimanje je već aktivno za drugo predavanje. Prvo ga zaustavite.')
    }
    this.set({ status: 'starting', talkId, session: null, error: null, upload: EMPTY_UPLOAD, elapsedMs: 0 })
    let session: RecordingSession
    try {
      session = await this.deps.api.startRecording(talkId)
    } catch (e) {
      this.set({ status: 'error', error: message(e, 'Snimanje nije moguće započeti.') })
      return
    }
    this.chunker = new Chunker(session.sample_rate_hz, session.chunk_seconds)
    const recordingId = session.recording_id
    this.queue = new UploadQueue({
      send: async (c) => {
        await this.deps.api.uploadChunk(recordingId, c)
      },
      isRetryable: (e) => !(e instanceof ApiError) || e.retryable,
      onChange: (upload) => this.set({ upload }),
    })
    this.startedAtLocal = this.now()
    this.set({ session })
    await this.openMic()
  }

  async pause(): Promise<void> {
    if (this.snap.status !== 'recording') return
    await this.closeMic()
    this.set({ status: 'paused' })
  }

  async resume(): Promise<void> {
    if (!this.snap.session || !['paused', 'error'].includes(this.snap.status)) return
    this.set({ status: 'starting', error: null })
    // The pause becomes a visible gap in recording time instead of shifting later speech.
    this.chunker?.jumpTo(this.now() - this.startedAtLocal)
    await this.openMic()
  }

  async stop(): Promise<void> {
    const session = this.snap.session
    if (!session || !this.isActive) return
    this.set({ status: 'stopping' })
    await this.closeMic()
    if (this.queue) {
      await Promise.race([this.queue.drain(), new Promise((r) => setTimeout(r, 15000))])
      this.queue.close()
    }
    try {
      await this.deps.api.stopRecording(session.recording_id)
      this.set({ status: 'stopped' })
    } catch (e) {
      this.set({ status: 'stopped', error: message(e, 'Server nije potvrdio zaustavljanje snimanja.') })
    }
  }

  /** Forget a finished session (transcript polling for it stops). */
  reset() {
    if (this.isActive) return
    this.set({ status: 'idle', talkId: null, session: null, error: null, upload: EMPTY_UPLOAD, elapsedMs: 0 })
  }

  private async openMic() {
    const session = this.snap.session!
    try {
      const cap = await this.deps.startCapture({
        preferredSampleRate: session.sample_rate_hz,
        onFrames: (f) => this.onFrames(f),
        onEnded: (reason) => void this.onMicEnded(reason),
      })
      this.capture = cap
      this.resampler = new StreamingResampler(cap.sampleRate, session.sample_rate_hz)
      this.set({ status: 'recording', error: null })
      void this.acquireWakeLock()
    } catch (e) {
      this.set({ status: 'error', error: message(e, 'Mikrofon nije moguće pokrenuti.') })
    }
  }

  private async closeMic() {
    const cap = this.capture
    this.capture = null
    if (cap) await cap.stop()
    const tail = this.chunker?.flush()
    if (tail) this.enqueue(tail)
    this.resampler = null
    void this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
  }

  private async onMicEnded(reason: string) {
    if (this.snap.status !== 'recording') return
    await this.closeMic()
    this.set({ status: 'paused', error: reason })
  }

  private onFrames(frames: Float32Array) {
    if (!this.resampler || !this.chunker || this.snap.status !== 'recording') return
    for (const c of this.chunker.push(this.resampler.process(frames))) this.enqueue(c)
    const t = this.now()
    if (t - this.lastTick > 500) {
      this.lastTick = t
      this.set({ elapsedMs: this.chunker.elapsedMs })
    }
  }

  private enqueue(c: PcmChunk) {
    const rate = this.snap.session!.sample_rate_hz
    const blob = new Blob([encodeWavPcm16(c.samples, rate)], { type: 'audio/wav' })
    this.queue?.enqueue({ sequence: c.sequence, start_ms: c.start_ms, end_ms: c.end_ms, blob })
  }

  private async acquireWakeLock() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock
      if (wl) this.wakeLock = await wl.request('screen')
    } catch {
      // best effort: screen may still sleep and the OS may suspend the microphone
    }
  }

  private set(patch: Partial<RecorderSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((l) => l())
  }
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}
