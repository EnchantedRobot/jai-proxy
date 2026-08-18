import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dismissToast, useToasts } from '@/lib/toast'

/**
 * The toast stack, mounted once in the shell. Bottom-right, sage for a success
 * and the red `bad` token for a failure — the two outcomes a write has.
 */
export function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'flex max-w-[360px] items-start gap-2.5 rounded-[11px] border bg-surface px-3.5 py-2.5 text-[13px] shadow-[0_18px_50px_#000000a6]',
            'data-[v=ok]:border-sage-line data-[v=bad]:border-bad/50',
          )}
          data-v={t.variant}
        >
          <span
            className={cn(
              'mt-1 block size-2 flex-none rounded-full',
              t.variant === 'ok' ? 'bg-sage' : 'bg-bad',
            )}
          />
          <span className="flex-1 leading-[1.4]">{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="-mt-0.5 -mr-1 grid size-6 flex-none place-items-center rounded-md text-faint hover:bg-raised hover:text-text"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
