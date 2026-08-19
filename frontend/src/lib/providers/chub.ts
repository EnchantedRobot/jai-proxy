/**
 * Chub (chub.ai) browse + fetch, at Discover's mock fidelity -- salvage item 5.
 * Ported from the request shapes in `web/modules/providers/chub/chub-api.js`
 * and `chub-browse.js`; the full browse view (author search, timeline, tag
 * dropdown, favourites) is not -- Discover only needs a search box and a grid.
 */

import { fetchWithProxy } from './shared'

export const CHUB_API_BASE = 'https://api.chub.ai'
export const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars/'

export type ChubSort = 'trending' | 'download_count' | 'id'

/**
 * Chub's URQL_TOKEN, sent as a plain `Authorization: Bearer` header.
 *
 * The name misleads: chub.ai's own site uses urql as its GraphQL client and
 * persists the session token under the `URQL_TOKEN` localStorage key, so that
 * is what the "how do I get my token" instructions tell you to copy. There is
 * no GraphQL on our side -- the value is used as a REST bearer token, exactly
 * as `web/modules/providers/chub/chub-api.js:45-53` used it.
 */
export interface ChubAuth {
  token?: string | null
  nsfw?: boolean
}

function chubHeaders(auth?: ChubAuth): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`
  return headers
}

/** Chub takes NSFW as two separate flags; the setting drives both. */
function nsfwParams(auth?: ChubAuth): { nsfw: string; nsfl: string } {
  const on = auth?.nsfw ?? true
  return { nsfw: String(on), nsfl: String(on) }
}

/** The fields Discover's tile and "have" guard need from a search row. Chub's
 * envelope shape varies by endpoint, so every field is read defensively. */
export interface ChubNode {
  id?: number | string
  fullPath?: string
  name?: string
  tagline?: string
  avatar_url?: string
  max_res_url?: string
  topics?: string[]
  starCount?: number
  n_favorites?: number
  [key: string]: unknown
}

function extractNodes(data: unknown): ChubNode[] {
  const d = data as Record<string, unknown>
  if (Array.isArray(d?.nodes)) return d.nodes as ChubNode[]
  const inner = d?.data as Record<string, unknown> | unknown[] | undefined
  if (inner && !Array.isArray(inner) && Array.isArray(inner.nodes))
    return inner.nodes as ChubNode[]
  if (Array.isArray(inner)) return inner as ChubNode[]
  if (Array.isArray(d)) return d as unknown as ChubNode[]
  return []
}

export async function searchChub(opts: {
  search?: string
  page?: number
  sort?: ChubSort
  auth?: ChubAuth
  /** A single creator's cards, used by the Following feed. */
  username?: string
}): Promise<{ nodes: ChubNode[]; hasMore: boolean }> {
  const { search = '', page = 1, sort = 'trending', auth, username } = opts
  const params = new URLSearchParams({
    first: '48',
    page: String(page),
    ...nsfwParams(auth),
    include_forks: 'true',
    venus: 'false',
    min_tokens: '50',
  })
  if (search) params.set('search', search)
  if (username) params.set('username', username)
  // Relevance ordering (Chub's `default`) only makes sense once there's a
  // search term; browsing with no term needs an explicit sort.
  if (search || sort !== 'trending') params.set('sort', sort)
  // NOTE: `topics`/`excludetopics` are deliberately never sent -- Chub's
  // server-side tag matching is unreliable. Tag filtering is client-side, in
  // `shared.ts`. See salvage item 6.

  const response = await fetchWithProxy(`${CHUB_API_BASE}/search?${params}`, {
    headers: chubHeaders(auth),
  })
  if (!response.ok)
    throw new Error(`Chub search failed: HTTP ${response.status}`)
  const data = await response.json()
  const nodes = extractNodes(data)
  const d = data as Record<string, unknown>
  const inner = d?.data as Record<string, unknown> | undefined
  const cursor = inner?.cursor ?? d?.cursor
  return { nodes, hasMore: cursor != null && nodes.length > 0 }
}

export function chubAvatarUrl(node: ChubNode): string {
  if (node.avatar_url) return node.avatar_url
  if (node.max_res_url) return node.max_res_url
  return node.fullPath ? `${CHUB_AVATAR_BASE}${node.fullPath}/avatar.webp` : ''
}

/** The full node (`?full=true`), which is what `POST /build-chub` needs --
 * search rows are summaries missing `definition`. */
export async function fetchChubFull(
  fullPath: string,
  auth?: ChubAuth,
): Promise<ChubNode | null> {
  const response = await fetchWithProxy(
    `${CHUB_API_BASE}/api/characters/${fullPath}?full=true`,
    { headers: chubHeaders(auth) },
  )
  if (!response.ok) return null
  const data = await response.json()
  return (data as { node?: ChubNode }).node ?? null
}

// ---- Following (read-only) -------------------------------------------------

/** Raised when Chub answers 401/403 -- the token is missing or stale. The
 *  Following UI shows "connect your token" rather than an error. */
export class ChubAuthRequired extends Error {
  constructor() {
    super('Chub token required')
    this.name = 'ChubAuthRequired'
  }
}

export interface ChubCreator {
  id: string
  name: string
  username: string
  avatar?: string
}

/**
 * The signed-in account's own username, needed because the follows endpoint is
 * keyed by username rather than by "me" (`chub-browse.js:2360-2445`).
 */
export async function fetchChubAccount(auth: ChubAuth): Promise<string | null> {
  if (!auth.token) throw new ChubAuthRequired()
  const response = await fetchWithProxy(`${CHUB_API_BASE}/api/account`, {
    headers: chubHeaders(auth),
  })
  if (response.status === 401 || response.status === 403)
    throw new ChubAuthRequired()
  if (!response.ok) return null
  const data = (await response.json()) as Record<string, unknown>
  const inner = (data.user ?? data) as Record<string, unknown>
  const name = inner.user_name ?? inner.username ?? inner.name
  return typeof name === 'string' ? name : null
}

/**
 * Who this account follows on Chub. Read-only by decision (Stage 6B B2):
 * following and unfollowing happen on chub.ai itself, so the archive never
 * issues writes against a third-party account.
 */
export async function fetchChubFollows(auth: ChubAuth): Promise<ChubCreator[]> {
  const username = await fetchChubAccount(auth)
  if (!username) return []
  const creators: ChubCreator[] = []
  // Paged until the reported count is reached, capped the way the old UI capped
  // it so a bad `count` cannot spin forever.
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchWithProxy(
      `${CHUB_API_BASE}/api/follows/${encodeURIComponent(username)}?page=${page}`,
      { headers: chubHeaders(auth) },
    )
    if (response.status === 401 || response.status === 403)
      throw new ChubAuthRequired()
    if (!response.ok) break
    const data = (await response.json()) as Record<string, unknown>
    const rows = (data.follows ?? data.nodes ?? data.data ?? []) as Record<
      string,
      unknown
    >[]
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const name = (row.user_name ?? row.username ?? row.name) as
        string | undefined
      if (!name) continue
      creators.push({
        id: String(row.id ?? name),
        name: (row.display_name as string) || name,
        username: name,
        avatar: row.avatar_url as string | undefined,
      })
    }
    const total = Number(data.count ?? 0)
    if (total && creators.length >= total) break
  }
  return creators
}

/**
 * The timeline carries whatever a followed author published -- lorebooks and
 * posts included. Only characters belong in Discover's grid, and they are told
 * apart the way `chub-browse.js:1849-1878` told them apart: by path prefix,
 * plus the presence of at least one character-only field for rows whose
 * `fullPath` is unhelpful.
 */
function isCharacterNode(node: ChubNode): boolean {
  const path = (node.fullPath ?? (node.full_path as string) ?? '').toLowerCase()
  if (path.startsWith('lorebooks/') || path.startsWith('posts/')) return false
  if (Array.isArray(node.entries)) return false
  return (
    path.includes('/') ||
    node.tagline !== undefined ||
    node.definition !== undefined ||
    node.first_mes !== undefined ||
    node.topics !== undefined
  )
}

/**
 * The "new from followed authors" feed.
 *
 * Page-numbered, despite the `cursor`/`previous_cursor` fields in its envelope:
 * verified live 2026-08-19, `/api/timeline/v1` answers `cursor: null` on every
 * page, ignores `first` (20 rows per page, always) and honours `page`. Reading
 * that null cursor as "no more pages" is what capped Following at a single page
 * of 20 cards. `count` is no help either -- it reports the feed total on page 1
 * and the page's own row count from page 2 on -- so the end of the feed is a
 * page that comes back empty.
 */
export async function fetchChubTimeline(opts: {
  auth: ChubAuth
  page?: number
}): Promise<{ nodes: ChubNode[]; hasMore: boolean }> {
  const { auth, page = 1 } = opts
  if (!auth.token) throw new ChubAuthRequired()
  const params = new URLSearchParams({
    first: '50',
    page: String(page),
    count: 'true',
    ...nsfwParams(auth),
  })

  const response = await fetchWithProxy(
    `${CHUB_API_BASE}/api/timeline/v1?${params}`,
    { headers: chubHeaders(auth) },
  )
  if (response.status === 401 || response.status === 403)
    throw new ChubAuthRequired()
  if (!response.ok)
    throw new Error(`Chub timeline failed: HTTP ${response.status}`)
  const data = (await response.json()) as Record<string, unknown>
  const nodes = extractNodes(data)
  // `hasMore` keys off the unfiltered page: a page that is all lorebooks is
  // still a page, and must not end the feed.
  return { nodes: nodes.filter(isCharacterNode), hasMore: nodes.length > 0 }
}

// ---- Tag catalogue ---------------------------------------------------------

/**
 * Chub publishes no tag catalogue, so the old UI built one by tallying `topics`
 * across a few hundred popular cards (`chub-browse.js:1262-1380`). Same idea
 * here, deliberately cheap: four sorts, one page each, counted and ranked.
 *
 * This is a *suggestion* list for the filter popover, not an authority -- trap
 * 1 in `shared.ts` means any given card's tags may be truncated, so a tag being
 * absent here does not mean no card carries it. The popover's own search box
 * lets a known tag be typed in regardless.
 */
export async function fetchChubPopularTags(auth?: ChubAuth): Promise<string[]> {
  const sorts: ChubSort[] = ['trending', 'download_count', 'id']
  const counts = new Map<string, { label: string; n: number }>()
  const pages = await Promise.all(
    sorts.map((sort) =>
      searchChub({ sort, page: 1, auth }).catch(() => ({
        nodes: [] as ChubNode[],
        hasMore: false,
      })),
    ),
  )
  for (const { nodes } of pages) {
    for (const node of nodes) {
      for (const topic of node.topics ?? []) {
        if (!topic) continue
        const key = topic.toLowerCase()
        const seen = counts.get(key)
        if (seen) seen.n += 1
        else counts.set(key, { label: topic, n: 1 })
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 600)
    .map((entry) => entry.label)
}
