import { Link } from 'react-router'
import { useBatchSelection } from '@/hooks/use-batch-selection'
import { useRecentlyAdded } from '@/hooks/use-characters'
import { weekAgo } from '@/lib/browse'
import { CardGrid } from './CardGrid'
import { CardTile } from './CardTile'

/**
 * Exactly one row of the newest cards, whatever the grid beneath it is sorted
 * by. `columns` comes from `useGridColumns` over the grid itself, so the row is
 * full at any width without a breakpoint here.
 */
export function RecentShelf({
  columns,
  onHide,
}: {
  columns: number
  onHide: () => void
}) {
  const recent = useRecentlyAdded(columns)
  const batch = useBatchSelection()
  if (!recent.data?.items.length) return null

  // The shelf always shows the newest cards; the badge says they arrived this
  // week. On a quiet week those are not the same claim, so it is checked rather
  // than assumed -- otherwise a card acquired in March wears a "new" label.
  const since = weekAgo()

  return (
    <section className="pt-5 pb-1">
      <div className="flex items-center gap-3 pb-3">
        <h2 className="text-[14.5px] font-semibold">Recently added</h2>
        <span className="text-xs text-faint">
          {recent.data.items.length} newest
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            to="/?sort=-added"
            className="text-[12.5px] text-sage hover:underline"
          >
            See all →
          </Link>
          <button
            type="button"
            onClick={onHide}
            className="text-[12.5px] text-faint hover:text-text"
          >
            Hide
          </button>
        </div>
      </div>
      <CardGrid className="pb-1">
        {recent.data.items.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            isNew={!!card.linked_at && card.linked_at >= since}
            // The shelf is sorted newest-first; hand that ordering to the
            // detail page so prev/next walks the recently-added set, not the
            // default A→Z the empty home querystring would imply.
            search="?sort=-added"
            batchMode={batch.active}
            selected={batch.selected.has(card.id)}
            onToggleSelect={batch.toggleSelected}
          />
        ))}
      </CardGrid>
      <hr className="mt-5 border-0 border-t border-line-soft" />
    </section>
  )
}
