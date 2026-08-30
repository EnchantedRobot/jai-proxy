import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { BatchSelectionProvider } from '@/hooks/use-batch-selection'

/**
 * A component under the providers the app always has: a query client, a
 * router, and the batch-selection context `CharactersPage`'s grid reads from.
 * Retries are off so a test asserting an error path fails in one attempt
 * rather than three.
 */
export function renderApp(
  ui: React.ReactElement,
  { route = '/' }: { route?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <BatchSelectionProvider>{ui}</BatchSelectionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** A `CardOut` with the fields a tile reads, and sane values for the rest. */
export function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'Abbie_0d162f5f.png',
    name: 'Abbie',
    creator: 'KornyPony',
    page_name: '',
    tags: ['Female'],
    source_kind: 'janitor_core',
    source_url: '',
    card_id: '0d162f5f',
    fragment: '0d162f5f',
    gallery_id: '',
    character_version: '1',
    greetings: 1,
    lore_entries: 0,
    description_chars: 100,
    prompt_chars: 200,
    has_creator_notes: false,
    has_example_dialogue: false,
    favorite: false,
    size: 1000,
    modified: '2026-08-01T00:00:00Z',
    linked_at: '2026-08-01T00:00:00Z',
    create_date: '2026-08-01T00:00:00Z',
    thumb_url: '/api/v1/characters/Abbie_0d162f5f.png/thumb',
    png_url: '/api/v1/characters/Abbie_0d162f5f.png/png',
    extensions: null,
    error: null,
    ...overrides,
  }
}
