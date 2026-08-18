import type { components } from './api-schema'

export type Card = components['schemas']['CardOut']

/**
 * The browse state, and its round trip through the URL.
 *
 * It lives in the query string rather than in React state on purpose: every
 * filtered view is then a link — shareable, bookmarkable, and restored by the
 * back button — which is the thing the old UI could not do (docs/UI_REWRITE_PLAN.md
 * §2.5). Nothing else holds a copy, so there is no state to keep in sync.
 */

/** A chip that is on or off. The tag chips are separate — they have three states. */
export type Flag = 'fav' | 'lore' | 'greets' | 'new' | 'untagged'

/** Click a tag once to require it, again to exclude it, again to drop it. */
export type TagMode = 'inc' | 'exc'

export type Scope = 'all' | 'name' | 'creator' | 'tags'

export interface BrowseState {
  q: string
  scope: Scope
  sort: string
  flags: Set<Flag>
  tags: Map<string, TagMode>
}

export const FLAG_LABELS: Record<Flag, string> = {
  fav: 'Favorites',
  lore: 'Has a lorebook',
  greets: 'Multiple greetings',
  new: 'Added this week',
  untagged: 'Untagged',
}

/** The chips the strip always shows, in the mock's order. */
export const PRESET_FLAGS: Flag[] = ['fav', 'lore', 'greets', 'new']

export const SORTS: { value: string; label: string; hint?: string }[] = [
  { value: 'name', label: 'Name', hint: 'A→Z' },
  { value: '-added', label: 'Recently added' },
  { value: '-lore', label: 'Lore entries' },
  { value: '-greetings', label: 'Greetings' },
  { value: '-description', label: 'Description length' },
  { value: 'creator', label: 'Creator' },
]

export function sortLabel(sort: string): string {
  const bare = sort.replace(/^-/, '')
  const match = SORTS.find((s) => s.value.replace(/^-/, '') === bare)
  return match ? match.label : sort
}

/** Whether `sort` runs against its option's natural direction. */
export function isReversed(sort: string, option: string): boolean {
  return sort.startsWith('-') !== option.startsWith('-')
}

export function readState(params: URLSearchParams): BrowseState {
  const flags = new Set<Flag>()
  for (const flag of params.getAll('flag')) {
    if (flag in FLAG_LABELS) flags.add(flag as Flag)
  }
  const tags = new Map<string, TagMode>()
  for (const tag of params.getAll('tag')) tags.set(tag, 'inc')
  for (const tag of params.getAll('xtag')) tags.set(tag, 'exc')
  const scope = params.get('scope')
  return {
    q: params.get('q') ?? '',
    scope: (['name', 'creator', 'tags'] as string[]).includes(scope ?? '')
      ? (scope as Scope)
      : 'all',
    sort: params.get('sort') ?? 'name',
    flags,
    tags,
  }
}

export function writeState(state: BrowseState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.q) params.set('q', state.q)
  if (state.scope !== 'all') params.set('scope', state.scope)
  if (state.sort !== 'name') params.set('sort', state.sort)
  for (const flag of state.flags) params.append('flag', flag)
  for (const [tag, mode] of state.tags) {
    params.append(mode === 'inc' ? 'tag' : 'xtag', tag)
  }
  return params
}

export function isFiltered(state: BrowseState): boolean {
  return state.flags.size > 0 || state.tags.size > 0 || state.q !== ''
}

/**
 * The start of "this week", as the `added_after` chip means it: midnight seven
 * days ago, local time.
 *
 * Rounded to the day rather than computed as `now - 7d` so that the value is
 * stable across renders — it is part of a TanStack Query key, and a timestamp
 * that moves every millisecond would refetch the grid on every render.
 */
export function weekAgo(now = new Date()): string {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 6)
  return start.toISOString()
}

/** The browse state as `GET /api/v1/characters` takes it. */
export function toQuery(state: BrowseState) {
  const include: string[] = []
  const exclude: string[] = []
  for (const [tag, mode] of state.tags) {
    ;(mode === 'inc' ? include : exclude).push(tag)
  }
  return {
    ...(state.q ? { q: state.q, scope: state.scope } : {}),
    sort: state.sort,
    ...(include.length ? { tag: include } : {}),
    ...(exclude.length ? { exclude_tag: exclude } : {}),
    ...(state.flags.has('fav') ? { favorite: true } : {}),
    ...(state.flags.has('lore') ? { has_lorebook: true } : {}),
    ...(state.flags.has('greets') ? { min_greetings: 2 } : {}),
    ...(state.flags.has('untagged') ? { untagged: true } : {}),
    ...(state.flags.has('new') ? { added_after: weekAgo() } : {}),
  }
}
