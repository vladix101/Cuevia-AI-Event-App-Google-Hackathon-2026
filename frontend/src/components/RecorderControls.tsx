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
    <div
      className={`space-y-2 rounded-md border p-3 transition-colors ${status === 'recording' ? 'border-alarm/60 bg-alarm/5' : 'border-line bg-panel'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          {status === 'recording' && (
            <>
              <span className="cue-light h-3.5 w-3.5 rounded-full bg-alarm" aria-hidden />
              <span className="font-semibold text-alarm">Snima se</span>
              <span className="font-display text-xl font-bold text-ink tabular-nums [font-stretch:120%]">{fmtMs(snap.elapsedMs)}</span>
            </>
          )}
          {status === 'starting' && <span className="text-mute">Pokretanje mikrofona…</span>}
          {status === 'paused' && <span className="font-medium text-ink">Pauzirano</span>}
          {status === 'stopping' && <span className="text-mute">Završavam slanje zvuka…</span>}
          {status === 'stopped' && <span className="text-mute">Snimanje završeno</span>}
          {(status === 'idle' || status === 'error') && <span className="text-mute">Mikrofon isključen</span>}
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
        <p role="alert" className="text-sm text-alarm">
          {snap.error}
        </p>
      )}
      {mine && (u.queued > 3 || u.dropped > 0 || u.lastError) && (
        <p className="text-xs text-warn">
          {u.queued > 0 && `Na čekanju za slanje: ${u.queued}. `}
          {u.dropped > 0 && `Izgubljeno delova zvuka: ${u.dropped} (u transkriptu će biti prekid). `}
          {u.lastError && `Poslednja greška: ${u.lastError}`}
        </p>
      )}
      {status === 'idle' && (
        <p className="text-xs text-mute">
          Telefon snima zvuk sale i šalje ga serveru na transkripciju. Držite ekran uključen; na telefonu je potreban HTTPS.
        </p>
      )}
      {talkEnded && status === 'idle' && <p className="text-xs text-mute">Predavanje je završeno.</p>}
    </div>
  )
}
