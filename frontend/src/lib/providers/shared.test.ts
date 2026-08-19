import { describe, it, expect } from 'vitest'
import {
  matchesTagFilters,
  tagMatchKey,
  withPersistentExcludes,
  hasTagFilters,
  NO_TAG_FILTERS,
} from './shared'

describe('tagMatchKey — decoration stripping', () => {
  it('folds the spellings creators actually use for one tag', () => {
    // The cases the old UI's tagMatchKey existed to handle: a hash prefix, an
    // emoji bullet, stray casing and padding all name the same tag.
    const spellings = [
      'Female',
      '#Female',
      '👩 female',
      '  FEMALE  ',
      '#female',
    ]
    for (const spelling of spellings) {
      expect(tagMatchKey(spelling)).toBe('female')
    }
  })

  it('collapses inner punctuation and whitespace', () => {
    expect(tagMatchKey('Sci-Fi')).toBe('sci fi')
    expect(tagMatchKey('sci   fi')).toBe('sci fi')
    expect(tagMatchKey('slice_of_life')).toBe('slice of life')
  })

  it('does not fold genuinely different tags together', () => {
    expect(tagMatchKey('Female')).not.toBe(tagMatchKey('Futanari'))
    expect(tagMatchKey('male')).not.toBe(tagMatchKey('female'))
  })
})

describe('matchesTagFilters — include ALL, exclude ANY', () => {
  const card = ['Female', '#Fantasy', '👩 Romance']

  it('passes everything when no filter is set', () => {
    expect(matchesTagFilters(card, NO_TAG_FILTERS)).toBe(true)
    expect(matchesTagFilters(undefined, NO_TAG_FILTERS)).toBe(true)
    expect(hasTagFilters(NO_TAG_FILTERS)).toBe(false)
  })

  it('requires EVERY include tag, not any', () => {
    expect(
      matchesTagFilters(card, { include: ['female', 'fantasy'], exclude: [] }),
    ).toBe(true)
    // "fantasy" matches but "mecha" does not -- an AND, so the card is out.
    expect(
      matchesTagFilters(card, { include: ['fantasy', 'mecha'], exclude: [] }),
    ).toBe(false)
  })

  it('rejects on ANY exclude tag', () => {
    expect(
      matchesTagFilters(card, { include: [], exclude: ['mecha', 'romance'] }),
    ).toBe(false)
    expect(
      matchesTagFilters(card, { include: [], exclude: ['mecha', 'horror'] }),
    ).toBe(true)
  })

  it('matches through decoration on both sides', () => {
    // The card's tag is "#Fantasy", the chip says "fantasy".
    expect(matchesTagFilters(card, { include: ['fantasy'], exclude: [] })).toBe(
      true,
    )
    // ...and the reverse: a decorated chip against a bare card tag.
    expect(
      matchesTagFilters(['fantasy'], { include: ['#Fantasy'], exclude: [] }),
    ).toBe(true)
  })

  it('lets exclude win over include for the same tag', () => {
    expect(
      matchesTagFilters(card, { include: ['female'], exclude: ['female'] }),
    ).toBe(false)
  })

  it('treats a card with no tags as unmatched by any include', () => {
    expect(matchesTagFilters([], { include: ['female'], exclude: [] })).toBe(
      false,
    )
    // ...but an exclude-only filter has nothing to reject, so it passes.
    expect(matchesTagFilters([], { include: [], exclude: ['female'] })).toBe(
      true,
    )
  })
})

describe('withPersistentExcludes', () => {
  it('layers the stored always-exclude list under the session chips', () => {
    const merged = withPersistentExcludes(
      { include: ['fantasy'], exclude: ['gore'] },
      ['futa', 'futanari'],
    )
    expect(merged.include).toEqual(['fantasy'])
    expect(merged.exclude).toEqual(['gore', 'futa', 'futanari'])
  })

  it('is a no-op when nothing is stored', () => {
    const filters = { include: ['fantasy'], exclude: [] }
    expect(withPersistentExcludes(filters, [])).toBe(filters)
    expect(withPersistentExcludes(filters, undefined)).toBe(filters)
  })

  it('cannot be re-admitted by an include chip', () => {
    // A standing exclusion is a floor: including the same tag must not win.
    const merged = withPersistentExcludes({ include: ['futa'], exclude: [] }, [
      'futa',
    ])
    expect(matchesTagFilters(['Futa'], merged)).toBe(false)
  })
})
