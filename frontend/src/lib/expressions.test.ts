import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPRESSIONS,
  expressionLabel,
  groupExpressions,
} from './expressions'
import type { GalleryFile } from './card'

function file(name: string): GalleryFile {
  return {
    name,
    kind: 'image',
    size: 100,
    modified: '2026-08-01T00:00:00Z',
    url: `/files/${name}`,
    thumb_url: `/files/${name}/thumb`,
  }
}

describe('expressionLabel', () => {
  it('matches ST exactly on the real corpus shapes: ComfyUI padding and bare names', () => {
    // 7,507 of 7,539 real files are this shape.
    expect(expressionLabel('admiration-_00001_.webp')).toBe('admiration')
    // 32 real files (one folder) are this shape.
    expect(expressionLabel('joy.webp')).toBe('joy')
    expect(expressionLabel('joy-1.webp')).toBe('joy')
  })

  it('lowercases before parsing, so casing never splits one expression in two', () => {
    expect(expressionLabel('Joy-1.webp')).toBe('joy')
    expect(expressionLabel('NEUTRAL.webp')).toBe('neutral')
  })

  it('cuts at the first "-" or "." and nothing after it, even mid-word', () => {
    // Harmless for the 28 defaults (single words), but this is why a custom
    // label may not contain either character.
    expect(expressionLabel('re-render.webp')).toBe('re')
  })

  it('strips only the last extension, matching path.parse(...).name', () => {
    expect(expressionLabel('archive.tar.webp')).toBe('archive')
  })

  it('every default expression resolves to itself', () => {
    for (const label of DEFAULT_EXPRESSIONS)
      expect(expressionLabel(`${label}-_00001_.webp`)).toBe(label)
  })
})

describe('groupExpressions', () => {
  it('groups by label and sorts neutral first, the rest alphabetically', () => {
    const files = [
      file('sadness-_00001_.webp'),
      file('neutral-_00001_.webp'),
      file('joy-_00001_.webp'),
      file('joy-_00002_.webp'),
    ]
    const groups = groupExpressions(files)
    expect(groups.map((g) => g.label)).toEqual(['neutral', 'joy', 'sadness'])
    expect(groups.find((g) => g.label === 'joy')?.files).toHaveLength(2)
  })

  it('is empty for an empty folder', () => {
    expect(groupExpressions([])).toEqual([])
  })
})
