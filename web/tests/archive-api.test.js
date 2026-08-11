"use strict";
// What the adapter must get right, stated as tests.
//
// Every case here is a translation the frontend depends on and cannot check for
// itself: it calls a SillyTavern URL and trusts what comes back to be a
// SillyTavern shape. If one of these mistranslates, the failure surfaces as an
// empty grid or a missing gallery three layers away from the cause.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAdapter, post, card } = require("./helpers/load-adapter.js");

const LIST = "/api/v1/characters?limit=0&health=all&include=extensions";

test("the character list is fetched whole, with extensions", async () => {
  const { fetch, calls } = loadAdapter({ [LIST]: { total: 1, items: [card()] } });

  const resp = await post(fetch, "/api/characters/all", {});
  const chars = await resp.json();

  // include=extensions is not decoration: without it every card in the grid
  // loses its provider link, gallery id and version uid.
  assert.deepEqual(calls, [LIST]);
  assert.equal(chars.length, 1);
  assert.equal(chars[0].avatar, "Abbie_0d162f5f.png");
  assert.deepEqual(chars[0].data.extensions.jai, { id: "0d162f5f", pageName: "Abbie" });
});

test("a listed card is never marked shallow", async () => {
  // `shallow: true` makes library.js believe extensions were stripped and fire
  // one request per card to recover them -- 3,839 of them on the real archive.
  // We ship the extensions in the list, so there is nothing to recover.
  const { fetch } = loadAdapter({ [LIST]: { total: 1, items: [card()] } });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.ok(!char.shallow);
});

test("the token estimate comes from the server, not from absent prose", async () => {
  const { fetch } = loadAdapter({
    [LIST]: { total: 1, items: [card({ prompt_chars: 4000 })] },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.token_estimate, 1000);
});

test("the favourite flag is read out of extensions, where the cards keep it", async () => {
  const { fetch } = loadAdapter({
    [LIST]: {
      total: 2,
      items: [
        card({ id: "a.png", extensions: { fav: true } }),
        card({ id: "b.png", extensions: {} }),
      ],
    },
  });
  const chars = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(chars[0].fav, true);
  assert.equal(chars[1].fav, false);
});

test("date_added is epoch milliseconds, which is what the grid sorts on", async () => {
  const { fetch } = loadAdapter({
    [LIST]: { total: 1, items: [card({ linked_at: "2026-07-17T12:00:00Z" })] },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(typeof char.date_added, "number");
  assert.equal(char.date_added, Date.parse("2026-07-17T12:00:00Z"));
});

test("one card comes back with its prose at the root and in data", async () => {
  // library.js reads char.description as readily as char.data.description --
  // SillyTavern serves both -- so the detail view breaks if only one is filled.
  const { fetch, calls } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png": {
      ...card(),
      spec: "chara_card_v3",
      spec_version: "3.0",
      card: {
        name: "Abbie",
        description: "A vampire.",
        first_mes: "Hello.",
        alternate_greetings: ["Hi.", "Hey."],
        tags: ["Female", "Vampire"],
        extensions: { gallery_id: "kzbYR2QbpncC" },
      },
      gallery: { gallery_id: "kzbYR2QbpncC", folder: "Abbie_kzbYR2QbpncC", exists: true, images: 4, bytes: 100 },
    },
  });

  const resp = await post(fetch, "/api/characters/get", { avatar_url: "Abbie_0d162f5f.png" });
  const char = await resp.json();

  assert.deepEqual(calls, ["/api/v1/characters/Abbie_0d162f5f.png"]);
  assert.equal(char.description, "A vampire.");
  assert.equal(char.data.description, "A vampire.");
  assert.deepEqual(char.alternate_greetings, ["Hi.", "Hey."]);
  assert.equal(char.spec, "chara_card_v3");
});

test("a card id with characters that need escaping survives the round trip", async () => {
  const id = "A Mother's Claim_7urd.png";
  const { fetch, calls } = loadAdapter({
    [`/api/v1/characters/${encodeURIComponent(id)}`]: { ...card({ id }), card: {} },
  });
  const resp = await post(fetch, "/api/characters/get", { avatar_url: id });
  assert.equal(resp.status, 200);
  assert.equal(calls[0], `/api/v1/characters/${encodeURIComponent(id)}`);
});

test("avatar thumbnails and card PNGs map to their archive routes", async () => {
  const { fetch, calls } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png/thumb": {},
    "/api/v1/characters/Abbie_0d162f5f.png/png": {},
  });
  await fetch("/thumbnail?type=avatar&file=Abbie_0d162f5f.png");
  await fetch("/characters/Abbie_0d162f5f.png");
  assert.deepEqual(calls, [
    "/api/v1/characters/Abbie_0d162f5f.png/thumb",
    "/api/v1/characters/Abbie_0d162f5f.png/png",
  ]);
});

test("a gallery listing is flattened to the filenames the frontend expects", async () => {
  const { fetch } = loadAdapter({
    "/api/v1/galleries/Abbie_kzbYR2QbpncC": {
      folder: "Abbie_kzbYR2QbpncC",
      total: 2,
      bytes: 100,
      items: [
        { name: "one.webp", kind: "image", size: 50, modified: "2026-07-17T12:00:00Z", url: "u", thumb_url: "t" },
        { name: "two.mp4", kind: "video", size: 50, modified: "2026-07-17T12:00:00Z", url: "u", thumb_url: null },
      ],
    },
  });
  const files = await (await post(fetch, "/api/images/list", { folder: "Abbie_kzbYR2QbpncC" })).json();
  assert.deepEqual(files, ["one.webp", "two.mp4"]);
});

test("a missing gallery folder reads as an empty gallery, not an error", async () => {
  // SillyTavern answered 200 [] here because it created the directory on the
  // way past. The archive 404s rather than littering, so the emptiness has to
  // be synthesised at this seam -- otherwise the frontend shows "failed to
  // load gallery" for every character that never had images downloaded.
  const { fetch } = loadAdapter({
    "/api/v1/galleries/Nobody_xxx": new Response(null, { status: 404 }),
  });
  const resp = await post(fetch, "/api/images/list", { folder: "Nobody_xxx" });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), []);
});

test("gallery folders are reported as bare names", async () => {
  const { fetch } = loadAdapter({
    "/api/v1/galleries": [
      { folder: "Abbie_kzbYR2QbpncC", card_id: "Abbie_0d162f5f.png" },
      { folder: "Orphan_zzz", card_id: null },
    ],
  });
  const folders = await (await post(fetch, "/api/images/folders", {})).json();
  assert.deepEqual(folders, ["Abbie_kzbYR2QbpncC", "Orphan_zzz"]);
});

test("a gallery image URL splits folder from filename on the first slash only", async () => {
  // Gallery filenames are long, punctuated and occasionally contain characters
  // that survived a URL round trip; splitting on the last slash would put half
  // the filename in the folder.
  const { fetch, calls } = loadAdapter({
    "/api/v1/galleries/A.D.A_NUe2L64PstqQ/files/localized_media_1786.webp": {},
  });
  await fetch("/user/images/A.D.A_NUe2L64PstqQ/localized_media_1786.webp");
  assert.deepEqual(calls, ["/api/v1/galleries/A.D.A_NUe2L64PstqQ/files/localized_media_1786.webp"]);
});

test("gallery thumbnails keep their requested size", async () => {
  const { fetch, calls } = loadAdapter({
    "/api/v1/galleries/Abbie_kz/files/one.webp/thumb?size=384": {},
  });
  await fetch("/api/plugins/cl-helper/gallery-thumb/Abbie_kz/one.webp?s=384");
  assert.deepEqual(calls, ["/api/v1/galleries/Abbie_kz/files/one.webp/thumb?size=384"]);
});

test("everything else cl-helper offered is gone, and says so with a 404", async () => {
  const { fetch, calls } = loadAdapter({});
  const resp = await fetch("/api/plugins/cl-helper/avatar-thumb-stats");
  assert.equal(resp.status, 404);
  assert.deepEqual(calls, [], "a vanished plugin route must not reach the server");
});

test("the frontend's own JSON blobs round-trip through browser storage", async () => {
  const { fetch } = loadAdapter({});
  const payload = JSON.stringify({ presets: [{ name: "vampires" }] });
  const b64 = Buffer.from(payload, "utf8").toString("base64");

  assert.equal((await fetch("/user/files/cl_filter_presets.json")).status, 404);

  const saved = await post(fetch, "/api/files/upload", { name: "cl_filter_presets.json", data: b64 });
  assert.equal(saved.status, 200);

  const read = await fetch("/user/files/cl_filter_presets.json");
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { presets: [{ name: "vampires" }] });

  await post(fetch, "/api/files/delete", { path: "user/files/cl_filter_presets.json" });
  assert.equal((await fetch("/user/files/cl_filter_presets.json")).status, 404);
});

test("a blob with non-ASCII text survives base64 as UTF-8, not as bytes", async () => {
  const { fetch } = loadAdapter({});
  const payload = JSON.stringify({ name: "A Mother’s Claim — café" });
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  await post(fetch, "/api/files/upload", { name: "x.json", data: b64 });
  const back = await (await fetch("/user/files/x.json")).json();
  assert.equal(back.name, "A Mother’s Claim — café");
});

test("every write refuses with 501 and an explanation", async () => {
  const { fetch, calls } = loadAdapter({});
  const writes = [
    "/api/characters/edit-attribute",
    "/api/characters/delete",
    "/api/characters/import",
    "/api/characters/merge-attributes",
    "/api/images/upload",
    "/api/images/delete",
    "/api/worldinfo/edit",
  ];
  for (const path of writes) {
    const resp = await post(fetch, path, {});
    assert.equal(resp.status, 501, `${path} should refuse`);
    // 501 not 404: the route was recognised, the capability is absent. A user
    // clicking Delete in a read-only build gets told which.
    assert.match((await resp.json()).error, /not supported/);
  }
  assert.deepEqual(calls, [], "a refused write must never reach the server");
});

test("chats are refused as out of scope, not silently swallowed", async () => {
  const { fetch } = loadAdapter({});
  assert.equal((await post(fetch, "/api/chats/get", {})).status, 501);
  assert.equal((await post(fetch, "/api/characters/chats", {})).status, 501);
});

test("cross-origin requests pass through untouched", async () => {
  // Nine card providers and ten gallery extractors fetch the open internet
  // through this same window.fetch. Intercepting any of them would break
  // acquisition outright.
  const { fetch, calls } = loadAdapter({
    "https://api.chub.ai/search?q=x": new Response("[]", { status: 200 }),
  });
  const resp = await fetch("https://api.chub.ai/search?q=x");
  assert.equal(resp.status, 200);
  assert.deepEqual(calls, ["https://api.chub.ai/search?q=x"]);
});

test("an unmapped same-origin path falls through to the server", async () => {
  // Static assets -- library.css, the fonts, the module files -- are same-origin
  // and must not be routed anywhere.
  const { fetch, calls } = loadAdapter({ "/modules/core-api.js": new Response("//", { status: 200 }) });
  await fetch("/modules/core-api.js");
  assert.deepEqual(calls, ["/modules/core-api.js"]);
});

test("a body sent as a Request object is read, not lost", async () => {
  // Most call sites pass (url, init), but not all; a handler that only looked at
  // init.body would see an empty payload and 400 on a valid call.
  const { fetch } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png": { ...card(), card: {} },
  });
  const request = new Request("http://archive.test/api/characters/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_url: "Abbie_0d162f5f.png" }),
  });
  const resp = await fetch(request);
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).avatar, "Abbie_0d162f5f.png");
});

test("a fetch for one card without an id is a 400, not a request for nothing", async () => {
  const { fetch, calls } = loadAdapter({});
  const resp = await post(fetch, "/api/characters/get", {});
  assert.equal(resp.status, 400);
  assert.deepEqual(calls, []);
});

test("date_added prefers acquisition time over the file's mtime", async () => {
  // The bulk repair passes rewrote 84% of the archive within one day, so
  // sorting the grid on mtime collapses "recently added" into alphabetical.
  const { fetch } = loadAdapter({
    [LIST]: {
      total: 1,
      items: [card({ linked_at: "2026-07-21T17:31:47.257Z", modified: "2026-07-30T00:00:00Z" })],
    },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.date_added, Date.parse("2026-07-21T17:31:47.257Z"));
});

test("a card with no acquisition stamp falls back to its mtime", async () => {
  // Every card this tool wrote carries linkedAt; one dropped in by hand does not.
  const { fetch } = loadAdapter({
    [LIST]: { total: 1, items: [card({ linked_at: "", modified: "2026-07-30T00:00:00Z" })] },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.date_added, Date.parse("2026-07-30T00:00:00Z"));
});
