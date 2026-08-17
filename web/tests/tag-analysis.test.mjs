// Ported from SillyTavern-Character-Tools/test/tag-analysis.test.js (vitest ->
// node:test) with no behavioral changes. tag-analysis.js is vendored verbatim
// at web/vendor/tag-tools/ -- see docs/PHASE_5_TAGS_PLAN.md and
// web/VENDORED.md. Run with `cd web && node --test`, or `make test-js`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
} from "../vendor/tag-tools/tag-analysis.js";

// assert.partial: node:assert has no toMatchObject equivalent -- check that
// every key in `expected` matches on `actual`, ignoring the rest.
function assertMatchObject(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(actual[key], value, `field "${key}"`);
  }
}

// ── norm() ───────────────────────────────────────────────────────────────────

const NORM_GOLDEN = [
  ["#Female", "female"],
  ["female", "female"],
  ["FEMALE", "female"],
  ["  Arranged   Marriage ", "arranged marriage"],
  ["##FOO", "foo"],
  ["#  Spaced", "spaced"],
  ["Multi   Word", "multi word"],
  ["a\tb  c", "a b c"],
  ["  #  ", ""],
  ["AnyPOV", "anypov"],
];

describe("norm", () => {
  for (const [input, expected] of NORM_GOLDEN) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(norm(input), expected);
    });
  }

  it("coerces non-strings via String()", () => {
    assert.equal(norm(123), "123");
  });
});

// ── getCardTags() ──────────────────────────────────────────────────────────────

describe("getCardTags", () => {
  it("prefers data.tags (the real V2/V3 field)", () => {
    assert.deepStrictEqual(getCardTags({ data: { tags: ["a", "b"] }, tags: ["x"] }), ["a", "b"]);
  });

  it("falls back to the root tags mirror", () => {
    assert.deepStrictEqual(getCardTags({ tags: ["x", "y"] }), ["x", "y"]);
  });

  it("drops non-strings and blank/whitespace entries", () => {
    assert.deepStrictEqual(getCardTags({ data: { tags: ["a", "", "  ", 3, null, "b"] } }), ["a", "b"]);
  });

  it("returns [] when there are no tags or the shape is odd", () => {
    assert.deepStrictEqual(getCardTags({}), []);
    assert.deepStrictEqual(getCardTags(null), []);
    assert.deepStrictEqual(getCardTags({ data: { tags: "nope" } }), []);
  });
});

// ── pickCanonical() ─────────────────────────────────────────────────────────────

describe("pickCanonical", () => {
  it("prefers a capitalized variant, most frequent wins", () => {
    assert.equal(
      pickCanonical([
        { tag: "female", count: 5 },
        { tag: "Female", count: 2 },
      ]),
      "Female",
    );
  });

  it("strips a leading # from a #Capital variant", () => {
    assert.equal(pickCanonical([{ tag: "#Female", count: 3 }]), "Female");
  });

  it("preserves intentional mixed-case that leads with a capital", () => {
    assert.equal(pickCanonical([{ tag: "AnyPOV", count: 1 }]), "AnyPOV");
  });

  it("synthesises Title Case from an all-lowercase separated variant", () => {
    assert.equal(pickCanonical([{ tag: "arranged_marriage", count: 3 }]), "Arranged Marriage");
    assert.equal(pickCanonical([{ tag: "space opera", count: 1 }]), "Space Opera");
  });
});

// ── buildBuckets() ──────────────────────────────────────────────────────────────

const mapping = {
  Female: ["female", "woman", "girl"],
  Romance: ["romance", "romantic"],
};
const removedTags = ["junk"];

const characters = [
  { avatar: "a.png", data: { tags: ["female", "romance", "junk", "unmapped"] } },
  { avatar: "b.png", tags: ["Female", "Female"] }, // root fallback + intra-card dupe
  { avatar: "c.png", data: { tags: ["ROMANTIC"] } },
];

/** canonical -> Map(exact tag string -> count) for easy assertions. */
function groupCounts(buckets, canonical) {
  const g = buckets.groups.find((x) => x.canonical === canonical);
  return new Map((g?.variants ?? []).map((v) => [v.tag, v.count]));
}

describe("buildBuckets", () => {
  it("makes a group for every canonical, seeding unseen variants at count 0", () => {
    const buckets = buildBuckets([], mapping, removedTags);
    assert.deepStrictEqual(
      buckets.groups.map((g) => g.canonical).sort(),
      ["Female", "Romance"],
    );
    const female = groupCounts(buckets, "Female");
    assert.equal(female.get("female"), 0);
    assert.equal(female.get("woman"), 0);
    assert.equal(female.get("girl"), 0);
  });

  it("counts observed variants and keeps distinct case-strings separate", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    const female = groupCounts(buckets, "Female");
    // 'female' (card a) and 'Female' (card b) are distinct chips, each seen once.
    assert.equal(female.get("female"), 1);
    assert.equal(female.get("Female"), 1);
    assert.equal(female.get("woman"), 0); // declared but never observed
  });

  it("matches variants case-insensitively via norm", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    const romance = groupCounts(buckets, "Romance");
    assert.equal(romance.get("romance"), 1);
    assert.equal(romance.get("ROMANTIC"), 1); // norm('ROMANTIC') === 'romantic'
  });

  it("dedupes tags case-insensitively within a single card", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    // card b lists 'Female' twice; it should count once.
    assert.equal(groupCounts(buckets, "Female").get("Female"), 1);
  });

  it("routes junk to the removed bucket and out of unassigned", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    assert.equal(buckets.removed.find((r) => r.tag === "junk")?.count, 1);
    assert.equal(buckets.unassigned.find((u) => u.tag === "junk"), undefined);
  });

  it("puts unmatched observed tags in unassigned", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    assert.equal(buckets.unassigned.find((u) => u.tag === "unmapped")?.count, 1);
  });

  it("lets a canonical claim a tag that is also in removedTags (mapping wins)", () => {
    // 'girl' is both a Female variant and flagged as removed.
    const buckets = buildBuckets([{ avatar: "z.png", data: { tags: ["girl"] } }], mapping, ["girl"]);
    // The observed occurrence (count 1) is attributed to the canonical group...
    assert.equal(groupCounts(buckets, "Female").get("girl"), 1);
    // ...while the removed list still shows the declared entry, but only as a
    // count-0 seed (the observed hit did not land here).
    assert.equal(buckets.removed.find((r) => r.tag === "girl")?.count, 0);
  });

  it("aggregates avatars per variant", () => {
    const buckets = buildBuckets(characters, mapping, removedTags);
    const female = buckets.groups.find((g) => g.canonical === "Female");
    const femaleVariant = female.variants.find((v) => v.tag === "female");
    assert.deepStrictEqual(femaleVariant.avatars, ["a.png"]);
  });
});

// ── declared vs discovered ──────────────────────────────────────────────────

function variantIn(list, tag) {
  return list.find((v) => v.tag === tag);
}

describe("buildBuckets — declared vs discovered", () => {
  const buckets = buildBuckets(characters, mapping, removedTags);

  it("flags an exact declared alias as declared, whether or not it is observed", () => {
    const female = buckets.groups.find((g) => g.canonical === "Female").variants;
    assert.equal(variantIn(female, "female").declared, true); // observed, exact declared match
    assert.equal(variantIn(female, "woman").declared, true); // declared, unobserved (count 0)
  });

  it("flags an observed tag that only matches by normalizing as discovered", () => {
    const female = buckets.groups.find((g) => g.canonical === "Female").variants;
    // 'Female' is never itself a declared alias — it only matched by
    // normalizing to the same key as the declared 'female'.
    assert.equal(variantIn(female, "Female").declared, false);

    const romance = buckets.groups.find((g) => g.canonical === "Romance").variants;
    assert.equal(variantIn(romance, "ROMANTIC").declared, false); // declared alias is 'romantic'
  });

  it("applies the same declared/discovered split to the removed bucket", () => {
    assert.equal(variantIn(buckets.removed, "junk").declared, true); // exact declared junk
  });
});

// ── buildApplyPayload() ──────────────────────────────────────────────────────

describe("buildApplyPayload", () => {
  const cards = (...tagLists) => tagLists.map((tags, i) => ({ avatar: `c${i}.png`, tags }));

  it("emits one literal rename per observed spelling", () => {
    const plan = buildApplyPayload(cards(["girl"], ["woman", "Female"], ["female"]), { Female: ["girl", "woman"] }, []);
    // 'Female' is skipped — renaming a tag to itself is a no-op — but the
    // lowercase 'female' still needs an entry to get its casing fixed.
    assert.deepStrictEqual(plan.rename, { girl: "Female", woman: "Female", female: "Female" });
  });

  it("omits declared aliases that no card uses", () => {
    const plan = buildApplyPayload(cards(["girl"]), { Female: ["girl", "woman", "lady"] }, []);
    assert.deepStrictEqual(plan.rename, { girl: "Female" });
  });

  it("omits removed tags that no card uses", () => {
    const plan = buildApplyPayload(cards(["anypov"]), {}, ["anypov", "oc", "selfies"]);
    assert.deepStrictEqual(plan.remove, ["anypov"]);
  });

  it("leaves unassigned tags out of the plan entirely", () => {
    const plan = buildApplyPayload(cards(["dragons", "girl"]), { Female: ["girl"] }, []);
    assert.deepStrictEqual(plan.rename, { girl: "Female" });
    assert.deepStrictEqual(plan.remove, []);
  });

  it("never emits a tag in both rename and remove (mapping wins)", () => {
    const plan = buildApplyPayload(cards(["sharingabed"]), { "Forced Proximity": ["sharingabed"] }, ["sharingabed"]);
    assert.deepStrictEqual(plan.rename, { sharingabed: "Forced Proximity" });
    assert.deepStrictEqual(plan.remove, []);
  });

  it("is empty when the dictionary changes nothing on these cards", () => {
    const plan = buildApplyPayload(cards(["Female"]), { Female: ["girl"] }, ["oc"]);
    assert.deepStrictEqual(plan.rename, {});
    assert.deepStrictEqual(plan.remove, []);
  });

  it("preserves the exact card spelling as the key, including a leading #", () => {
    const plan = buildApplyPayload(cards(["#Girl", "  woman "]), { Female: ["girl", "woman"] }, []);
    assert.deepStrictEqual(plan.rename, { "#Girl": "Female", "  woman ": "Female" });
  });

  it("handles a missing removedTags list", () => {
    assert.deepStrictEqual(buildApplyPayload(cards(["girl"]), { Female: ["girl"] }), {
      rename: { girl: "Female" },
      remove: [],
    });
  });
});

// ── glob match rules ─────────────────────────────────────────────────────────

describe("parsePattern", () => {
  it("recognises the three anchored forms", () => {
    assertMatchObject(parsePattern("*monster*"), { kind: "contains", needle: "monster" });
    assertMatchObject(parsePattern("monster*"), { kind: "prefix", needle: "monster" });
    assertMatchObject(parsePattern("*monster"), { kind: "suffix", needle: "monster" });
  });

  it("normalizes the needle the same way card tags are normalized", () => {
    assert.equal(parsePattern("*Monster Girl*").needle, "monster girl");
    assert.equal(parsePattern("*  SPACED  *").needle, "spaced");
  });

  // Failing "not a pattern" is the safe direction: the entry falls through as
  // an ordinary literal alias rather than becoming a surprise global matcher.
  for (const entry of ["monster", "", "*", "**", "a*b", "*a*b*"]) {
    it(`treats ${JSON.stringify(entry)} as a literal, not a rule`, () => {
      assert.equal(parsePattern(entry), null);
      assert.equal(isPattern(entry), false);
    });
  }
});

describe("matchPattern precedence", () => {
  const rules = sortPatterns([
    { ...parsePattern("*girl*"), canonical: "Broad" },
    { ...parsePattern("*monstergirl*"), canonical: "Specific" },
    { ...parsePattern("*monster*"), canonical: "Medium" },
  ]);

  it("picks the longest matching needle", () => {
    assert.equal(matchPattern(rules, "amonstergirlx").canonical, "Specific");
    assert.equal(matchPattern(rules, "monsterbear").canonical, "Medium");
    assert.equal(matchPattern(rules, "catgirl").canonical, "Broad");
  });

  it("prefers an anchored rule over an unanchored one of equal length", () => {
    const tie = sortPatterns([
      { ...parsePattern("*elf*"), canonical: "Loose" },
      { ...parsePattern("elf*"), canonical: "Anchored" },
    ]);
    assert.equal(matchPattern(tie, "elfgirl").canonical, "Anchored");
    assert.equal(matchPattern(tie, "halfelfx").canonical, "Loose"); // anchored can't match
  });

  it("is independent of input order", () => {
    const reversed = sortPatterns([...rules].reverse());
    assert.equal(matchPattern(reversed, "amonstergirlx").canonical, "Specific");
  });

  it("returns undefined when nothing matches", () => {
    assert.equal(matchPattern(rules, "dragons"), undefined);
  });
});

describe("splitEntries", () => {
  it("separates rules from literal aliases", () => {
    assert.deepStrictEqual(splitEntries(["monster", "*monster*", "monsters"]), {
      aliases: ["monster", "monsters"],
      patterns: ["*monster*"],
    });
  });
});

describe("buildBuckets with rules", () => {
  const card = (...tags) => ({ avatar: "a.png", data: { tags } });

  it("claims an otherwise-unassigned tag and records which rule did it", () => {
    const b = buildBuckets([card("monsterbeargirl")], { "Non-Human": ["*monster*"] }, []);
    const g = b.groups.find((x) => x.canonical === "Non-Human");
    assert.deepStrictEqual(
      g.variants.map((v) => v.tag),
      ["monsterbeargirl"],
    );
    assertMatchObject(g.variants[0], { declared: false, matchedBy: "pattern:*monster*" });
    assert.deepStrictEqual(b.unassigned, []);
  });

  // The load-bearing guarantee: rules are a fallback, so any literal entry —
  // including a user's override — outranks them.
  it("lets a literal alias elsewhere beat a rule", () => {
    const b = buildBuckets(
      [card("monstergirl")],
      { "Non-Human": ["*monster*"], "Demi-Human": ["monstergirl"] },
      [],
    );
    assert.deepStrictEqual(
      b.groups.find((g) => g.canonical === "Demi-Human").variants.map((v) => v.tag),
      ["monstergirl"],
    );
    assert.deepStrictEqual(b.groups.find((g) => g.canonical === "Non-Human").variants, []);
  });

  it("lets a literal removal beat a rule", () => {
    const b = buildBuckets([card("monsterpov")], { "Non-Human": ["*monster*"] }, ["monsterpov"]);
    assert.equal(b.removed.find((r) => r.tag === "monsterpov").count, 1);
  });

  it("does not render a rule as a chip, but exposes it on the group", () => {
    const b = buildBuckets([], { "Non-Human": ["*monster*", "monsters"] }, []);
    const g = b.groups.find((x) => x.canonical === "Non-Human");
    assert.deepStrictEqual(
      g.variants.map((v) => v.tag),
      ["monsters"],
    );
    assert.deepStrictEqual(g.patterns, ["*monster*"]);
  });

  it("supports removal rules, and lets a mapping rule rescue from one", () => {
    const b = buildBuckets(
      [card("selfies", "monsterselfie")],
      { "Non-Human": ["*monster*"] },
      ["*selfie*"],
    );
    assertMatchObject(b.removed.find((r) => r.tag === "selfies"), { matchedBy: "pattern:*selfie*" });
    // 'monsterselfie' matches both; the mapping tier is consulted first.
    assert.deepStrictEqual(
      b.groups.find((g) => g.canonical === "Non-Human").variants.map((v) => v.tag),
      ["monsterselfie"],
    );
    assert.deepStrictEqual(b.removedPatterns, ["*selfie*"]);
  });

  it("tags literal and norm matches with matchedBy too", () => {
    const b = buildBuckets([card("FEMALE", "girl")], { Female: ["female", "girl"] }, []);
    const g = b.groups.find((x) => x.canonical === "Female");
    assert.equal(g.variants.find((v) => v.tag === "girl").matchedBy, "declared");
    assert.equal(g.variants.find((v) => v.tag === "FEMALE").matchedBy, "norm");
  });

  it("is a no-op for a dictionary with no rules", () => {
    const b = buildBuckets([card("dragons")], { Female: ["girl"] }, []);
    assert.deepStrictEqual(
      b.unassigned.map((v) => v.tag),
      ["dragons"],
    );
    assert.ok(b.groups.every((g) => g.patterns.length === 0));
  });
});

describe("buildApplyPayload with rules", () => {
  // Rules never reach the server: they are resolved here into literal renames,
  // which is what keeps the server a string-equality lookup.
  it("emits a literal rename for a rule-captured tag", () => {
    const plan = buildApplyPayload(
      [{ avatar: "a.png", data: { tags: ["monsterbeargirl"] } }],
      { "Non-Human": ["*monster*"] },
      [],
    );
    assert.deepStrictEqual(plan.rename, { monsterbeargirl: "Non-Human" });
  });

  it("never emits the rule itself", () => {
    const plan = buildApplyPayload([], { "Non-Human": ["*monster*"] }, ["*selfie*"]);
    assert.deepStrictEqual(plan, { rename: {}, remove: [] });
  });

  it("emits a literal removal for a rule-captured junk tag", () => {
    const plan = buildApplyPayload([{ avatar: "a.png", data: { tags: ["beachselfie"] } }], {}, ["*selfie*"]);
    assert.deepStrictEqual(plan.remove, ["beachselfie"]);
  });
});
