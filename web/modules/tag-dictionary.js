/**
 * tag-dictionary.js -- Phase 5B: the dictionary-ownership layer for the tag
 * editor. Port of SillyTavern-Character-Tools/index.js lines 31-156, minus the
 * legacy full-dictionary migration (we have never persisted a dictionary in
 * any form, so there is nothing to migrate) and minus getExtSettings (we use
 * CoreAPI.getSetting/setSetting, with defaulting in DEFAULT_SETTINGS instead).
 *
 * Pure-ish and DOM-free on purpose -- this is the part web/tests/ can cover,
 * since there is no jsdom (see web/tests/README.md). The base dictionary can
 * run to hundreds of canonicals, but a session's edits are almost always a
 * handful of moves, so only the delta from the base is persisted (see
 * ../vendor/tag-tools/tag-delta.js) -- not the whole expanded dictionary.
 */
import * as CoreAPI from './core-api.js';
import { diffDictionary, applyDelta } from '../vendor/tag-tools/tag-delta.js';

const BASE_URL = new URL('../vendor/tag-tools/tag-dictionary.json', import.meta.url);
let baseDictCache = null;

/**
 * Fetch and flatten the shipped base dictionary. Cached -- it's a static file.
 * @returns {Promise<{mapping: Object<string,string[]>, removedTags: string[], canonicalCategories: Object<string,string>, categoryOrder: string[]}|null>}
 */
export async function loadBaseDictionary() {
    if (baseDictCache) return baseDictCache;
    try {
        const res = await fetch(BASE_URL);
        if (!res.ok) return null;
        const json = await res.json();
        const mapping = {};
        const canonicalCategories = {};
        const categoryOrder = Object.keys(json?.mapping ?? {});
        for (const [cat, canonicals] of Object.entries(json?.mapping ?? {})) {
            for (const [canonical, aliases] of Object.entries(canonicals)) {
                mapping[canonical] = Array.isArray(aliases) ? aliases : [];
                canonicalCategories[canonical] = cat;
            }
        }
        baseDictCache = {
            mapping,
            removedTags: Array.isArray(json?.removedTags) ? json.removedTags : [],
            canonicalCategories,
            categoryOrder,
        };
        return baseDictCache;
    } catch (e) {
        console.error('[TagDictionary] failed to load tag-dictionary.json', e);
        return null;
    }
}

/**
 * Return the user's working dictionary: the shipped base plus the persisted
 * delta, with category metadata from the base attached.
 * @returns {Promise<{mapping: Object<string,string[]>, removedTags: string[], canonicalCategories: Object<string,string>, categoryOrder: string[], baseMapping: Object<string,string[]>, baseRemovedTags: string[]}>}
 */
export async function ensureDictionary() {
    const base = await loadBaseDictionary();
    const delta = CoreAPI.getSetting('tagDictionaryDelta') ?? { overrides: {}, blanks: {} };
    const working = base ? applyDelta(base, delta) : { mapping: {}, removedTags: [] };
    return {
        mapping: working.mapping,
        removedTags: working.removedTags,
        canonicalCategories: base?.canonicalCategories ?? {},
        categoryOrder: base?.categoryOrder ?? [],
        baseMapping: base?.mapping ?? {},
        baseRemovedTags: base?.removedTags ?? [],
    };
}

/**
 * Persist the working dictionary as a delta against the base.
 * No-ops if the base fails to load -- diffing against an empty base would
 * emit an override for every tag in the dictionary, permanently bloating
 * data/settings.json and pinning the user to today's dictionary.
 * @param {Object<string,string[]>} mapping
 * @param {string[]} removedTags
 */
export async function saveDictionary(mapping, removedTags) {
    const base = await loadBaseDictionary();
    if (!base) return;
    CoreAPI.setSetting('tagDictionaryDelta', diffDictionary(base, { mapping, removedTags }));
}

/**
 * Rebuild the {mapping, removed} dictionary from live editor state.
 *
 * Only `declared` variants are written out -- chips that are only showing
 * because a card's tag matched via norm() or a glob rule reattach
 * automatically on every future load, so persisting them would re-declare
 * every incidental spelling a card happens to use as if it were an
 * intentional alias.
 *
 * Glob rules are re-emitted verbatim alongside the literal aliases. They are
 * core-dictionary-only and the UI offers no way to add, edit or move one;
 * this is purely round-tripping what the shipped dictionary already declared.
 *
 * @param {{groups: Array<{canonical:string, variants: Array<{tag:string, declared:boolean}>, patterns?: string[]}>, removed: Array<{tag:string, declared:boolean}>, removedPatterns?: string[]}} state
 * @returns {{mapping: Object<string,string[]>, removed: string[]}}
 */
export function rebuildMapping(state) {
    const mapping = {};
    for (const g of state.groups) {
        if (!g.canonical) continue;
        mapping[g.canonical] = [...g.variants.filter(v => v.declared).map(v => v.tag), ...(g.patterns ?? [])];
    }
    const removed = [...state.removed.filter(v => v.declared).map(v => v.tag), ...(state.removedPatterns ?? [])];
    return { mapping, removed };
}

/** Stable string for dirty-checking a dictionary regardless of key/array order. */
export function dictSnapshot(mapping, removedTags) {
    const m = {};
    for (const k of Object.keys(mapping).sort()) m[k] = [...mapping[k]].sort();
    return JSON.stringify({ m, r: [...removedTags].sort() });
}
