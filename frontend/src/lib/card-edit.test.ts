import { describe, expect, it } from 'vitest'
import { dialogueBlocks, type CardData } from './card'
import { setDialogue, setField, setGreetings, setTags } from './card-edit'

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

describe('setDialogue', () => {
  it('writes one <START> block per entry', () => {
    const next = setDialogue({}, ['{{user}}: hi\n{{char}}: hello', 'second'])
    expect(next.mes_example).toBe(
      '<START>\n{{user}}: hi\n{{char}}: hello\n<START>\nsecond',
    )
  })

  it('drops blank blocks so an emptied box leaves nothing behind', () => {
    const next = setDialogue({}, ['  ', 'only', ''])
    expect(next.mes_example).toBe('<START>\nonly')
  })

  it('an all-empty set clears mes_example', () => {
    const next = setDialogue({ mes_example: 'was here' }, ['', '  '])
    expect(next.mes_example).toBe('')
  })

  it('round-trips through dialogueBlocks', () => {
    const written = setDialogue({}, ['{{user}}: hi', '{{char}}: hello'])
    const blocks = dialogueBlocks(written)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].turns).toEqual([{ speaker: 'user', text: 'hi' }])
    expect(blocks[1].turns).toEqual([{ speaker: 'char', text: 'hello' }])
  })
})

describe('setTags', () => {
  it('trims and drops case-insensitive duplicates, keeping the first spelling', () => {
    const next = setTags({}, [' Female ', 'female', 'SFW', ''])
    expect(next.tags).toEqual(['Female', 'SFW'])
  })
})
