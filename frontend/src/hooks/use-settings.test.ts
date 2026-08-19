import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { server } from '@/test/msw-server'
import { useUpdateRoot, useUpdateUi2 } from './use-settings'

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

describe('useUpdateUi2 — the §3.7 read-modify-write', () => {
  it('preserves every existing key (the old UI tokens) while merging under ui2', async () => {
    // The stored blob is the only copy of the Chub/DataCat tokens the old UI
    // wrote. A naive "write my settings" would replace the whole document and
    // destroy them; this proves the merge keeps them.
    let putBody: Record<string, unknown> | null = null
    const stored: Record<string, unknown> = {
      botbooruToken: 'secret-token',
      // The real legacy key. This fixture said `chubApiKey` until Stage 6B --
      // a name that exists in neither codebase, so the assertion below proved
      // nothing about the token that actually needs protecting.
      chubToken: 'chub-urql-token',
      datacatFollowedCreators: [{ id: 'a', name: 'Greatn', source: 'datacat' }],
      ui2: { existingUi2Key: 42 },
    }
    server.use(
      http.get('*/api/v1/settings', () => HttpResponse.json(stored)),
      http.put('*/api/v1/settings', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(putBody)
      }),
    )

    const { result } = renderHook(() => useUpdateUi2(), { wrapper: wrapper() })
    result.current.mutate({
      key: 'tagDictionaryDelta',
      value: { overrides: { x: { removed: true } } },
    })

    await waitFor(() => expect(putBody).not.toBeNull())

    const body = putBody as unknown as Record<string, unknown>
    // The tokens survive untouched.
    expect(body.botbooruToken).toBe('secret-token')
    expect(body.chubToken).toBe('chub-urql-token')
    // As does the followed-creator list, which is real data with no other copy.
    expect(body.datacatFollowedCreators).toEqual([
      { id: 'a', name: 'Greatn', source: 'datacat' },
    ])
    // The new key lands under ui2, next to the old ui2 key rather than replacing it.
    expect(body.ui2).toEqual({
      existingUi2Key: 42,
      tagDictionaryDelta: { overrides: { x: { removed: true } } },
    })
  })

  it('merges onto a fresh GET, not a stale cache', async () => {
    // The GET the mutation issues must reflect what is on the server *now*, so
    // two writes in quick succession cannot clobber each other's merge.
    let latest: Record<string, unknown> = { serverAdded: 'after-first-write' }
    server.use(
      http.get('*/api/v1/settings', () => HttpResponse.json(latest)),
      http.put('*/api/v1/settings', async ({ request }) => {
        latest = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(latest)
      }),
    )

    const { result } = renderHook(() => useUpdateUi2(), { wrapper: wrapper() })
    result.current.mutate({ key: 'tagDictionaryDelta', value: 1 })

    await waitFor(() =>
      expect((latest.ui2 as Record<string, unknown>)?.tagDictionaryDelta).toBe(
        1,
      ),
    )
    // The key the server grew between reads is still there.
    expect(latest.serverAdded).toBe('after-first-write')
  })
})

describe('useUpdateRoot — provider keys live at the blob root', () => {
  it('writes a root key without disturbing ui2 or the other provider keys', async () => {
    // Provider credentials and the followed-creator list deliberately sit at
    // the root, not under `ui2`, because the old UI and the server-side scripts
    // read them flat. This proves a write to one leaves the rest intact.
    let putBody: Record<string, unknown> | null = null
    const stored: Record<string, unknown> = {
      chubToken: 'chub-urql-token',
      datacatToken: 'datacat-session',
      datacatFollowedCreators: [{ id: 'a', name: 'Greatn', source: 'datacat' }],
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      ui2: { defaultSort: 'name' },
    }
    server.use(
      http.get('*/api/v1/settings', () => HttpResponse.json(stored)),
      http.put('*/api/v1/settings', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(putBody)
      }),
    )

    const { result } = renderHook(() => useUpdateRoot(), { wrapper: wrapper() })
    result.current.mutate({ chubNsfw: false })

    await waitFor(() => expect(putBody).not.toBeNull())

    const body = putBody as unknown as Record<string, unknown>
    expect(body.chubNsfw).toBe(false)
    expect(body.chubToken).toBe('chub-urql-token')
    expect(body.datacatToken).toBe('datacat-session')
    expect(body.datacatFollowedCreators).toEqual([
      { id: 'a', name: 'Greatn', source: 'datacat' },
    ])
    expect(body.httpProxyUrl).toBe('socks5://127.0.0.1:1080')
    expect(body.ui2).toEqual({ defaultSort: 'name' })
  })
})
