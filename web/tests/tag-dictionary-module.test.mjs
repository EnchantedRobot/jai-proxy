// Unit tests for web/modules/tag-dictionary.js. Stubs fetch and the
// CoreAPI-backed window.getSetting/setSetting bridge before importing, in the
// same style as tag-delta.test.mjs -- no jsdom (see web/tests/README.md), so
// this covers only the DOM-free dictionary-ownership layer.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const FIXTURE = {
  mapping: {
    "Genre": {
      "Fantasy": ["fantasy", "high fantasy"],
      "Sci-Fi": ["scifi", "sci-fi"],
    },
    "Tone": {
      "Dark": ["dark", "grim"],
    },
  },
  removedTags: ["spam", "test"],
};

let settingsStore = {};

globalThis.window = globalThis.window ?? {};
window.getSetting = (key) => settingsStore[key];
window.setSetting = (key, value) => { settingsStore[key] = value; };

let fetchImpl = async () => ({ ok: true, json: async () => FIXTURE });
globalThis.fetch = (...args) => fetchImpl(...args);

const mod = await import("../modules/tag-dictionary.js");
const { loadBaseDictionary, ensureDictionary, saveDictionary, rebuildMapping, dictSnapshot } = mod;

// loadBaseDictionary caches at module scope, so each test that needs a fresh
// fetch must reset that cache via a fresh dynamic import... instead we keep
// the fixture fetch stable across tests and only vary settingsStore, except
// for the one test that needs a different base (imported in isolation below).
beforeEach(() => {
  settingsStore = {};
});

describe("loadBaseDictionary", () => {
  it("keeps categories and preserves JSON key order", async () => {
    const base = await loadBaseDictionary();
    assert.deepStrictEqual(base.canonicalCategories, {
      Fantasy: "Genre",
      "Sci-Fi": "Genre",
      Dark: "Tone",
    });
    assert.deepStrictEqual(base.categoryOrder, ["Genre", "Tone"]);
  });

  it("still flattens to {canonical: [alias...]} the same as before", async () => {
    const base = await loadBaseDictionary();
    assert.deepStrictEqual(base.mapping, {
      Fantasy: ["fantasy", "high fantasy"],
      "Sci-Fi": ["scifi", "sci-fi"],
      Dark: ["dark", "grim"],
    });
    assert.deepStrictEqual(base.removedTags, ["spam", "test"]);
  });
});

describe("ensureDictionary / saveDictionary delta round-trip", () => {
  it("reconstructs an edited dictionary from a saved delta", async () => {
    const working = await ensureDictionary();
    const editedMapping = { ...working.mapping, Fantasy: ["fantasy"], "Sci-Fi": [...working.mapping["Sci-Fi"], "space opera"] };
    await saveDictionary(editedMapping, working.removedTags);

    // Only the moved/added tags should appear in the persisted delta.
    const delta = settingsStore.tagDictionaryDelta;
    assert.deepStrictEqual(Object.keys(delta.overrides).sort(), ["high fantasy", "space opera"]);

    const reconstructed = await ensureDictionary();
    assert.deepStrictEqual(
      [...reconstructed.mapping.Fantasy].sort(),
      ["fantasy"],
    );
    assert.deepStrictEqual(
      [...reconstructed.mapping["Sci-Fi"]].sort(),
      ["sci-fi", "scifi", "space opera"].sort(),
    );
  });

  it("flows a new base canonical through even with an existing delta", async () => {
    settingsStore.tagDictionaryDelta = { overrides: { grim: { unassigned: true } }, blanks: {} };
    let dict = await ensureDictionary();
    assert.ok(!dict.mapping.Dark.includes("grim"));

    // Swap in a base with an extra canonical (simulates a re-vendored dictionary).
    const savedFetch = fetchImpl;
    fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        mapping: { ...FIXTURE.mapping, Genre: { ...FIXTURE.mapping.Genre, Horror: ["horror"] } },
        removedTags: FIXTURE.removedTags,
      }),
    });
    // Force a fresh module instance so the base-dictionary cache doesn't mask the new fetch.
    const fresh = await import(`../modules/tag-dictionary.js?cachebust=${Date.now()}`);
    dict = await fresh.ensureDictionary();
    assert.ok(!dict.mapping.Dark.includes("grim"), "the user's edit is preserved");
    assert.deepStrictEqual(dict.mapping.Horror, ["horror"], "the new canonical flows through");
    fetchImpl = savedFetch;
  });

  it("no-ops when the base fails to load, never calling setSetting", async () => {
    const savedFetch = fetchImpl;
    fetchImpl = async () => { throw new Error("network down"); };
    const fresh = await import(`../modules/tag-dictionary.js?cachebust=${Date.now()}`);
    await fresh.saveDictionary({ Fantasy: ["fantasy"] }, []);
    assert.equal(settingsStore.tagDictionaryDelta, undefined);
    fetchImpl = savedFetch;
  });
});

describe("rebuildMapping", () => {
  it("drops undeclared variants and preserves patterns verbatim", () => {
    const state = {
      groups: [
        {
          canonical: "Fantasy",
          patterns: ["*fantasy*"],
          variants: [
            { tag: "fantasy", declared: true },
            { tag: "Fantasy", declared: false }, // discovered via norm(), must not persist
          ],
        },
        {
          canonical: "Empty Bucket",
          variants: [],
        },
      ],
      removed: [
        { tag: "spam", declared: true },
        { tag: "Spam", declared: false },
      ],
      removedPatterns: ["*selfie*"],
    };

    const { mapping, removed } = rebuildMapping(state);
    assert.deepStrictEqual(mapping.Fantasy, ["fantasy", "*fantasy*"]);
    assert.deepStrictEqual(mapping["Empty Bucket"], []);
    assert.deepStrictEqual(removed, ["spam", "*selfie*"]);
  });
});

describe("dictSnapshot", () => {
  it("is stable regardless of key/array order", () => {
    const a = dictSnapshot({ B: ["y", "x"], A: ["1"] }, ["z", "a"]);
    const b = dictSnapshot({ A: ["1"], B: ["x", "y"] }, ["a", "z"]);
    assert.equal(a, b);
  });
});
