import type { Segment } from '../api/types'

/*
 * Browser speech recognition (Web Speech API).
 *
 * NOT Gemma: the browser vendor performs the recognition (Chrome/Edge send the
 * audio to their own cloud speech service). The resulting transcript stays on
 * this device. It is NOT sent to the backend and is NOT the authoritative
 * transcript used for question evaluation. The server-side Gemma transcript
 * (RecordingController → backend → /transcribe) is unchanged.
 */

// Minimal typings: SpeechRecognition is not part of TypeScript's lib.dom.
interface SpeechAlternative {
  transcript: string
}
interface SpeechResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechAlternative
}
export interface SpeechResultEvent {
  readonly resultIndex: number
  readonly results: { readonly length: number; [index: number]: SpeechResult }
}
export interface SpeechErrorEvent {
  readonly error: string
}
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type WebSpeechStatus = 'unsupported' | 'idle' | 'listening' | 'stopped' | 'error'

export interface WebSpeechSnapshot {
  status: WebSpeechStatus
  lang: string
  segments: Segment[]
  /** Not yet final text of the utterance currently being spoken. */
  interim: string
  error: string | null
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Pristup mikrofonu ili prepoznavanju govora je odbijen u pregledaču.',
  'service-not-allowed': 'Pregledač ne dozvoljava prepoznavanje govora na ovoj stranici.',
  'audio-capture': 'Mikrofon nije dostupan.',
  network: 'Prepoznavanje govora zahteva internet vezu (servis pregledača nije dostupan).',
  'language-not-supported': 'Izabrani jezik nije podržan za prepoznavanje govora u ovom pregledaču.',
}
// Errors after which restarting would just fail again.
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'])

export interface WebSpeechDeps {
  ctor?: SpeechRecognitionCtor | null
  now?: () => number
}

/**
 * Continuous recognizer that outlives React components. Browsers end a
 * recognition session after silence or ~1 min, so it restarts itself while
 * the user still wants it running.
 */
export class WebSpeechTranscriber {
  private readonly ctor: SpeechRecognitionCtor | null
  private readonly now: () => number
  private rec: SpeechRecognitionLike | null = null
  private wanted = false
  private startedAt = 0
  private utteranceStart: number | null = null
  private seq = 0
  private restarts = 0
  private listeners = new Set<() => void>()
  private snap: WebSpeechSnapshot

  constructor(deps: WebSpeechDeps = {}) {
    this.ctor = deps.ctor === undefined ? getSpeechRecognition() : deps.ctor
    this.now = deps.now ?? (() => performance.now())
    this.snap = { status: this.ctor ? 'idle' : 'unsupported', lang: 'sr-RS', segments: [], interim: '', error: null }
  }

  get supported() {
    return this.ctor !== null
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  getSnapshot = () => this.snap

  start(lang = this.snap.lang) {
    if (!this.ctor || this.wanted) return
    this.wanted = true
    this.restarts = 0
    if (this.snap.status !== 'stopped' || this.snap.segments.length === 0) {
      // New session; "Nastavi" after a stop keeps the existing text and timeline.
      this.seq = 0
      this.startedAt = this.now()
      this.set({ segments: [], interim: '' })
    }
    this.set({ lang, error: null })
    this.open()
  }

  stop() {
    this.wanted = false
    const rec = this.rec
    this.rec = null
    if (rec) {
      rec.onend = null
      rec.stop()
    }
    this.commitInterim()
    this.set({ status: this.ctor ? 'stopped' : 'unsupported', interim: '' })
  }

  /** Change recognition language (only while not listening). */
  setLang(lang: string) {
    if (this.wanted || lang === this.snap.lang) return
    this.set({ lang })
  }

  /** Clear the transcript (only while not listening). */
  reset() {
    if (this.wanted) return
    this.seq = 0
    this.set({ status: this.ctor ? 'idle' : 'unsupported', segments: [], interim: '', error: null })
  }

  private open() {
    const rec = new this.ctor!()
    rec.lang = this.snap.lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onresult = (e) => this.onResult(e)
    rec.onerror = (e) => this.onError(e)
    rec.onend = () => this.onEnd()
    this.rec = rec
    try {
      rec.start()
      this.set({ status: 'listening' })
    } catch (e) {
      this.wanted = false
      this.rec = null
      this.set({ status: 'error', error: e instanceof Error ? e.message : 'Prepoznavanje govora nije moguće pokrenuti.' })
    }
  }

  private onResult(e: SpeechResultEvent) {
    const t = this.now() - this.startedAt
    let interim = ''
    const finals: string[] = []
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      const text = (r[0]?.transcript ?? '').trim()
      if (!text) continue
      if (r.isFinal) finals.push(text)
      else interim += (interim ? ' ' : '') + text
    }
    if (this.utteranceStart === null && (finals.length || interim)) this.utteranceStart = t
    if (finals.length) {
      this.pushSegment(finals.join(' '), this.utteranceStart ?? t, t)
      this.utteranceStart = interim ? t : null
    }
    this.set({ interim })
  }

  private onError(e: SpeechErrorEvent) {
    if (e.error === 'no-speech' || e.error === 'aborted') return // normal; onend restarts
    this.set({ error: ERRORS[e.error] ?? `Greška prepoznavanja govora: ${e.error}` })
    if (FATAL.has(e.error)) {
      this.wanted = false
      this.set({ status: 'error' })
    }
  }

  private onEnd() {
    this.rec = null
    this.commitInterim()
    if (!this.wanted) {
      if (this.snap.status === 'listening') this.set({ status: 'stopped' })
      return
    }
    if (++this.restarts > 50) {
      this.wanted = false
      this.set({ status: 'error', error: 'Prepoznavanje govora se stalno prekida; pokušajte ponovo.' })
      return
    }
    this.open()
  }

  private commitInterim() {
    const text = this.snap.interim.trim()
    if (!text) return
    const t = this.now() - this.startedAt
    this.pushSegment(text, this.utteranceStart ?? t, t)
    this.utteranceStart = null
    this.set({ interim: '' })
  }

  private pushSegment(text: string, start: number, end: number) {
    const seg: Segment = {
      id: `ws-${this.seq}`,
      sequence: this.seq,
      start_ms: Math.max(0, Math.round(start)),
      end_ms: Math.max(0, Math.round(end)),
      text,
      status: 'ready',
    }
    this.seq++
    this.set({ segments: [...this.snap.segments, seg] })
  }

  private set(patch: Partial<WebSpeechSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((l) => l())
  }
}

/** App-wide instance so navigating between pages never stops listening. */
let shared: WebSpeechTranscriber | null = null
export function sharedWebSpeech(): WebSpeechTranscriber {
  shared ??= new WebSpeechTranscriber()
  return shared
}
