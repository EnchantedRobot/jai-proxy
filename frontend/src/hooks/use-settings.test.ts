import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { server } from '@/test/msw-server'
import { useUpdateUi2 } from './use-settings'

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
      chubApiKey: 'chub-key',
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
    result.current.mutate({ key: 'tagDictionaryDelta', value: { overrides: { x: { removed: true } } } })

    await waitFor(() => expect(putBody).not.toBeNull())

    const body = putBody as unknown as Record<string, unknown>
    // The tokens survive untouched.
    expect(body.botbooruToken).toBe('secret-token')
    expect(body.chubApiKey).toBe('chub-key')
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

    await waitFor(() => expect((latest.ui2 as Record<string, unknown>)?.tagDictionaryDelta).toBe(1))
    // The key the server grew between reads is still there.
    expect(latest.serverAdded).toBe('after-first-write')
  })
})
