"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModules } = require("./helpers/load-src");

// _INCLUDE/_EXCLUDE (which filterSummary reads) are computed once from
// BULK_TAG_FILTER at module-load time, so each filter variant needs its own
// load -- same pattern as bulk.tag-filter.test.js's loadTagFilter().
function load(filter, pathname) {
  return loadModules(["bulk.js"], ["filterSummary", "currentCreatorId"], {
    BULK_TAG_FILTER: filter,
    location: { pathname: pathname || "" },
  });
}

test("filterSummary describes both include and exclude when both are set", () => {
  const { filterSummary } = load({ include: ["female"], exclude: ["futa", "futanari"] });
  assert.equal(filterSummary(), "only female · no futa, futanari");
});

test("filterSummary describes an include-only filter", () => {
  const { filterSummary } = load({ include: ["female"], exclude: [] });
  assert.equal(filterSummary(), "only female");
});

test("filterSummary describes an exclude-only filter", () => {
  const { filterSummary } = load({ include: [], exclude: ["futa"] });
  assert.equal(filterSummary(), "no futa");
});

test("filterSummary is empty when no filter is configured", () => {
  const { filterSummary } = load({ include: [], exclude: [] });
  assert.equal(filterSummary(), "");
});

test("currentCreatorId reads and lower-cases the uuid from /profiles/<uuid>_slug", () => {
  const { currentCreatorId } = load(
    { include: [], exclude: [] },
    "/profiles/1A2B3C4D-1234-5678-9ABC-1234567890AB_some-creator"
  );
  assert.equal(currentCreatorId(), "1a2b3c4d-1234-5678-9abc-1234567890ab");
});

test("currentCreatorId returns null off a profile page", () => {
  const { currentCreatorId } = load({ include: [], exclude: [] }, "/characters/1a2b3c4d-1234-5678-9abc-1234567890ab");
  assert.equal(currentCreatorId(), null);
});
