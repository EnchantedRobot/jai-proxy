import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverCount,
  PopoverDot,
  PopoverHeading,
  PopoverItem,
  PopoverSeparator,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useTagFacets } from '@/hooks/use-characters'
import { FLAG_LABELS, type BrowseState, type Flag } from '@/lib/browse'

/** Flags in the popover, including the two that are not preset chips. */
const FLAGS: Flag[] = ['fav', 'lore', 'greets', 'new', 'untagged']

/**
 * ＋ Filter: every flag, and the tag catalogue with archive-wide counts.
 *
 * The counts come from `/api/v1/facets`, which is computed over the *unfiltered*
 * archive by design — a filter list that shrank its own options as you used it
 * would make a second tag look unavailable when it is merely rare.
 */
export function FilterPopover({
  state,
  onChange,
  pinned = [],
}: {
  state: BrowseState
  onChange: (next: BrowseState) => void
  pinned?: Flag[]
}) {
  const [search, setSearch] = useState('')
  const facets = useTagFacets()

  const toggleFlag = (flag: Flag) => {
    const flags = new Set(state.flags)
    if (!flags.delete(flag)) flags.add(flag)
    onChange({ ...state, flags })
  }

  const cycleTag = (tag: string) => {
    const tags = new Map(state.tags)
    const current = tags.get(tag)
    if (!current) tags.set(tag, 'inc')
    else if (current === 'inc') tags.set(tag, 'exc')
    else tags.delete(tag)
    onChange({ ...state, tags })
  }

  const needle = search.trim().toLowerCase()
  const tags = (facets.data?.tags ?? []).filter((t) =>
    t.value.toLowerCase().includes(needle),
  )

  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-[30px] flex-none items-center gap-[7px] rounded-full border border-dashed border-white/15 px-3.5 text-[13px] text-faint hover:border-sage-line hover:text-sage">
        ＋ Filter
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[278px]">
        <input
          className="mt-0.5 mb-1.5 h-8 w-full rounded-[9px] border border-line bg-ground px-2.5 focus:border-sage focus:outline-none"
          placeholder="Search tags…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <PopoverHeading>Filters</PopoverHeading>
        {FLAGS.filter((flag) => !pinned.includes(flag)).map((flag) => (
          <PopoverItem key={flag} onClick={() => toggleFlag(flag)}>
            <PopoverDot state={state.flags.has(flag) ? 'inc' : undefined} />
            {FLAG_LABELS[flag]}
          </PopoverItem>
        ))}
        <PopoverSeparator />
        <PopoverHeading>
          Tags · click to include, again to exclude
        </PopoverHeading>
        <div className="max-h-[300px] overflow-y-auto">
          {facets.isPending && (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              reading the tag list…
            </div>
          )}
          {facets.error && (
            <div className="px-2.5 py-2 text-[13px] text-bad">
              {facets.error.message}
            </div>
          )}
          {tags.map((tag) => (
            <PopoverItem key={tag.value} onClick={() => cycleTag(tag.value)}>
              <PopoverDot state={state.tags.get(tag.value)} />
              {tag.value}
              <PopoverCount>{tag.count.toLocaleString()}</PopoverCount>
            </PopoverItem>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
