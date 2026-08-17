// Ported from SillyTavern-Character-Tools/test/tag-delta.test.js (vitest ->
// node:test) with no behavioral changes. tag-delta.js is vendored verbatim at
// web/vendor/tag-tools/ -- see docs/PHASE_5_TAGS_PLAN.md and web/VENDORED.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffDictionary, applyDelta } from "../vendor/tag-tools/tag-delta.js";

// Sort a dictionary's keys and array contents so structurally-equal dictionaries
// compare equal regardless of insertion order (applyDelta doesn't promise order).
function normalize({ mapping, removedTags }) {
  const m = {};
  for (const key of Object.keys(mapping).sort()) m[key] = [...mapping[key]].sort();
  return { mapping: m, removedTags: [...removedTags].sort() };
}

function roundTrip(base, current) {
  const delta = diffDictionary(base, current);
  return { delta, result: applyDelta(base, delta) };
}

function omit(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const BASE = {
  mapping: {
    Female: ["female", "#Female"],
    Male: ["male"],
    NSFW: [],
  },
  removedTags: ["spam", "test"],
};

describe("diffDictionary / applyDelta", () => {
  it("produces an empty delta for an untouched dictionary", () => {
    const delta = diffDictionary(BASE, BASE);
    assert.deepStrictEqual(delta, { overrides: {}, blanks: {} });
  });

  it("round-trips an untouched dictionary back to the base", () => {
    const { result } = roundTrip(BASE, BASE);
    assert.deepStrictEqual(normalize(result), normalize(BASE));
  });

  it("records a single override when a variant moves to a different canonical", () => {
    const current = {
      mapping: { ...BASE.mapping, Female: ["#Female"], Male: ["male", "female"] },
      removedTags: BASE.removedTags,
    };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, { female: { canonical: "Male" } });
    assert.deepStrictEqual(delta.blanks, {});
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("records an override when a tag is removed", () => {
    const current = {
      mapping: { ...BASE.mapping, Female: ["#Female"] },
      removedTags: [...BASE.removedTags, "female"],
    };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, { female: { removed: true } });
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("records an override when a removed tag is restored to unassigned", () => {
    const current = { mapping: BASE.mapping, removedTags: ["test"] };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, { spam: { unassigned: true } });
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("implies a brand-new non-empty canonical purely through overrides (no blanks entry)", () => {
    const current = {
      mapping: { ...BASE.mapping, Robot: ["android", "cyborg"] },
      removedTags: BASE.removedTags,
    };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, {
      android: { canonical: "Robot" },
      cyborg: { canonical: "Robot" },
    });
    assert.deepStrictEqual(delta.blanks, {});
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("tracks a brand-new empty canonical as a blank", () => {
    const current = { mapping: { ...BASE.mapping, "New Tag": [] }, removedTags: BASE.removedTags };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, {});
    assert.deepStrictEqual(delta.blanks, { "New Tag": true });
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("tracks deletion of a base canonical that shipped with zero aliases", () => {
    const current = { mapping: omit(BASE.mapping, "NSFW"), removedTags: BASE.removedTags };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.blanks, { NSFW: false });
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("deleting a populated canonical clears it via per-variant overrides, no blanks entry", () => {
    const current = { mapping: omit(BASE.mapping, "Male"), removedTags: BASE.removedTags };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, { male: { unassigned: true } });
    assert.deepStrictEqual(delta.blanks, {});
    const result = applyDelta(BASE, delta);
    assert.equal(result.mapping.Male, undefined);
    assert.deepStrictEqual(normalize(result), normalize(current));
  });

  it("renaming a canonical is a bulk per-variant override, and round-trips", () => {
    const current = {
      mapping: { ...omit(BASE.mapping, "Female"), Girl: ["female", "#Female"] },
      removedTags: BASE.removedTags,
    };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, {
      female: { canonical: "Girl" },
      "#Female": { canonical: "Girl" },
    });
    const result = applyDelta(BASE, delta);
    assert.equal(result.mapping.Female, undefined);
    assert.deepStrictEqual(normalize(result), normalize(current));
  });

  it("a variant added to a previously-blank canonical clears its blanks entry", () => {
    const current = { mapping: { ...BASE.mapping, NSFW: ["gore"] }, removedTags: BASE.removedTags };
    const delta = diffDictionary(BASE, current);
    assert.deepStrictEqual(delta.overrides, { gore: { canonical: "NSFW" } });
    assert.deepStrictEqual(delta.blanks, {});
    assert.deepStrictEqual(normalize(applyDelta(BASE, delta)), normalize(current));
  });

  it("composes multiple simultaneous edits into one small delta that still round-trips", () => {
    const current = {
      mapping: {
        Female: ["#Female"], // 'female' moved out
        Male: ["male", "female"], // 'female' moved in
        Robot: ["android"], // brand new canonical
        "Empty Bucket": [], // brand new blank canonical
        NSFW: [],
      },
      removedTags: ["test", "spam-extra"], // 'spam' restored, 'spam-extra' newly removed
    };
    const { delta, result } = roundTrip(BASE, current);
    assert.deepStrictEqual(normalize(result), normalize(current));
    // Sanity: the delta only mentions what actually changed, not the whole dictionary.
    assert.deepStrictEqual(
      Object.keys(delta.overrides).sort(),
      ["android", "female", "spam", "spam-extra"].sort(),
    );
    assert.deepStrictEqual(delta.blanks, { "Empty Bucket": true });
  });

  it("produces a delta far smaller than the full dictionary for a small edit against a large base", () => {
    const bigMapping = {};
    for (let i = 0; i < 200; i++) bigMapping[`Canonical${i}`] = [`alias${i}a`, `alias${i}b`, `alias${i}c`];
    const bigBase = { mapping: bigMapping, removedTags: [] };
    const current = {
      mapping: { ...bigMapping, Canonical0: ["alias0a", "alias0c"] }, // dropped one alias
      removedTags: ["alias0b"],
    };
    const delta = diffDictionary(bigBase, current);
    assert.ok(JSON.stringify(delta).length < JSON.stringify(bigBase).length / 10);
    assert.deepStrictEqual(normalize(applyDelta(bigBase, delta)), normalize(current));
  });
});

// ── glob rules are core-dictionary-only ─────────────────────────────────────
//
// The delta is the ONLY channel a user's edits travel through. Keeping rules out
// of it is what makes them unauthorable, unmovable and undeletable by a user —
// the editor's inert rule chips are the UI half of the same guarantee.

describe("glob rules in the delta", () => {
  const base = {
    mapping: { "Non-Human": ["*monster*", "monsters"], "Demi-Human": ["beargirl"] },
    removedTags: ["*selfie*", "oc"],
  };

  it("round-trips rules through an empty delta", () => {
    assert.deepStrictEqual(applyDelta(base, { overrides: {}, blanks: {} }), base);
  });

  it("keeps rules when the user moves a literal alias", () => {
    const current = {
      mapping: { "Non-Human": ["*monster*", "monsters"], "Demi-Human": ["beargirl", "monsters"] },
      removedTags: ["*selfie*", "oc"],
    };
    // The move is recorded; the rules are not.
    const delta = diffDictionary(base, {
      ...current,
      mapping: { "Non-Human": ["*monster*"], "Demi-Human": ["beargirl", "monsters"] },
    });
    assert.deepStrictEqual(delta.overrides, { monsters: { canonical: "Demi-Human" } });
    assert.ok(applyDelta(base, delta).mapping["Non-Human"].includes("*monster*"));
  });

  it("never diffs a rule into overrides, even if one goes missing", () => {
    // Simulates a caller that dropped the rules when rebuilding the mapping.
    const stripped = { mapping: { "Non-Human": ["monsters"], "Demi-Human": ["beargirl"] }, removedTags: ["oc"] };
    const delta = diffDictionary(base, stripped);
    assert.ok(!Object.keys(delta.overrides).includes("*monster*"));
    assert.ok(!Object.keys(delta.overrides).includes("*selfie*"));
    // ...and the rules survive the round trip regardless.
    const rebuilt = applyDelta(base, delta);
    assert.ok(rebuilt.mapping["Non-Human"].includes("*monster*"));
    assert.ok(rebuilt.removedTags.includes("*selfie*"));
  });

  it("ignores a hand-crafted override that tries to move a rule", () => {
    const rebuilt = applyDelta(base, { overrides: { "*monster*": { canonical: "Demi-Human" } }, blanks: {} });
    assert.ok(rebuilt.mapping["Non-Human"].includes("*monster*"));
    assert.ok(!(rebuilt.mapping["Demi-Human"] ?? []).includes("*monster*"));
  });

  it("ignores a hand-crafted override that tries to delete a rule", () => {
    const rebuilt = applyDelta(base, { overrides: { "*selfie*": { unassigned: true } }, blanks: {} });
    assert.ok(rebuilt.removedTags.includes("*selfie*"));
  });

  it("ignores a hand-crafted override that tries to invent a rule", () => {
    const rebuilt = applyDelta(base, { overrides: { "*girl*": { canonical: "Demi-Human" } }, blanks: {} });
    assert.deepStrictEqual(rebuilt.mapping["Demi-Human"], ["beargirl"]);
  });
});
