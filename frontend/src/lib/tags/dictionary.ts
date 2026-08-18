// dictionary.ts — the dictionary-ownership layer for the tag editor.
//
// Ported from web/modules/tag-dictionary.js (behaviour unchanged), with two
// deliberate changes for the new app:
//   - the base dictionary is imported as a module (bundled), not fetched. It is
//     a static asset shipped with the client, so there is no reason to pay a
//     network round trip or handle a fetch failure for it.
//   - persistence is not wired here. These are pure functions over an explicit
//     `delta`; the settings read-modify-write lives in use-tag-dictionary.ts so
//     the §3.7 whole-document-replace trap is handled in exactly one place.
//
// The base can run to hundreds of canonicals, but a session's edits are almost
// always a handful of moves, so only the delta from the base is persisted (see
// tag-delta.ts) — not the whole expanded dictionary.

import {
  applyDelta,
  diffDictionary,
  type Delta,
  type Dictionary,
} from './tag-delta'
import { isPattern, type Mapping, type Variant } from './tag-analysis'
import baseJson from './tag-dictionary.json'

/** The shipped dictionary's on-disk shape: category → canonical → aliases. */
interface BaseJson {
  mapping: Record<string, Record<string, string[]>>
  removedTags: string[]
}

export interface BaseDictionary extends Dictionary {
  /** canonical → the category it was shipped under. */
  canonicalCategories: Record<string, string>
  /** category names in dictionary order. */
  categoryOrder: string[]
}

export interface WorkingDictionary extends BaseDictionary {
  baseMapping: Mapping
  baseRemovedTags: string[]
}

let baseCache: BaseDictionary | null = null

/**
 * Flatten the shipped base dictionary from `category → canonical → aliases`
 * into `{ canonical: [alias…] }`, keeping the category metadata alongside.
 * Cached — it's a static, bundled asset.
 */
export function loadBaseDictionary(): BaseDictionary {
  if (baseCache) return baseCache
  const json = baseJson as BaseJson
  const mapping: Mapping = {}
  const canonicalCategories: Record<string, string> = {}
  const categoryOrder = Object.keys(json?.mapping ?? {})
  for (const [cat, canonicals] of Object.entries(json?.mapping ?? {})) {
    for (const [canonical, aliases] of Object.entries(canonicals)) {
      mapping[canonical] = Array.isArray(aliases) ? aliases : []
      canonicalCategories[canonical] = cat
    }
  }
  baseCache = {
    mapping,
    removedTags: Array.isArray(json?.removedTags) ? json.removedTags : [],
    canonicalCategories,
    categoryOrder,
  }
  return baseCache
}

/**
 * The user's working dictionary: the shipped base plus the persisted delta,
 * with category metadata from the base attached.
 */
export function ensureDictionary(
  delta: Delta | null | undefined,
): WorkingDictionary {
  const base = loadBaseDictionary()
  const working = applyDelta(base, delta ?? { overrides: {}, blanks: {} })
  return {
    mapping: working.mapping,
    removedTags: working.removedTags,
    canonicalCategories: base.canonicalCategories,
    categoryOrder: base.categoryOrder,
    baseMapping: base.mapping,
    baseRemovedTags: base.removedTags,
  }
}

/**
 * Diff a working dictionary against the shipped base into the delta that gets
 * persisted. The counterpart to {@link ensureDictionary}.
 */
export function dictionaryDelta(
  mapping: Mapping,
  removedTags: string[],
): Delta {
  const base = loadBaseDictionary()
  return diffDictionary(base, { mapping, removedTags })
}

/** State that {@link rebuildMapping} projects back into a dictionary. */
export interface EditorState {
  groups: Array<{ canonical: string; variants: Variant[]; patterns?: string[] }>
  removed: Variant[]
  removedPatterns?: string[]
}

/**
 * Rebuild the {mapping, removedTags} dictionary from live editor state.
 *
 * Only `declared` variants are written out — chips that are only showing
 * because a card's tag matched via norm() or a glob rule reattach automatically
 * on every future load, so persisting them would re-declare every incidental
 * spelling a card happens to use as if it were an intentional alias.
 *
 * Glob rules are re-emitted verbatim alongside the literal aliases. They are
 * core-dictionary-only and the UI offers no way to add, edit or move one; this
 * is purely round-tripping what the shipped dictionary already declared.
 */
export function rebuildMapping(state: EditorState): Dictionary {
  const mapping: Mapping = {}
  for (const g of state.groups) {
    if (!g.canonical) continue
    mapping[g.canonical] = [
      ...g.variants.filter((v) => v.declared).map((v) => v.tag),
      ...(g.patterns ?? []),
    ]
  }
  const removedTags = [
    ...state.removed.filter((v) => v.declared).map((v) => v.tag),
    ...(state.removedPatterns ?? []),
  ]
  return { mapping, removedTags }
}

/** Stable string for dirty-checking a dictionary regardless of key/array order. */
export function dictSnapshot(mapping: Mapping, removedTags: string[]): string {
  const m: Record<string, string[]> = {}
  for (const k of Object.keys(mapping).sort()) m[k] = [...mapping[k]].sort()
  return JSON.stringify({ m, r: [...removedTags].sort() })
}

/** True if a dictionary entry is a glob rule rather than a literal alias. */
export { isPattern }
