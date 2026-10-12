export interface QueuedChunk {
  sequence: number
  start_ms: number
  end_ms: number
  blob: Blob
}

export interface UploadQueueState {
  queued: number
  sent: number
  dropped: number
  lastError: string | null
}

export interface UploadQueueOptions {
  send: (c: QueuedChunk) => Promise<void>
  /** Network errors, 408, 429 and 5xx are retryable; other 4xx are not. */
  isRetryable: (e: unknown) => boolean
  maxQueued?: number
  maxAttempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  onChange?: (s: UploadQueueState) => void
}

/**
 * Bounded FIFO with sequential delivery and exponential backoff. Each retry
 * reuses the same sequence number, so the backend can deduplicate. When the
 * queue overflows, the OLDEST waiting chunk is dropped (the backend records a
 * gap), keeping phone memory bounded during long outages.
 */
export class UploadQueue {
  private readonly items: QueuedChunk[] = []
  private readonly send: UploadQueueOptions['send']
  private readonly isRetryable: UploadQueueOptions['isRetryable']
  private readonly maxQueued: number
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onChange?: (s: UploadQueueState) => void
  private inFlight: QueuedChunk | null = null
  private closed = false
  private idleWaiters: Array<() => void> = []
  state: UploadQueueState = { queued: 0, sent: 0, dropped: 0, lastError: null }

  constructor(opts: UploadQueueOptions) {
    this.send = opts.send
    this.isRetryable = opts.isRetryable
    this.maxQueued = opts.maxQueued ?? 30
    this.maxAttempts = opts.maxAttempts ?? 6
    this.baseDelayMs = opts.baseDelayMs ?? 500
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.onChange = opts.onChange
  }

  enqueue(c: QueuedChunk) {
    if (this.closed) return
    this.items.push(c)
    let dropped = 0
    while (this.items.length > this.maxQueued) {
      this.items.shift()
      dropped++
    }
    this.update({ dropped: this.state.dropped + dropped })
    void this.pump()
  }

  /** Resolves when everything queued so far has been sent or dropped. */
  drain(): Promise<void> {
    if (!this.inFlight && this.items.length === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  /** Stop accepting chunks and discard what is still waiting. */
  close() {
    this.closed = true
    const n = this.items.length
    this.items.length = 0
    this.update({ dropped: this.state.dropped + n })
    this.notifyIdle()
  }

  private async pump() {
    if (this.inFlight) return
    while (this.items.length > 0 && !this.closed) {
      const c = this.items.shift()!
      this.inFlight = c
      this.update({})
      for (let attempt = 1; ; attempt++) {
        try {
          await this.send(c)
          this.update({ sent: this.state.sent + 1, lastError: null })
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Slanje nije uspelo'
          if (this.closed || !this.isRetryable(e) || attempt >= this.maxAttempts) {
            this.update({ dropped: this.state.dropped + 1, lastError: msg })
            break
          }
          this.update({ lastError: msg })
          await this.sleep(Math.min(this.baseDelayMs * 2 ** (attempt - 1), 8000))
        }
      }
      this.inFlight = null
      this.update({})
    }
    this.notifyIdle()
  }

  private update(patch: Partial<UploadQueueState>) {
    this.state = { ...this.state, ...patch, queued: this.items.length + (this.inFlight ? 1 : 0) }
    this.onChange?.(this.state)
  }

  private notifyIdle() {
    if (this.inFlight || this.items.length > 0) return
    const w = this.idleWaiters
    this.idleWaiters = []
    w.forEach((r) => r())
  }
}
