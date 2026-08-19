import { useQuery } from '@tanstack/react-query'
import { apiClient, unwrap } from '@/lib/api-client'
import type { components } from '@/lib/api-schema'
import {
  fetchChubFull,
  fetchChubLinkedLorebook,
  type ChubAuth,
  type ChubNode,
} from '@/lib/providers/chub'
import {
  datacatSourceKind,
  fetchDatacatDetail,
  fetchDatacatDownload,
  hydrateDatacatScripts,
  type DatacatCharacter,
} from '@/lib/providers/datacat'
import type { Provider } from './use-discover'

export type DiscoverPreview = components['schemas']['DiscoverPreviewOut']

/**
 * Everything the server needs to describe — or to keep — one provider card.
 *
 * Captured once, used twice: the preview route and the build route take the
 * same body, so opening a card and then adding it costs one round of provider
 * fetches, not two. It also means what you looked at is literally what gets
 * written.
 */
export type ProviderCapture =
  | { provider: 'chub'; node: ChubNode; linked_lorebook?: unknown }
  | { provider: 'datacat'; character: DatacatCharacter; download?: unknown }

/**
 * Fetch a card from its provider in full, at the fidelity an import needs.
 *
 * The two providers each hide something behind a second request, and both were
 * being skipped before this existed — which meant cards imported *without* the
 * lorebook they advertise:
 *
 * - Chub keeps a linked lorebook in a separate project, reachable only through
 *   its v4 git API (`fetchChubLinkedLorebook`). A search row's `related_lorebooks`
 *   says it exists; nothing but that fetch produces it.
 * - DataCat serves a lorebook script's *content* from janitorai.com, per script
 *   (`hydrateDatacatScripts`). The detail payload carries the stubs only, and
 *   the archive server cannot make that call itself — it has no janitorai
 *   session — so it has to happen here.
 */
export async function captureProviderCard(
  provider: Provider,
  raw: ChubNode | DatacatCharacter,
  auth: ChubAuth,
): Promise<ProviderCapture> {
  if (provider === 'chub') {
    const node = raw as ChubNode
    const fullPath = node.fullPath
    if (!fullPath) throw new Error('this card has no fullPath to fetch')
    // Authed where a token exists: a private or restricted card returns null
    // anonymously, which would surface as "could not fetch" for no reason.
    const full = await fetchChubFull(fullPath, auth)
    if (!full) throw new Error('could not fetch the full card from Chub')
    const linked = (full.related_lorebooks as unknown[] | undefined)?.length
      ? await fetchChubLinkedLorebook(full.id, auth)
      : null
    return { provider: 'chub', node: full, linked_lorebook: linked }
  }

  const hit = raw as DatacatCharacter
  const id = hit.character_id ?? hit.characterId ?? ''
  if (!id) throw new Error('this card has no character id')
  const sourceKind = datacatSourceKind(hit)
  const character = await fetchDatacatDetail(id, sourceKind)
  if (!character) throw new Error('could not fetch the card from DataCat')
  await hydrateDatacatScripts(character)
  const download = await fetchDatacatDownload(id, sourceKind)
  return { provider: 'datacat', character, download: download ?? undefined }
}

/**
 * One provider card, mapped by the server into the archive's own terms.
 *
 * The mapping runs server-side (`POST /api/v1/discover/preview`) because it is
 * the *same* code `/build-chub` and `/build-datacat` run on the way in — see
 * that module's docstring. What comes back is shaped like an archived card
 * minus the on-disk facts, which is exactly what the detail panes read.
 */
export function useDiscoverPreview(
  provider: Provider,
  providerId: string | undefined,
  capture: ProviderCapture | undefined,
) {
  return useQuery({
    queryKey: ['discover-preview', provider, providerId],
    enabled: Boolean(providerId) && Boolean(capture),
    // A provider card does not change while you are looking at it, and stepping
    // back and forth through the grid should not re-fetch one you just read.
    staleTime: 10 * 60_000,
    queryFn: () =>
      unwrap(
        apiClient.POST('/api/v1/discover/preview', {
          body: capture as never,
        }),
        'could not read this card',
      ),
  })
}
