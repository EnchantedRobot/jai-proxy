import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { server } from '@/test/msw-server'
import { card, renderApp } from '@/test/render'
import { Route, Routes } from 'react-router'
import { CharacterDetailPage } from './CharacterDetailPage'
import { Toaster } from '@/components/ui/Toaster'

/** The detail page needs a matched route for useParams to see :id. The Toaster
 *  rides along so write feedback (Saved, stale-write) is assertable. */
function renderDetail(route: string) {
  return renderApp(
    <>
      <Routes>
        <Route path="/characters/:id" element={<CharacterDetailPage />} />
      </Routes>
      <Toaster />
    </>,
    { route },
  )
}

/** A CardDetailOut: the summary a tile uses, plus the embedded V3 `card`. */
function detailCard(overrides: Record<string, unknown> = {}) {
  return {
    ...card(overrides),
    spec: 'chara_card_v3',
    spec_version: '3.0',
    gallery: { gallery_id: '', folder: '', exists: false, images: 0, bytes: 0 },
    card: {
      name: 'Abbie',
      description: 'A long description of Abbie.',
      personality: 'wry and watchful',
      first_mes: 'You again.',
      alternate_greetings: ['A second greeting.'],
      creator_notes: '## About\n\nWorks best under 300 words.',
      character_book: {
        name: 'Abbie world',
        entries: [{ keys: ['the tower'], content: 'tall and cold', id: 1 }],
      },
      ...(overrides.card as object),
    },
    ...overrides,
  }
}

const detailHandler = (data = detailCard()) =>
  http.get('*/api/v1/characters/:id', () =>
    HttpResponse.json(data, { headers: { ETag: '"abc-1"' } }),
  )

/** The neighbour list the prev/next pager reads. */
const listHandler = (items = [detailCard({ id: 'Abbie_0d162f5f.png' })]) =>
  http.get('*/api/v1/characters', () =>
    HttpResponse.json({ total: items.length, limit: 100, offset: 0, items }),
  )

describe('CharacterDetailPage', () => {
  it('renders the overview: tagline, description and first greeting', async () => {
    // The tagline is the page blurb (`page_name`) when it differs from the name.
    server.use(
      detailHandler(detailCard({ page_name: 'wry and watchful' })),
      listHandler(),
    )
    renderDetail('/characters/Abbie_0d162f5f.png')

    expect(
      await screen.findByRole('heading', { name: 'Abbie', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('wry and watchful')).toBeInTheDocument()
    expect(screen.getByText('A long description of Abbie.')).toBeInTheDocument()
    expect(screen.getByText('You again.')).toBeInTheDocument()
  })

  it('switches tabs: Greetings lists every greeting, Info shows card.json', async () => {
    server.use(detailHandler(), listHandler())
    renderDetail('/characters/Abbie_0d162f5f.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /Greetings/ }))
    expect(screen.getByText('Greeting 1 · primary')).toBeInTheDocument()
    expect(screen.getByText('A second greeting.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^Info$/ }))
    expect(
      screen.getByText(/"chara_card_v3"|chara_card_v3/),
    ).toBeInTheDocument()
    // card.json block carries the description verbatim.
    expect(screen.getByText(/A long description of Abbie/)).toBeInTheDocument()
  })

  it('the lorebook tab shows the entry keys', async () => {
    server.use(detailHandler(), listHandler())
    renderDetail('/characters/Abbie_0d162f5f.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /Lorebook/ }))
    expect(screen.getByText('the tower')).toBeInTheDocument()
    expect(screen.getByText('tall and cold')).toBeInTheDocument()
  })

  it('a card with no lorebook shows the empty state', async () => {
    const bare = detailCard({ card: { character_book: null } })
    server.use(detailHandler(bare), listHandler([bare]))
    renderDetail('/characters/x.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /Lorebook/ }))
    expect(screen.getByText(/No lorebook on this card/)).toBeInTheDocument()
  })

  it('deep-links a tab via ?tab=', async () => {
    server.use(detailHandler(), listHandler())
    renderDetail('/characters/Abbie_0d162f5f.png?tab=info')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })
    expect(screen.getByText(/A long description of Abbie/)).toBeInTheDocument()
  })

  it('edits the description: whole-card PUT with the read’s If-Match', async () => {
    let put: { body: { card: Record<string, unknown> }; ifMatch: string | null } | null =
      null
    server.use(
      detailHandler(),
      listHandler(),
      http.put('*/api/v1/characters/:id', async ({ request }) => {
        const body = (await request.json()) as { card: Record<string, unknown> }
        put = { body, ifMatch: request.headers.get('If-Match') }
        return HttpResponse.json(
          detailCard({ card: { ...body.card } }),
          { headers: { ETag: '"abc-2"' } },
        )
      }),
    )
    renderDetail('/characters/Abbie_0d162f5f.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    const box = screen.getByRole('textbox')
    await userEvent.clear(box)
    await userEvent.type(box, 'A rewritten description.')
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(put).not.toBeNull())
    expect(put!.ifMatch).toBe('"abc-1"')
    // The whole card goes back, not a patch — name and greeting ride along.
    expect(put!.body.card.name).toBe('Abbie')
    expect(put!.body.card.first_mes).toBe('You again.')
    expect(put!.body.card.description).toBe('A rewritten description.')
    // The editor closes and the new prose is shown.
    await waitFor(() =>
      expect(screen.getByText('A rewritten description.')).toBeInTheDocument(),
    )
  })

  it('a stale write (412) is reported, not clobbered', async () => {
    server.use(
      detailHandler(),
      listHandler(),
      http.put('*/api/v1/characters/:id', () =>
        HttpResponse.json({ detail: 'stale' }, { status: 412 }),
      ),
    )
    renderDetail('/characters/Abbie_0d162f5f.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    // The editor stays open (a textbox is still present) and a toast explains why.
    expect(await screen.findByText(/changed since you opened it/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('favourites the card: POST with the new value, button reflects it', async () => {
    let posted: boolean | null = null
    server.use(
      detailHandler(),
      listHandler(),
      http.post('*/api/v1/characters/:id/favorite', async ({ request }) => {
        const body = (await request.json()) as { value: boolean }
        posted = body.value
        return HttpResponse.json({ id: 'Abbie_0d162f5f.png', favorite: body.value })
      }),
    )
    renderDetail('/characters/Abbie_0d162f5f.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: /^Favourite$/ }))
    await waitFor(() => expect(posted).toBe(true))
    expect(
      await screen.findByRole('button', { name: /^Favourited$/ }),
    ).toBeInTheDocument()
  })

  it('the pager reports the position within the neighbour set', async () => {
    const a = detailCard({ id: 'a.png', name: 'Abbie' })
    const b = detailCard({ id: 'b.png', name: 'Bella' })
    server.use(
      http.get('*/api/v1/characters/:id', ({ params }) =>
        HttpResponse.json(params.id === 'b.png' ? b : a),
      ),
      listHandler([a, b]),
    )
    renderDetail('/characters/a.png')
    await screen.findByRole('heading', { name: 'Abbie', level: 1 })
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeInTheDocument())
  })
})
