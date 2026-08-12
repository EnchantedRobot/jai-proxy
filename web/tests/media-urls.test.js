"use strict";
// `extractMediaUrls` is where media localization starts: a URL it mangles is a
// file that never downloads and, worse, a fabricated URL that 404s and gets
// filed as permanently dead -- the same laundering docs/PHASE_3C_PLAN.md §1
// was written about, one layer earlier.

const test = require("node:test");
const assert = require("node:assert");
const { loadSection } = require("./helpers/load-section");

const section = loadSection("30-media-localization-feature.js");

// The sandbox has its own `Array`, so its results are never reference-equal to a
// host literal under deepStrictEqual. Copy across the realm boundary once, here.
const extractMediaUrls = (text) => Array.from(section.extractMediaUrls(text));

test("a JanitorAI {{random:(a),(b)}} macro yields each URL, not one run-on string", () => {
  const text =
    "![]{{random:(https://files.catbox.moe/2og42i.jpg)," +
    "(https://files.catbox.moe/mgnq2e.jpg)," +
    "(https://files.catbox.moe/4p0fdu.jpg)}}";
  assert.deepStrictEqual(extractMediaUrls(text), [
    "https://files.catbox.moe/2og42i.jpg",
    "https://files.catbox.moe/mgnq2e.jpg",
    "https://files.catbox.moe/4p0fdu.jpg",
  ]);
});

test("a markdown image's closing paren is not part of the URL", () => {
  const text = "![](https://media.datacat.run/a/b.webp/0501d0ff901a583e)\n\nprose";
  assert.deepStrictEqual(extractMediaUrls(text), [
    "https://media.datacat.run/a/b.webp/0501d0ff901a583e",
  ]);
});

test("a real URL containing parens still survives, via the markdown branch", () => {
  const text = "![](https://i.postimg.cc/CLPDhrp9/(16).jpg)";
  assert.deepStrictEqual(extractMediaUrls(text), ["https://i.postimg.cc/CLPDhrp9/(16).jpg"]);
});

test("bare URLs, html tags and css url() all still resolve", () => {
  const text = [
    "see https://example.com/plain.png here",
    '<img src="https://example.com/tag.jpg">',
    "background-image: url('https://example.com/css.webp')",
  ].join("\n");
  assert.deepStrictEqual(extractMediaUrls(text).sort(), [
    "https://example.com/css.webp",
    "https://example.com/plain.png",
    "https://example.com/tag.jpg",
  ]);
});
