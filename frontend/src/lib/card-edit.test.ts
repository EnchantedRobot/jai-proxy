import { describe, expect, it } from 'vitest'
import type { CardData } from './card'
import { setField, setGreetings, setTags } from './card-edit'

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
