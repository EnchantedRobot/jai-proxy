/**
 * Salvage item 5 (docs/UI_REWRITE_PLAN.md §1.3) -- provider request shapes as
 * knowledge, transcribed rather than moved: the direct-fetch-then-`/proxy/`-
 * fallback pattern from `web/modules/providers/provider-utils.js`, at the
 * fidelity Discover actually needs (not the full extractor/session stack
 * `web/` carries for import-time enrichment).
 *
 * Salvage item 6 -- the two tag-filter traps. These were comments *about*
 * absent code until Stage 6B; they are now the rules `matchesTagFilters` below
 * follows:
 *
 *   1. Both providers truncate the per-card tag list in *list* payloads (Chub
 *      caps at 15, DataCat's summary rows carry fewer than the detail read
 *      does). A tag chip built from a search page's own results will miss
 *      cards whose matching tag got truncated off the row. This is why an
 *      include filter is allowed to *thin* a page rather than being treated as
 *      an authoritative "no results", and why the caller auto-fetches more
 *      pages instead of concluding the archive has nothing.
 *   2. Tag include/exclude is never sent as a server query param to either
 *      provider -- Chub's `topics`/`excludetopics` and DataCat's `tagIds` both
 *      have unreliable server-side matching (see
 *      `feedback_tag_filters_local_only` in project memory). Filtering runs
 *      client-side over what the main query already fetched, exactly as the old
 *      UI's `charMatchesChubTagFilters` did.
 */

// encodeURIComponent leaves !'()* literal; strict reverse proxies/WAFs 403
// literal parens, so escape them for /proxy/.
export function proxyEncode(url: string): string {
  return encodeURIComponent(url).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * Try a provider's CORS-open API directly; fall back to the server's
 * `/proxy/{url}` passthrough when the browser itself refuses the request
 * (CORS, DNS, a provider that doesn't send the header). An HTTP error from a
 * direct fetch is a real answer, not a proxy trigger -- only a thrown
 * `fetch()` counts.
 */
export async function fetchWithProxy(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch {
    return fetch(`/proxy/${proxyEncode(url)}`, init)
  }
}

// ---- Tag filtering (client-side only -- see trap 2 above) -------------------

/**
 * Reduce a provider tag to the key two spellings of the same tag share.
 *
 * Creators decorate tags freely: `#Female`, `👩 female`, `Female `, `f e m a l e`
 * is not the same tag but the first three are. Ported from the old UI's
 * `tagMatchKey` (`web/modules/providers/chub/chub-browse.js:2188-2214`) -- strip
 * leading hashes and non-letter decoration, collapse whitespace, casefold.
 */
export function tagMatchKey(tag: string): string {
  return (
    tag
      .normalize('NFKD')
      // Emoji, pictographs and variation selectors used as bullets.
      .replace(/[\p{Extended_Pictographic}️‍]/gu, ' ')
      .replace(/^[#\s]+/, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  )
}

export interface TagFilters {
  /** Every one of these must be present. */
  include: string[]
  /** Any one of these rejects the card. */
  exclude: string[]
}

export const NO_TAG_FILTERS: TagFilters = { include: [], exclude: [] }

export function hasTagFilters(filters: TagFilters): boolean {
  return filters.include.length > 0 || filters.exclude.length > 0
}

/**
 * Include = *all* must match, exclude = *any* rejects.
 *
 * The asymmetry is deliberate and matches the old UI: narrowing by two tags
 * means "both", while an exclusion list is a set of things you never want to
 * see, so one hit is enough to drop the card.
 */
export function matchesTagFilters(
  tags: readonly string[] | undefined,
  filters: TagFilters,
): boolean {
  if (!hasTagFilters(filters)) return true
  const keys = new Set((tags ?? []).map(tagMatchKey))
  for (const tag of filters.exclude) {
    if (keys.has(tagMatchKey(tag))) return false
  }
  for (const tag of filters.include) {
    if (!keys.has(tagMatchKey(tag))) return false
  }
  return true
}

/**
 * Fold a provider's persistent `providerExcludeTags` entry into the session's
 * chips. The stored list is an always-on floor: chips narrow further, they
 * never re-admit something the standing exclusion rejects.
 */
export function withPersistentExcludes(
  filters: TagFilters,
  persistent: readonly string[] | undefined,
): TagFilters {
  if (!persistent?.length) return filters
  return { ...filters, exclude: [...filters.exclude, ...persistent] }
}
