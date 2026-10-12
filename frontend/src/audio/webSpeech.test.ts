import { describe, expect, it } from 'vitest'
import { WebSpeechTranscriber, type SpeechRecognitionLike, type SpeechResultEvent } from './webSpeech'

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  onresult: ((e: SpeechResultEvent) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = false
  constructor() {
    FakeRecognition.instances.push(this)
  }
  start() {
    this.started = true
  }
  stop() {
    this.started = false
    this.onend?.()
  }
  abort() {
    this.stop()
  }
  emit(results: Array<[string, boolean]>, resultIndex = 0) {
    const list = results.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }))
    this.onresult?.({ resultIndex, results: list as unknown as SpeechResultEvent['results'] })
  }
}

function setup() {
  FakeRecognition.instances = []
  let clock = 0
  const t = new WebSpeechTranscriber({ ctor: FakeRecognition, now: () => clock })
  return { t, tick: (ms: number) => (clock += ms), rec: () => FakeRecognition.instances.at(-1)! }
}

describe('WebSpeechTranscriber', () => {
  it('reports unsupported browsers', () => {
    const t = new WebSpeechTranscriber({ ctor: null })
    expect(t.getSnapshot().status).toBe('unsupported')
    t.start()
    expect(t.getSnapshot().status).toBe('unsupported')
  })

  it('configures continuous interim recognition in the chosen language', () => {
    const { t, rec } = setup()
    t.start('sr-RS')
    expect(rec()).toMatchObject({ lang: 'sr-RS', continuous: true, interimResults: true, started: true })
    expect(t.getSnapshot().status).toBe('listening')
  })

  it('turns final results into timed contract-shaped segments and shows interim text', () => {
    const { t, tick, rec } = setup()
    t.start()
    tick(1000)
    rec().emit([['Dobro veče', false]])
    expect(t.getSnapshot().interim).toBe('Dobro veče')
    expect(t.getSnapshot().segments).toEqual([])
    tick(2000)
    rec().emit([['Dobro veče svima', true]])
    expect(t.getSnapshot().interim).toBe('')
    expect(t.getSnapshot().segments).toEqual([
      { id: 'ws-0', sequence: 0, start_ms: 1000, end_ms: 3000, text: 'Dobro veče svima', status: 'ready' },
    ])
  })

  it('restarts automatically when the browser ends the session', () => {
    const { t, rec } = setup()
    t.start()
    const first = rec()
    first.onend?.()
    expect(FakeRecognition.instances).toHaveLength(2)
    expect(rec()).not.toBe(first)
    expect(t.getSnapshot().status).toBe('listening')
  })

  it('stop keeps pending interim text as a segment and does not restart', () => {
    const { t, tick, rec } = setup()
    t.start()
    tick(500)
    rec().emit([['nedovršena rečenica', false]])
    t.stop()
    expect(FakeRecognition.instances).toHaveLength(1)
    expect(t.getSnapshot().status).toBe('stopped')
    expect(t.getSnapshot().segments.map((s) => s.text)).toEqual(['nedovršena rečenica'])
  })

  it('resuming keeps the timeline; reset clears it', () => {
    const { t, rec } = setup()
    t.start()
    rec().emit([['prvi', true]])
    t.stop()
    t.start()
    rec().emit([['drugi', true]])
    expect(t.getSnapshot().segments.map((s) => s.id)).toEqual(['ws-0', 'ws-1'])
    t.stop()
    t.reset()
    expect(t.getSnapshot().segments).toEqual([])
  })

  it('stops on permission errors with a readable message', () => {
    const { t, rec } = setup()
    t.start()
    rec().onerror?.({ error: 'not-allowed' })
    rec().onend?.()
    expect(FakeRecognition.instances).toHaveLength(1)
    expect(t.getSnapshot().status).toBe('error')
    expect(t.getSnapshot().error).toMatch(/odbijen/)
  })

  it('ignores no-speech and keeps listening', () => {
    const { t, rec } = setup()
    t.start()
    rec().onerror?.({ error: 'no-speech' })
    rec().onend?.()
    expect(t.getSnapshot()).toMatchObject({ status: 'listening', error: null })
  })
})
