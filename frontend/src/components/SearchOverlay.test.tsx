import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { server } from '@/test/msw-server'
import { card, renderApp } from '@/test/render'
import { SearchOverlay } from './SearchOverlay'

function results(onQuery: (url: URL) => void) {
  return http.get('*/api/v1/characters', ({ request }) => {
    onQuery(new URL(request.url))
    return HttpResponse.json({
      total: 1,
      limit: 60,
      offset: 0,
      items: [card({ name: 'Abbie' })],
    })
  })
}

describe('SearchOverlay', () => {
  it('shows recently added before anything is typed', async () => {
    const queries: URL[] = []
    server.use(results((url) => queries.push(url)))

    renderApp(<SearchOverlay open onOpenChange={() => {}} />)

    expect(await screen.findByText('Abbie')).toBeInTheDocument()
    expect(await screen.findByText('recently added')).toBeInTheDocument()
    expect(queries[0].searchParams.get('sort')).toBe('-added')
    expect(queries[0].searchParams.get('q')).toBeNull()
  })

  it('sends the chosen scope with the query', async () => {
    const queries: URL[] = []
    server.use(results((url) => queries.push(url)))

    renderApp(<SearchOverlay open onOpenChange={() => {}} />)
    await screen.findByText('Abbie')
    await userEvent.click(screen.getByRole('button', { name: 'Creator' }))
    await userEvent.type(screen.getByLabelText('Search query'), 'korny')

    await waitFor(() => {
      const last = queries.at(-1)!
      expect(last.searchParams.get('q')).toBe('korny')
      expect(last.searchParams.get('scope')).toBe('creator')
    })
  })

  it('does not offer a Description scope', () => {
    // Cut deliberately: the index holds no prose, so the chip could only be
    // answered by reading every card on every keystroke
    // (docs/UI_REWRITE_PLAN.md §3.9).
    server.use(results(() => {}))

    renderApp(<SearchOverlay open onOpenChange={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Description' })).toBeNull()
  })

  it('reports the size of the whole match, not the page it shows', async () => {
    server.use(
      http.get('*/api/v1/characters', () =>
        HttpResponse.json({
          total: 412,
          limit: 60,
          offset: 0,
          items: [card()],
        }),
      ),
    )

    renderApp(<SearchOverlay open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText('Search query'), 'a')

    expect(await screen.findByText('412 matches')).toBeInTheDocument()
  })
})
