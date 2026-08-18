import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { server } from '@/test/msw-server'
import { card, renderApp } from '@/test/render'
import { RecentShelf } from './RecentShelf'

describe('RecentShelf', () => {
  it('asks for exactly one row of the newest cards', async () => {
    const queries: URL[] = []
    server.use(
      http.get('*/api/v1/characters', ({ request }) => {
        queries.push(new URL(request.url))
        return HttpResponse.json({
          total: 3868,
          limit: 7,
          offset: 0,
          items: [card({ name: 'Newest' })],
        })
      }),
    )

    renderApp(<RecentShelf columns={7} onHide={() => {}} />)

    expect(await screen.findByText('Newest')).toBeInTheDocument()
    await waitFor(() => {
      expect(queries[0].searchParams.get('limit')).toBe('7')
      expect(queries[0].searchParams.get('sort')).toBe('-added')
    })
  })

  it('badges only the cards that really did arrive this week', async () => {
    server.use(
      http.get('*/api/v1/characters', () =>
        HttpResponse.json({
          total: 2,
          limit: 2,
          offset: 0,
          items: [
            card({
              id: 'fresh.png',
              name: 'Fresh',
              linked_at: new Date().toISOString(),
            }),
            card({
              id: 'stale.png',
              name: 'Stale',
              linked_at: '2020-01-01T00:00:00Z',
            }),
          ],
        }),
      ),
    )

    renderApp(<RecentShelf columns={2} onHide={() => {}} />)

    await screen.findByText('Fresh')
    // The shelf shows the newest cards whether or not the archive has been busy
    // -- the badge is a claim about dates, so it is checked against them.
    expect(screen.getAllByText('new')).toHaveLength(1)
  })

  it('fetches nothing until the grid has been measured', () => {
    // Columns is 0 on the first render, before the grid exists to measure. A
    // `limit=0` request would mean "the whole archive" to this API -- 3,868
    // cards for a shelf that holds seven.
    renderApp(<RecentShelf columns={0} onHide={() => {}} />)

    expect(screen.queryByText('Recently added')).toBeNull()
  })
})
