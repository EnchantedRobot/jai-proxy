import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { server } from '@/test/msw-server'
import { scrollSentinelIntoView } from '@/test/observers'
import { card, renderApp } from '@/test/render'
import { CharactersPage } from './CharactersPage'

/** Records what the grid actually asked the archive for. */
function listHandler(onQuery?: (url: URL) => void) {
  return http.get('*/api/v1/characters', ({ request }) => {
    const url = new URL(request.url)
    onQuery?.(url)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return HttpResponse.json({
      total: 2,
      limit: 100,
      offset,
      items: [
        card({ id: 'a.png', name: 'Abbie' }),
        card({ id: 'b.png', name: 'Bella', creator: 'Someone Else' }),
      ],
    })
  })
}

/** The offsets the grid asked for, in order -- the shelf's own query has none. */
function pageOffsets(queries: URL[]): (string | null)[] {
  return queries
    .map((url) => url.searchParams.get('offset'))
    .filter((offset) => offset !== null)
}

const stats = http.get('*/api/v1/stats', () =>
  HttpResponse.json({
    cards: 3868,
    unreadable: 0,
    bytes: 0,
    creators: 1,
    tags: 1,
    galleries: 0,
    archive_dir: '/tmp',
    thumbs: { cached: 0, missing: 0, stale: 0 },
    index: { scanned: 0, parsed: 0, unchanged: 0, removed: 0, seconds: 0 },
  }),
)

const facets = http.get('*/api/v1/facets', () =>
  HttpResponse.json({
    tags: [
      { value: 'Female', count: 3808 },
      { value: 'NSFW', count: 1726 },
    ],
    creators: [],
    sources: [],
  }),
)

describe('CharactersPage', () => {
  it('lists the archive and says how much of it is showing', async () => {
    server.use(listHandler(), stats, facets)

    renderApp(<CharactersPage />)

    expect(await screen.findByText('Abbie')).toBeInTheDocument()
    expect(await screen.findByText('2 shown of 3,868')).toBeInTheDocument()
  })

  it('sends a chip as the filter it stands for', async () => {
    const queries: URL[] = []
    server.use(
      listHandler((url) => queries.push(url)),
      stats,
      facets,
    )

    renderApp(<CharactersPage />)
    await screen.findByText('Abbie')
    await userEvent.click(
      screen.getByRole('button', { name: 'Has a lorebook' }),
    )

    await waitFor(() => {
      const last = queries.at(-1)!
      expect(last.searchParams.get('has_lorebook')).toBe('true')
    })
  })

  it('pins the favourites filter on its own route', async () => {
    const queries: URL[] = []
    server.use(
      listHandler((url) => queries.push(url)),
      stats,
      facets,
    )

    renderApp(<CharactersPage favorites />, { route: '/favorites' })

    expect(await screen.findByText('Favorites')).toBeInTheDocument()
    await waitFor(() =>
      expect(queries.at(-1)!.searchParams.get('favorite')).toBe('true'),
    )
  })

  it('fetches the next page when the sentinel scrolls into view', async () => {
    const queries: URL[] = []
    server.use(
      http.get('*/api/v1/characters', ({ request }) => {
        const url = new URL(request.url)
        queries.push(url)
        const offset = Number(url.searchParams.get('offset') ?? 0)
        return HttpResponse.json({
          total: 250,
          limit: 100,
          offset,
          items: Array.from({ length: 100 }, (_, i) =>
            card({ id: `${offset + i}.png`, name: `Card ${offset + i}` }),
          ),
        })
      }),
      stats,
      facets,
    )

    renderApp(<CharactersPage />)
    await screen.findByText('Card 0')
    // The first page and nothing more: paging is driven by the viewport, not
    // by mounting the grid.
    expect(pageOffsets(queries)).toEqual(['0'])

    scrollSentinelIntoView()

    expect(await screen.findByText('Card 100')).toBeInTheDocument()
    await waitFor(() => expect(pageOffsets(queries)).toEqual(['0', '100']))
  })

  it('stops paging at the end of the filtered set', async () => {
    const queries: URL[] = []
    server.use(
      listHandler((url) => queries.push(url)),
      stats,
      facets,
    )

    renderApp(<CharactersPage />)
    await screen.findByText('Abbie')

    // Two cards, a total of two: there is no next page, so a sentinel that
    // scrolls into view must not ask for one.
    scrollSentinelIntoView()

    await waitFor(() => expect(pageOffsets(queries)).toEqual(['0']))
  })

  it('says so plainly when nothing matches', async () => {
    server.use(
      http.get('*/api/v1/characters', () =>
        HttpResponse.json({ total: 0, limit: 100, offset: 0, items: [] }),
      ),
      stats,
      facets,
    )

    renderApp(<CharactersPage />)

    expect(
      await screen.findByText('Nothing matches those filters.'),
    ).toBeInTheDocument()
  })

  it('surfaces a failed read rather than showing an empty archive', async () => {
    server.use(
      http.get(
        '*/api/v1/characters',
        () => new HttpResponse(null, { status: 500 }),
      ),
      stats,
      facets,
    )

    renderApp(<CharactersPage />)

    expect(
      await screen.findByText(/could not list the archive/),
    ).toBeInTheDocument()
  })
})
