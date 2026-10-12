import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { Segment } from '../api/types'
import { fmtMs } from '../lib/format'
import { useApi } from '../services'
import { Button, Drawer, ErrorAlert, Notice } from './ui'

const RANGES = [
  { key: '30s', label: 'Posl. 30 s', ms: 30_000 },
  { key: '1m', label: 'Posl. 1 min', ms: 60_000 },
  { key: '3m', label: 'Posl. 3 min', ms: 180_000 },
  { key: 'all', label: 'Od početka', ms: null },
] as const

export function catchUpRange(range: (typeof RANGES)[number]['key'], currentMs: number) {
  const r = RANGES.find((x) => x.key === range)!
  return { start_ms: r.ms === null ? 0 : Math.max(0, currentMs - r.ms), end_ms: currentMs }
}

/** "Izgubio sam nit": short cue + summary for a recent range. The recording keeps running. */
export function CatchUpDrawer({
  recordingId,
  segments,
  open,
  onOpenChange,
  onJump,
}: {
  recordingId: string | null
  segments: Segment[]
  open: boolean
  onOpenChange: (o: boolean) => void
  onJump: (segmentId: string) => void
}) {
  const api = useApi()
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('1m')
  const ready = segments.filter((s) => s.status === 'ready')
  const currentMs = segments.length ? segments[segments.length - 1].end_ms : 0
  const m = useMutation({
    mutationFn: ({ start_ms, end_ms }: { start_ms: number; end_ms: number }) => api.catchUp(recordingId!, start_ms, end_ms),
  })
  const canAsk = !!recordingId && ready.length > 0

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Izgubio sam nit" description="Kratak podsetnik šta je rečeno. Snimanje se nastavlja.">
      {!canAsk && <Notice>Za sažetak je potreban transkript ovog predavanja. Pokrenite snimanje i sačekajte prve segmente.</Notice>}
      <fieldset className="mt-2">
        <legend className="mb-2 text-sm font-medium">Koji deo?</legend>
        <div className="grid grid-cols-2 gap-2">
          {RANGES.map((r) => (
            <label
              key={r.key}
              className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-brand-600 ${range === r.key ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-slate-300'}`}
            >
              <input type="radio" name="catchup-range" value={r.key} checked={range === r.key} onChange={() => setRange(r.key)} className="sr-only" />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Button className="mt-3 w-full" disabled={!canAsk || m.isPending} onClick={() => m.mutate(catchUpRange(range, currentMs))}>
        {m.isPending ? 'Pravim sažetak…' : 'Sažmi'}
      </Button>
      {m.isError && (
        <div className="mt-3">
          <ErrorAlert error={m.error} />
        </div>
      )}
      {m.data && (
        <article className="mt-4 space-y-3" aria-live="polite">
          <p className="text-sm text-slate-600">
            {fmtMs(m.data.start_ms)}–{fmtMs(m.data.end_ms)}
          </p>
          <p className="text-lg font-semibold">{m.data.cue}</p>
          <p className="leading-relaxed whitespace-pre-wrap">{m.data.summary}</p>
          {m.data.source_segment_ids.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">Izvor u transkriptu</h3>
              <ul className="mt-1 flex flex-wrap gap-2">
                {m.data.source_segment_ids.map((id) => {
                  const seg = segments.find((s) => s.id === id)
                  return (
                    <li key={id}>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!seg}
                        onClick={() => {
                          onOpenChange(false)
                          onJump(id)
                        }}
                      >
                        {seg ? fmtMs(seg.start_ms) : 'segment nije učitan'}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </article>
      )}
    </Drawer>
  )
}
