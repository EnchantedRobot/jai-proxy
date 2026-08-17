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

// Images only: audio and video are no longer archived (the writer refuses them
// at both doors -- proxy/media/writer.py UNSUPPORTED_EXT_RE). Discovery has to
// drop them too, or every run proposes a 14MB mp3 the server then declines.

test("audio and video URLs are not discovered", () => {
  const text = [
    "theme https://cdn.example.com/song.mp3 here",
    '<audio src="https://cdn.example.com/voice.mp3"></audio>',
    '<video><source src="https://cdn.example.com/clip.webm"></video>',
    "![](https://cdn.example.com/scene.mp4)",
    "background-image: url('https://cdn.example.com/loop.mov')",
    "https://cdn.example.com/take.wav",
    "https://cdn.example.com/track.m4a",
    "https://cdn.example.com/lossless.flac",
  ].join("\n");
  assert.deepStrictEqual(extractMediaUrls(text), []);
});

test("images alongside audio still come through", () => {
  const text = [
    "![](https://cdn.example.com/portrait.png)",
    "https://cdn.example.com/theme.mp3",
    '<img src="https://cdn.example.com/ref.webp">',
  ].join("\n");
  assert.deepStrictEqual(extractMediaUrls(text), [
    "https://cdn.example.com/portrait.png",
    "https://cdn.example.com/ref.webp",
  ]);
});

test("a query string neither hides an mp3 nor condemns a png", () => {
  // The bare-URL branch has always stopped at the extension, so the `?...` is
  // dropped here rather than preserved -- that is pre-existing behaviour and
  // not what this test is about. What matters: the signed mp3 is still refused
  // and the png whose *query* merely says "mp4" is still kept.
  const text = [
    "https://cdn.example.com/song.mp3?token=abc",
    "https://cdn.example.com/art.png?format=mp4",
  ].join("\n");
  assert.deepStrictEqual(extractMediaUrls(text), ["https://cdn.example.com/art.png"]);
});

test("a markdown-linked mp3 with a signature query is refused", () => {
  // The markdown branch *does* keep the query, so this exercises the
  // pathname-only matching in isArchivableMediaUrl.
  assert.deepStrictEqual(extractMediaUrls("![](https://cdn.example.com/song.mp3?sig=xyz)"), []);
});
