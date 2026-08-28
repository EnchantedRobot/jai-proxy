import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { components } from '@/lib/api-schema'

export type MediaUpload = components['schemas']['MediaUploadOut']

/** Which of the two folder resources a file is going into. Both mount the
 *  same routes over a different root, so the only difference here is a path
 *  segment and which query goes stale. */
export type MediaKind = 'galleries' | 'expressions'

/**
 * Send files to a card's gallery or expressions folder
 * (docs/FORKS_AND_EXTRAS_PLAN.md §9).
 *
 * `fetch` rather than `apiClient`: these are multipart bodies of
 * multi-megabyte binaries, the same reason `useReplaceAvatar` goes direct. A
 * `.zip` is posted whole to `/zip`, which unpacks it server-side; everything
 * else goes one request per file so one bad sprite in a drop of forty does not
 * lose the other thirty-nine. Both shapes report the same way, so the pane
 * renders one result either way.
 */
export function useUploadMedia(kind: MediaKind, folder: string | undefined) {
  const client = useQueryClient()
  return useMutation<MediaUpload, Error, File[]>({
    mutationFn: async (files) => {
      if (!folder) throw new Error('this card has no folder to upload into')
      const combined: MediaUpload = { folder, written: [], skipped: [] }
      for (const file of files) {
        const zip = /\.zip$/i.test(file.name)
        const body = new FormData()
        // The filename is passed explicitly: it is what the server stores the
        // file as (stem preserved, extension swapped), and a `FormData` entry
        // set from a Blob-like without one is sent as `blob`.
        body.set('file', file, file.name)
        const response = await fetch(
          `/api/v1/${kind}/${encodeURIComponent(folder)}/${zip ? 'zip' : 'files'}`,
          { method: 'POST', body },
        )
        if (response.status === 422) {
          const detail = await response.json().catch(() => null)
          combined.skipped.push({
            name: file.name,
            reason: detail?.detail ?? 'rejected',
          })
          continue
        }
        if (!response.ok)
          throw new Error(
            `could not upload ${file.name}: ${response.status} ${response.statusText}`.trim(),
          )
        const result = await response.json()
        // The single-file route answers with the one file it wrote; the zip
        // route with a whole report. Normalise to the report.
        if (zip) {
          combined.written.push(...result.written)
          combined.skipped.push(...result.skipped)
        } else {
          combined.written.push(result)
        }
        combined.folder = result.folder
      }
      return combined
    },
    onSuccess: () => {
      // Keyed on the prefix, not on the folder: the server resolves a folder
      // by its gallery_id suffix, so after a rename the name it writes under
      // is not the name the query is keyed on. The card's detail goes too — a
      // first upload flips its `exists` from false.
      void client.invalidateQueries({ queryKey: [listKey(kind)] })
      void client.invalidateQueries({ queryKey: ['character'] })
    },
  })
}

/** The prefix `useGalleryFiles` / `useExpressionFiles` key their queries on. */
function listKey(kind: MediaKind): 'gallery' | 'expressions' {
  return kind === 'galleries' ? 'gallery' : 'expressions'
}
