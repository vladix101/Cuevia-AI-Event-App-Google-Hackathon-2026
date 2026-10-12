/** Raw microphone capture → mono Float32 frames. No speech recognition, no model. */
export interface AudioCapture {
  /** Actual sample rate of the frames delivered to onFrames. */
  readonly sampleRate: number
  stop(): Promise<void>
}

export interface CaptureOptions {
  preferredSampleRate: number
  onFrames: (frames: Float32Array) => void
  /** Track ended unexpectedly (permission revoked, device unplugged, phone call). */
  onEnded: (reason: string) => void
}

export type StartCapture = (opts: CaptureOptions) => Promise<AudioCapture>

export class CaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

type AudioContextCtor = typeof AudioContext

export const startBrowserCapture: StartCapture = async ({ preferredSampleRate, onFrames, onEnded }) => {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    throw new CaptureError(
      'Mikrofon zahteva HTTPS (ili localhost). Otvorite aplikaciju preko https:// adrese na telefonu.',
    )
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError('Ovaj pregledač ne podržava snimanje mikrofona.')
  }
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  if (!Ctor) throw new CaptureError('Ovaj pregledač ne podržava Web Audio API.')

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
  } catch (e) {
    const name = (e as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new CaptureError('Pristup mikrofonu je odbijen. Dozvolite mikrofon u podešavanjima pregledača.')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CaptureError('Mikrofon nije pronađen.')
    if (name === 'NotReadableError') throw new CaptureError('Mikrofon koristi druga aplikacija.')
    throw new CaptureError('Mikrofon nije moguće pokrenuti.')
  }

  const stopTracks = () => stream.getTracks().forEach((t) => t.stop())
  let ctx: AudioContext
  let src: MediaStreamAudioSourceNode
  try {
    // Let the browser resample when it can (Chromium); Firefox rejects mixed rates → fall back.
    ctx = new Ctor({ sampleRate: preferredSampleRate })
    try {
      src = ctx.createMediaStreamSource(stream)
    } catch {
      await ctx.close()
      ctx = new Ctor()
      src = ctx.createMediaStreamSource(stream)
    }
    await ctx.resume()
  } catch {
    stopTracks()
    throw new CaptureError('Audio obrada nije moguća u ovom pregledaču.')
  }

  const sink = ctx.createGain()
  sink.gain.value = 0 // keep the graph pulled without audible playback
  sink.connect(ctx.destination)

  let node: AudioNode
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/pcm-capture.js`)
    const w = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 })
    w.port.onmessage = (ev: MessageEvent<Float32Array>) => onFrames(ev.data)
    node = w
  } else {
    // Older Safari fallback: ScriptProcessorNode does the same downmix on the main thread.
    const sp = ctx.createScriptProcessor(4096, 1, 1)
    sp.onaudioprocess = (ev) => {
      const b = ev.inputBuffer
      const out = new Float32Array(b.length)
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c)
        for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels
      }
      onFrames(out)
    }
    node = sp
  }
  src.connect(node)
  node.connect(sink)

  let stopped = false
  const track = stream.getAudioTracks()[0]
  track?.addEventListener('ended', () => {
    if (!stopped) onEnded('Mikrofon je prestao da šalje zvuk (dozvola opozvana ili uređaj isključen).')
  })

  return {
    sampleRate: ctx.sampleRate,
    async stop() {
      if (stopped) return
      stopped = true
      try {
        src.disconnect()
        node.disconnect()
        sink.disconnect()
      } catch {
        // already disconnected
      }
      stopTracks()
      await ctx.close().catch(() => undefined)
    },
  }
}
