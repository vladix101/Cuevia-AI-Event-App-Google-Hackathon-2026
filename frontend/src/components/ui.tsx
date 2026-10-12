import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import { safeExternalUrl } from '../api/sanitize'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-spot text-stage hover:bg-spot-hot disabled:bg-line disabled:text-faint',
  secondary: 'bg-panel text-ink border border-line-strong hover:bg-raise disabled:text-faint',
  ghost: 'text-spot hover:bg-spot/10 disabled:text-faint',
  danger: 'bg-panel text-alarm border border-alarm/50 hover:bg-alarm/10 disabled:text-faint',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }
>(function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded font-semibold transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-base',
        variants[variant],
        className,
      )}
      {...rest}
    />
  )
})

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('rounded-md border border-line bg-panel p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-xl">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    slate: 'bg-raise text-ink',
    green: 'bg-ok/20 text-ok',
    amber: 'bg-warn/20 text-warn',
    red: 'bg-alarm/20 text-alarm',
    blue: 'bg-spot/20 text-spot',
  }
  return <span className={clsx('inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', tones[tone])}>{children}</span>
}

export function Spinner({ label = 'Učitavanje…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-4 text-mute">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-spot" aria-hidden />
      <span>{label}</span>
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line-strong p-4 text-center text-mute">{children}</p>
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return 'Došlo je do greške.'
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : null
  return (
    <div role="alert" className="rounded-lg border border-alarm/40 bg-alarm/10 p-3 text-alarm">
      <p>{errorText(error)}</p>
      {requestId && <p className="mt-1 text-xs text-alarm">ID zahteva: {requestId}</p>}
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          Pokušaj ponovo
        </Button>
      )}
    </div>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'success' }) {
  const tones = {
    info: 'border-spot/30 bg-spot/10 text-spot',
    warn: 'border-warn/40 bg-warn/10 text-warn',
    success: 'border-ok/40 bg-ok/10 text-ok',
  }
  return <div className={clsx('rounded-lg border p-3 text-sm', tones[tone])}>{children}</div>
}

/** External link that only renders for http(s) URLs and never leaks the opener. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeExternalUrl(href)
  if (!safe) return <span className="text-mute">{children} (nevažeći link)</span>
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="text-spot underline underline-offset-2 break-words">
      {children}
      <span className="sr-only"> (otvara se u novom prozoru)</span>
    </a>
  )
}

/** Bottom sheet on phones, right-side panel on wider screens. Non-blocking for the recorder. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-stage/75 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-xl border-t border-line-strong bg-panel sm:inset-y-0 sm:border-t-0 sm:border-l sm:right-0 sm:left-auto sm:max-h-none sm:w-[28rem] sm:rounded-none"
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-2 border-b border-line p-4">
            <div>
              <Dialog.Title className="font-display text-xl font-bold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="text-sm text-mute">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Zatvori">
                ✕
              </Button>
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
          {footer && <div className="border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-mute">{hint}</p>}
    </div>
  )
}

export const inputClass =
  'block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-base text-ink placeholder:text-faint focus:border-spot'
