import { describe, expect, it } from 'vitest'
import type { CardData, LoreEntry } from './card'
import { loreEntries } from './card'
import { setField, setGreetings, setLoreEntries, setTags } from './card-edit'

describe('setField', () => {
  it('replaces one key and leaves the rest', () => {
    const next = setField(
      { name: 'Abbie', description: 'old' },
      'description',
      'new',
    )
    expect(next).toEqual({ name: 'Abbie', description: 'new' })
  })

  it('does not mutate the input', () => {
    const data: CardData = { description: 'old' }
    setField(data, 'description', 'new')
    expect(data.description).toBe('old')
  })
})

describe('setGreetings', () => {
  it('writes the first as first_mes and the rest as alternates', () => {
    const next = setGreetings({}, ['hi', 'hey', 'yo'])
    expect(next.first_mes).toBe('hi')
    expect(next.alternate_greetings).toEqual(['hey', 'yo'])
  })

  it('drops blank greetings so an emptied box leaves nothing behind', () => {
    const next = setGreetings({}, ['  ', 'only', ''])
    expect(next.first_mes).toBe('only')
    expect(next.alternate_greetings).toEqual([])
  })

  it('an all-empty set clears the greeting', () => {
    const next = setGreetings({ first_mes: 'was here' }, ['', '  '])
    expect(next.first_mes).toBe('')
    expect(next.alternate_greetings).toEqual([])
  })
})

describe('setTags', () => {
  it('trims and drops case-insensitive duplicates, keeping the first spelling', () => {
    const next = setTags({}, [' Female ', 'female', 'SFW', ''])
    expect(next.tags).toEqual(['Female', 'SFW'])
  })
})

describe('setLoreEntries', () => {
  const book = {
    character_book: {
      name: 'World',
      entries: [
        {
          keys: ['tower'],
          content: 'tall',
          id: 1,
          // A routing field the editor never surfaces; it must survive a save.
          insertion_order: 5,
          selectiveLogic: 2,
        },
      ],
    },
  }

  it('merges edits onto the raw entry, preserving untouched fields', () => {
    const entries = loreEntries(book)
    entries[0].content = 'tall and cold'
    const next = setLoreEntries(book, entries)
    const saved = (next.character_book as CardData).entries as CardData[]
    expect(saved[0].content).toBe('tall and cold')
    expect(saved[0].selectiveLogic).toBe(2)
    expect(saved[0].keys).toEqual(['tower'])
  })

  it('appends a new entry', () => {
    const entries = loreEntries(book)
    const added: LoreEntry = {
      id: 2,
      keys: ['moat'],
      secondaryKeys: [],
      content: 'deep',
      comment: '',
      enabled: true,
      constant: false,
      insertionOrder: 1,
    }
    const next = setLoreEntries(book, [...entries, added])
    const saved = (next.character_book as CardData).entries as CardData[]
    expect(saved).toHaveLength(2)
    expect(saved[1].keys).toEqual(['moat'])
    expect(saved[1].secondary_keys).toEqual([])
  })

  it('is a no-op on a card with no character_book', () => {
    const data: CardData = { name: 'x' }
    expect(setLoreEntries(data, [])).toBe(data)
  })
})
