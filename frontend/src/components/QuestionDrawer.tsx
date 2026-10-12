import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { isApiError } from '../api/client'
import { qk } from '../api/hooks'
import type { QuestionCreated, QuestionPublic, Quota } from '../api/types'
import { fmtClock, newRequestId } from '../lib/format'
import { useApi } from '../services'
import { Button, Drawer, ErrorAlert, errorText, Spinner } from './ui'

const MAX_LEN = 500

/**
 * A pending submission keeps its client_request_id until the server confirms
 * it, so retries after timeouts/network errors can never consume a second slot.
 * Editing the text starts a new submission (new id).
 */
export function useQuestionComposer(talkId: string) {
  const api = useApi()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const pending = useRef<{ text: string; id: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: ({ text, id }: { text: string; id: string }) => api.askQuestion(talkId, text, id),
    onSuccess: (r: QuestionCreated, vars) => {
      qc.setQueryData<Quota>(qk.quota(talkId), r.quota)
      qc.setQueryData<QuestionPublic[]>(qk.myQuestions(talkId), (prev) =>
        prev?.some((q) => q.id === r.question.id) ? prev : [...(prev ?? []), r.question],
      )
      if (pending.current?.id === vars.id) pending.current = null
      // Only clear the box if the user has not started typing something else meanwhile.
      setText((cur) => (cur.trim() === vars.text ? '' : cur))
      setNotice(null)
    },
    onError: (e) => {
      if (isApiError(e, 'QUESTION_LIMIT_REACHED')) {
        pending.current = null
        setNotice('Iskoristili ste sva 3 pitanja za ovo predavanje. Vaš tekst je sačuvan u polju, ali ne može biti poslat.')
      } else if (isApiError(e) && e.status === 409) {
        setNotice('Stanje se promenilo na drugom uređaju. Osvežili smo listu — proverite pa pošaljite ponovo.')
      } else {
        setNotice(null)
      }
      // Server is authoritative: resync quota and list after any failure.
      void qc.invalidateQueries({ queryKey: qk.quota(talkId) })
      void qc.invalidateQueries({ queryKey: qk.myQuestions(talkId) })
    },
  })

  const submit = () => {
    const t = text.trim()
    if (!t || mutation.isPending) return
    if (!pending.current || pending.current.text !== t) pending.current = { text: t, id: newRequestId() }
    mutation.mutate({ text: t, id: pending.current.id })
  }

  return { text, setText, submit, mutation, notice, pendingId: () => pending.current?.id ?? null }
}

export function QuestionDrawer({ talkId, open, onOpenChange }: { talkId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const api = useApi()
  const quota = useQuery({ queryKey: qk.quota(talkId), queryFn: () => api.questionQuota(talkId), enabled: open })
  const list = useQuery({ queryKey: qk.myQuestions(talkId), queryFn: () => api.myQuestions(talkId), enabled: open })
  const c = useQuestionComposer(talkId)
  const inputId = useId()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [list.data?.length, open])

  const q = quota.data
  const exhausted = !!q && q.remaining <= 0
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    c.submit()
  }
  const failed = c.mutation.isError && !isApiError(c.mutation.error, 'QUESTION_LIMIT_REACHED') && !(isApiError(c.mutation.error) && c.mutation.error.status === 409)

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Pitanje za govornika"
      description="Pitanja se čuvaju i govornik ih čita na kraju. Ovde nema automatskih odgovora."
      footer={
        <form onSubmit={onSubmit} className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={inputId} className="font-medium">
              Vaše pitanje
            </label>
            <span aria-live="polite" className={exhausted ? 'font-semibold text-red-700' : 'text-slate-700'}>
              {q ? `${q.used}/${q.limit} pitanja` : '–/3 pitanja'}
            </span>
          </div>
          <textarea
            id={inputId}
            rows={3}
            maxLength={MAX_LEN}
            className="block w-full resize-none rounded-lg border border-slate-300 p-3 text-base"
            value={c.text}
            onChange={(e) => c.setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) c.submit()
            }}
            disabled={exhausted && !c.text}
            placeholder={exhausted ? 'Nema preostalih pitanja za ovo predavanje.' : 'Napišite pitanje…'}
          />
          {c.notice && (
            <p role="alert" className="text-sm text-amber-900">
              {c.notice}
            </p>
          )}
          {failed && (
            <p role="alert" className="text-sm text-red-700">
              Slanje nije uspelo ({errorText(c.mutation.error)}). Tekst je sačuvan — pokušajte ponovo; pitanje neće biti poslato dvaput.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-600">{c.text.length}/{MAX_LEN}</span>
            <Button type="submit" disabled={!c.text.trim() || c.mutation.isPending || exhausted}>
              {c.mutation.isPending ? 'Slanje…' : failed ? 'Pošalji ponovo' : 'Pošalji'}
            </Button>
          </div>
        </form>
      }
    >
      {(list.isPending || quota.isPending) && <Spinner />}
      {list.isError && <ErrorAlert error={list.error} onRetry={() => list.refetch()} />}
      {quota.isError && <ErrorAlert error={quota.error} onRetry={() => quota.refetch()} />}
      {list.data && list.data.length === 0 && (
        <p className="text-center text-sm text-slate-600">Još niste postavili pitanje za ovo predavanje. Možete postaviti do 3.</p>
      )}
      <ol className="space-y-3" aria-label="Vaša pitanja">
        {list.data?.map((qq) => (
          <li key={qq.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-white">
            <p className="whitespace-pre-wrap break-words">{qq.text}</p>
            <p className="mt-1 text-right text-xs text-brand-100">
              Sačuvano {fmtClock(qq.submitted_at)} · {qq.read_status === 'read' ? 'govornik je pročitao' : 'čeka govornika'}
            </p>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
    </Drawer>
  )
}

export function QuestionFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Postavi pitanje"
      title="Postavi pitanje"
      className="fixed right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-2xl font-bold text-white shadow-lg hover:bg-brand-700"
    >
      ?
    </button>
  )
}
