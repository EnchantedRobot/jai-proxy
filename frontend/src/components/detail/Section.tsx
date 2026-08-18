import { cn } from '@/lib/utils'

/**
 * One labelled block of the detail body — the mock's `.sec`: an uppercase
 * eyebrow with an optional action on the right, then its content.
 *
 * The `action` slot is where an Edit button will live in Stage 3; read-only in
 * Stage 2, it stays in the layout so adding the button later does not reflow
 * the page.
 */
export function Section({
  title,
  count,
  action,
  className,
  children,
}: {
  title: string
  count?: number | string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('flex flex-col', className)}>
      <h3 className="flex items-center gap-2.5 text-[10.5px] font-semibold tracking-[0.13em] text-faint uppercase">
        {title}
        {count !== undefined && (
          <span className="tracking-normal text-faint/80 normal-case">
            {count}
          </span>
        )}
        {action && <span className="ml-auto normal-case">{action}</span>}
      </h3>
      {children}
    </section>
  )
}

/** A boxed prose block, the mock's `.prose.box`. */
export function ProseBox({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mt-2.5 rounded-xl border border-line-soft bg-surface px-[17px] py-[15px] text-[14.5px] leading-[1.68] whitespace-pre-wrap text-[#d2d8da]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** The empty-state line used when a pane has nothing to show. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-xl border border-dashed border-line py-10 text-center text-[13.5px] text-faint">
      {children}
    </p>
  )
}
