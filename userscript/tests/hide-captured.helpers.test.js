"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModules, plain } = require("./helpers/load-src");

// Neither helper touches ServerClient/passesTagFilter at load time, so
// hide-captured.js can be loaded on its own with no globals.
function load() {
  return loadModules(["hide-captured.js"], ["cardIdFromHref", "tagRowFromWrapper"]);
}

test("cardIdFromHref extracts and lower-cases the uuid from a character link", () => {
  const { cardIdFromHref } = load();
  assert.equal(
    cardIdFromHref("/characters/1A2B3C4D-1234-5678-9ABC-1234567890AB_some-slug"),
    "1a2b3c4d-1234-5678-9abc-1234567890ab"
  );
});

test("cardIdFromHref accepts the singular /character/ path too", () => {
  const { cardIdFromHref } = load();
  assert.equal(
    cardIdFromHref("/character/1a2b3c4d-1234-5678-9abc-1234567890ab_slug"),
    "1a2b3c4d-1234-5678-9abc-1234567890ab"
  );
});

test("cardIdFromHref returns null when no uuid is present", () => {
  const { cardIdFromHref } = load();
  assert.equal(cardIdFromHref("/characters/not-a-uuid"), null);
  assert.equal(cardIdFromHref(""), null);
  assert.equal(cardIdFromHref(undefined), null);
});

function makeWrapper({ hasTagBox = true, chips = [] } = {}) {
  return {
    querySelector() {
      if (!hasTagBox) return null;
      return {
        querySelectorAll() {
          return chips.map((text) => ({ textContent: text }));
        },
      };
    },
  };
}

test("tagRowFromWrapper returns null when the tile has no chip container yet", () => {
  const { tagRowFromWrapper } = load();
  assert.equal(tagRowFromWrapper(makeWrapper({ hasTagBox: false })), null);
});

test("tagRowFromWrapper returns an empty row for a chip container with no chips", () => {
  const { tagRowFromWrapper } = load();
  assert.deepEqual(plain(tagRowFromWrapper(makeWrapper({ chips: [] }))), { custom_tags: [] });
});

test("tagRowFromWrapper collects raw chip text, unnormalized", () => {
  const { tagRowFromWrapper } = load();
  const row = tagRowFromWrapper(makeWrapper({ chips: ["👩‍🦰 Female", "#custom"] }));
  assert.deepEqual(plain(row), { custom_tags: ["👩‍🦰 Female", "#custom"] });
});
