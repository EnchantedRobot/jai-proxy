import { cn } from '@/lib/utils'

/**
 * The grid track, shared by the browse grid, the shelf and the search results.
 *
 * `auto-fill` with a minimum track is what makes the layout responsive without
 * a breakpoint anywhere: the column count falls out of the available width, to
 * one or two columns on a phone (docs/UI_REWRITE_PLAN.md §6.3).
 */
export function CardGrid({
  className,
  ref,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      ref={ref}
      className={cn(
        'grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-x-3.5 gap-y-[22px]',
        className,
      )}
      {...props}
    />
  )
}
