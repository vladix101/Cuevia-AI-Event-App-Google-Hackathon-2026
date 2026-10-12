// AudioWorkletProcessor: downmix the microphone input to mono Float32 and post
// batches (~2048 frames) to the main thread. No recognition or model runs here.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batch = new Float32Array(2048)
    this.fill = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const frames = input[0].length
    const channels = input.length
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i]
      this.batch[this.fill++] = sum / channels
      if (this.fill === this.batch.length) {
        this.port.postMessage(this.batch)
        this.batch = new Float32Array(2048)
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
