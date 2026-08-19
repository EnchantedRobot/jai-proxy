import { useQuery } from '@tanstack/react-query'
import { apiClient, unwrap } from '@/lib/api-client'
import type { components } from '@/lib/api-schema'

export type CardDetail = components['schemas']['CardDetailOut']
export type GalleryFiles = components['schemas']['GalleryFilesOut']

/** A card and the `If-Match` token the read handed out with it. */
export interface CardDetailResult {
  card: CardDetail
  /** The `ETag` off the detail response — the precondition a whole-card `PUT`
   *  sends back to prove it is writing over what it read. `null` when the server
   *  omitted it (older builds), in which case the write goes last-writer-wins. */
  etag: string | null
}

/**
 * One card in full — the embedded V3 card plus the summary, gallery meta, and
 * the `ETag` an edit needs. Reading the header is why this queries by hand
 * rather than through `unwrap`, which keeps only the body.
 */
export function useCharacterDetail(id: string | undefined) {
  return useQuery<CardDetailResult>({
    queryKey: ['character', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, response } = await apiClient.GET(
        '/api/v1/characters/{card_id}',
        { params: { path: { card_id: id! } } },
      )
      if (!response.ok || data === undefined)
        throw new Error(
          `could not read the card: ${response.status} ${response.statusText}`.trim(),
        )
      return { card: data, etag: response.headers.get('ETag') }
    },
  })
}

/**
 * A card's gallery contents, for the Gallery pane and the strip on Overview.
 *
 * Keyed on the folder rather than the card id, because that is what the files
 * live under and a rename does not move them (the folder is resolved from the
 * gallery_id suffix). `exists: false` on the card's gallery means no folder, so
 * the query is disabled and the pane shows the empty state without a 404.
 */
export function useGalleryFiles(folder: string | undefined, exists: boolean) {
  return useQuery({
    queryKey: ['gallery', folder],
    enabled: !!folder && exists,
    queryFn: () =>
      unwrap(
        apiClient.GET('/api/v1/galleries/{folder}', {
          params: { path: { folder: folder! } },
        }),
        'could not read the gallery',
      ),
  })
}

/**
 * Cards by the same creator, for the Related pane. `creator=` is an exact,
 * case-insensitive match server-side, so this is one small query rather than a
 * client-side scan of the archive.
 */
export function useSameCreator(creator: string, excludeId: string) {
  return useQuery({
    queryKey: ['related', 'creator', creator],
    enabled: creator.length > 0 && creator !== 'unknown',
    queryFn: async () => {
      const page = await unwrap(
        apiClient.GET('/api/v1/characters', {
          params: { query: { creator, limit: 24, sort: 'name' } },
        }),
        'could not read related cards',
      )
      return page.items.filter((card) => card.id !== excludeId)
    },
  })
}

/**
 * Cards that share a tag, for the Related pane's second row.
 *
 * The list route ANDs the tags it is given, so a single representative tag is
 * sent rather than all of them (which would ask for cards carrying every tag at
 * once — almost none). The caller picks the card's most specific tag.
 */
export function useSharesTag(tag: string | undefined, excludeId: string) {
  return useQuery({
    queryKey: ['related', 'tag', tag],
    enabled: !!tag,
    queryFn: async () => {
      const page = await unwrap(
        apiClient.GET('/api/v1/characters', {
          params: { query: { tag: [tag!], limit: 24, sort: '-added' } },
        }),
        'could not read related cards',
      )
      return page.items.filter((card) => card.id !== excludeId)
    },
  })
}
