// Validates the shipped tag-dictionary.json for internal consistency. These
// invariants are what a contradictory entry violates — e.g. a canonical that is
// ALSO in removedTags, which makes the merge non-idempotent (it deletes a
// canonical it just produced). Catching that here is far cheaper than noticing a
// card lose a tag on a re-run.
//
// Ported from SillyTavern-Character-Tools/test/tag-dictionary.test.js (vitest ->
// node:test) with no behavioral changes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { norm, parsePattern, isPattern, buildApplyPayload } from "../vendor/tag-tools/tag-analysis.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(dir, "..", "vendor", "tag-tools");
const raw = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, "tag-dictionary.json"), "utf8"));

// Flatten { category: { canonical: [alias…] } } -> { canonical: [alias…] }, exactly
// like the extension's loadBaseDictionary(), so we validate the shape it runs.
const mapping = {};
for (const canonicals of Object.values(raw.mapping ?? {})) {
  for (const [canonical, aliases] of Object.entries(canonicals)) {
    mapping[canonical] = Array.isArray(aliases) ? aliases : [];
  }
}
const removedTags = Array.isArray(raw.removedTags) ? raw.removedTags : [];

// Glob rules are a separate tier and are validated separately below; the literal
// invariants (one canonical per tag, no mapped/removed overlap) don't apply to
// them, since a rule deliberately overlaps whatever it captures.
const rules = [];
for (const [canonical, entries] of Object.entries(mapping)) {
  for (const e of entries) {
    const p = parsePattern(e);
    if (p) rules.push({ ...p, canonical });
  }
}
for (const t of removedTags) {
  const p = parsePattern(t);
  if (p) rules.push({ ...p, canonical: "<removed>" });
}

// norm(tag) -> the set of canonicals that claim it (as their own key or a variant).
function buildClaims() {
  const claims = new Map();
  const add = (nrm, canonical) => {
    if (!claims.has(nrm)) claims.set(nrm, new Set());
    claims.get(nrm).add(canonical);
  };
  for (const [canonical, variants] of Object.entries(mapping)) {
    add(norm(canonical), canonical);
    for (const v of variants) if (!isPattern(v)) add(norm(v), canonical);
  }
  return claims;
}

describe("shipped tag-dictionary.json", () => {
  const claims = buildClaims();

  it("never claims one tag under more than one canonical", () => {
    const clashes = [];
    for (const [nrm, canonicals] of claims) {
      if (canonicals.size > 1) clashes.push(`"${nrm}" -> ${JSON.stringify([...canonicals])}`);
    }
    assert.deepStrictEqual(clashes, [], `A tag must belong to exactly one canonical bucket:\n  ${clashes.join("\n  ")}`);
  });

  it("never lists a removed tag that a canonical also claims", () => {
    const contradictions = [];
    for (const t of removedTags) {
      if (isPattern(t)) continue;
      const nrm = norm(t);
      if (claims.has(nrm)) contradictions.push(`"${t}" is also mapped to ${JSON.stringify([...claims.get(nrm)])}`);
    }
    assert.deepStrictEqual(
      contradictions,
      [],
      `removedTags must not overlap the mapping (a tag can't be both merged and deleted):\n  ${contradictions.join("\n  ")}`,
    );
  });

  it("has no duplicate removed tags (by normalized form)", () => {
    const counts = new Map();
    for (const t of removedTags) {
      if (isPattern(t)) continue;
      counts.set(norm(t), (counts.get(norm(t)) ?? 0) + 1);
    }
    const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([n, c]) => `"${n}" x${c}`);
    assert.deepStrictEqual(dupes, [], `removedTags has duplicates:\n  ${dupes.join("\n  ")}`);
  });
});

// Glob rules are the one part of the dictionary a user can't correct from the
// editor, so a bad one is silent and global. These are the guard rails that make
// authoring them safe; run pattern-preview.mjs before adding any.
describe("shipped glob match rules", () => {
  // An entry containing '*' that ISN'T a valid rule is almost certainly a typo
  // for one ('**monster*', 'mon*ster'), and would silently become a literal
  // alias that matches nothing.
  it("has no malformed rule-looking entries", () => {
    const suspect = [];
    const check = (entry, where) => {
      if (String(entry).includes("*") && !isPattern(entry)) suspect.push(`"${entry}" (${where})`);
    };
    for (const [canonical, entries] of Object.entries(mapping)) for (const e of entries) check(e, canonical);
    for (const t of removedTags) check(t, "removedTags");
    assert.deepStrictEqual(suspect, [], `entries with '*' must be valid rules (*x*, x*, *x):\n  ${suspect.join("\n  ")}`);
  });

  // Two identical rules pointing different directions is an authoring mistake:
  // precedence would resolve it by source text, which is arbitrary, not intent.
  it("never declares the same rule for two different canonicals", () => {
    const seen = new Map();
    const clashes = [];
    for (const r of rules) {
      const key = `${r.kind}:${r.needle}`;
      if (seen.has(key) && seen.get(key) !== r.canonical) clashes.push(`${r.source} -> ${seen.get(key)} and ${r.canonical}`);
      seen.set(key, r.canonical);
    }
    assert.deepStrictEqual(clashes, [], `a rule must resolve to exactly one canonical:\n  ${clashes.join("\n  ")}`);
  });

  // Measured against this corpus: an unanchored short needle is where rules go
  // wrong ('*elf*' eats "selfharm", '*cat*' eats "catholic"), while the same
  // needle anchored is clean ('elf*' captures elfgirl/elfmommy and nothing
  // else). So the floor is higher for `contains` than for prefix/suffix.
  const MIN = { contains: 5, prefix: 3, suffix: 3 };
  it("has no dangerously short needles", () => {
    const tooShort = rules
      .filter((r) => r.needle.length < MIN[r.kind])
      .map((r) => `${r.source} -> ${r.canonical} (needle "${r.needle}" is ${r.needle.length}, min ${MIN[r.kind]} for ${r.kind})`);
    assert.deepStrictEqual(tooShort, [], `short unanchored needles capture unrelated words; anchor it or lengthen it:\n  ${tooShort.join("\n  ")}`);
  });

  // A rule that matches a literal alias of a DIFFERENT canonical is legal —
  // exact wins — but if it matches one of its own it's just redundant, which is
  // fine. What we surface here is the count, so a rule that shadows a large
  // slice of the dictionary can't slip in unnoticed.
  it("reports how much of the dictionary each rule overlaps", () => {
    const literals = [];
    for (const [canonical, entries] of Object.entries(mapping)) {
      for (const e of entries) if (!isPattern(e)) literals.push({ key: norm(e), canonical });
    }
    const hit = (r, key) => (r.kind === "contains" ? key.includes(r.needle) : r.kind === "prefix" ? key.startsWith(r.needle) : key.endsWith(r.needle));
    const broad = rules
      .map((r) => ({ r, foreign: literals.filter((l) => l.canonical !== r.canonical && hit(r, l.key)) }))
      .filter((x) => x.foreign.length > 25)
      .map((x) => `${x.r.source} -> ${x.r.canonical} shadows ${x.foreign.length} literal aliases of other canonicals`);
    assert.deepStrictEqual(broad, [], `these rules are far too broad — run pattern-preview.mjs:\n  ${broad.join("\n  ")}`);
  });
});

// When a rule goes in, the literal aliases it subsumes come OUT of the
// dictionary — keeping both would mean 111 entries that resolve identically
// either way, and the exact tier would mask a rule that had quietly stopped
// working. The pruned literals aren't discarded though: they move to
// fixtures/pattern-vectors.json and become the regression evidence that the rule
// really does cover every variant actually observed on a card. Each is a tag
// that USED to be a literal alias, so "does the rule still catch it?" is a
// question with a known-correct answer.
describe("pruned literals still resolve through their rule", () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, "fixtures", "pattern-vectors.json"), "utf8"));
  const allTags = vectors.flatMap((v) => v.tags);
  const expected = new Map(vectors.flatMap((v) => v.tags.map((t) => [t, v.canonical])));

  it("routes every pruned tag to its canonical end-to-end", () => {
    // One card carrying all of them at once, through the real apply path —
    // the same projection the server receives, not a reimplementation.
    const { rename } = buildApplyPayload([{ avatar: "fixture.png", data: { tags: allTags } }], mapping, removedTags);
    const wrong = allTags
      .filter((t) => rename[t] !== expected.get(t))
      .map((t) => `"${t}" -> ${rename[t] ?? "(unmapped)"}, expected ${expected.get(t)}`);
    assert.deepStrictEqual(wrong, [], `pruned aliases must still resolve via their rule:\n  ${wrong.join("\n  ")}`);
  });

  // A rule deleted or retargeted without moving its vectors back would leave
  // the fixture describing coverage nothing provides.
  it("has every fixture rule still declared under its canonical", () => {
    const missing = vectors
      .filter((v) => !(raw.mapping?.[v.category]?.[v.canonical] ?? []).includes(v.rule))
      .map((v) => `${v.rule} is missing from ${v.category} :: ${v.canonical}`);
    assert.deepStrictEqual(missing, [], `fixture vectors describe rules that are no longer shipped:\n  ${missing.join("\n  ")}`);
  });

  // Re-adding a pruned tag as a literal would make the test above pass for the
  // wrong reason: the exact tier would answer, and a broken rule would hide.
  it("has no fixture tag re-added as a literal alias", () => {
    const literals = new Set();
    for (const entries of Object.values(mapping)) for (const e of entries) if (!isPattern(e)) literals.add(norm(e));
    const dupes = allTags.filter((t) => literals.has(norm(t)));
    assert.deepStrictEqual(dupes, [], `these belong to the fixture OR the dictionary, not both:\n  ${dupes.join("\n  ")}`);
  });
});
