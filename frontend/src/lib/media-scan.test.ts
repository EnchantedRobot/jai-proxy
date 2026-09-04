import { describe, expect, it } from 'vitest'
import { describeScan } from '@/lib/media-scan'

/**
 * The line under the Gallery pane's scan button.
 *
 * The case that matters is the last one: a card whose entire gallery is a
 * Civitai post has no image URLs of its own, so before galleries were counted
 * the pane said "No remote media URLs found in this card's text" over forty
 * images and offered no Download button at all.
 */
describe('describeScan', () => {
  it('counts images and singularises', () => {
    expect(describeScan(1, 0, 0)).toBe('1 image found.')
    expect(describeScan(3, 0, 0)).toBe('3 images found.')
  })

  it('calls out how many came from the lorebook', () => {
    expect(describeScan(3, 1, 0)).toBe('3 images (1 in the lorebook) found.')
  })

  it('reports galleries alongside images without folding them into the count', () => {
    expect(describeScan(3, 0, 2)).toBe('3 images and 2 galleries found.')
    expect(describeScan(3, 1, 1)).toBe(
      '3 images (1 in the lorebook) and 1 gallery found.',
    )
  })

  it('describes a card whose only media is behind a gallery link', () => {
    expect(describeScan(0, 0, 1)).toBe('1 gallery found.')
  })
})
