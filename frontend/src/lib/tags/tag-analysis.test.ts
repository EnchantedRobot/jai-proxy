// Ported verbatim (behaviour unchanged) from web/tests/tag-analysis.test.mjs
// (node:test -> vitest). tag-analysis.ts is the salvaged TypeScript port of the
// vendored tag-analysis.js; this suite is its acceptance gate. See
// docs/UI_REWRITE_PLAN.md §2 (salvage item 2).

import { describe, it, expect } from 'vitest'
import {
  norm,
  getCardTags,
  pickCanonical,
  buildBuckets,
  buildApplyPayload,
  parsePattern,
  isPattern,
  sortPatterns,
  matchPattern,
  splitEntries,
  type CardLike,
} from './tag-analysis'

// ── norm() ───────────────────────────────────────────────────────────────────

const NORM_GOLDEN: Array<[string, string]> = [
  ['#Female', 'female'],
  ['female', 'female'],
  ['FEMALE', 'female'],
  ['  Arranged   Marriage ', 'arranged marriage'],
  ['##FOO', 'foo'],
  ['#  Spaced', 'spaced'],
  ['Multi   Word', 'multi word'],
  ['a\tb  c', 'a b c'],
  ['  #  ', ''],
  ['AnyPOV', 'anypov'],
]

describe('norm', () => {
  for (const [input, expected] of NORM_GOLDEN) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(norm(input)).toBe(expected)
    })
  }

  it('coerces non-strings via String()', () => {
    expect(norm(123 as unknown as string)).toBe('123')
  })
})

// ── getCardTags() ──────────────────────────────────────────────────────────────

describe('getCardTags', () => {
  it('prefers data.tags (the real V2/V3 field)', () => {
    expect(getCardTags({ data: { tags: ['a', 'b'] }, tags: ['x'] })).toEqual([
      'a',
      'b',
    ])
  })

  it('falls back to the root tags mirror', () => {
    expect(getCardTags({ tags: ['x', 'y'] })).toEqual(['x', 'y'])
  })

  it('drops non-strings and blank/whitespace entries', () => {
    expect(
      getCardTags({
        data: { tags: ['a', '', '  ', 3, null, 'b'] as unknown as string[] },
      }),
    ).toEqual(['a', 'b'])
  })

  it('returns [] when there are no tags or the shape is odd', () => {
    expect(getCardTags({})).toEqual([])
    expect(getCardTags(null as unknown as CardLike)).toEqual([])
    expect(
      getCardTags({ data: { tags: 'nope' as unknown as string[] } }),
    ).toEqual([])
  })
})

// ── pickCanonical() ─────────────────────────────────────────────────────────────

describe('pickCanonical', () => {
  it('prefers a capitalized variant, most frequent wins', () => {
    expect(
      pickCanonical([
        { tag: 'female', count: 5 },
        { tag: 'Female', count: 2 },
      ]),
    ).toBe('Female')
  })

  it('strips a leading # from a #Capital variant', () => {
    expect(pickCanonical([{ tag: '#Female', count: 3 }])).toBe('Female')
  })

  it('preserves intentional mixed-case that leads with a capital', () => {
    expect(pickCanonical([{ tag: 'AnyPOV', count: 1 }])).toBe('AnyPOV')
  })

  it('synthesises Title Case from an all-lowercase separated variant', () => {
    expect(pickCanonical([{ tag: 'arranged_marriage', count: 3 }])).toBe(
      'Arranged Marriage',
    )
    expect(pickCanonical([{ tag: 'space opera', count: 1 }])).toBe(
      'Space Opera',
    )
  })
})

// ── buildBuckets() ──────────────────────────────────────────────────────────────

const mapping = {
  Female: ['female', 'woman', 'girl'],
  Romance: ['romance', 'romantic'],
}
const removedTags = ['junk']

const characters: CardLike[] = [
  {
    avatar: 'a.png',
    data: { tags: ['female', 'romance', 'junk', 'unmapped'] },
  },
  { avatar: 'b.png', tags: ['Female', 'Female'] }, // root fallback + intra-card dupe
  { avatar: 'c.png', data: { tags: ['ROMANTIC'] } },
]

/** canonical -> Map(exact tag string -> count) for easy assertions. */
function groupCounts(
  buckets: ReturnType<typeof buildBuckets>,
  canonical: string,
) {
  const g = buckets.groups.find((x) => x.canonical === canonical)
  return new Map((g?.variants ?? []).map((v) => [v.tag, v.count]))
}

describe('buildBuckets', () => {
  it('makes a group for every canonical, seeding unseen variants at count 0', () => {
    const buckets = buildBuckets([], mapping, removedTags)
    expect(buckets.groups.map((g) => g.canonical).sort()).toEqual([
      'Female',
      'Romance',
    ])
    const female = groupCounts(buckets, 'Female')
    expect(female.get('female')).toBe(0)
    expect(female.get('woman')).toBe(0)
    expect(female.get('girl')).toBe(0)
  })

  it('counts observed variants and keeps distinct case-strings separate', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    const female = groupCounts(buckets, 'Female')
    // 'female' (card a) and 'Female' (card b) are distinct chips, each seen once.
    expect(female.get('female')).toBe(1)
    expect(female.get('Female')).toBe(1)
    expect(female.get('woman')).toBe(0) // declared but never observed
  })

  it('matches variants case-insensitively via norm', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    const romance = groupCounts(buckets, 'Romance')
    expect(romance.get('romance')).toBe(1)
    expect(romance.get('ROMANTIC')).toBe(1) // norm('ROMANTIC') === 'romantic'
  })

  it('dedupes tags case-insensitively within a single card', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    // card b lists 'Female' twice; it should count once.
    expect(groupCounts(buckets, 'Female').get('Female')).toBe(1)
  })

  it('routes junk to the removed bucket and out of unassigned', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    expect(buckets.removed.find((r) => r.tag === 'junk')?.count).toBe(1)
    expect(buckets.unassigned.find((u) => u.tag === 'junk')).toBeUndefined()
  })

  it('puts unmatched observed tags in unassigned', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    expect(buckets.unassigned.find((u) => u.tag === 'unmapped')?.count).toBe(1)
  })

  it('lets a canonical claim a tag that is also in removedTags (mapping wins)', () => {
    // 'girl' is both a Female variant and flagged as removed.
    const buckets = buildBuckets(
      [{ avatar: 'z.png', data: { tags: ['girl'] } }],
      mapping,
      ['girl'],
    )
    // The observed occurrence (count 1) is attributed to the canonical group...
    expect(groupCounts(buckets, 'Female').get('girl')).toBe(1)
    // ...while the removed list still shows the declared entry, but only as a
    // count-0 seed (the observed hit did not land here).
    expect(buckets.removed.find((r) => r.tag === 'girl')?.count).toBe(0)
  })

  it('aggregates avatars per variant', () => {
    const buckets = buildBuckets(characters, mapping, removedTags)
    const female = buckets.groups.find((g) => g.canonical === 'Female')!
    const femaleVariant = female.variants.find((v) => v.tag === 'female')!
    expect(femaleVariant.avatars).toEqual(['a.png'])
  })
})

// ── declared vs discovered ──────────────────────────────────────────────────

function variantIn(
  list: ReturnType<typeof buildBuckets>['unassigned'],
  tag: string,
) {
  return list.find((v) => v.tag === tag)
}

describe('buildBuckets — declared vs discovered', () => {
  const buckets = buildBuckets(characters, mapping, removedTags)

  it('flags an exact declared alias as declared, whether or not it is observed', () => {
    const female = buckets.groups.find(
      (g) => g.canonical === 'Female',
    )!.variants
    expect(variantIn(female, 'female')!.declared).toBe(true) // observed, exact declared match
    expect(variantIn(female, 'woman')!.declared).toBe(true) // declared, unobserved (count 0)
  })

  it('flags an observed tag that only matches by normalizing as discovered', () => {
    const female = buckets.groups.find(
      (g) => g.canonical === 'Female',
    )!.variants
    // 'Female' is never itself a declared alias — it only matched by
    // normalizing to the same key as the declared 'female'.
    expect(variantIn(female, 'Female')!.declared).toBe(false)

    const romance = buckets.groups.find(
      (g) => g.canonical === 'Romance',
    )!.variants
    expect(variantIn(romance, 'ROMANTIC')!.declared).toBe(false) // declared alias is 'romantic'
  })

  it('applies the same declared/discovered split to the removed bucket', () => {
    expect(variantIn(buckets.removed, 'junk')!.declared).toBe(true) // exact declared junk
  })
})

// ── buildApplyPayload() ──────────────────────────────────────────────────────

describe('buildApplyPayload', () => {
  const cards = (...tagLists: string[][]): CardLike[] =>
    tagLists.map((tags, i) => ({ avatar: `c${i}.png`, tags }))

  it('emits one literal rename per observed spelling', () => {
    const plan = buildApplyPayload(
      cards(['girl'], ['woman', 'Female'], ['female']),
      { Female: ['girl', 'woman'] },
      [],
    )
    // 'Female' is skipped — renaming a tag to itself is a no-op — but the
    // lowercase 'female' still needs an entry to get its casing fixed.
    expect(plan.rename).toEqual({
      girl: 'Female',
      woman: 'Female',
      female: 'Female',
    })
  })

  it('omits declared aliases that no card uses', () => {
    const plan = buildApplyPayload(
      cards(['girl']),
      { Female: ['girl', 'woman', 'lady'] },
      [],
    )
    expect(plan.rename).toEqual({ girl: 'Female' })
  })

  it('omits removed tags that no card uses', () => {
    const plan = buildApplyPayload(cards(['anypov']), {}, [
      'anypov',
      'oc',
      'selfies',
    ])
    expect(plan.remove).toEqual(['anypov'])
  })

  it('leaves unassigned tags out of the plan entirely', () => {
    const plan = buildApplyPayload(
      cards(['dragons', 'girl']),
      { Female: ['girl'] },
      [],
    )
    expect(plan.rename).toEqual({ girl: 'Female' })
    expect(plan.remove).toEqual([])
  })

  it('never emits a tag in both rename and remove (mapping wins)', () => {
    const plan = buildApplyPayload(
      cards(['sharingabed']),
      { 'Forced Proximity': ['sharingabed'] },
      ['sharingabed'],
    )
    expect(plan.rename).toEqual({ sharingabed: 'Forced Proximity' })
    expect(plan.remove).toEqual([])
  })

  it('is empty when the dictionary changes nothing on these cards', () => {
    const plan = buildApplyPayload(cards(['Female']), { Female: ['girl'] }, [
      'oc',
    ])
    expect(plan.rename).toEqual({})
    expect(plan.remove).toEqual([])
  })

  it('preserves the exact card spelling as the key, including a leading #', () => {
    const plan = buildApplyPayload(
      cards(['#Girl', '  woman ']),
      { Female: ['girl', 'woman'] },
      [],
    )
    expect(plan.rename).toEqual({ '#Girl': 'Female', '  woman ': 'Female' })
  })

  it('handles a missing removedTags list', () => {
    expect(buildApplyPayload(cards(['girl']), { Female: ['girl'] })).toEqual({
      rename: { girl: 'Female' },
      remove: [],
    })
  })
})

// ── glob match rules ─────────────────────────────────────────────────────────

describe('parsePattern', () => {
  it('recognises the three anchored forms', () => {
    expect(parsePattern('*monster*')).toMatchObject({
      kind: 'contains',
      needle: 'monster',
    })
    expect(parsePattern('monster*')).toMatchObject({
      kind: 'prefix',
      needle: 'monster',
    })
    expect(parsePattern('*monster')).toMatchObject({
      kind: 'suffix',
      needle: 'monster',
    })
  })

  it('normalizes the needle the same way card tags are normalized', () => {
    expect(parsePattern('*Monster Girl*')!.needle).toBe('monster girl')
    expect(parsePattern('*  SPACED  *')!.needle).toBe('spaced')
  })

  // Failing "not a pattern" is the safe direction: the entry falls through as
  // an ordinary literal alias rather than becoming a surprise global matcher.
  for (const entry of ['monster', '', '*', '**', 'a*b', '*a*b*']) {
    it(`treats ${JSON.stringify(entry)} as a literal, not a rule`, () => {
      expect(parsePattern(entry)).toBeNull()
      expect(isPattern(entry)).toBe(false)
    })
  }
})

describe('matchPattern precedence', () => {
  const rules = sortPatterns([
    { ...parsePattern('*girl*')!, canonical: 'Broad' },
    { ...parsePattern('*monstergirl*')!, canonical: 'Specific' },
    { ...parsePattern('*monster*')!, canonical: 'Medium' },
  ])

  it('picks the longest matching needle', () => {
    expect(matchPattern(rules, 'amonstergirlx')!.canonical).toBe('Specific')
    expect(matchPattern(rules, 'monsterbear')!.canonical).toBe('Medium')
    expect(matchPattern(rules, 'catgirl')!.canonical).toBe('Broad')
  })

  it('prefers an anchored rule over an unanchored one of equal length', () => {
    const tie = sortPatterns([
      { ...parsePattern('*elf*')!, canonical: 'Loose' },
      { ...parsePattern('elf*')!, canonical: 'Anchored' },
    ])
    expect(matchPattern(tie, 'elfgirl')!.canonical).toBe('Anchored')
    expect(matchPattern(tie, 'halfelfx')!.canonical).toBe('Loose') // anchored can't match
  })

  it('is independent of input order', () => {
    const reversed = sortPatterns([...rules].reverse())
    expect(matchPattern(reversed, 'amonstergirlx')!.canonical).toBe('Specific')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchPattern(rules, 'dragons')).toBeUndefined()
  })
})

describe('splitEntries', () => {
  it('separates rules from literal aliases', () => {
    expect(splitEntries(['monster', '*monster*', 'monsters'])).toEqual({
      aliases: ['monster', 'monsters'],
      patterns: ['*monster*'],
    })
  })
})

describe('buildBuckets with rules', () => {
  const card = (...tags: string[]): CardLike => ({
    avatar: 'a.png',
    data: { tags },
  })

  it('claims an otherwise-unassigned tag and records which rule did it', () => {
    const b = buildBuckets(
      [card('monsterbeargirl')],
      { 'Non-Human': ['*monster*'] },
      [],
    )
    const g = b.groups.find((x) => x.canonical === 'Non-Human')!
    expect(g.variants.map((v) => v.tag)).toEqual(['monsterbeargirl'])
    expect(g.variants[0]).toMatchObject({
      declared: false,
      matchedBy: 'pattern:*monster*',
    })
    expect(b.unassigned).toEqual([])
  })

  // The load-bearing guarantee: rules are a fallback, so any literal entry —
  // including a user's override — outranks them.
  it('lets a literal alias elsewhere beat a rule', () => {
    const b = buildBuckets(
      [card('monstergirl')],
      { 'Non-Human': ['*monster*'], 'Demi-Human': ['monstergirl'] },
      [],
    )
    expect(
      b.groups
        .find((g) => g.canonical === 'Demi-Human')!
        .variants.map((v) => v.tag),
    ).toEqual(['monstergirl'])
    expect(b.groups.find((g) => g.canonical === 'Non-Human')!.variants).toEqual(
      [],
    )
  })

  it('lets a literal removal beat a rule', () => {
    const b = buildBuckets(
      [card('monsterpov')],
      { 'Non-Human': ['*monster*'] },
      ['monsterpov'],
    )
    expect(b.removed.find((r) => r.tag === 'monsterpov')!.count).toBe(1)
  })

  it('does not render a rule as a chip, but exposes it on the group', () => {
    const b = buildBuckets([], { 'Non-Human': ['*monster*', 'monsters'] }, [])
    const g = b.groups.find((x) => x.canonical === 'Non-Human')!
    expect(g.variants.map((v) => v.tag)).toEqual(['monsters'])
    expect(g.patterns).toEqual(['*monster*'])
  })

  it('supports removal rules, and lets a mapping rule rescue from one', () => {
    const b = buildBuckets(
      [card('selfies', 'monsterselfie')],
      { 'Non-Human': ['*monster*'] },
      ['*selfie*'],
    )
    expect(b.removed.find((r) => r.tag === 'selfies')).toMatchObject({
      matchedBy: 'pattern:*selfie*',
    })
    // 'monsterselfie' matches both; the mapping tier is consulted first.
    expect(
      b.groups
        .find((g) => g.canonical === 'Non-Human')!
        .variants.map((v) => v.tag),
    ).toEqual(['monsterselfie'])
    expect(b.removedPatterns).toEqual(['*selfie*'])
  })

  it('tags literal and norm matches with matchedBy too', () => {
    const b = buildBuckets(
      [card('FEMALE', 'girl')],
      { Female: ['female', 'girl'] },
      [],
    )
    const g = b.groups.find((x) => x.canonical === 'Female')!
    expect(g.variants.find((v) => v.tag === 'girl')!.matchedBy).toBe('declared')
    expect(g.variants.find((v) => v.tag === 'FEMALE')!.matchedBy).toBe('norm')
  })

  it('is a no-op for a dictionary with no rules', () => {
    const b = buildBuckets([card('dragons')], { Female: ['girl'] }, [])
    expect(b.unassigned.map((v) => v.tag)).toEqual(['dragons'])
    expect(b.groups.every((g) => g.patterns.length === 0)).toBe(true)
  })
})

describe('buildApplyPayload with rules', () => {
  // Rules never reach the server: they are resolved here into literal renames,
  // which is what keeps the server a string-equality lookup.
  it('emits a literal rename for a rule-captured tag', () => {
    const plan = buildApplyPayload(
      [{ avatar: 'a.png', data: { tags: ['monsterbeargirl'] } }],
      { 'Non-Human': ['*monster*'] },
      [],
    )
    expect(plan.rename).toEqual({ monsterbeargirl: 'Non-Human' })
  })

  it('never emits the rule itself', () => {
    const plan = buildApplyPayload([], { 'Non-Human': ['*monster*'] }, [
      '*selfie*',
    ])
    expect(plan).toEqual({ rename: {}, remove: [] })
  })

  it('emits a literal removal for a rule-captured junk tag', () => {
    const plan = buildApplyPayload(
      [{ avatar: 'a.png', data: { tags: ['beachselfie'] } }],
      {},
      ['*selfie*'],
    )
    expect(plan.remove).toEqual(['beachselfie'])
  })
})
