import * as Slider from '@radix-ui/react-slider'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Segment } from '../api/types'
import { fmtMs } from '../lib/format'
import { Button } from './ui'

export interface TextSelection {
  text: string
  segmentId: string
}

export interface TranscriptHandle {
  jumpTo(segmentId: string): void
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Readable timed transcript with a history slider. While "following live" new
 * segments scroll into view; moving the slider or scrolling up pauses that
 * until "Vrati se uživo".
 */
export const Transcript = forwardRef<
  TranscriptHandle,
  { segments: Segment[]; onSelectText: (s: TextSelection | null) => void; lagMs: number }
>(function Transcript({ segments, onSelectText, lagMs }, ref) {
  const scroller = useRef<HTMLDivElement>(null)
  const [followLive, setFollowLive] = useState(true)
  const [viewIndex, setViewIndex] = useState(0)
  const [highlight, setHighlight] = useState<string | null>(null)
  const last = segments.length - 1

  const scrollToIndex = useCallback(
    (i: number) => {
      const seg = segments[i]
      if (!seg) return
      const el = scroller.current?.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(seg.id)}"]`)
      el?.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    },
    [segments],
  )

  useImperativeHandle(ref, () => ({
    jumpTo(segmentId) {
      const i = segments.findIndex((s) => s.id === segmentId)
      if (i < 0) return
      setFollowLive(false)
      setViewIndex(i)
      setHighlight(segmentId)
      requestAnimationFrame(() => scrollToIndex(i))
    },
  }))

  useEffect(() => {
    if (followLive && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [segments.length, followLive])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (fromBottom > 120 && followLive) {
      setFollowLive(false)
      setViewIndex(last)
    }
  }

  const onSelectRef = useRef(onSelectText)
  onSelectRef.current = onSelectText

  const captureSelection = () => {
    const onSelectText = onSelectRef.current
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !scroller.current) return onSelectText(null)
    const anchor = sel.anchorNode
    if (!anchor || !scroller.current.contains(anchor)) return onSelectText(null)
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    const segEl = (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement)?.closest('[data-segment-id]')
    const segmentId = segEl?.getAttribute('data-segment-id')
    if (!text || text.length > 120 || !segmentId) return onSelectText(null)
    onSelectText({ text, segmentId })
  }

  useEffect(() => {
    const h = () => captureSelection()
    document.addEventListener('selectionchange', h)
    return () => document.removeEventListener('selectionchange', h)
  }, [])

  const sliderValue = followLive ? last : Math.min(viewIndex, last)
  // Surtitle effect: while following live, the newest spoken line is lit and the rest dim.
  const liveId = followLive ? [...segments].reverse().find((s) => s.status !== 'gap')?.id : undefined

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-[56dvh] overflow-y-auto px-4 py-5 sm:px-6"
        role="log"
        aria-live={followLive ? 'polite' : 'off'}
        aria-label="Transkript"
        tabIndex={0}
      >
        {segments.length === 0 && (
          <p className="text-mute">Transkript će se pojaviti nekoliko sekundi nakon početka snimanja.</p>
        )}
        <ol className="space-y-4">
          {segments.map((s) =>
            s.status === 'gap' ? (
              <li key={s.sequence} data-segment-id={s.id} className="text-center text-sm text-faint italic">
                — prekid u transkriptu {fmtMs(s.start_ms)}–{fmtMs(s.end_ms)} —
              </li>
            ) : (
              <li
                key={s.sequence}
                data-segment-id={s.id}
                className={`grid grid-cols-[3.25rem_1fr] gap-3 border-l-2 py-1 pl-2 transition-colors ${highlight === s.id ? 'border-spot bg-spot/10' : 'border-transparent'}`}
              >
                <time className="pt-1.5 text-xs text-faint tabular-nums" dateTime={`PT${Math.floor(s.start_ms / 1000)}S`}>
                  {fmtMs(s.start_ms)}
                </time>
                <p
                  className={`select-text transition-colors duration-500 ${
                    s.id === liveId
                      ? 'text-2xl leading-snug font-bold text-ink sm:text-3xl'
                      : liveId
                        ? 'text-lg leading-relaxed text-mute'
                        : 'text-lg leading-relaxed text-ink'
                  }`}
                >
                  {s.text}
                </p>
              </li>
            ),
          )}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line p-3">
        <Slider.Root
          className="relative flex h-6 min-w-40 flex-1 touch-none items-center select-none"
          min={0}
          max={Math.max(1, last)}
          step={1}
          value={[Math.max(0, sliderValue)]}
          disabled={segments.length < 2}
          onValueChange={([v]) => {
            setFollowLive(false)
            setViewIndex(v)
            setHighlight(segments[v]?.id ?? null)
            scrollToIndex(v)
          }}
          aria-label="Istorija transkripta"
        >
          <Slider.Track className="relative h-1.5 flex-1 rounded-full bg-line">
            <Slider.Range className="absolute h-full rounded-full bg-spot" />
          </Slider.Track>
          <Slider.Thumb
            className="block h-5 w-5 rounded-full bg-spot shadow-[0_0_12px_rgb(255_210_94/0.6)]"
            aria-valuetext={segments[sliderValue] ? fmtMs(segments[sliderValue].start_ms) : 'nema segmenata'}
          />
        </Slider.Root>
        {!followLive ? (
          <Button
            size="sm"
            onClick={() => {
              setFollowLive(true)
              setHighlight(null)
            }}
          >
            Vrati se uživo ↓
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-spot">
            <span className="h-1.5 w-1.5 rounded-full bg-spot" aria-hidden />
            Prati uživo
          </span>
        )}
        {lagMs > 0 && <span className="text-xs text-mute">kašnjenje obrade ~{Math.round(lagMs / 1000)} s</span>}
      </div>
    </div>
  )
})
