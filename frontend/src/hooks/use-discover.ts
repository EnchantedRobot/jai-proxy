import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { apiClient, unwrap } from '@/lib/api-client'
import type { components } from '@/lib/api-schema'
import {
  chubAvatarUrl,
  fetchChubFull,
  fetchChubFollows,
  fetchChubPopularTags,
  fetchChubTimeline,
  searchChub,
  ChubAuthRequired,
  type ChubAuth,
  type ChubNode,
  type ChubSort,
} from '@/lib/providers/chub'
import {
  datacatAvatarUrl,
  datacatCharacterId,
  datacatCreatorName,
  datacatName,
  fetchDatacatCreator,
  fetchDatacatCreatorCharacters,
  fetchDatacatDetail,
  fetchDatacatDownload,
  fetchDatacatTags,
  resolveDatacatTagNames,
  searchDatacat,
  type DatacatCharacter,
} from '@/lib/providers/datacat'
import {
  useProviderSettings,
  useUpdateRoot,
  type FollowedCreator,
} from './use-settings'
import { invalidateArchive } from './use-card-mutations'

export type Provider = 'chub' | 'datacat'

/** Discover's two modes -- the mock's `Discover | Following` pair. */
export type DiscoverMode = 'browse' | 'following'

/** One provider result, normalized to what `DiscoverTile` and the have-guard
 * need. `raw` carries the row exactly as the provider returned it, since
 * adding a card to the archive needs a further per-provider fetch (Chub's
 * search rows are summaries; DataCat's need a detail + download read). */
export interface DiscoverItem {
  key: string
  provider: Provider
  providerId: string
  name: string
  creator: string
  avatarUrl: string
  tags: string[]
  raw: ChubNode | DatacatCharacter
}

const PAGE_SIZE = 48

function fromChub(node: ChubNode): DiscoverItem {
  const id = node.id != null ? String(node.id) : ''
  return {
    key: `chub:${id || node.fullPath}`,
    provider: 'chub',
    providerId: id,
    name: node.name ?? 'Unknown',
    creator: node.fullPath?.split('/')[0] ?? '',
    avatarUrl: chubAvatarUrl(node),
    tags: node.topics ?? [],
    raw: node,
  }
}

function fromDatacat(hit: DatacatCharacter): DiscoverItem {
  const id = datacatCharacterId(hit)
  return {
    key: `datacat:${id}`,
    provider: 'datacat',
    providerId: id,
    name: datacatName(hit),
    creator: datacatCreatorName(hit),
    avatarUrl: datacatAvatarUrl(hit),
    tags: resolveDatacatTagNames(hit.tags),
    raw: hit,
  }
}

/**
 * Provider browse (docs/UI_REWRITE_PLAN.md §3.8, §4.5's `DiscoverGrid`). One
 * query shape over both providers' very different pagination (Chub is
 * page-numbered, DataCat is offset-based) -- `pageParam` is a page index
 * either way, translated to an offset only for DataCat's call.
 */
/**
 * One cursor covering four very different paginations: Chub browse is
 * page-numbered, Chub's Following timeline is cursor-based, DataCat browse is
 * offset-based, and DataCat's Following fans out over followed creators in
 * batches. `index` counts our own pages; `cursor` carries Chub's opaque token.
 */
interface DiscoverCursor {
  index: number
  cursor: string | null
}

const FIRST_CURSOR: DiscoverCursor = { index: 1, cursor: null }

/** DataCat's Following fetches this many creators per page of results, matching
 *  the old UI's 3-at-a-time fan-out (`datacat-browse.js:1996-2062`). */
const CREATORS_PER_BATCH = 3

export function useDiscoverSearch(
  provider: Provider,
  search: string,
  sort: ChubSort,
  opts: {
    mode?: DiscoverMode
    auth?: ChubAuth
    followed?: FollowedCreator[]
  } = {},
) {
  const { mode = 'browse', auth, followed = [] } = opts
  const followedIds = followed.map((c) => c.id).join(',')

  return useInfiniteQuery({
    queryKey: [
      'discover',
      provider,
      mode,
      search,
      sort,
      // The token changes what Chub returns, so it belongs in the key -- but
      // only as a presence flag, never the secret itself.
      auth?.token ? 'authed' : 'anon',
      auth?.nsfw ?? true,
      mode === 'following' ? followedIds : '',
    ],
    initialPageParam: FIRST_CURSOR,
    queryFn: async ({ pageParam }) => {
      const { index, cursor } = pageParam

      if (provider === 'chub' && mode === 'following') {
        const { nodes, cursor: next } = await fetchChubTimeline({
          auth: auth ?? {},
          cursor,
        })
        return {
          items: nodes.map(fromChub),
          hasMore: Boolean(next) && nodes.length > 0,
          next: { index: index + 1, cursor: next },
          total: undefined as number | undefined,
        }
      }

      if (provider === 'chub') {
        const { nodes, hasMore } = await searchChub({
          search,
          page: index,
          sort,
          auth,
        })
        return {
          items: nodes.map(fromChub),
          hasMore,
          next: { index: index + 1, cursor: null },
          total: undefined as number | undefined,
        }
      }

      if (mode === 'following') {
        // DataCat has no timeline endpoint, so the feed *is* the fan-out: a
        // slice of followed creators per page, each creator's cards fetched in
        // one call. Ordering follows the stored list, which is stable.
        const slice = followed.slice(
          (index - 1) * CREATORS_PER_BATCH,
          index * CREATORS_PER_BATCH,
        )
        const batches = await Promise.all(
          slice.map((creator) =>
            fetchDatacatCreatorCharacters({
              creatorId: creator.id,
              limit: PAGE_SIZE,
            }).catch(() => ({ totalCount: 0, characters: [] })),
          ),
        )
        return {
          items: batches.flatMap((b) => b.characters.map(fromDatacat)),
          hasMore: index * CREATORS_PER_BATCH < followed.length,
          next: { index: index + 1, cursor: null },
          total: undefined as number | undefined,
        }
      }

      const offset = (index - 1) * PAGE_SIZE
      const { characters, totalCount } = await searchDatacat({
        search,
        limit: PAGE_SIZE,
        offset,
      })
      return {
        items: characters.map(fromDatacat),
        hasMore: offset + characters.length < totalCount,
        next: { index: index + 1, cursor: null },
        total: totalCount,
      }
    },
    getNextPageParam: (last) => (last.hasMore ? last.next : undefined),
    // A missing/expired Chub token is an expected state with its own UI, not a
    // transient failure worth retrying.
    retry: (count, error) => !(error instanceof ChubAuthRequired) && count < 2,
  })
}

/** Chub's follows, read-only by decision (Stage 6B B2) -- following and
 *  unfollowing happen on chub.ai itself. */
export function useChubFollows(auth: ChubAuth) {
  return useQuery({
    queryKey: ['chub-follows', auth.token ? 'authed' : 'anon'],
    enabled: Boolean(auth.token),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => fetchChubFollows(auth),
  })
}

/**
 * DataCat's followed creators, which are ours to manage: the list is local
 * settings data tied to no account, so this *is* the feature rather than a
 * cache of a remote one.
 */
export function useDatacatFollows() {
  const { datacatFollowedCreators } = useProviderSettings()
  const update = useUpdateRoot()

  const follow = useMutation({
    mutationFn: async (idOrUrl: string) => {
      const id = extractDatacatCreatorId(idOrUrl)
      if (!id) throw new Error('that does not look like a DataCat creator id')
      if (datacatFollowedCreators.some((c) => c.id === id))
        throw new Error('already following that creator')
      // Resolve the name so the stored row is readable later; a creator that
      // cannot be resolved is still followable by id rather than being refused.
      const creator = await fetchDatacatCreator(id)
      const row: FollowedCreator = {
        id,
        name: creator?.name ?? id,
        source: 'datacat',
      }
      await update.mutateAsync({
        datacatFollowedCreators: [...datacatFollowedCreators, row],
      })
      return row
    },
  })

  const unfollow = useMutation({
    mutationFn: (id: string) =>
      update.mutateAsync({
        datacatFollowedCreators: datacatFollowedCreators.filter(
          (c) => c.id !== id,
        ),
      }),
  })

  return { creators: datacatFollowedCreators, follow, unfollow }
}

/** Accept a bare uuid, a profile URL, or a paste of either. */
export function extractDatacatCreatorId(input: string): string | null {
  const text = input.trim()
  const uuid = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )
  return uuid ? uuid[0] : null
}

/**
 * The tag catalogue behind Discover's ＋ Filter popover.
 *
 * A suggestion list, not an authority: both providers truncate per-card tag
 * lists in list payloads (trap 1), so a tag missing here does not mean no card
 * carries it -- which is why the popover keeps a free-text search box.
 */
export function useProviderTags(provider: Provider, auth?: ChubAuth) {
  return useQuery({
    queryKey: ['provider-tags', provider],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<string[]> =>
      provider === 'chub'
        ? fetchChubPopularTags(auth)
        : (await fetchDatacatTags()).map((tag) => tag.name),
  })
}

/** Which of the currently-loaded provider ids are already archived --
 * `POST /characters/have`, the same `_<id8>` fragment match the userscript's
 * own `/existing` answers from (§3.8). */
export function useHaveGuard(providerIds: string[]) {
  return useQuery({
    queryKey: ['characters-have', providerIds.join(',')],
    enabled: providerIds.length > 0,
    queryFn: () =>
      unwrap(
        apiClient.POST('/api/v1/characters/have', {
          body: { ids: providerIds },
        }),
        'could not check the archive',
      ),
    select: (data) => new Set(data.have),
    staleTime: 30_000,
  })
}

type BuildResponse = components['schemas']['BuildResponse']

/** Chub's "Get": re-fetch the full node (search rows omit `definition`), then
 * `POST /build-chub` -- the server does the V2 mapping and the write. */
export function useAddChubToArchive() {
  const client = useQueryClient()
  const { chubToken, chubNsfw } = useProviderSettings()
  return useMutation<BuildResponse, Error, ChubNode>({
    mutationFn: async (node) => {
      const fullPath = node.fullPath
      if (!fullPath) throw new Error('this card has no fullPath to fetch')
      // Authed where a token exists: a private or restricted card returns null
      // anonymously, which would surface as "could not fetch" for no reason.
      const full = await fetchChubFull(fullPath, {
        token: chubToken,
        nsfw: chubNsfw,
      })
      if (!full) throw new Error('could not fetch the full card from Chub')
      const avatarUrl = chubAvatarUrl(full) || chubAvatarUrl(node) || null
      return unwrap(
        apiClient.POST('/build-chub', {
          body: { node: full, avatar_url: avatarUrl },
        }),
        'could not add the card',
      )
    },
    onSuccess: () => {
      invalidateArchive(client)
      void client.invalidateQueries({ queryKey: ['characters-have'] })
    },
  })
}

/** DataCat's "Get": detail + (best-effort) download, then `POST
 * /build-datacat`. Lorebook script hydration is left out -- see the module
 * docstring in `lib/providers/datacat.ts`. */
export function useAddDatacatToArchive() {
  const client = useQueryClient()
  return useMutation<BuildResponse, Error, DatacatCharacter>({
    mutationFn: async (hit) => {
      const id = datacatCharacterId(hit)
      if (!id) throw new Error('this card has no character id')
      const sourceKind =
        (hit.primary_content_source_kind as string | null) ?? null
      const character = await fetchDatacatDetail(id, sourceKind)
      if (!character) throw new Error('could not fetch the card from DataCat')
      const download = await fetchDatacatDownload(id, sourceKind)
      return unwrap(
        apiClient.POST('/build-datacat', {
          body: { character, download: download ?? null },
        }),
        'could not add the card',
      )
    },
    onSuccess: () => {
      invalidateArchive(client)
      void client.invalidateQueries({ queryKey: ['characters-have'] })
    },
  })
}
