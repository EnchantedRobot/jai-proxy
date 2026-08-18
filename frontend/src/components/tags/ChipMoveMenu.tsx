import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverItem,
  PopoverSeparator,
  PopoverTrigger,
} from '@/components/ui/popover'

export interface GroupTarget {
  id: string
  canonical: string
}

export interface FixedAction {
  label: string
  onSelect: () => void
}

/**
 * The move menu behind a tag chip: a filterable list of canonicals to move the
 * tag into, plus fixed actions (unassign / remove / new canonical) that depend
 * on where the chip currently lives.
 *
 * Mirrors tag-manager.js `openChipMenu`, rebuilt on the app's Popover primitive
 * so positioning, focus trapping and outside-click close come for free rather
 * than being hand-rolled in viewport coordinates.
 */
export function ChipMoveMenu({
  trigger,
  groups,
  fixed,
  onPickGroup,
}: {
  trigger: React.ReactNode
  groups: GroupTarget[]
  fixed: FixedAction[]
  onPickGroup: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const matches = (
    q ? groups.filter((g) => g.canonical.toLowerCase().includes(q)) : groups
  ).slice(0, 50)

  const close = () => {
    setOpen(false)
    setFilter('')
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="min-w-[240px]">
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter canonicals…"
          className="mb-1 w-full rounded-[9px] border border-line bg-ground px-2.5 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-sage"
        />
        <div className="max-h-[240px] overflow-y-auto">
          {matches.length === 0 ? (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              No matching canonicals
            </div>
          ) : (
            matches.map((g) => (
              <PopoverItem
                key={g.id}
                onClick={() => {
                  onPickGroup(g.id)
                  close()
                }}
              >
                <span className="text-faint">→</span>
                <span className="truncate">{g.canonical}</span>
              </PopoverItem>
            ))
          )}
        </div>
        <PopoverSeparator />
        {fixed.map((action) => (
          <PopoverItem
            key={action.label}
            onClick={() => {
              action.onSelect()
              close()
            }}
          >
            {action.label}
          </PopoverItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
