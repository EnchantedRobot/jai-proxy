import { useQuery } from '@tanstack/react-query'
import { apiClient, unwrap } from '@/lib/api-client'
import type { CardLike } from '@/lib/tags/tag-analysis'

/**
 * Every card's tags, for the Tags page.
 *
 * Unlike the browse grid — which pages server-side to keep the first paint small
 * (see use-characters.ts) — the tag editor genuinely needs the whole archive at
 * once: the staged stats and the apply plan are computed over every card, and
 * "cards affected" is only exact when counted over real cards. So this fetches
 * the whole filtered set in one request (`limit: 0`), which is what CardOut is
 * shaped to allow — no prose, no extensions. It maps each row to the minimal
 * `{ avatar, tags }` shape the tag logic reads, using the filename as the avatar
 * key (the value buildBuckets aggregates for its per-variant card counts).
 *
 * `health: 'all'` so a card that fails to parse is still surveyed — its tags, if
 * any survived, still get consolidated, matching the old UI's whole-archive scan.
 */
export function useAllCardTags() {
  return useQuery({
    queryKey: ['all-card-tags'],
    staleTime: 60_000,
    queryFn: async (): Promise<CardLike[]> => {
      const page = await unwrap(
        apiClient.GET('/api/v1/characters', {
          params: { query: { limit: 0, health: 'all' } },
        }),
        'could not survey the archive',
      )
      return page.items.map((c) => ({ avatar: c.id, tags: c.tags }))
    },
  })
}
