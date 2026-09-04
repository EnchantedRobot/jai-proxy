/**
 * Turning a media scan into the line under the Gallery pane's scan button.
 *
 * Its own module rather than a helper inside `MediaDiscovery.tsx` because a
 * component file that also exports a function loses fast refresh.
 */

/**
 * "3 images (1 in the lorebook) and 2 galleries found."
 *
 * Galleries are counted rather than resolved — `POST .../media/scan` lists a
 * card's gallery sources but does not open them, which is what keeps the scan
 * instant and offline. Their images are therefore deliberately not in the
 * image total, and saying "and 2 galleries" is honest about that where a
 * combined number would not be.
 */
export function describeScan(
  images: number,
  inLorebook: number,
  galleries: number,
): string {
  const parts: string[] = []
  if (images)
    parts.push(
      `${images} image${images === 1 ? '' : 's'}` +
        (inLorebook ? ` (${inLorebook} in the lorebook)` : ''),
    )
  if (galleries)
    parts.push(`${galleries} ${galleries === 1 ? 'gallery' : 'galleries'}`)
  return `${parts.join(' and ')} found.`
}
