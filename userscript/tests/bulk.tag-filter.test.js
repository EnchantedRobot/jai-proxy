"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModules } = require("./helpers/load-src");

// Smoke test: loads only bulk.js (not the whole bridge) and hands it a fake
// BULK_TAG_FILTER, so the test exercises the filter logic itself rather than
// whatever tags happen to be hand-edited into config.js today.
function loadTagFilter(filter) {
  return loadModules(["bulk.js"], ["passesTagFilter", "normTag"], {
    BULK_TAG_FILTER: filter,
  });
}

test("normTag strips a leading emoji/punctuation prefix and lower-cases", () => {
  const { normTag } = loadTagFilter({ include: [], exclude: [] });
  assert.equal(normTag("👩‍🦰 Female"), "female");
  assert.equal(normTag("#custom"), "custom");
  assert.equal(normTag("Male"), "male");
});

test("passesTagFilter requires an include tag when include is set", () => {
  const { passesTagFilter } = loadTagFilter({ include: ["female"], exclude: [] });
  assert.equal(passesTagFilter({ tags: [{ name: "👩‍🦰 Female" }], custom_tags: [] }), true);
  assert.equal(passesTagFilter({ tags: [{ name: "Male" }], custom_tags: [] }), false);
});

test("passesTagFilter rejects any exclude tag even if an include tag also matches", () => {
  const { passesTagFilter } = loadTagFilter({ include: ["female"], exclude: ["futa", "futanari"] });
  assert.equal(
    passesTagFilter({ tags: [{ name: "Female" }], custom_tags: ["futanari"] }),
    false
  );
});

test("passesTagFilter matches tag names whole, not as a substring", () => {
  const { passesTagFilter } = loadTagFilter({ include: [], exclude: ["futa"] });
  assert.equal(passesTagFilter({ tags: [], custom_tags: ["futanari"] }), true);
  assert.equal(passesTagFilter({ tags: [], custom_tags: ["futa"] }), false);
});

test("passesTagFilter allows everything when both include and exclude are empty", () => {
  const { passesTagFilter } = loadTagFilter({ include: [], exclude: [] });
  assert.equal(passesTagFilter({ tags: [{ name: "anything" }], custom_tags: [] }), true);
  assert.equal(passesTagFilter({ tags: [], custom_tags: [] }), true);
});
