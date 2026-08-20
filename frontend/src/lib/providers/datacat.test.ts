import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  datacatAvatarUrl,
  fetchDatacatCreator,
  hydrateDatacatScripts,
} from './datacat'

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

describe('datacatAvatarUrl — a width hint only means something on janitorai', () => {
  it('appends width for a bare (janitorai) filename', () => {
    expect(
      datacatAvatarUrl({ avatar: 'uCrb0OQ2SZ.webp' }, { width: 400 }),
    ).toBe('https://ella.janitorai.com/bot-avatars/uCrb0OQ2SZ.webp?width=400')
  })

  it('appends width to a full janitorai URL, preserving existing params', () => {
    expect(
      datacatAvatarUrl(
        { avatar: 'https://ella.janitorai.com/bot-avatars/x.webp?v=2' },
        { width: 400 },
      ),
    ).toBe('https://ella.janitorai.com/bot-avatars/x.webp?v=2&width=400')
  })

  it('leaves a datacat-native (non-janitorai) URL untouched', () => {
    expect(
      datacatAvatarUrl(
        { avatar: 'https://media.datacat.run/prod-media/card.webp' },
        { width: 400 },
      ),
    ).toBe('https://media.datacat.run/prod-media/card.webp')
  })

  it('with no width, returns the resolved URL as-is', () => {
    expect(datacatAvatarUrl({ avatar: 'x.webp' })).toBe(
      'https://ella.janitorai.com/bot-avatars/x.webp',
    )
  })

  it('with no avatar, returns empty', () => {
    expect(datacatAvatarUrl({}, { width: 400 })).toBe('')
  })
})

describe('hydrateDatacatScripts — fetches every script in parallel', () => {
  it('does not wait for script N before starting script N+1', async () => {
    const started: string[] = []
    const resolvers = new Map<string, () => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input)
        started.push(path)
        return new Promise<Response>((resolve) => {
          resolvers.set(path, () =>
            resolve(
              new Response(JSON.stringify({ script: 'entries' }), {
                headers: { 'content-type': 'application/json' },
              }),
            ),
          )
        })
      }),
    )

    const scripts = [
      {
        type: 'lorebook',
        is_public: true,
        api_path: '/hampter/script/11111111-1111-1111-1111-111111111111',
        script: undefined as string | undefined,
      },
      {
        type: 'lorebook',
        is_public: true,
        api_path: '/hampter/script/22222222-2222-2222-2222-222222222222',
        script: undefined as string | undefined,
      },
    ]
    const character = { scripts }

    const done = hydrateDatacatScripts(character)
    // Both requests should be in flight before either resolves -- a
    // sequential loop would only have issued the first one by now.
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toHaveLength(2)

    for (const resolve of resolvers.values()) resolve()
    expect(await done).toBe(true)
    expect(scripts[0].script).toBe('entries')
    expect(scripts[1].script).toBe('entries')
  })
})
