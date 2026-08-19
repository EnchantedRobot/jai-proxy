import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchDatacatCreator } from './datacat'

/** The creator endpoint answers through `dc-proxy`, and the module bootstraps a
 * session before its first call -- both are plain `fetch`, so one stub covers
 * them. */
function stubFetch(creator: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('dc-init'))
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    return new Response(JSON.stringify({ success: true, creator }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchDatacatCreator — the creator endpoint speaks its own dialect', () => {
  it('reads the shape DataCat actually returns', async () => {
    // Trimmed from a live `/api/creators/{uuid}` response (2026-08-19): there is
    // no `name` and no `creator_name` on it -- reading those returned null, and
    // a followed creator was then stored under their raw uuid.
    stubFetch({
      creatorId: '1d8bf5a3-b184-413c-b7c1-2a7b3c53694d',
      userName: 'YoggySoth',
      avatar: 'uCrb0OQ2SZ_VxbSKt4-x4.webp',
      avatarDisplayUrl: 'https://media.datacat.run/prod-media/card.webp',
      charCount: 91,
    })

    expect(
      await fetchDatacatCreator('1d8bf5a3-b184-413c-b7c1-2a7b3c53694d'),
    ).toEqual({
      id: '1d8bf5a3-b184-413c-b7c1-2a7b3c53694d',
      name: 'YoggySoth',
      avatar: 'https://media.datacat.run/prod-media/card.webp',
      characterCount: 91,
    })
  })

  it('still reads the browse feed spellings', async () => {
    stubFetch({
      creator_id: 'abc',
      creator_name: 'Someone',
      character_count: 3,
    })
    const creator = await fetchDatacatCreator('abc')
    expect(creator?.name).toBe('Someone')
    expect(creator?.characterCount).toBe(3)
  })

  it('gives back null when nothing names the creator', async () => {
    stubFetch({ creatorId: 'abc' })
    expect(await fetchDatacatCreator('abc')).toBeNull()
  })
})
