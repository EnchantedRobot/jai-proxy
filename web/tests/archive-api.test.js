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

test("everything else cl-helper offered is gone, and refuses rather than 404ing", async () => {
  // No entry in the routing table synthesises this anymore (Phase 3B removed
  // the catch-all stub along with the plugin itself) -- gallery-thumb is the
  // one route kept alive above, and DataCat's own surface moved to a real
  // backend route (/api/v1/datacat/*, see proxy/api/datacat.py). What is left
  // is an ST-shaped path nothing claims, which the backstop answers: it used to
  // reach the server and 404, which reads as a typo rather than as a plugin
  // that is not here.
  const { fetch, calls } = loadAdapter({});
  const resp = await fetch("/api/plugins/cl-helper/avatar-thumb-stats");
  assert.equal(resp.status, 501);
  assert.deepEqual(calls, []);
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

test("the writes the archive does not do still refuse with 501", async () => {
  const { fetch, calls } = loadAdapter({});
  const refused = [
    // A card gets into the archive by being acquired from a provider or handed
    // over as a file; creating one from nothing has no equivalent here.
    "/api/characters/create",
    // Standalone World Info files are a SillyTavern concept; this archive's
    // lorebooks live inside their cards.
    "/api/worldinfo/edit",
    // No caller left, and no route left either -- isHostShaped answers for it.
    "/api/content/importURL",
  ];
  for (const path of refused) {
    const resp = await post(fetch, path, {});
    assert.equal(resp.status, 501, `${path} should refuse`);
    // 501 not 404: the route was recognised, the capability is absent. A user
    // clicking it gets told which.
    assert.match((await resp.json()).error, /not supported/);
  }
  assert.deepEqual(calls, [], "a refused write must never reach the server");
});

test("importing a card file becomes a multipart POST to the archive's intake", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/characters": { id: "Nadia_ab12cd34.png", name: "Nadia", duplicate: false },
  });

  const form = new FormData();
  form.append("avatar", new File(["png bytes"], "whatever.png", { type: "image/png" }));
  form.append("file_type", "png");
  const resp = await fetch("/api/characters/import", { method: "POST", body: form });

  // The caller reads `file_name` back and keys avatar URLs and gallery folders
  // on it, so the archive's `id` has to arrive under that name.
  assert.deepEqual(await resp.json(), { file_name: "Nadia_ab12cd34.png", duplicate: false });
  const [sent] = requests;
  assert.equal(sent.url, "/api/v1/characters");
  assert.equal(sent.method, "POST");
  assert.equal(sent.body.get("file").name, "whatever.png");
  // Default policy: never silently replace a card that is already here.
  assert.equal(sent.body.get("on_duplicate"), "skip");
});

test("an overwrite says so, and nothing else can ask for one", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/characters": { id: "Abbie_0d162f5f.png", name: "Abbie", overwritten: true },
  });

  for (const policy of ["overwrite", "copy", undefined]) {
    const form = new FormData();
    form.append("avatar", new File(["x"], "c.png", { type: "image/png" }));
    if (policy) form.append("on_duplicate", policy);
    await fetch("/api/characters/import", { method: "POST", body: form });
  }

  // `copy` is not a thing the archive can do -- two cards sharing one id
  // fragment is what the fragment exists to prevent -- so anything that is not
  // an explicit overwrite lands on skip.
  assert.deepEqual(
    requests.map((r) => r.body.get("on_duplicate")),
    ["overwrite", "skip", "skip"]
  );
});

test("an ST path no route claims refuses loudly instead of reaching the server", async () => {
  // The backstop. Without it an unmapped ST-shaped URL is passed straight
  // through to the archive server, which 404s it with a FastAPI error blob --
  // a missing capability disguised as a broken URL.
  const { fetch, calls } = loadAdapter({});
  for (const path of ["/api/characters/edit-attribute", "/api/backgrounds/all", "/user/notes/x"]) {
    const resp = await fetch(path, { method: "POST" });
    assert.equal(resp.status, 501, `${path} should refuse`);
  }
  assert.deepEqual(calls, [], "a refused path must never reach the server");
});

test("the archive's own API and the page's assets pass straight through", async () => {
  const { fetch, calls } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png": card(),
    "/img/ai4.png": {},
    "/lib/whatever.js": {},
  });
  await fetch("/api/v1/characters/Abbie_0d162f5f.png");
  await fetch("/img/ai4.png");
  await fetch("/lib/whatever.js");
  assert.deepEqual(calls, [
    "/api/v1/characters/Abbie_0d162f5f.png",
    "/img/ai4.png",
    "/lib/whatever.js",
  ]);
});

test("saving a card becomes a PUT of the whole card body", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png": { ok: true },
  });
  const data = { name: "Abbie", description: "rewritten", tags: ["Female"] };
  const resp = await post(fetch, "/api/characters/merge-attributes", {
    avatar: "Abbie_0d162f5f.png",
    // ST's payload mirrors the card at the root as well; only `data` is the
    // card, and only `data` should travel.
    name: "Abbie",
    description: "rewritten",
    data,
  });

  assert.equal(resp.status, 200);
  const sent = requests.at(-1);
  assert.equal(sent.method, "PUT");
  assert.equal(sent.url, "/api/v1/characters/Abbie_0d162f5f.png");
  assert.deepEqual(JSON.parse(sent.body), { card: data });
});

test("a card write that the archive rejects comes back as that rejection", async () => {
  // The frontend puts the body text in a toast, so "the card must have a
  // non-empty name" has to survive the hop rather than becoming a bare failure.
  const { fetch } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png": new Response(
      JSON.stringify({ detail: "the card must have a non-empty `name`" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  });
  const resp = await post(fetch, "/api/characters/merge-attributes", {
    avatar: "Abbie_0d162f5f.png",
    data: { name: "" },
  });
  assert.equal(resp.status, 422);
  assert.match((await resp.json()).error, /non-empty/);
});

test("a card write needs both the avatar and the card", async () => {
  const { fetch, calls } = loadAdapter({});
  assert.equal((await post(fetch, "/api/characters/merge-attributes", { data: {} })).status, 400);
  assert.equal(
    (await post(fetch, "/api/characters/merge-attributes", { avatar: "x.png" })).status,
    400,
  );
  assert.deepEqual(calls, [], "an incomplete write must not reach the server");
});

test("deleting a card keeps its gallery", async () => {
  // The delete modal removes the images itself, file by file, when the user
  // ticks that box -- so the card delete must not take them as well.
  const { fetch, requests } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png?gallery=keep": { id: "Abbie_0d162f5f.png" },
  });
  const resp = await post(fetch, "/api/characters/delete", {
    avatar_url: "Abbie_0d162f5f.png",
    delete_chats: false,
  });

  assert.equal(resp.status, 200);
  assert.equal(requests.at(-1).method, "DELETE");
  assert.match(requests.at(-1).url, /gallery=keep$/);
});

test("replacing an avatar forwards the file as multipart", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/characters/Abbie_0d162f5f.png/avatar": { ok: true },
  });
  const form = new FormData();
  form.append("avatar", new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" }));
  form.append("avatar_url", "Abbie_0d162f5f.png");

  const resp = await fetch("/api/characters/edit-avatar", { method: "POST", body: form });

  assert.equal(resp.status, 200);
  const sent = requests.at(-1);
  assert.equal(sent.method, "PUT");
  assert.equal(sent.url, "/api/v1/characters/Abbie_0d162f5f.png/avatar");
  // The archive names the part `image`; ST named it `avatar`.
  assert.ok(sent.body instanceof FormData);
  assert.ok(sent.body.get("image"), "the image part should be present");
});

test("a gallery upload turns base64 back into bytes", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/galleries/Abbie_kzbYR2QbpncC/files": { path: "user/images/Abbie_kzbYR2QbpncC/x.png" },
  });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const resp = await post(fetch, "/api/images/upload", {
    image: bytes.toString("base64"),
    filename: "x",
    format: "png",
    ch_name: "Abbie_kzbYR2QbpncC",
  });

  assert.equal(resp.status, 200);
  // Callers read `path` back and store it as the local media path.
  assert.equal((await resp.json()).path, "user/images/Abbie_kzbYR2QbpncC/x.png");

  const sent = requests.at(-1);
  assert.equal(sent.method, "POST");
  const part = sent.body.get("file");
  assert.equal(part.name, "x.png");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes, "the bytes should survive");
});

test("a gallery upload tolerates a data: URL prefix on the base64", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/galleries/G_kzbYR2QbpncC/files": { path: "user/images/G_kzbYR2QbpncC/x.png" },
  });
  await post(fetch, "/api/images/upload", {
    image: `data:image/png;base64,${Buffer.from([1, 2]).toString("base64")}`,
    filename: "x",
    format: "png",
    ch_name: "G_kzbYR2QbpncC",
  });
  const part = requests.at(-1).body.get("file");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), Buffer.from([1, 2]));
});

test("deleting a gallery image splits the ST path into folder and file", async () => {
  const { fetch, requests } = loadAdapter({
    "/api/v1/galleries/Abbie_kzbYR2QbpncC/files/one.jpg": new Response(null, { status: 204 }),
  });
  const resp = await post(fetch, "/api/images/delete", {
    path: "/user/images/Abbie_kzbYR2QbpncC/one.jpg",
  });

  assert.equal(resp.status, 200);
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(requests.at(-1).url, "/api/v1/galleries/Abbie_kzbYR2QbpncC/files/one.jpg");
});

test("deleting a gallery image that is already gone is a success", async () => {
  // The dedup and gallery passes both work from lists that go stale mid-run;
  // failing them on a file someone else already removed is noise.
  const { fetch } = loadAdapter({
    "/api/v1/galleries/Abbie_kzbYR2QbpncC/files/gone.jpg": new Response(null, { status: 404 }),
  });
  const resp = await post(fetch, "/api/images/delete", {
    path: "user/images/Abbie_kzbYR2QbpncC/gone.jpg",
  });
  assert.equal(resp.status, 200);
});

test("a character's chat list is empty, not unreadable", async () => {
  // The archive stores no chats, so zero is the truth for every card -- and the
  // difference between "none" and "could not read" is not cosmetic. The bundle
  // exporter counts an unreadable chat list as a per-character FAILURE and ends
  // a wholly clean 94-card run with "N file(s) failed". Observed live before
  // this route was split off from the 501 below.
  const { fetch } = loadAdapter({});
  const resp = await post(fetch, "/api/characters/chats", { avatar_url: "Abbie_0d162f5f.png" });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), []);
});

test("reading or writing an actual chat is still refused", async () => {
  // Unreachable while the list above is empty, and kept so it stays that way:
  // the archive never stores, reads or emits a chat file.
  const { fetch } = loadAdapter({});
  assert.equal((await post(fetch, "/api/chats/get", {})).status, 501);
  assert.equal((await post(fetch, "/api/chats/save", {})).status, 501);
  assert.equal((await post(fetch, "/api/chats/export", {})).status, 501);
});

test("settings load from the server, in the shape library.js looks for", async () => {
  // loadGallerySettings() reads settings.extension_settings[SETTINGS_KEY] --
  // where the blob sat when the frontend ran inside SillyTavern. The store
  // itself knows nothing of that nesting; it is applied here at the seam.
  const blob = { chubToken: "t0ken", datacatFollowedCreators: ["a", "b"] };
  const { fetch, calls } = loadAdapter({ "/api/v1/settings": blob });

  const data = await (await post(fetch, "/api/settings/get", {})).json();

  assert.deepEqual(calls, ["/api/v1/settings"]);
  assert.deepEqual(data.settings.extension_settings.SillyTavernCharacterGallery, blob);
});

test("the settings payload carries no world_info_settings", async () => {
  // Defence in depth for the destructive-bundle trap.
  //
  // getAllCharLore() looks for the additional-lorebook map at
  // settings.world_info_settings.world_info.charLore, and batch-transfer keys
  // manifest semantics off whether that read succeeds: unreadable omits
  // auxWorlds, readable-and-empty writes `auxWorlds: []`. An explicit [] means
  // "restore NO lorebooks" to an importing SillyTavern and strips lorebook
  // links off the cards it overwrites. It shipped once, from an adapter stub
  // returning `{ settings: {} }`, and put `auxWorlds: []` on all 94 characters
  // of a test bundle.
  //
  // getAllCharLore() is patched to return null outright (see web/VENDORED.md),
  // which is the real guard. This one ensures a re-vendor that loses the patch
  // still has to actively add the key back before it can do harm.
  const { fetch } = loadAdapter({ "/api/v1/settings": { chubToken: "t" } });
  const data = await (await post(fetch, "/api/settings/get", {})).json();
  assert.ok(!("world_info_settings" in data.settings), "must not ship a charLore source");
});

test("a settings save is coalesced, then PUT once", async () => {
  // The frontend saves on every change, including per-keystroke in the
  // custom-CSS box. Each of those must not become a disk write.
  const { fetch, calls } = loadAdapter({ "/api/v1/settings": {} });

  for (const v of ["a", "ab", "abc"]) {
    const resp = await post(fetch, "/api/settings/save", { settings: { customCSS: v } });
    assert.equal(resp.status, 200, "the UI is answered immediately, not after the disk");
  }
  assert.deepEqual(calls, [], "nothing written while the writes are still arriving");

  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(calls, ["/api/v1/settings"], "one write, not three");
});

test("a pending settings save is flushed when the page goes away", async () => {
  // Losing the last write to a tab close would lose whichever credential was
  // just pasted in -- the one thing this store exists to hold.
  const { fetch, calls, fire } = loadAdapter({ "/api/v1/settings": {} });

  await post(fetch, "/api/settings/save", { settings: { chubToken: "fresh" } });
  assert.deepEqual(calls, [], "still inside the debounce window");

  fire("window", "pagehide");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["/api/v1/settings"], "pagehide must force the write out");
});

test("a settings save that is not an object is refused", async () => {
  const { fetch, calls } = loadAdapter({});
  for (const bad of [undefined, null, "nope", [1, 2]]) {
    const resp = await post(fetch, "/api/settings/save", { settings: bad });
    assert.equal(resp.status, 400);
  }
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(calls, [], "a rejected save must never reach the server");
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

test("create_date is passed through for the Date Created sort", async () => {
  // The grid's "Date Created (Newest/Oldest)" options and the Info panel's
  // Dates section both read this. It was absent from the adapter entirely, so
  // every card scored 0 and the sort silently did nothing.
  const { fetch } = loadAdapter({
    [LIST]: {
      total: 1,
      items: [card({ create_date: "2026-05-15T15:41:58.048Z", linked_at: "2026-07-30T00:00:00Z" })],
    },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.create_date, "2026-05-15T15:41:58.048Z");
  // Distinct from date_added on purpose: acquisition is restamped by rewrites,
  // creation is not.
  assert.equal(char.date_added, Date.parse("2026-07-30T00:00:00Z"));
});

test("an undated card gets an empty create_date, not undefined", async () => {
  // getCharacterCreateDateValue filters falsy candidates, so '' sorts last;
  // undefined would reach `new Date(undefined)` in the Info panel instead.
  const { fetch } = loadAdapter({ [LIST]: { total: 1, items: [card({ create_date: "" })] } });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.create_date, "");
});

test("a card with no acquisition stamp falls back to its mtime", async () => {
  // Every card this tool wrote carries linkedAt; one dropped in by hand does not.
  const { fetch } = loadAdapter({
    [LIST]: { total: 1, items: [card({ linked_at: "", modified: "2026-07-30T00:00:00Z" })] },
  });
  const [char] = await (await post(fetch, "/api/characters/all", {})).json();
  assert.equal(char.date_added, Date.parse("2026-07-30T00:00:00Z"));
});
