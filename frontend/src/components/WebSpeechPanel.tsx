import { useSyncExternalStore } from 'react'
import { sharedWebSpeech, type WebSpeechTranscriber } from '../audio/webSpeech'
import { Badge, Button, Notice } from './ui'

const LANGS = [
  { value: 'sr-RS', label: 'Srpski' },
  { value: 'hr-HR', label: 'Hrvatski' },
  { value: 'en-US', label: 'English' },
]

export function useWebSpeech(t: WebSpeechTranscriber = sharedWebSpeech()) {
  const snap = useSyncExternalStore(t.subscribe, t.getSnapshot)
  return { transcriber: t, snap }
}

/** Start/stop controls for the browser (Web Speech API) transcript. */
export function WebSpeechPanel({ transcriber }: { transcriber?: WebSpeechTranscriber }) {
  const { transcriber: t, snap } = useWebSpeech(transcriber)

  if (snap.status === 'unsupported') {
    return (
      <Notice tone="warn">
        Ovaj pregledač ne podržava prepoznavanje govora (Web Speech API). Koristite Chrome ili Edge.
      </Notice>
    )
  }

  const listening = snap.status === 'listening'
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800">Transkript u pregledaču</span>
        <Badge tone="amber">Web Speech API · nije Gemma</Badge>
        {listening && (
          <span className="flex items-center gap-1 text-sm text-red-800" role="status">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" aria-hidden /> Sluša
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-700" htmlFor="ws-lang">
          Jezik
        </label>
        <select
          id="ws-lang"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
          value={snap.lang}
          disabled={listening}
          onChange={(e) => t.setLang(e.target.value)}
        >
          {LANGS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {listening ? (
          <Button size="sm" variant="secondary" onClick={() => t.stop()}>
            Zaustavi
          </Button>
        ) : (
          <Button size="sm" onClick={() => t.start(snap.lang)}>
            {snap.status === 'stopped' && snap.segments.length ? 'Nastavi' : 'Pokreni'}
          </Button>
        )}
        {!listening && snap.segments.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => t.reset()}>
            Obriši
          </Button>
        )}
      </div>
      {snap.error && <Notice tone="warn">{snap.error}</Notice>}
      <p className="text-xs text-slate-600">
        Govor prepoznaje sam pregledač (Chrome/Edge šalju zvuk svom servisu za prepoznavanje). Ovaj transkript ostaje na vašem uređaju i ne
        koristi se za ocenu pitanja.
      </p>
    </div>
  )
}
