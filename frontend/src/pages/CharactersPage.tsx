import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ChipStrip } from '@/components/ChipStrip'
import { CardGrid } from '@/components/CardGrid'
import { CardTile } from '@/components/CardTile'
import { RecentShelf } from '@/components/RecentShelf'
import { SortPopover } from '@/components/SortPopover'
import { useGridColumns } from '@/hooks/use-grid-columns'
import { useArchiveStats, useCharacters } from '@/hooks/use-characters'
import {
  isFiltered,
  readState,
  writeState,
  type BrowseState,
} from '@/lib/browse'

/**
 * Browse the archive: the chip strip, the sort control, the recently-added
 * shelf and the grid.
 *
 * `/favorites` is this page with one filter pinned on, rather than a page of
 * its own — the mock treats it as a tab, and everything else about it (chips,
 * sort, shelf suppression) is identical.
 */
export function CharactersPage({ favorites = false }: { favorites?: boolean }) {
  const [params, setParams] = useSearchParams()
  const [shelfHidden, setShelfHidden] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const columns = useGridColumns(gridRef)

  const urlState = readState(params)
  const state: BrowseState = favorites
    ? { ...urlState, flags: new Set(urlState.flags).add('fav') }
    : urlState

  const setState = (next: BrowseState) => {
    // Replace rather than push: filtering is a running adjustment, and pushing
    // every chip click would make Back walk through each of them one at a time.
    setParams(writeState(next), { replace: true })
  }

  const stats = useArchiveStats()
  const characters = useCharacters(state)
  const {
    data,
    error,
    isPending,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = characters

  const cards = data?.pages.flatMap((page) => page.items) ?? []
  const total = data?.pages[0]?.total ?? 0

  // Infinite scroll: a sentinel below the grid asks for the next page as it
  // comes into view. Kept a screen ahead with rootMargin so the grid does not
  // visibly stop at the bottom of each page.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = sentinelRef.current
    if (!element || !hasNextPage) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void fetchNextPage()
      },
      { rootMargin: '600px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasNextPage, fetchNextPage, cards.length])

  const showShelf = !shelfHidden && !favorites && !isFiltered(state)

  return (
    <>
      <div className="sticky top-0 z-20 border-b border-line-soft bg-ground/95 backdrop-blur-[12px]">
        <div className="mx-auto flex max-w-[1560px] items-center gap-3.5 px-5 py-3">
          <h1 className="text-[19px] font-semibold tracking-[-0.015em] whitespace-nowrap">
            {favorites ? 'Favorites' : 'Characters'}
          </h1>
          <span className="text-[12.5px] whitespace-nowrap text-faint">
            {isPending
              ? 'reading…'
              : `${total.toLocaleString()} shown${
                  stats.data ? ` of ${stats.data.cards.toLocaleString()}` : ''
                }`}
          </span>
          <ChipStrip
            state={state}
            onChange={setState}
            pinned={favorites ? ['fav'] : []}
          />
          <div className="flex-1" />
          <SortPopover
            sort={state.sort}
            onChange={(sort) => setState({ ...state, sort })}
          />
        </div>
      </div>

      <div className="mx-auto max-w-[1560px] px-5">
        {showShelf && (
          <RecentShelf columns={columns} onHide={() => setShelfHidden(true)} />
        )}

        {error && <p className="py-16 text-center text-bad">{error.message}</p>}
        {!isPending && !error && cards.length === 0 && (
          <p className="py-16 text-center text-faint">
            Nothing matches those filters.
          </p>
        )}

        <CardGrid ref={gridRef} className="pt-[22px] pb-[90px]">
          {cards.map((card) => (
            <CardTile key={card.id} card={card} />
          ))}
        </CardGrid>

        <div ref={sentinelRef} className="h-px" />
        {isFetchingNextPage && (
          <p className="pb-16 text-center text-[12.5px] text-faint">
            loading more…
          </p>
        )}
      </div>
    </>
  )
}
