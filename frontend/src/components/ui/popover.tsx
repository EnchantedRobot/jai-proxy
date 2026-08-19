import { Popover as P } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * The mock's popover, on radix's primitive.
 *
 * Hand-written rather than pulled from the shadcn registry because the mock
 * decides the whole surface here — 13px radius, its own shadow, 7px of padding
 * so the rows inside sit flush — and the registry component would arrive with a
 * different set of those and have to be edited anyway.
 */
export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverAnchor = P.Anchor

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-60 min-w-[210px] rounded-[13px] border border-line bg-surface p-[7px] shadow-[0_22px_60px_#000000a6]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </P.Portal>
  )
}

/** A section label inside a popover: `FILTERS`, `SORT BY`. */
export function PopoverHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.11em] text-faint uppercase">
      {children}
    </div>
  )
}

/** One clickable row. `state` paints the tag chips' three-way include/exclude. */
export function PopoverItem({
  className,
  state,
  ...props
}: React.ComponentProps<'button'> & { state?: 'inc' | 'exc' | 'on' }) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[13.5px] hover:bg-raised',
        state === 'on' && 'text-sage',
        className,
      )}
      {...props}
    />
  )
}

/** The square that fills in when a row is included (sage) or excluded (red). */
export function PopoverDot({ state }: { state?: 'inc' | 'exc' }) {
  return (
    <span
      className={cn(
        'size-3.5 flex-none rounded-[5px] border-[1.5px] border-line',
        state === 'inc' && 'border-sage bg-sage',
        state === 'exc' && 'border-bad bg-bad',
      )}
    />
  )
}

export function PopoverCount({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto text-[11.5px] text-faint">{children}</span>
}

export function PopoverSeparator() {
  return <hr className="my-1.5 border-0 border-t border-line-soft" />
}
