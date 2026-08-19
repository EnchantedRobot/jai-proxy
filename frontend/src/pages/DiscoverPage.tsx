import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { CardGrid } from '@/components/CardGrid'
import { DiscoverTile } from '@/components/DiscoverTile'
import { DiscoverTagFilter } from '@/components/DiscoverTagFilter'
import { EMPTY_TAGS, type TagSelection } from '@/components/discover-tags-def'
import { useDebounced } from '@/hooks/use-debounced'
import {
  useAddChubToArchive,
  useAddDatacatToArchive,
  useDatacatFollows,
  useDiscoverSearch,
  useHaveGuard,
  type DiscoverMode,
  type Provider,
} from '@/hooks/use-discover'
import { useProviderSettings, useSettings } from '@/hooks/use-settings'
import type { ChubNode } from '@/lib/providers/chub'
import type { ChubSort } from '@/lib/providers/chub'
import type { DatacatCharacter } from '@/lib/providers/datacat'
import {
  hasTagFilters,
  matchesTagFilters,
  withPersistentExcludes,
} from '@/lib/providers/shared'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const CHUB_SORTS: { value: ChubSort; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'download_count', label: 'Most downloaded' },
  { value: 'id', label: 'Newest' },
]

/**
 * Search providers and add straight to the archive (docs/UI_REWRITE_PLAN.md
 * §3.8, §4.5). Chub and DataCat, not the whole legacy provider stack --
 * JanitorAI Supabase auth, MeiliSearch and DataCat script hydration stay out of
 * scope for "search and add a card".
 *
 * Following and tag filtering landed at Stage 6B, having been deferred at Stage
 * 5 and then never built. The two are asymmetric on purpose: Chub's follows
 * live in a real account so they are read-only here, while DataCat's are local
 * settings data with no remote copy, so this app owns them outright.
 */
export function DiscoverPage() {
  const settings = useSettings()
  const { chubToken, chubNsfw, providerExcludeTags } = useProviderSettings()
  // Absent (nothing saved, or still loading) reads as both enabled -- the
  // page's behaviour before the Settings toggle existed.
  const providersConf = settings.data?.ui2?.providers
  const chubOn = providersConf?.chub !== false
  const datacatOn = providersConf?.datacat !== false

  const [provider, setProvider] = useState<Provider>('chub')
  const [mode, setMode] = useState<DiscoverMode>('browse')
  const [sort, setSort] = useState<ChubSort>('trending')
  const [rawSearch, setRawSearch] = useState('')
  const [hideHave, setHideHave] = useState(false)
  const [tags, setTags] = useState<TagSelection>(EMPTY_TAGS)
  const search = useDebounced(rawSearch, 350)

  const auth = useMemo(
    () => ({ token: chubToken, nsfw: chubNsfw }),
    [chubToken, chubNsfw],
  )
  const { creators: datacatFollows } = useDatacatFollows()

  // A provider turned off in Settings disappears from the toggle; if it was
  // the active one, fall back to whichever provider is still on.
  useEffect(() => {
    if (provider === 'chub' && !chubOn && datacatOn) setProvider('datacat')
    else if (provider === 'datacat' && !datacatOn && chubOn) setProvider('chub')
  }, [provider, chubOn, datacatOn])

  const results = useDiscoverSearch(provider, search, sort, {
    mode,
    auth,
    followed: datacatFollows,
  })
  const {
    data,
    error,
    isPending,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = results

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const total = data?.pages[data.pages.length - 1]?.total

  // Client-side only, always -- neither provider's server-side tag matching is
  // trustworthy (`lib/providers/shared.ts`, trap 2). The persistent
  // `providerExcludeTags` entry is layered underneath as a floor the chips
  // cannot re-admit.
  const filters = useMemo(
    () =>
      withPersistentExcludes(
        { include: tags.include, exclude: tags.exclude },
        providerExcludeTags?.[provider],
      ),
    [tags, providerExcludeTags, provider],
  )
  const filtering = hasTagFilters(filters)
  const tagMatched = useMemo(
    () =>
      filtering
        ? items.filter((i) => matchesTagFilters(i.tags, filters))
        : items,
    [items, filters, filtering],
  )

  const have = useHaveGuard(tagMatched.map((i) => i.providerId))
  const haveSet = have.data ?? new Set<string>()
  const haveCount = tagMatched.filter((i) => haveSet.has(i.providerId)).length
  const visible = hideHave
    ? tagMatched.filter((i) => !haveSet.has(i.providerId))
    : tagMatched

  // Trap 1: a page's own tag lists are truncated, so filtering thins results
  // unpredictably. Pull a few more pages rather than letting a live filter look
  // like an empty provider -- bounded, so a filter matching nothing still
  // settles instead of walking the whole provider.
  const autoPages = useRef(0)
  useEffect(() => {
    autoPages.current = 0
  }, [filters, provider, mode, search])
  useEffect(() => {
    if (!filtering || !hasNextPage || isFetching) return
    if (visible.length >= 12 || autoPages.current >= 3) return
    autoPages.current += 1
    void fetchNextPage()
  }, [filtering, hasNextPage, isFetching, visible.length, fetchNextPage])

  const chubNeedsToken =
    provider === 'chub' && mode === 'following' && !chubToken
  const noFollows =
    provider === 'datacat' &&
    mode === 'following' &&
    datacatFollows.length === 0

  const addChub = useAddChubToArchive()
  const addDatacat = useAddDatacatToArchive()
  const [addingKey, setAddingKey] = useState<string | null>(null)

  const onAdd = (key: string, raw: ChubNode | DatacatCharacter) => {
    setAddingKey(key)
    const mutation = provider === 'chub' ? addChub : addDatacat
    mutation.mutate(raw as ChubNode & DatacatCharacter, {
      onSuccess: (result) => {
        toast(
          result.duplicate
            ? 'Already in the archive.'
            : `Added ${result.card?.name ?? 'card'}.`,
        )
      },
      onError: (err) => toast(err.message, 'bad'),
      onSettled: () => setAddingKey(null),
    })
  }

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
  }, [hasNextPage, fetchNextPage, visible.length])

  return (
    <>
      <div className="sticky top-0 z-20 border-b border-line-soft bg-ground/95 backdrop-blur-[12px]">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-3.5 px-5 py-3">
          <h1 className="text-[19px] font-semibold tracking-[-0.015em] whitespace-nowrap">
            Discover
          </h1>
          <span className="text-[12.5px] whitespace-nowrap text-faint">
            search providers · add straight to the archive
          </span>

          <div className="flex min-w-0 flex-none items-center gap-1.5 rounded-full border border-white/6 bg-white/3 p-1">
            {chubOn && (
              <ProviderChip
                on={provider === 'chub'}
                onClick={() => setProvider('chub')}
              >
                Chub
              </ProviderChip>
            )}
            {datacatOn && (
              <ProviderChip
                on={provider === 'datacat'}
                onClick={() => setProvider('datacat')}
              >
                DataCat
              </ProviderChip>
            )}
            <span className="mx-1 h-[18px] w-px bg-white/8" />
            <ProviderChip
              on={mode === 'browse'}
              onClick={() => setMode('browse')}
            >
              Discover
            </ProviderChip>
            <ProviderChip
              on={mode === 'following'}
              onClick={() => setMode('following')}
            >
              Following
            </ProviderChip>
            <span className="mx-1 h-[18px] w-px bg-white/8" />
            <ProviderChip on={hideHave} onClick={() => setHideHave((v) => !v)}>
              Hide cards I have
            </ProviderChip>
          </div>

          <DiscoverTagFilter
            provider={provider}
            auth={auth}
            value={tags}
            onChange={setTags}
          />

          <div className="flex-1" />

          {provider === 'chub' && mode === 'browse' && (
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ChubSort)}
              className="h-[33px] rounded-full border border-line bg-ground px-3 text-[13px] text-muted-foreground focus:border-sage focus:outline-none"
            >
              {CHUB_SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-[1560px] px-5">
        <div className="flex flex-wrap items-center gap-2.5 py-5">
          {/* Neither provider's Following feed takes a search term, so the box
              is absent there rather than present and inert (§0). */}
          {mode === 'browse' && (
            <div className="flex h-[38px] max-w-[520px] flex-1 items-center gap-2.5 rounded-[10px] border border-line bg-surface px-3">
              <Search className="size-4 shrink-0 text-faint" />
              <input
                value={rawSearch}
                onChange={(e) => setRawSearch(e.target.value)}
                placeholder={`Search ${provider === 'chub' ? 'Chub' : 'DataCat'}…`}
                className="w-full bg-transparent text-[13.5px] outline-none"
              />
            </div>
          )}
          <span className="text-[12.5px] whitespace-nowrap text-faint">
            {isPending
              ? 'searching…'
              : filtering
                ? // With a tag filter on, the provider's own total is not the
                  // number on screen -- report what actually matched.
                  `${visible.length} of ${items.length} loaded match${haveCount ? ` · ${haveCount} already in the archive` : ''}`
                : total !== undefined
                  ? `${total.toLocaleString()} results${haveCount ? ` · ${haveCount} already in the archive` : ''}`
                  : `${items.length} results shown${haveCount ? ` · ${haveCount} already in the archive` : ''}`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex h-[35px] items-center gap-2 rounded-full border border-line px-3.5 text-[13px] text-muted-foreground hover:border-white/20 hover:text-text disabled:opacity-60"
          >
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            Refresh
          </button>
        </div>

        {chubNeedsToken ? (
          <EmptyFollowing
            title="Chub’s Following needs your token"
            body="Chub serves the followed-authors feed only to a signed-in account. Paste your URQL token in Settings → Providers and it will appear here. Following and unfollowing stay on chub.ai."
          />
        ) : noFollows ? (
          <EmptyFollowing
            title="You’re not following anyone on DataCat yet"
            body="DataCat has no accounts, so this list lives in your archive’s own settings. Add a creator in Settings → Providers and their cards show up here."
          />
        ) : (
          <>
            {error && (
              <p className="py-16 text-center text-bad">{error.message}</p>
            )}
            {!isPending && !error && visible.length === 0 && (
              <p className="py-16 text-center text-faint">
                {items.length === 0
                  ? 'No results.'
                  : filtering && tagMatched.length === 0
                    ? 'No result on the pages loaded so far carries those tags.'
                    : 'Every result on this page is already in the archive.'}
              </p>
            )}
          </>
        )}

        <CardGrid className="pb-[90px]">
          {visible.map((item) => (
            <DiscoverTile
              key={item.key}
              item={item}
              have={haveSet.has(item.providerId)}
              adding={addingKey === item.key}
              onAdd={() => onAdd(item.key, item.raw)}
            />
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

/** The two "Following is empty, and here is why" states. Both are ordinary
 *  conditions rather than errors, so neither uses the error colour. */
function EmptyFollowing({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-[460px] py-20 text-center">
      <p className="text-[15px] font-medium text-text">{title}</p>
      <p className="mt-2 text-[13px] leading-[1.6] text-faint">{body}</p>
    </div>
  )
}

function ProviderChip({
  on,
  className,
  ...props
}: React.ComponentProps<'button'> & { on?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-[30px] flex-none items-center gap-[7px] rounded-full border border-transparent px-3.5 text-[13px] text-muted-foreground hover:bg-white/5 hover:text-text',
        on && 'border-sage-line bg-sage-dim text-sage hover:bg-sage-dim',
        className,
      )}
      {...props}
    />
  )
}
