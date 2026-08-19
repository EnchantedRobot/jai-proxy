import { describe, it, expect } from 'vitest'
import type { CardLike } from './tag-analysis'
import { rebuildMapping } from './dictionary'
import {
  buildEditorState,
  bulkMove,
  computeStats,
  deleteGroup,
  moveVariant,
  newEmptyGroup,
  renameCanonical,
  type EditorState,
} from './tags-editor'
import { buildApplyPayload } from './tag-analysis'

const cards: CardLike[] = [
  { avatar: 'a.png', tags: ['girl', 'romance', 'junk'] },
  { avatar: 'b.png', tags: ['woman', 'romance'] },
  { avatar: 'c.png', tags: ['dragons'] },
]
const mapping = { Female: ['girl', 'woman'], Romance: ['romance'] }
const removed = ['junk']
const cats = { Female: 'Gender', Romance: 'Genre' }

function build(): EditorState {
  return buildEditorState(cards, mapping, removed, cats)
}

const groupBy = (s: EditorState, canonical: string) =>
  s.groups.find((g) => g.canonical === canonical)!
const variantOf = (s: EditorState, canonical: string, tag: string) =>
  groupBy(s, canonical).variants.find((v) => v.tag === tag)!

describe('buildEditorState', () => {
  it('lays out groups, buckets and categories from a survey', () => {
    const s = build()
    expect(groupBy(s, 'Female').category).toBe('Gender')
    expect(
      groupBy(s, 'Female')
        .variants.map((v) => v.tag)
        .sort(),
    ).toEqual(['girl', 'woman'])
    expect(s.unassigned.map((v) => v.tag)).toEqual(['dragons'])
    expect(s.removed.find((v) => v.tag === 'junk')!.count).toBe(1)
  })
})

describe('moveVariant', () => {
  it('moves a variant between groups and prunes an emptied source', () => {
    const s = build()
    const romance = groupBy(s, 'Romance')
    const female = groupBy(s, 'Female')
    // Romance holds only 'romance'; moving it out should drop the whole group.
    const next = moveVariant(
      s,
      variantOf(s, 'Romance', 'romance'),
      romance,
      female,
    )
    expect(next.groups.find((g) => g.canonical === 'Romance')).toBeUndefined()
    const moved = groupBy(next, 'Female').variants.find(
      (v) => v.tag === 'romance',
    )!
    expect(moved.declared).toBe(true)
  })

  it('unassign leaves the variant undeclared', () => {
    const s = build()
    const female = groupBy(s, 'Female')
    const next = moveVariant(
      s,
      variantOf(s, 'Female', 'girl'),
      female,
      'unassigned',
    )
    const u = next.unassigned.find((v) => v.tag === 'girl')!
    expect(u.declared).toBe(false)
    expect(groupBy(next, 'Female').variants.map((v) => v.tag)).toEqual([
      'woman',
    ])
  })

  it('new makes a fresh group named by pickCanonical', () => {
    const s = build()
    const next = moveVariant(s, s.unassigned[0], 'unassigned', 'new')
    expect(next.groups.some((g) => g.canonical === 'Dragons')).toBe(true)
    expect(next.unassigned).toEqual([])
  })

  it('is immutable — the input state is untouched', () => {
    const s = build()
    const before = JSON.stringify(s)
    moveVariant(
      s,
      variantOf(s, 'Female', 'girl'),
      groupBy(s, 'Female'),
      'removed',
    )
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('bulkMove', () => {
  it('moves a selection into one new group (not one group per tag)', () => {
    const s = build()
    // Put two tags in Unassigned first.
    const s2 = moveVariant(
      s,
      variantOf(s, 'Female', 'girl'),
      groupBy(s, 'Female'),
      'unassigned',
    )
    const s3 = moveVariant(
      s2,
      variantOf(s2, 'Female', 'woman'),
      groupBy(s2, 'Female'),
      'unassigned',
    )
    const picks = s3.unassigned.filter(
      (v) => v.tag === 'girl' || v.tag === 'woman',
    )
    const next = bulkMove(s3, picks, 'unassigned', 'new')
    const added = next.groups.filter((g) =>
      g.variants.some((v) => v.tag === 'girl' || v.tag === 'woman'),
    )
    expect(added).toHaveLength(1)
    expect(added[0].variants.map((v) => v.tag).sort()).toEqual([
      'girl',
      'woman',
    ])
  })
})

describe('deleteGroup', () => {
  it('sends variants back to Unassigned', () => {
    const s = build()
    const { state } = deleteGroup(s, groupBy(s, 'Female').id)
    expect(state.groups.find((g) => g.canonical === 'Female')).toBeUndefined()
    expect(state.unassigned.map((v) => v.tag).sort()).toContain('girl')
  })

  it('refuses to delete a group holding a glob rule', () => {
    const s = buildEditorState(cards, { 'Non-Human': ['*monster*'] }, [], {})
    const { state, blocked } = deleteGroup(s, s.groups[0].id)
    expect(blocked).toBeDefined()
    expect(state.groups).toHaveLength(1)
  })
})

describe('rename + rebuild round-trip', () => {
  it('renaming a canonical carries its variants into the plan', () => {
    const s = build()
    const renamed = renameCanonical(s, groupBy(s, 'Female').id, 'Woman')
    const { mapping: m, removedTags: r } = rebuildMapping(renamed)
    const plan = buildApplyPayload(cards, m, r)
    expect(plan.rename.girl).toBe('Woman')
    expect(plan.rename.woman).toBe('Woman')
  })

  it('rebuildMapping only writes declared variants', () => {
    // 'ROMANTIC'-style discovered variants must not be persisted; here every
    // declared alias round-trips and nothing extra is invented.
    const s = build()
    const { mapping: m } = rebuildMapping(s)
    expect(m.Female.sort()).toEqual(['girl', 'woman'])
  })

  it('newEmptyGroup adds a blank canonical', () => {
    const s = newEmptyGroup(build(), 'Fresh')
    expect(
      s.groups.some((g) => g.canonical === 'Fresh' && g.variants.length === 0),
    ).toBe(true)
  })
})

describe('computeStats', () => {
  it('counts renames, removals and affected cards over the real cards', () => {
    const s = build()
    const { mapping: m, removedTags: r } = rebuildMapping(s)
    const plan = buildApplyPayload(cards, m, r)
    const stats = computeStats(cards, plan)
    // girl→Female, woman→Female, romance→Romance ... and junk removed.
    expect(stats.renames).toBeGreaterThan(0)
    expect(stats.removals).toBe(1)
    // cards a (girl,romance,junk) and b (woman,romance) change; c (dragons) does not.
    expect(stats.affectedCards).toBe(2)
  })
})
