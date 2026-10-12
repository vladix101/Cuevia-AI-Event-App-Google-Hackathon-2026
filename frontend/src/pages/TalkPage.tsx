import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { hasRole, useMe, useTalks, useTranscript } from '../api/hooks'
import { CatchUpDrawer } from '../components/CatchUpDrawer'
import { ExplanationDrawer } from '../components/ExplanationDrawer'
import { QuestionDrawer, QuestionFab } from '../components/QuestionDrawer'
import { RecorderControls } from '../components/RecorderControls'
import { Transcript, type TextSelection, type TranscriptHandle } from '../components/Transcript'
import { useWebSpeech, WebSpeechPanel } from '../components/WebSpeechPanel'
import { Button, ErrorAlert, Notice } from '../components/ui'
import { useApi, useRecorder } from '../services'

export function TalkPage() {
  const { eventId = '', talkId = '' } = useParams()
  const api = useApi()
  const talks = useTalks(eventId)
  const me = useMe()
  const talk = talks.data?.find((t) => t.id === talkId)
  const { snap } = useRecorder()
  const mine = snap.talkId === talkId
  const recordingId = mine ? (snap.session?.recording_id ?? null) : null
  const polling = mine && ['recording', 'paused', 'stopping', 'starting'].includes(snap.status)
  const transcript = useTranscript(recordingId, polling)
  const segments = transcript.data?.segments ?? []
  const transcriptRef = useRef<TranscriptHandle>(null)
  const ws = useWebSpeech()
  // Browser (Web Speech API) transcript is shown when there is no server recording for this talk.
  const showWebSpeech = !recordingId && (ws.snap.status === 'listening' || ws.snap.segments.length > 0 || !!ws.snap.interim)

  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [explain, setExplain] = useState<{ term: string; segmentId: string | null } | null>(null)
  const [catchUpOpen, setCatchUpOpen] = useState(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)

  const lastReady = [...segments].reverse().find((s) => s.status === 'ready') ?? null

  const designate = useMutation({
    mutationFn: () => api.setTranscriptSource(talkId, recordingId!),
  })

  // Warn before leaving the page while audio is still being captured or uploaded.
  useEffect(() => {
    if (!mine || !['recording', 'stopping'].includes(snap.status)) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [mine, snap.status])

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">{talk?.title ?? 'Predavanje'}</h1>
        {talk && <p className="text-slate-600">{talk.speaker_name}</p>}
      </div>
      {talks.isError && <ErrorAlert error={talks.error} onRetry={() => talks.refetch()} />}

      <RecorderControls talkId={talkId} eventId={eventId} talkEnded={talk?.status === 'ended'} />
      <WebSpeechPanel />

      {hasRole(me.data?.roles, 'organizer') && recordingId && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button size="sm" variant="secondary" onClick={() => designate.mutate()} disabled={designate.isPending || designate.isSuccess}>
            {designate.isSuccess ? 'Označeno kao zvanični izvor ✓' : 'Označi ovaj snimak kao zvanični izvor transkripta'}
          </Button>
          {designate.isError && <ErrorAlert error={designate.error} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setCatchUpOpen(true)}>
          🧭 Izgubio sam nit
        </Button>
        <Button variant="secondary" onClick={() => setExplain({ term: '', segmentId: lastReady?.id ?? null })} disabled={!recordingId}>
          Objasni pojam
        </Button>
      </div>

      {!recordingId && !showWebSpeech && (
        <Notice>
          Transkript, „Izgubio sam nit" i objašnjenja pojmova rade nad snimkom sa vašeg telefona. Pitanje govorniku možete postaviti i bez
          snimanja.
        </Notice>
      )}
      {transcript.isError && <ErrorAlert error={transcript.error} onRetry={() => transcript.refetch()} />}

      {recordingId && (
        <Transcript ref={transcriptRef} segments={segments} lagMs={transcript.data?.lagMs ?? 0} onSelectText={setSelection} />
      )}

      {showWebSpeech && (
        <div className="space-y-2">
          <Transcript segments={ws.snap.segments} lagMs={0} onSelectText={() => undefined} />
          {ws.snap.interim && (
            <p className="rounded-lg bg-slate-50 px-4 py-2 text-lg text-slate-500 italic" aria-live="polite">
              {ws.snap.interim}…
            </p>
          )}
        </div>
      )}

      {selection && (
        <div className="fixed inset-x-0 bottom-24 z-20 flex justify-center px-4">
          <Button
            className="max-w-full shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setExplain({ term: selection.text, segmentId: selection.segmentId })
              setSelection(null)
            }}
          >
            <span className="truncate">Objasni: „{selection.text}"</span>
          </Button>
        </div>
      )}

      <QuestionFab onClick={() => setQuestionsOpen(true)} />

      <QuestionDrawer talkId={talkId} open={questionsOpen} onOpenChange={setQuestionsOpen} />
      <CatchUpDrawer
        recordingId={recordingId}
        segments={segments}
        open={catchUpOpen}
        onOpenChange={setCatchUpOpen}
        onJump={(id) => transcriptRef.current?.jumpTo(id)}
      />
      <ExplanationDrawer
        recordingId={recordingId}
        initialTerm={explain?.term ?? ''}
        segmentId={explain?.segmentId ?? null}
        open={!!explain}
        onOpenChange={(o) => !o && setExplain(null)}
      />
    </div>
  )
}
