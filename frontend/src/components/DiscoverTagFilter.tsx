import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverCount,
  PopoverDot,
  PopoverHeading,
  PopoverItem,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useProviderTags, type Provider } from '@/hooks/use-discover'
import type { ChubAuth } from '@/lib/providers/chub'
import {
  cycleTag,
  tagState,
  EMPTY_TAGS,
  type TagSelection,
} from './discover-tags-def'
import { cn } from '@/lib/utils'

/**
 * Discover's tag filter: the active chips plus the ＋ Filter catalogue.
 *
 * The catalogue is a *suggestion* list. Both providers truncate per-card tag
 * lists in list payloads, so a tag being absent here does not mean nothing
 * carries it — which is why the search box accepts a free-text tag the
 * catalogue never offered. Matching itself always happens client-side; no tag
 * is ever sent as a provider query param (`lib/providers/shared.ts`, trap 2).
 */
export function DiscoverTagFilter({
  provider,
  auth,
  value,
  onChange,
}: {
  provider: Provider
  auth?: ChubAuth
  value: TagSelection
  onChange: (next: TagSelection) => void
}) {
  const [search, setSearch] = useState('')
  const catalogue = useProviderTags(provider, auth)

  const needle = search.trim().toLowerCase()
  const all = catalogue.data ?? []
  const listed = all.filter((tag) => tag.toLowerCase().includes(needle))
  // A tag typed in full that the catalogue does not carry is still selectable —
  // see trap 1 above.
  const unlisted =
    needle && !all.some((tag) => tag.toLowerCase() === needle)
      ? [search.trim()]
      : []

  const active = [
    ...value.include.map((tag) => ({ tag, state: 'inc' as const })),
    ...value.exclude.map((tag) => ({ tag, state: 'exc' as const })),
  ]

  return (
    <>
      {active.map(({ tag, state }) => (
        <button
          key={`${state}:${tag}`}
          type="button"
          onClick={() => onChange(cycleTag(value, tag))}
          title={
            state === 'inc'
              ? 'Included — click to exclude'
              : 'Excluded — click to clear'
          }
          className={cn(
            'inline-flex h-[30px] flex-none items-center gap-[7px] rounded-full border px-3.5 text-[13px]',
            state === 'inc'
              ? 'border-sage-line bg-sage-dim text-sage'
              : 'border-bad/40 bg-bad/10 text-bad line-through',
          )}
        >
          {tag}
        </button>
      ))}

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
          <PopoverHeading>
            Tags · click to include, again to exclude
          </PopoverHeading>
          <div className="max-h-[300px] overflow-y-auto">
            {catalogue.isPending && (
              <div className="px-2.5 py-2 text-[13px] text-faint">
                reading {provider === 'chub' ? 'Chub' : 'DataCat'}’s tags…
              </div>
            )}
            {!catalogue.isPending &&
              listed.length === 0 &&
              !unlisted.length && (
                <div className="px-2.5 py-2 text-[13px] text-faint">
                  no matching tag
                </div>
              )}
            {unlisted.map((tag) => (
              <PopoverItem
                key={`new:${tag}`}
                onClick={() => onChange(cycleTag(value, tag))}
              >
                <PopoverDot state={tagState(value, tag)} />
                {tag}
                <PopoverCount>use anyway</PopoverCount>
              </PopoverItem>
            ))}
            {listed.slice(0, 400).map((tag) => (
              <PopoverItem
                key={tag}
                onClick={() => onChange(cycleTag(value, tag))}
              >
                <PopoverDot state={tagState(value, tag)} />
                {tag}
              </PopoverItem>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {(value.include.length > 0 || value.exclude.length > 0) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_TAGS)}
          className="text-[12.5px] text-faint hover:text-text"
        >
          clear
        </button>
      )}
    </>
  )
}
