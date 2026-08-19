// tag-delta.ts
// Pure diff/reconstruct helpers for the persisted tag dictionary. No DOM, no
// SillyTavern globals. Ported verbatim (behaviour unchanged) from
// web/vendor/tag-tools/tag-delta.js as salvage item 2 of the UI rewrite
// (docs/UI_REWRITE_PLAN.md §2); its test suite comes across as the acceptance
// gate (tag-delta.test.ts).
//
// The settings blob persists only the delta between the shipped base dictionary
// and the user's working copy, not the whole expanded dictionary: the base can
// run to hundreds of canonicals, but a session's edits are almost always a
// handful of moves. Storing the full copy also froze a user's dictionary at
// whatever the base looked like when first seeded, since nothing distinguished
// "the base" from "what the user changed" after that. Diffing against the base
// at save time and replaying the diff over the (always-current) base at load
// time fixes both: settings stay small, and updates to the shipped dictionary
// keep flowing through for anything the user hasn't touched.
//
// Glob match rules (`*monster*`) ride through here as ordinary entries so they
// reconstruct with the rest of the mapping, but they are never diffed into the
// delta and never honoured out of it — see the isPattern() guards below. That is
// what keeps them core-dictionary-only: the delta is the only channel a user's
// edits travel through, so a rule that can't enter it can't be authored, moved
// or deleted by a user.

import { isPattern, type Mapping } from './tag-analysis'

export interface Dictionary {
  mapping: Mapping
  removedTags: string[]
}

type Placement =
  { canonical: string } | { removed: true } | { unassigned: true }

export interface Delta {
  overrides?: Record<string, Placement>
  blanks?: Record<string, boolean>
}

/**
 * Build a tag -> placement lookup ({canonical} | {removed:true}) from a full
 * dictionary, plus the set of canonicals with zero aliases. A canonical with
 * no aliases has no tag to hang a placement off, so its bare existence has to
 * be tracked separately.
 */
function placementsOf({ mapping, removedTags }: Dictionary): {
  placements: Map<string, Placement>
  blanks: Set<string>
} {
  const placements = new Map<string, Placement>()
  const blanks = new Set<string>()
  for (const [canonical, aliases] of Object.entries(mapping ?? {})) {
    if (!aliases || aliases.length === 0) {
      blanks.add(canonical)
      continue
    }
    for (const a of aliases) placements.set(a, { canonical })
  }
  for (const t of removedTags ?? []) placements.set(t, { removed: true })
  return { placements, blanks }
}

const samePlacement = (a: Placement | null, b: Placement | null): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Diff a full working dictionary against the shipped base. Returns the minimal
 * delta needed to reconstruct `current` from `base` via {@link applyDelta}:
 * `overrides` holds only the tags whose placement differs from the base
 * (moved to a different canonical, removed, or un-removed/unassigned), and
 * `blanks` holds only the canonical names whose "has zero aliases" state
 * differs from the base (a brand-new empty canonical, or a base one the user
 * deleted while it had none).
 */
export function diffDictionary(
  base: Dictionary,
  current: Dictionary,
): Required<Delta> {
  const b = placementsOf(base)
  const c = placementsOf(current)

  const overrides: Record<string, Placement> = {}
  for (const tag of new Set([...b.placements.keys(), ...c.placements.keys()])) {
    if (isPattern(tag)) continue // core-only; never a user edit
    const bp = b.placements.get(tag) ?? null
    const cp = c.placements.get(tag) ?? null
    if (!samePlacement(bp, cp)) overrides[tag] = cp ?? { unassigned: true }
  }

  // A canonical with ≥1 alias in `current` already exists via its alias
  // overrides above, so it never needs a blanks entry — only record one when
  // adding a genuinely blank canonical, or canceling a base blank that
  // `current` doesn't merely repopulate but drops outright.
  const blanks: Record<string, boolean> = {}
  for (const name of new Set([...b.blanks, ...c.blanks])) {
    const inBase = b.blanks.has(name)
    const inCurrent = c.blanks.has(name)
    if (inBase === inCurrent) continue
    if (inCurrent) {
      blanks[name] = true
      continue
    }
    const stillPopulated = (current.mapping?.[name]?.length ?? 0) > 0
    if (!stillPopulated) blanks[name] = false
  }

  return { overrides, blanks }
}

/**
 * Reconstruct the full working dictionary by layering a delta (as produced by
 * {@link diffDictionary}) over the shipped base.
 */
export function applyDelta(base: Dictionary, delta: Delta): Dictionary {
  const { placements, blanks } = placementsOf(base)
  for (const [tag, placement] of Object.entries(delta?.overrides ?? {})) {
    // Glob match rules (`*monster*`) are core-dictionary-only. The editor
    // renders them inert and never emits one, so an override keyed by a
    // pattern can only come from a hand-edited or corrupted settings blob —
    // honouring it would let a user relocate or delete a global matcher, or
    // invent one. Drop it and let the base's own rule stand.
    if (isPattern(tag)) continue
    if ('unassigned' in placement && placement.unassigned)
      placements.delete(tag)
    else placements.set(tag, placement)
  }
  for (const [name, present] of Object.entries(delta?.blanks ?? {})) {
    if (present) blanks.add(name)
    else blanks.delete(name)
  }

  const mapping: Mapping = {}
  for (const name of blanks) mapping[name] = []
  const removedTags: string[] = []
  for (const [tag, placement] of placements) {
    if ('canonical' in placement)
      (mapping[placement.canonical] ??= []).push(tag)
    else removedTags.push(tag)
  }
  return { mapping, removedTags }
}
