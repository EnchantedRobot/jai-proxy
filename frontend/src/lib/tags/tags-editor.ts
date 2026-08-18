// tags-editor.ts — the tag editor's state model.
//
// Ported from web/modules/tag-manager.js (behaviour unchanged), turned from
// mutable module state + full re-render into immutable transforms the React
// page holds in `useState`. The projection back to a dictionary is
// rebuildMapping (dictionary.ts) and the plan projection is buildApplyPayload
// (tag-analysis.ts) — the same functions the old UI used, so what is previewed
// is what lands on disk.

import {
  buildBuckets,
  getCardTags,
  pickCanonical,
  type ApplyPayload,
  type Buckets,
  type CardLike,
  type Mapping,
  type Variant,
} from './tag-analysis'

export interface EditorGroup {
  id: string
  canonical: string
  variants: Variant[]
  /** Inert glob rules for this canonical — rendered, never moved, always saved. */
  patterns: string[]
  category: string
}

export interface EditorState {
  groups: EditorGroup[]
  unassigned: Variant[]
  removed: Variant[]
  removedPatterns: string[]
  /** Monotonic id source for freshly-created groups. */
  seq: number
}

/** Where a variant lives: a group, or one of the two flat buckets. */
export type Bucket = 'unassigned' | 'removed'
export type MoveTo = EditorGroup | Bucket | 'new'
export type MoveFrom = EditorGroup | Bucket

export interface PlanStats {
  renames: number
  removals: number
  affectedCards: number
  vocabBefore: number
  vocabAfter: number
}

/**
 * The staged-change stats shown above the editor, derived from the SAME literal
 * plan the server would apply — not a second interpretation of it. Mirrors
 * tag-manager.js `computeStats`. `affectedCards` is exact because it is counted
 * over the real cards (the whole archive is fetched for this page, §3.5).
 */
export function computeStats(
  characters: CardLike[],
  plan: ApplyPayload,
): PlanStats {
  const removeSet = new Set(plan.remove)
  const before = new Set<string>()
  const after = new Set<string>()
  let affectedCards = 0

  for (const char of characters) {
    const tags = getCardTags(char)
    let changed = false
    for (const tag of tags) {
      before.add(tag)
      if (removeSet.has(tag)) {
        changed = true
        continue
      }
      const mapped = plan.rename[tag] ?? tag
      if (mapped !== tag) changed = true
      after.add(mapped)
    }
    if (changed) affectedCards++
  }

  return {
    renames: Object.keys(plan.rename).length,
    removals: plan.remove.length,
    affectedCards,
    vocabBefore: before.size,
    vocabAfter: after.size,
  }
}

/** Build editor state from a dictionary surveyed against the cards. */
export function buildEditorState(
  characters: CardLike[],
  mapping: Mapping,
  removedTags: string[],
  canonicalCategories: Record<string, string>,
  startSeq = 0,
): EditorState {
  const buckets: Buckets = buildBuckets(characters, mapping, removedTags)
  let seq = startSeq
  return {
    groups: buckets.groups.map((g) => ({
      id: `g${seq++}`,
      canonical: g.canonical,
      variants: g.variants,
      patterns: g.patterns,
      category: canonicalCategories[g.canonical] ?? '',
    })),
    unassigned: buckets.unassigned,
    removed: buckets.removed,
    removedPatterns: buckets.removedPatterns,
    seq,
  }
}

function withDeclared(v: Variant, declared: boolean): Variant {
  return { ...v, declared }
}

/** Remove a variant from wherever it currently lives, returning fresh containers. */
function removeFrom(state: EditorState, variant: Variant, from: MoveFrom) {
  if (from === 'unassigned') {
    return {
      ...state,
      unassigned: state.unassigned.filter((v) => v !== variant),
    }
  }
  if (from === 'removed') {
    return { ...state, removed: state.removed.filter((v) => v !== variant) }
  }
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === from.id
        ? { ...g, variants: g.variants.filter((v) => v !== variant) }
        : g,
    ),
  }
}

/** Drop any group that a move has left with no variants and no rules. */
function pruneEmptyGroups(groups: EditorGroup[]): EditorGroup[] {
  return groups.filter((g) => g.variants.length > 0 || g.patterns.length > 0)
}

/**
 * Move one variant between groups / unassigned / removed / a new group.
 * Mirrors tag-manager.js `moveVariant`: destination edits set `declared`, and an
 * emptied source group is pruned (a group holding a rule is never emptied here
 * because rules cannot be moved).
 */
export function moveVariant(
  state: EditorState,
  variant: Variant,
  from: MoveFrom,
  to: MoveTo,
): EditorState {
  let next = removeFrom(state, variant, from)
  let seq = next.seq

  if (to === 'unassigned') {
    const moved = withDeclared(variant, false)
    next = { ...next, unassigned: [...next.unassigned, moved] }
  } else if (to === 'removed') {
    const moved = withDeclared(variant, true)
    next = { ...next, removed: [...next.removed, moved] }
  } else if (to === 'new') {
    const moved = withDeclared(variant, true)
    next = {
      ...next,
      groups: [
        ...next.groups,
        {
          id: `g${seq++}`,
          canonical: pickCanonical([moved]),
          variants: [moved],
          patterns: [],
          category: '',
        },
      ],
    }
  } else {
    const moved = withDeclared(variant, true)
    next = {
      ...next,
      groups: next.groups.map((g) =>
        g.id === to.id ? { ...g, variants: [...g.variants, moved] } : g,
      ),
    }
  }

  return { ...next, groups: pruneEmptyGroups(next.groups), seq }
}

/**
 * Move a selection of variants out of one flat bucket. Mirrors tag-manager.js
 * `bulkMoveSelected`: the source is always a bucket (unassigned/removed), the
 * destination is a group, the opposite bucket, or a single new group holding
 * them all.
 */
export function bulkMove(
  state: EditorState,
  variants: Variant[],
  from: Bucket,
  to: MoveTo,
): EditorState {
  const moving = new Set(variants)
  let next: EditorState = {
    ...state,
    unassigned:
      from === 'unassigned'
        ? state.unassigned.filter((v) => !moving.has(v))
        : state.unassigned,
    removed:
      from === 'removed'
        ? state.removed.filter((v) => !moving.has(v))
        : state.removed,
  }
  let seq = next.seq

  if (to === 'new') {
    const declared = variants.map((v) => withDeclared(v, true))
    next = {
      ...next,
      groups: [
        ...next.groups,
        {
          id: `g${seq++}`,
          canonical: pickCanonical(declared),
          variants: declared,
          patterns: [],
          category: '',
        },
      ],
    }
  } else if (to === 'removed') {
    next = {
      ...next,
      removed: [...next.removed, ...variants.map((v) => withDeclared(v, true))],
    }
  } else if (to === 'unassigned') {
    next = {
      ...next,
      unassigned: [
        ...next.unassigned,
        ...variants.map((v) => withDeclared(v, false)),
      ],
    }
  } else {
    const declared = variants.map((v) => withDeclared(v, true))
    next = {
      ...next,
      groups: next.groups.map((g) =>
        g.id === to.id ? { ...g, variants: [...g.variants, ...declared] } : g,
      ),
    }
  }

  return { ...next, seq }
}

/** Add a fresh, empty canonical. Mirrors `onNewEmptyGroup`. */
export function newEmptyGroup(
  state: EditorState,
  canonical = 'New Tag',
): EditorState {
  return {
    ...state,
    groups: [
      ...state.groups,
      {
        id: `g${state.seq}`,
        canonical,
        variants: [],
        patterns: [],
        category: '',
      },
    ],
    seq: state.seq + 1,
  }
}

/** Rename a canonical (the row's text field). Empty falls back to the old name. */
export function renameCanonical(
  state: EditorState,
  groupId: string,
  name: string,
): EditorState {
  const trimmed = name.trim()
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === groupId ? { ...g, canonical: trimmed || g.canonical } : g,
    ),
  }
}

/**
 * Delete a canonical, sending its variants back to Unassigned. Refuses (returns
 * the state unchanged with `blocked` set) when the group holds a glob rule,
 * which is core-dictionary-only and would be silently destroyed. Mirrors the
 * row-dismiss handler.
 */
export function deleteGroup(
  state: EditorState,
  groupId: string,
): { state: EditorState; blocked?: EditorGroup } {
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return { state }
  if (group.patterns.length > 0) return { state, blocked: group }
  return {
    state: {
      ...state,
      groups: state.groups.filter((g) => g.id !== groupId),
      unassigned: [
        ...state.unassigned,
        ...group.variants.map((v) => withDeclared(v, false)),
      ],
    },
  }
}
