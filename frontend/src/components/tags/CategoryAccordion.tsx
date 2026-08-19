import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Variant } from '@/lib/tags/tag-analysis'
import type { EditorGroup } from '@/lib/tags/tags-editor'
import { CanonicalRow } from './CanonicalRow'
import type { GroupTarget } from './ChipMoveMenu'
import type { MoveDest, MoveFrom } from './move-types'

/** Union of card avatars across every group in a category — the header count. */
function categoryCards(groups: EditorGroup[]): number {
  const set = new Set<string>()
  for (const g of groups)
    for (const v of g.variants) for (const a of v.avatars) set.add(a)
  return set.size
}

export function CategoryAccordion({
  category,
  groups,
  targets,
  open,
  onToggle,
  onRename,
  onMove,
  onDelete,
}: {
  category: string
  groups: EditorGroup[]
  targets: GroupTarget[]
  open: boolean
  onToggle: () => void
  onRename: (id: string, name: string) => void
  onMove: (variant: Variant, from: MoveFrom, dest: MoveDest) => void
  onDelete: (id: string) => void
}) {
  return (
    <section className="mb-2.5 overflow-hidden rounded-[15px] border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-raised"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-faint transition-transform',
            open && 'rotate-90',
          )}
        />
        <h3 className="text-[14px] font-semibold text-sage">{category}</h3>
        <span className="ml-auto text-[12px] text-faint">
          {groups.length} canonical
        </span>
        <span className="min-w-[74px] text-right text-[12px] text-faint">
          {categoryCards(groups).toLocaleString()} cards
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2">
          <div className="grid grid-cols-[minmax(180px,1.1fr)_minmax(260px,2fr)_72px_34px] gap-4 px-3 pt-1.5 pb-2 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">
            <span>Canonical tag</span>
            <span>Merged variants</span>
            <span className="text-right">Cards</span>
            <span />
          </div>
          {groups.map((group) => (
            <CanonicalRow
              key={group.id}
              group={group}
              targets={targets}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  )
}
