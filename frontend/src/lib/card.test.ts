import { describe, expect, it } from 'vitest'
import {
  extension,
  formatBytes,
  formatDate,
  greetings,
  groupSources,
  loreEntries,
  lorebookName,
  sourceLabel,
  str,
  type CardData,
} from './card'

describe('reading the embedded card', () => {
  it('greetings puts first_mes ahead of the alternates', () => {
    const card: CardData = {
      first_mes: 'hello',
      alternate_greetings: ['hi', 'hey'],
    }
    expect(greetings(card)).toEqual(['hello', 'hi', 'hey'])
  })

  it('greetings drops a blank first_mes rather than leading with empty', () => {
    const card: CardData = { first_mes: '', alternate_greetings: ['only'] }
    expect(greetings(card)).toEqual(['only'])
  })

  it('greetings ignores group_only_greetings', () => {
    const card: CardData = {
      first_mes: 'hi',
      group_only_greetings: ['group'],
    }
    expect(greetings(card)).toEqual(['hi'])
  })

  it('loreEntries reads a character_book and defaults a missing enabled to on', () => {
    const card: CardData = {
      character_book: {
        name: 'World',
        entries: [
          { keys: ['tower'], content: 'tall', id: 5 },
          { keys: ['pact'], content: 'sealed', enabled: false },
        ],
      },
    }
    const entries = loreEntries(card)
    expect(entries).toHaveLength(2)
    expect(entries[0].id).toBe(5)
    expect(entries[0].enabled).toBe(true)
    expect(entries[1].enabled).toBe(false)
    expect(lorebookName(card)).toBe('World')
  })

  it('loreEntries is empty for a card with no book, not a throw', () => {
    expect(loreEntries({})).toEqual([])
    expect(loreEntries({ character_book: null } as CardData)).toEqual([])
    expect(loreEntries({ character_book: {} })).toEqual([])
    expect(lorebookName({})).toBe('')
  })

  it('str returns a string field or empty, never undefined', () => {
    expect(str({ description: 'x' }, 'description')).toBe('x')
    expect(str({ description: 42 } as CardData, 'description')).toBe('')
    expect(str({}, 'missing')).toBe('')
  })

  it('extension reads a provider block or an empty object', () => {
    const card: CardData = { extensions: { jai: { id: 'abc' } } }
    expect(extension(card, 'jai')).toEqual({ id: 'abc' })
    expect(extension(card, 'chub')).toEqual({})
    expect(extension({}, 'jai')).toEqual({})
  })
})

describe('formatting', () => {
  it('sourceLabel names the platform, not the importer', () => {
    // The `_core`/`_import` half says which pass acquired the card, which is
    // not what "Source: Chub" is answering -- both kinds are Chub.
    expect(sourceLabel('janitor_core')).toBe('JanitorAI')
    expect(sourceLabel('chub_import')).toBe('Chub')
    expect(sourceLabel('chub_core')).toBe('Chub')
    expect(sourceLabel('datacat_core')).toBe('DataCat')
    // A kind with no label yet still reads, rather than falling out.
    expect(sourceLabel('botbooru_import')).toBe('Botbooru')
    expect(sourceLabel('something_else')).toBe('Something else')
  })

  it('groupSources folds the two kinds of a platform into one row', () => {
    const groups = groupSources([
      { value: 'chub_import', count: 1196 },
      { value: 'janitor_core', count: 1483 },
      { value: 'chub_core', count: 7 },
    ])

    expect(groups).toEqual([
      {
        platform: 'janitor',
        label: 'JanitorAI',
        count: 1483,
        kinds: ['janitor_core'],
      },
      {
        platform: 'chub',
        label: 'Chub',
        count: 1203,
        kinds: ['chub_import', 'chub_core'],
      },
    ])
  })

  it('formatBytes scales B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1_500_000)).toBe('1.4 MB')
  })

  it('formatDate slices the ISO date and never parses junk', () => {
    expect(formatDate('2026-08-14T09:00:00Z')).toBe('2026-08-14')
    expect(formatDate('')).toBe('—')
    expect(formatDate(null)).toBe('—')
    // A shape Date would misread is passed through by slice, not NaN.
    expect(formatDate('2026-08-14 weird')).toBe('2026-08-14')
  })
})
