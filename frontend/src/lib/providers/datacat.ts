/**
 * DataCat (datacat.run) browse + fetch, at Discover's mock fidelity -- salvage
 * item 5. Ported from `web/modules/providers/datacat/datacat-api.js`'s
 * network/browse/card-builder sections; the JanitorAI Supabase auth flow
 * (page-2+ Hampter unlock), MeiliSearch, and script hydration are deliberately
 * left out -- none of them are needed to browse and add a card, and the plan's
 * §3.8 scope is "goes through the existing dc-init / dc-proxy / dc-extract
 * session routes", not the whole legacy provider.
 */

import { apiClient } from '@/lib/api-client'

export const DATACAT_JANITOR_IMAGE_BASE =
  'https://ella.janitorai.com/bot-avatars/'

// Matches DataCat's own frontend default quality floor.
export const MIN_TOTAL_TOKENS = 889

export interface DatacatCharacter {
  character_id?: string
  characterId?: string
  chat_name?: string
  chatName?: string
  name?: string
  avatar?: string
  tags?: (string | { name?: string; slug?: string })[]
  creator_name?: string
  creatorName?: string
  primary_content_source_kind?: string | null
  [key: string]: unknown
}

let bootstrap: Promise<boolean> | null = null
let warmed = false
let savedToken: string | null = null

/**
 * Hand the module the token persisted in settings (Stage 6B).
 *
 * The server keeps its session in process memory only, so after a restart it
 * holds nothing and `dc-init` would mint a brand-new anonymous identity --
 * discarding the one the user saved. Publishing the saved token here lets
 * `bootstrapSession` restore it *first* and only identify fresh if it is dead.
 */
export function setSavedDatacatToken(token: string | null | undefined): void {
  const next = token ?? null
  if (next === savedToken) return
  savedToken = next
  // A different token invalidates whatever the server currently holds.
  warmed = false
}

/** `dc-init`, shared across concurrent callers and re-armed after it settles
 * so a later 401 can trigger a fresh attempt -- same shape as the JS
 * `tryBootstrapSession`'s in-flight promise. A saved token is offered to the
 * server before falling back to a fresh anonymous identify. */
function bootstrapSession(): Promise<boolean> {
  if (!bootstrap) {
    bootstrap = (async () => {
      if (savedToken) {
        try {
          if (await datacatAdoptSavedToken(savedToken)) return true
        } catch {
          // fall through to a fresh identify
        }
      }
      const { data } = await apiClient.POST('/api/v1/datacat/dc-init', {
        body: { force: false },
      })
      return Boolean((data as { ok?: boolean } | undefined)?.ok)
    })()
      .catch(() => false)
      .finally(() => {
        bootstrap = null
      })
  }
  return bootstrap
}

/** One authenticated GET through the server's dc-proxy. The server holds no
 * session until the first `dc-init`, so the very first call of a page load
 * would otherwise always 401 -- `warmed` bootstraps once, proactively,
 * before the first request rather than reactively after a guaranteed miss.
 * A *later* 401 (the held token expired) still bootstraps again and retries
 * once. `path` is the full datacat.run API path, query string included
 * (e.g. `/api/characters/recent-public?limit=48`). */
async function dcFetch(path: string): Promise<Response> {
  if (!warmed) warmed = await bootstrapSession()
  let response = await fetch(`/api/v1/datacat/dc-proxy${path}`)
  if (response.status === 401 || response.status === 403) {
    warmed = await bootstrapSession()
    if (warmed) {
      response = await fetch(`/api/v1/datacat/dc-proxy${path}`)
    }
  }
  return response
}

export async function searchDatacat(opts: {
  search?: string
  limit?: number
  offset?: number
}): Promise<{ totalCount: number; characters: DatacatCharacter[] }> {
  const { search = '', limit = 48, offset = 0 } = opts
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    summary: '1',
    minTotalTokens: String(MIN_TOTAL_TOKENS),
  })
  if (search) params.set('search', search)

  const response = await dcFetch(`/api/characters/recent-public?${params}`)
  if (!response.ok)
    throw new Error(`DataCat search failed: HTTP ${response.status}`)
  const data = await response.json()
  return { totalCount: data.totalCount ?? 0, characters: data.characters ?? [] }
}

export function datacatAvatarUrl(hit: DatacatCharacter): string {
  const avatar = hit.avatar
  if (!avatar || typeof avatar !== 'string') return ''
  return /^https?:\/\//i.test(avatar)
    ? avatar
    : `${DATACAT_JANITOR_IMAGE_BASE}${avatar}`
}

export function datacatCharacterId(hit: DatacatCharacter): string {
  return hit.character_id ?? hit.characterId ?? ''
}

export function datacatName(hit: DatacatCharacter): string {
  return hit.chat_name ?? hit.chatName ?? hit.name ?? 'Unknown'
}

export function datacatCreatorName(hit: DatacatCharacter): string {
  return hit.creator_name ?? hit.creatorName ?? ''
}

export function resolveDatacatTagNames(
  tags: DatacatCharacter['tags'],
): string[] {
  if (!Array.isArray(tags)) return []
  return tags
    .map((t) =>
      typeof t === 'string' ? t.trim() : (t?.name ?? t?.slug ?? '').trim(),
    )
    .filter(Boolean)
}

/** The full detail payload `POST /build-datacat` needs. */
export async function fetchDatacatDetail(
  id: string,
  sourceKind?: string | null,
): Promise<DatacatCharacter | null> {
  const qs = sourceKind ? `?sourceKind=${encodeURIComponent(sourceKind)}` : ''
  const response = await dcFetch(`/api/characters/${id}${qs}`)
  if (!response.ok) return null
  const data = await response.json()
  return data.character ?? null
}

/** Often fills in fields the detail payload leaves empty (repaired Saucepan
 * cards); `/build-datacat` prefers it when present. */
export async function fetchDatacatDownload(
  id: string,
  sourceKind?: string | null,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ t: String(Date.now()) })
  if (sourceKind) params.set('sourceKind', sourceKind)
  const response = await dcFetch(`/api/characters/${id}/download?${params}`)
  if (!response.ok) return null
  return response.json()
}

// ---- Session token lifecycle (Stage 6B B3) ---------------------------------

/**
 * The anonymous session token, made visible and controllable.
 *
 * `DatacatSession` holds it in process memory only
 * (`proxy/sources/datacat_client.py:239-244`), so before Stage 6B a server
 * restart silently minted a brand-new anonymous identity and there was no way
 * to see, refresh, or clear it. These four wrap the server routes that already
 * existed and were called by nothing; the caller persists the token to the
 * settings blob as `datacatToken` so it survives a restart, exactly as the old
 * UI did (`web/modules/providers/datacat/datacat-api.js:175-229`).
 */
export interface DatacatSessionState {
  valid: boolean
  /** Why not, when invalid -- shown verbatim in Settings so a dead token is
   *  diagnosable rather than just "off". */
  reason?: string
  totalCount?: number
}

/** NOTE: `dc-validate` answers `{valid, reason}`, *not* the `{ok}` every other
 *  route in this group uses (`proxy/sources/datacat_client.py:295-311`). */
export async function datacatValidate(): Promise<DatacatSessionState> {
  const { data } = await apiClient.GET('/api/v1/datacat/dc-validate', {})
  // The route is typed as a bare JSON object, so this narrows rather than
  // asserts -- via `unknown`, since the two shapes do not overlap structurally.
  const record = (data ?? {}) as unknown as Partial<DatacatSessionState>
  return {
    valid: Boolean(record.valid),
    reason: record.reason,
    totalCount: record.totalCount,
  }
}

/** Restore a previously saved token into the server's in-memory session. */
export async function datacatSetToken(token: string): Promise<boolean> {
  const { data } = await apiClient.POST('/api/v1/datacat/dc-set-token', {
    body: { token },
  })
  const ok = Boolean((data as { ok?: boolean } | undefined)?.ok)
  if (ok) warmed = true
  return ok
}

/** Mint a fresh anonymous identity (`force`), returning the new token so the
 *  caller can persist it. */
export async function datacatRefreshToken(): Promise<string | null> {
  const { data } = await apiClient.POST('/api/v1/datacat/dc-init', {
    body: { force: true },
  })
  const record = data as { ok?: boolean; token?: string } | undefined
  warmed = Boolean(record?.ok)
  return record?.token ?? null
}

export async function datacatClearToken(): Promise<void> {
  await apiClient.POST('/api/v1/datacat/dc-clear-token', {})
  warmed = false
}

/**
 * Adopt a token saved in settings, once per page load, before anything else
 * dials DataCat. Without this the server's warm-start mints a *new* anonymous
 * session on every restart and the saved one is dead weight.
 */
export async function datacatAdoptSavedToken(
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) return false
  if (!(await datacatSetToken(token))) return false
  return (await datacatValidate()).valid
}

// ---- Following (Stage 6B B4) -----------------------------------------------

/**
 * DataCat has no account and no server-side follow list -- the followed-creator
 * list is purely local settings data (`datacatFollowedCreators`). That makes
 * this list *the* feature rather than a cache of one, which is why follow and
 * unfollow are built here in full while Chub's are deliberately not.
 */
export interface DatacatCreator {
  id: string
  name: string
  avatar?: string
  characterCount?: number
}

export async function fetchDatacatCreator(
  id: string,
): Promise<DatacatCreator | null> {
  const response = await dcFetch(`/api/creators/${encodeURIComponent(id)}`)
  if (!response.ok) return null
  const data = await response.json()
  const creator = (data.creator ?? data) as Record<string, unknown>
  const name = (creator.name ?? creator.creator_name) as string | undefined
  if (!name) return null
  return {
    id: String(creator.id ?? creator.creator_id ?? id),
    name,
    avatar: creator.avatar as string | undefined,
    characterCount: Number(creator.character_count ?? 0) || undefined,
  }
}

export async function fetchDatacatCreatorCharacters(opts: {
  creatorId: string
  limit?: number
  offset?: number
  sortBy?: string
}): Promise<{ totalCount: number; characters: DatacatCharacter[] }> {
  const { creatorId, limit = 48, offset = 0, sortBy = 'recent' } = opts
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortBy,
  })
  const response = await dcFetch(
    `/api/creators/${encodeURIComponent(creatorId)}/characters?${params}`,
  )
  if (!response.ok)
    throw new Error(`DataCat creator fetch failed: HTTP ${response.status}`)
  const data = await response.json()
  return { totalCount: data.totalCount ?? 0, characters: data.characters ?? [] }
}

// ---- Tag catalogue ---------------------------------------------------------

export interface DatacatTag {
  id: string
  name: string
  count?: number
}

/**
 * DataCat's faceted tag catalogue -- a real published catalogue, unlike Chub's,
 * so no tallying is needed (`datacat-api.js:499-512`). Already allow-listed
 * server-side at `proxy/sources/datacat_client.py:227` and, until Stage 6B,
 * called by nothing.
 *
 * As with Chub, the result feeds the filter popover only; matching itself is
 * client-side and `tagIds` is never sent as a query param (trap 2).
 */
export async function fetchDatacatTags(): Promise<DatacatTag[]> {
  const params = new URLSearchParams({
    mode: 'recent',
    minTotalTokens: String(MIN_TOTAL_TOKENS),
  })
  const response = await dcFetch(`/api/tags/faceted?${params}`)
  if (!response.ok) return []
  const data = await response.json()
  const rows = (data.tags ?? []) as Record<string, unknown>[]
  return rows
    .map((row) => ({
      id: String(row.id ?? row.slug ?? row.name ?? ''),
      name: String(row.name ?? row.slug ?? ''),
      count: Number(row.count ?? row.total ?? 0) || undefined,
    }))
    .filter((tag) => tag.name)
}
