import { describe, expect, it } from 'vitest'
import {
  isFiltered,
  readState,
  sortLabel,
  tileSearch,
  toQuery,
  weekAgo,
  writeState,
  type BrowseState,
} from './browse'

function state(overrides: Partial<BrowseState> = {}): BrowseState {
  return {
    q: '',
    scope: 'all',
    sort: 'name',
    flags: new Set(),
    tags: new Map(),
    ...overrides,
  }
}

describe('the browse state in the URL', () => {
  it('round-trips through the query string', () => {
    const original = state({
      q: 'abbie',
      scope: 'creator',
      sort: '-added',
      flags: new Set(['fav', 'lore']),
      tags: new Map([
        ['Female', 'inc'],
        ['NSFW', 'exc'],
      ] as const),
    })

    const parsed = readState(writeState(original))

    expect(parsed).toEqual(original)
  })

  it('leaves the defaults out of the URL', () => {
    expect(writeState(state()).toString()).toBe('')
  })

  it('writes a sort down whenever it is not the stored default', () => {
    // The bug this pins: with "Recently added" saved as the default sort,
    // picking "Name" wrote nothing to the URL, so the page read an empty URL
    // and re-applied the default over the top -- the click did nothing at all.
    expect(writeState(state({ sort: 'name' }), '-added').get('sort')).toBe(
      'name',
    )
    expect(writeState(state({ sort: '-added' }), '-added').get('sort')).toBe(
      null,
    )
    expect(writeState(state({ sort: '-lore' }), '-added').get('sort')).toBe(
      '-lore',
    )
  })

  it('ignores a flag or scope it does not recognise', () => {
    // The query string is user-editable and survives across deploys, so a stale
    // or hand-typed value has to degrade to the default rather than filter on
    // something the server will reject.
    const parsed = readState(new URLSearchParams('flag=telepathy&scope=vibes'))

    expect(parsed.flags.size).toBe(0)
    expect(parsed.scope).toBe('all')
  })
})

describe('the querystring a tile carries to the detail page', () => {
  // The detail page rebuilds the browse set from this string alone, to walk
  // prev/next through it. Anything the browse URL is allowed to omit has to be
  // spelled out here, or the page rebuilds a *different* set, fails to find the
  // card in it, and silently shows no pager and dead J/K keys.
  it('always names the sort, even when the URL may omit it', () => {
    const params = new URLSearchParams(tileSearch(state({ sort: 'name' })))

    expect(params.get('sort')).toBe('name')
  })

  it("carries the route's pinned favourites flag", () => {
    // /favorites pins the filter on the route, not in the URL.
    const params = new URLSearchParams(
      tileSearch(state({ flags: new Set(['fav']), sort: '-added' })),
    )

    expect(params.getAll('flag')).toEqual(['fav'])
    expect(params.get('sort')).toBe('-added')
  })

  it('round-trips back into the same state the grid was showing', () => {
    const grid = state({
      q: 'elf',
      scope: 'name',
      sort: '-lore',
      flags: new Set(['lore']),
      tags: new Map([['Female', 'inc']] as const),
    })

    expect(readState(new URLSearchParams(tileSearch(grid)))).toEqual(grid)
  })
})

describe('the API query it builds', () => {
  it('splits tags into include and exclude', () => {
    const query = toQuery(
      state({
        tags: new Map([
          ['Female', 'inc'],
          ['Vampire', 'inc'],
          ['NSFW', 'exc'],
        ] as const),
      }),
    )

    expect(query.tag).toEqual(['Female', 'Vampire'])
    expect(query.exclude_tag).toEqual(['NSFW'])
  })

  it('maps each chip to the parameter that answers it', () => {
    const query = toQuery(
      state({ flags: new Set(['fav', 'lore', 'greets', 'untagged', 'media']) }),
    )

    expect(query).toMatchObject({
      favorite: true,
      has_lorebook: true,
      min_greetings: 2,
      untagged: true,
      needs_media: true,
    })
  })

  it('sends no search parameters at all when the box is empty', () => {
    // `scope` alone would be a filter on nothing, and it would change the query
    // key, so an empty search would refetch the grid every time the scope moved.
    expect(toQuery(state({ scope: 'name' }))).not.toHaveProperty('scope')
    expect(toQuery(state({ q: 'x', scope: 'name' }))).toMatchObject({
      q: 'x',
      scope: 'name',
    })
  })

  it('rounds "added this week" to a day boundary', () => {
    // It is part of a query key: a value derived from `Date.now()` directly
    // would differ on every render and refetch the whole grid each time.
    const morning = weekAgo(new Date('2026-08-18T09:15:00'))
    const evening = weekAgo(new Date('2026-08-18T23:59:00'))

    expect(morning).toBe(evening)
    expect(new Date(morning).getHours()).toBe(0)
  })
})

describe('helpers', () => {
  it('knows when anything is filtering', () => {
    expect(isFiltered(state())).toBe(false)
    expect(isFiltered(state({ q: 'abbie' }))).toBe(true)
    expect(isFiltered(state({ flags: new Set(['fav']) }))).toBe(true)
  })

  it('names a sort the way the button does, in either direction', () => {
    expect(sortLabel('-added')).toBe('Recently added')
    expect(sortLabel('added')).toBe('Recently added')
  })
})
