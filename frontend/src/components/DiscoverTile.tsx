import type { DiscoverItem } from '@/hooks/use-discover'
import { cn } from '@/lib/utils'

/**
 * One provider search result (docs/UI_REWRITE_PLAN.md §4.5). Not a link —
 * there is no detail route for a card that isn't in the archive yet, only the
 * "Get" affordance the mock puts on hover, plus a badge when it already is.
 */
export function DiscoverTile({
  item,
  have,
  onAdd,
  adding,
}: {
  item: DiscoverItem
  have: boolean
  onAdd: () => void
  adding: boolean
}) {
  return (
    <div className="group">
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-line-soft bg-raised group-hover:border-sage-line">
        {have && (
          <span className="absolute top-[7px] right-[7px] z-2 rounded-[6px] border border-sage-line bg-ground/80 px-1.5 py-px text-[10px] font-bold tracking-[0.05em] text-sage uppercase backdrop-blur-[6px]">
            Have
          </span>
        )}
        {item.avatarUrl ? (
          <img
            src={item.avatarUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-[450ms] ease-[cubic-bezier(.2,.7,.3,1)] group-hover:scale-105"
          />
        ) : (
          <div className="size-full bg-raised" />
        )}
        <span className="pointer-events-none absolute inset-0 shadow-[inset_0_-54px_44px_-30px_#0f1113de]" />
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          className={cn(
            'absolute inset-x-[7px] bottom-[7px] z-3 hidden h-7 items-center justify-center rounded-lg bg-sage text-[12px] font-semibold text-on-sage group-hover:flex disabled:opacity-60',
          )}
        >
          {adding ? 'Adding…' : have ? 'Add again' : 'Get'}
        </button>
      </div>
      <h3 className="mt-2 line-clamp-2 text-[13.5px] leading-[1.3] font-medium">
        {item.name}
      </h3>
      <div className="mt-px truncate text-[11.5px] text-faint">
        {item.creator || 'unknown'}
      </div>
    </div>
  )
}
