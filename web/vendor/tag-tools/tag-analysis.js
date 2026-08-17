// tag-analysis.js
// Pure tag logic — no DOM, no SillyTavern globals. Safe to import in a browser
// or run under Node.
//
// The live extension is mapping-driven: a persistent `{ canonical: [variant…] }`
// dictionary is the source of truth. This module turns the cards + that mapping
// into the editor's display buckets (buildBuckets), and projects those same
// buckets into the literal plan the server applies (buildApplyPayload). The base
// dictionary lives in tag-dictionary.json (category → canonical → aliases) and
// is flattened to { canonical: [alias…] } on load.
//
// ALL tag-matching semantics live here — norm(), alias lookup, canonical casing,
// mapping-beats-removal. The server holds none of it: it receives the resolved
// { rename, remove } plan and applies it by literal string equality. So this file
// is the single place a match decision is made, and because the editor and the
// plan are built from the same buildBuckets() call, the preview cannot disagree
// with what lands on disk. It still never rewrites a card itself — the write is
// the server's job (see the server plugin's tagMerge.ts).

/**
 * Normalize a tag to its match key: trim, strip leading '#', trim again,
 * collapse internal whitespace, lowercase. Applied to both the dictionary aliases
 * on load and to card tags at match time (so "#Female", "  female ", "FEMALE"
 * all resolve to the same entry).
 * @param {string} t
 * @returns {string}
 */
export function norm(t) {
    return String(t)
        .trim()
        .replace(/^#+/, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Read the embedded card tags off a SillyTavern character object.
 * Prefers data.tags (the real V2/V3 field) and falls back to the root mirror.
 * @param {object} char
 * @returns {string[]}
 */
export function getCardTags(char) {
    const tags = char?.data?.tags ?? char?.tags ?? [];
    return Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim() !== '') : [];
}

/**
 * Scan all characters and tally tag usage.
 * Tags are deduplicated per-card (case-insensitively) so a card that lists
 * "Female" twice only counts once.
 * @param {object[]} characters
 * @returns {Map<string, {count: number, avatars: Set<string>}>} keyed by the exact tag string
 */
function scanTags(characters) {
    const stats = new Map();
    for (const char of characters ?? []) {
        const avatar = char?.avatar ?? '';
        const seen = new Set(); // lowercase tags already counted for this card
        for (const tag of getCardTags(char)) {
            const lower = tag.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            let entry = stats.get(tag);
            if (!entry) {
                entry = { count: 0, avatars: new Set() };
                stats.set(tag, entry);
            }
            entry.count++;
            if (avatar) entry.avatars.add(avatar);
        }
    }
    return stats;
}

/**
 * Pick a clean display tag for a freshly-created group (e.g. "New group from
 * this tag"). Not used for the persisted mapping's existing keys.
 *
 * Priority:
 *   1. A variant that starts with a capital letter (no #) — most frequent wins,
 *      returned verbatim ("Arranged Marriage", "AnyPOV").
 *   2. A variant that starts with # then a capital — leading # stripped.
 *   3. Otherwise synthesise from the most-frequent variant: strip #, collapse
 *      separators, Title Case (unless it's already intentional mixed-case).
 * @param {Array<{tag:string,count:number}>} variants
 * @returns {string}
 */
export function pickCanonical(variants) {
    const byFreq = (a, b) => b.count - a.count || a.tag.localeCompare(b.tag);

    const cleanCaps = variants.filter(v => /^[A-Z]/.test(v.tag));
    if (cleanCaps.length > 0) return [...cleanCaps].sort(byFreq)[0].tag;

    const hashCaps = variants.filter(v => /^#+[A-Z]/.test(v.tag));
    if (hashCaps.length > 0) return [...hashCaps].sort(byFreq)[0].tag.replace(/^#+/, '');

    const top = [...variants].sort(byFreq)[0];
    const stripped = top.tag.replace(/^#+/, '');
    const isAllLower = stripped === stripped.toLowerCase();
    const isAllUpper = stripped === stripped.toUpperCase();
    if (!isAllLower && !isAllUpper) return stripped;

    return stripped
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
        .join(' ');
}

// ── Pattern entries ─────────────────────────────────────────────────────────
//
// A dictionary entry wrapped in `*` is a glob rule rather than a literal alias:
// `*monster*` contains, `monster*` starts-with, `*monster` ends-with. They exist
// so a whole concept family ("anything monster-ish") can be claimed by one entry
// instead of enumerating every compound anyone might invent.
//
// Patterns are a FALLBACK tier, consulted only when no literal alias matches
// (see buildBuckets). That ordering is what makes them safe: measured against
// the shipped dictionary, every tag a reasonable pattern would wrongly capture
// was already a literal alias somewhere, so the exact tier resolves it at no
// cost. It's also the user's escape hatch — moving a chip writes a literal
// override, which by construction beats any pattern.
//
// Deliberately NOT regex: these are curated by hand, shown to users, and must
// never introduce catastrophic backtracking.

const PATTERN_RE = /^(\*?)([^*]+)(\*?)$/;

/**
 * Parse a dictionary entry as a glob pattern, or return null if it's a literal
 * alias. Only a leading and/or trailing `*` counts — an interior `*`, a bare
 * `*`, or `**` is not a pattern and falls through as an ordinary (if odd)
 * literal, which is the safe direction to fail.
 *
 * The needle is normalized with the same {@link norm} applied to card tags, so
 * matching compares like with like.
 *
 * @param {string} entry
 * @returns {{kind:'contains'|'prefix'|'suffix', needle:string, source:string}|null}
 */
export function parsePattern(entry) {
    const source = String(entry);
    if (!source.startsWith('*') && !source.endsWith('*')) return null;
    const m = PATTERN_RE.exec(source);
    if (!m) return null;
    const [, lead, body, tail] = m;
    if (!lead && !tail) return null;
    const needle = norm(body);
    if (!needle) return null;
    const kind = lead && tail ? 'contains' : (tail ? 'prefix' : 'suffix');
    return { kind, needle, source };
}

/** True if a dictionary entry is a glob rule rather than a literal alias. */
export const isPattern = (entry) => parsePattern(entry) !== null;

/** Does a parsed pattern match an already-normalized tag key? */
function patternMatches(p, key) {
    if (p.kind === 'contains') return key.includes(p.needle);
    if (p.kind === 'prefix') return key.startsWith(p.needle);
    return key.endsWith(p.needle);
}

// An anchored pattern is stricter than an unanchored one of the same length, so
// it wins ties: `elf*` should beat `*elf*` for "elfgirl".
const patternRank = (p) => (p.kind === 'contains' ? 0 : 1);

/**
 * Order patterns most-specific first: longest needle wins, then anchored over
 * unanchored, then source text for a total order. Sorting once and taking the
 * first match makes resolution deterministic and independent of dictionary
 * iteration order — two patterns that both match never depend on which
 * canonical happened to be declared first.
 * @template {{needle:string, kind:string, source:string}} P
 * @param {P[]} patterns
 * @returns {P[]}
 */
export function sortPatterns(patterns) {
    return [...patterns].sort((a, b) =>
        b.needle.length - a.needle.length
        || patternRank(b) - patternRank(a)
        || a.source.localeCompare(b.source));
}

/**
 * First (most specific) pattern matching a tag, or undefined.
 * @param {Array<{kind:string, needle:string, source:string}>} sorted  output of {@link sortPatterns}
 * @param {string} tag  raw tag; normalized here
 */
export function matchPattern(sorted, tag) {
    const key = norm(tag);
    return sorted.find(p => patternMatches(p, key));
}

/**
 * Split a canonical's dictionary entries into literal aliases and glob rules.
 * @param {string[]} entries
 * @returns {{aliases: string[], patterns: string[]}}
 */
export function splitEntries(entries) {
    const aliases = [];
    const patterns = [];
    for (const e of entries ?? []) (isPattern(e) ? patterns : aliases).push(String(e));
    return { aliases, patterns };
}

/**
 * Turn the cards + the persistent mapping into display buckets.
 *
 * Every canonical in the mapping becomes a group, even if none of its variants
 * appear on any card (the dictionary is shown in full). Declared variants that
 * aren't observed appear with count 0. Every observed tag that matches a
 * declared variant or canonical (case-insensitively) joins that group; every
 * other observed tag falls into `unassigned`.
 *
 * Resolution order for an observed tag is exact → pattern → unassigned, with
 * removals checked at each tier (so a mapping pattern rescues a tag a removal
 * pattern would otherwise drop, mirroring "mapping is the more specific
 * intent"). Each variant records how it got there in `matchedBy`:
 * `'declared'` (literal dictionary entry), `'norm'` (matched a literal entry
 * only after normalizing — a casing/spacing variant), or `'pattern:<source>'`.
 * A group's glob rules are returned separately as `patterns`; they are rules,
 * not tags, and must never be rendered or counted as chips.
 *
 * Tags listed in `removedTags` (junk to be deleted) form a third bucket and are
 * excluded from `unassigned`. A tag claimed by both a canonical and the removed
 * list stays with its canonical (mapping is the more specific intent).
 *
 * Each variant carries `declared`: true for exact strings actually present in
 * `mapping`/`removedTags`, false for exact strings that only got here by
 * normalizing to match one of those (e.g. a different casing, or a card
 * literally tagged with the canonical's own name). Callers that persist edits
 * back to the dictionary MUST only write out `declared` variants — the
 * discovered ones reattach automatically via `norm()` on every future load, so
 * saving them too would silently re-declare every incidental casing/spelling
 * variant your cards happen to use as if it were an intentional alias.
 *
 * @param {object[]} characters
 * @param {Object<string,string[]>} mapping  canonical -> variant strings (literal aliases and/or glob rules)
 * @param {string[]} [removedTags]  tag strings flagged as junk (literal and/or glob)
 * @returns {{groups: Array<{canonical:string, variants:Array<{tag:string,count:number,avatars:string[],declared:boolean,matchedBy:string}>, patterns:string[]}>, unassigned: Array<{tag:string,count:number,avatars:string[]}>, removed: Array<{tag:string,count:number,avatars:string[],declared:boolean,matchedBy:string}>, removedPatterns: string[]}}
 */
export function buildBuckets(characters, mapping, removedTags) {
    const map = mapping || {};
    const stats = scanTags(characters);

    // Normalized literal alias/canonical -> canonical key, plus the glob rules
    // held out as a separate fallback tier.
    const lookup = new Map();
    const mapPatterns = [];
    const groupPatterns = new Map();
    for (const [canonical, variants] of Object.entries(map)) {
        lookup.set(norm(canonical), canonical);
        groupPatterns.set(canonical, []);
        for (const v of variants ?? []) {
            const p = parsePattern(v);
            if (p) {
                mapPatterns.push({ ...p, canonical });
                groupPatterns.get(canonical).push(String(v));
            } else {
                lookup.set(norm(v), canonical);
            }
        }
    }
    const sortedMapPatterns = sortPatterns(mapPatterns);

    // Removed bucket, keyed by exact string. Seed declared junk at count 0 so the
    // full removal list shows even when none of it appears on a card. Glob rules
    // are held out — they're rules, not junk tags, so they get no chip.
    const removedMap = new Map();
    const removedLookup = new Set();
    const removePatterns = [];
    for (const t of removedTags ?? []) {
        const p = parsePattern(t);
        if (p) { removePatterns.push(p); continue; }
        removedLookup.add(norm(t));
        if (!removedMap.has(String(t))) removedMap.set(String(t), { tag: String(t), count: 0, avatars: [], declared: true, matchedBy: 'declared' });
    }
    const sortedRemovePatterns = sortPatterns(removePatterns);

    // canonical -> Map(exact tag string -> variant). Seed with declared variants
    // (count 0) so the full dictionary round-trips even when nothing on a card
    // uses it. Keying by the exact string keeps distinct case variants ("female"
    // and "Female") as separate chips instead of clobbering each other's counts.
    const groupMap = new Map();
    const ensure = (c) => { let g = groupMap.get(c); if (!g) { g = new Map(); groupMap.set(c, g); } return g; };
    for (const [canonical, variants] of Object.entries(map)) {
        const g = ensure(canonical);
        for (const v of variants ?? []) {
            if (isPattern(v)) continue;
            if (!g.has(String(v))) g.set(String(v), { tag: String(v), count: 0, avatars: [], declared: true, matchedBy: 'declared' });
        }
    }

    const unassigned = [];
    for (const [tag, entry] of stats) {
        const variant = { tag, count: entry.count, avatars: [...entry.avatars] };
        const canonical = lookup.get(norm(tag));
        if (canonical) {
            const g = ensure(canonical);
            // Exact-string match to a declared seed wins the real count/avatars
            // but keeps its declared:true; any other exact string observed here
            // only matched by normalizing, so it's discovered, not declared.
            const declared = g.get(tag)?.declared ?? false;
            g.set(tag, { ...variant, declared, matchedBy: declared ? 'declared' : 'norm' });
            continue;
        }
        if (removedLookup.has(norm(tag))) {
            const declared = removedMap.get(tag)?.declared ?? false;
            removedMap.set(tag, { ...variant, declared, matchedBy: declared ? 'declared' : 'norm' });
            continue;
        }
        // No literal entry claims it — fall back to the glob tier. Mapping
        // patterns are tried before removal patterns so a concept rule rescues a
        // tag a junk rule would otherwise delete.
        const hit = matchPattern(sortedMapPatterns, tag);
        if (hit) {
            ensure(hit.canonical).set(tag, { ...variant, declared: false, matchedBy: `pattern:${hit.source}` });
            continue;
        }
        const junk = matchPattern(sortedRemovePatterns, tag);
        if (junk) {
            removedMap.set(tag, { ...variant, declared: false, matchedBy: `pattern:${junk.source}` });
            continue;
        }
        unassigned.push(variant);
    }

    const byCount = (a, b) => b.count - a.count || a.tag.localeCompare(b.tag);
    const groups = [...groupMap.entries()].map(([canonical, vmap]) => ({
        canonical,
        variants: [...vmap.values()].sort(byCount),
        patterns: groupPatterns.get(canonical) ?? [],
    }));
    return {
        groups,
        unassigned: unassigned.sort(byCount),
        removed: [...removedMap.values()].sort(byCount),
        removedPatterns: removePatterns.map(p => p.source),
    };
}

/**
 * Project the editor's buckets into the literal tag plan the server applies:
 * `{ rename: { <exact card tag>: <exact canonical> }, remove: [<exact card tag>] }`.
 *
 * This is the whole extension/server contract. Every match decision — norm(),
 * alias lookup, canonical casing, mapping-beats-removal — is resolved HERE,
 * against the tags actually observed on cards, so the server can apply the
 * result by literal string equality and make no decisions of its own. It is
 * deliberately a projection of {@link buildBuckets}, the same function that
 * renders the editor: what the user previewed is byte-for-byte what gets sent.
 *
 * Only observed tags (`count > 0`) are emitted — the dictionary's thousands of
 * declared-but-unused aliases would be dead weight on the wire and can't match
 * anything on disk anyway. A tag already equal to its canonical is skipped too,
 * since renaming it to itself is a no-op; the server leaves unmentioned tags
 * alone, which is also what keeps re-runs idempotent.
 *
 * @param {object[]} characters  cards as surveyed from the server
 * @param {Object<string,string[]>} mapping  canonical -> variant strings
 * @param {string[]} [removedTags]  tag strings flagged as junk
 * @returns {{rename: Object<string,string>, remove: string[]}}
 */
export function buildApplyPayload(characters, mapping, removedTags) {
    const { groups, removed } = buildBuckets(characters, mapping, removedTags);

    const rename = {};
    for (const g of groups) {
        if (!g.canonical) continue;
        for (const v of g.variants) {
            if (v.count === 0 || v.tag === g.canonical) continue;
            rename[v.tag] = g.canonical;
        }
    }

    return { rename, remove: removed.filter(v => v.count > 0).map(v => v.tag) };
}
