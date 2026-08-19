import { useState } from 'react'
import { formatTokens } from '@/lib/card'
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
  style,
}: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      style={style}
      className={cn(
        'mt-2.5 rounded-xl border border-line-soft bg-surface px-[17px] py-[15px] text-[14.5px] leading-[1.68] whitespace-pre-wrap text-[#d2d8da]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * A `ProseBox` that clamps to `lines` and offers to expand (Stage 6B D6).
 *
 * Greetings run to thousands of words on plenty of cards. The box used to take
 * whatever height it was given, which on a long greeting meant a scroll thumb a
 * few pixels tall inside an already-scrolling page. Clamping with a real line
 * count keeps the page navigable and makes "there is more here" visible, and
 * the fade tells you the text is cut rather than finished.
 *
 * `line-clamp` needs no measurement, so there is no layout thrash and no
 * ResizeObserver -- but it also cannot tell us whether the text actually
 * overflowed, so the toggle is offered whenever the content is long enough to
 * plausibly clamp. A short greeting never reaches that threshold.
 */
export function ClampedProse({
  children,
  lines = 10,
  className,
}: {
  children: string
  lines?: number
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  // ~72 characters per rendered line at this measure, doubled as a margin so
  // the button never appears on text that would not have clamped.
  const clampable = children.length > lines * 72

  return (
    <div>
      <ProseBox
        className={cn(
          !expanded && clampable && 'relative overflow-hidden',
          className,
        )}
        style={
          !expanded && clampable
            ? {
                display: '-webkit-box',
                WebkitLineClamp: lines,
                WebkitBoxOrient: 'vertical',
              }
            : undefined
        }
      >
        {children}
      </ProseBox>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 text-[12.5px] text-faint hover:text-sage"
        >
          {expanded
            ? 'Show less'
            : `Show more · ${formatTokens(children.length)}`}
        </button>
      )}
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
