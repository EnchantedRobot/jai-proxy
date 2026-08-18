import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient, unwrap } from '@/lib/api-client'

/**
 * The stored settings blob (docs/UI_REWRITE_PLAN.md §3.7).
 *
 * It is an opaque object the server neither reads nor schema-checks. The new app
 * keeps all of its own keys under a single `ui2` namespace so it never collides
 * with the keys the old `web/` UI writes into the same blob during the overlap.
 */
export type SettingsBlob = Record<string, unknown> & { ui2?: Ui2Settings }

/** The new app's own settings. Grows as later stages need it; Stage 4 uses one. */
export interface Ui2Settings {
  /** The tag dictionary delta (see tag-delta.ts). */
  tagDictionaryDelta?: unknown
  [key: string]: unknown
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    // The blob changes only when this app (or the old UI) writes it, and it is
    // read on route entry rather than continuously.
    staleTime: 60_000,
    queryFn: () =>
      unwrap(
        apiClient.GET('/api/v1/settings'),
        'could not read settings',
      ) as Promise<SettingsBlob>,
  })
}

/**
 * Update one key under the `ui2` namespace with a read-modify-write.
 *
 * **The trap this exists to avoid (§3.7):** `PUT /settings` is a whole-document
 * replace, and that same blob is the only copy of the old UI's Chub and DataCat
 * tokens. Writing just `{ ui2: … }` would destroy them, and the failure would
 * surface later, in Discover, looking like an auth bug. So every write fetches
 * the current blob first and merges onto it. The GET is fresh (not the cached
 * query) so two writes in quick succession cannot clobber each other's merge.
 */
export function useUpdateUi2() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const current = (await unwrap(
        apiClient.GET('/api/v1/settings'),
        'could not read settings',
      )) as SettingsBlob
      const merged: SettingsBlob = {
        ...current,
        ui2: { ...(current.ui2 ?? {}), [key]: value },
      }
      await unwrap(
        apiClient.PUT('/api/v1/settings', { body: merged }),
        'could not save settings',
      )
      return merged
    },
    onSuccess: (merged) => {
      qc.setQueryData(['settings'], merged)
    },
  })
}
