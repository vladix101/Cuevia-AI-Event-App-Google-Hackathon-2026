import { Link } from 'react-router-dom'
import { fmtMs } from '../lib/format'
import { useRecorder } from '../services'
import { Badge, Button, Notice } from './ui'

export function RecorderControls({ talkId, eventId, talkEnded }: { talkId: string; eventId: string; talkEnded: boolean }) {
  const { recorder, snap } = useRecorder()
  const mine = snap.talkId === talkId
  const busyElsewhere = !mine && recorder.isActive

  if (busyElsewhere) {
    return (
      <Notice tone="warn">
        Mikrofon trenutno snima drugo predavanje.{' '}
        <Link className="underline" to={`/events/${eventId}/talks/${snap.talkId}`}>
          Otvorite ga
        </Link>{' '}
        i zaustavite snimanje pre novog.
      </Notice>
    )
  }

  const status = mine ? snap.status : 'idle'
  const u = snap.upload
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          {status === 'recording' && (
            <>
              <span className="h-3 w-3 animate-pulse rounded-full bg-red-600" aria-hidden />
              <span className="font-semibold text-red-800">Snima se</span>
              <span className="font-mono text-sm text-slate-700">{fmtMs(snap.elapsedMs)}</span>
            </>
          )}
          {status === 'starting' && <span className="text-slate-700">Pokretanje mikrofona…</span>}
          {status === 'paused' && <span className="font-medium text-slate-800">Pauzirano</span>}
          {status === 'stopping' && <span className="text-slate-700">Završavam slanje zvuka…</span>}
          {status === 'stopped' && <span className="text-slate-700">Snimanje završeno</span>}
          {(status === 'idle' || status === 'error') && <span className="text-slate-700">Mikrofon isključen</span>}
        </div>
        {mine && snap.session?.mode === 'replay' && <Badge tone="amber">Reprodukcija — nije uživo</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          {(status === 'idle' || status === 'stopped' || (status === 'error' && !snap.session)) && (
            <Button
              disabled={talkEnded}
              onClick={() => {
                if (status === 'stopped') recorder.reset()
                void recorder.start(talkId).catch(() => undefined)
              }}
            >
              🎙 {status === 'stopped' ? 'Novo snimanje' : 'Pokreni transkripciju'}
            </Button>
          )}
          {status === 'recording' && (
            <Button variant="secondary" onClick={() => void recorder.pause()}>
              Pauza
            </Button>
          )}
          {(status === 'paused' || (status === 'error' && snap.session)) && (
            <Button onClick={() => void recorder.resume()}>Nastavi</Button>
          )}
          {(status === 'recording' || status === 'paused' || (status === 'error' && snap.session)) && (
            <Button variant="danger" onClick={() => void recorder.stop()}>
              Zaustavi
            </Button>
          )}
        </div>
      </div>
      {mine && snap.error && (
        <p role="alert" className="text-sm text-red-700">
          {snap.error}
        </p>
      )}
      {mine && (u.queued > 3 || u.dropped > 0 || u.lastError) && (
        <p className="text-xs text-amber-900">
          {u.queued > 0 && `Na čekanju za slanje: ${u.queued}. `}
          {u.dropped > 0 && `Izgubljeno delova zvuka: ${u.dropped} (u transkriptu će biti prekid). `}
          {u.lastError && `Poslednja greška: ${u.lastError}`}
        </p>
      )}
      {status === 'idle' && (
        <p className="text-xs text-slate-600">
          Telefon snima zvuk sale i šalje ga serveru na transkripciju. Držite ekran uključen; na telefonu je potreban HTTPS.
        </p>
      )}
      {talkEnded && status === 'idle' && <p className="text-xs text-slate-600">Predavanje je završeno.</p>}
    </div>
  )
}
