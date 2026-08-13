# web/ — the vendored Character Library frontend

This directory started as a **copy** of [SillyTavern-CharacterLibrary][cl] 7.0.4,
taken from `~/workspaces/SillyTavern-CharacterLibrary` on branch `upstream-fixes`,
and adapted to run against the archive server instead of SillyTavern.

**It is no longer a minimal-diff vendor.** The original bet — keep the diff tiny,
treat the API contract as the durable artifact — held through Phase 1–2. Once the
pivot's scope decisions were final, carrying features with no server behind them
cost more than it saved, so the tree was **trimmed to the archive's five jobs**
(store, browse/edit/galleries, acquire, export, bulk tag cleanup). See
"The trim" below for what came out and why.

Re-vendoring wholesale from upstream is therefore no longer possible without
redoing the trim. That is deliberate and was the point.

## The trim

63,000 lines came out — `web/` went from ~151,000 lines of JS/CSS/HTML to ~80,500,
and from 117 files to 73. Nothing here was a judgement call made on the spot: the
drop list is the pivot's own scope decision.

### Features dropped (no server behind them, by decision)

`chats`, `character-creator` (and its AI Studio), `recommender`, `card-updates`,
`playlists`, `css-assistant` — named in the pivot as dropped. Plus three more,
decided during the trim: `custom-css` + the theme customizer,
`character-versions` (snapshots need a write path the API does not have), and
`gallery-sync` (it flags cards missing a `gallery_id`, but the archive stamps one
at write time, so it could never fire).

`lorebook-manager` followed in Phase 3 (6,773 lines) once the write path made
the decision unavoidable: it is a full-screen editor for standalone World Info
*files*, which are a SillyTavern concept. This archive's lorebooks live inside
their cards as `character_book`, edited in the detail modal and written by the
card write path — a format the archive owns. A sidecar file store beside it
would be host compatibility, which is the thing being cut. Its six world-file
helpers in `library.js` now answer locally (`null` / `[]` / `false`) instead of
posting into a refusal, so the callers that remain get "there are none" quietly.
Dropping it also removed the last live consumer of the shared LLM client, which
is now dead code awaiting the next trim.

Each removal is the module file, its CSS, its loader block, its `index.html`
markup, its `library.js` call sites, its settings rows and its Help & Tips
section.

### The mobile layer

`library-mobile.js` + `library-mobile.css` (8,559 lines) deleted outright. The
desktop layout was usable on a phone before that layer existed; the layer made it
worse.

### Providers: 9 → 2

Only **chub** and **datacat** remain. The archive was surveyed first — provider
link keys actually present across 3,839 cards were `datacat` (2,589), `chub`
(1,196) and `jannyai` (54). There were **zero** `janitorai`, `saucepan`,
`pygmalion`, `wyvern`, `chartavern` and `botbooru` links, so those browse views
were dead weight in every sense. Note the CL janitorai provider reads
`extensions.janitorai`, which is *not* this repo's `extensions.jai` key — dropping
it cost nothing at all.

**Two API modules survive their providers, and must not be "cleaned up":**

| kept | why |
| --- | --- |
| `providers/janny/janny-api.js` | `datacat-api.js` searches JannyAI's Meili index and maps its numeric tag ids via `TAG_MAP`. |
| `providers/saucepan/saucepan-api.js` | a datacat hit can be sourced from saucepan; `datacat-browse.js` calls `fetchSaucepanCompanion*` to fill those in. |

Each folder carries a `README.md` saying so. `providers/janitor-bridge.js` also
stays (datacat's Cloudflare pass); `providers/janitor-session.js` went, because
only the deleted janitorai provider imported it and datacat has its own.

### Dead host compatibility

This is the pivot's "host compatibility is the hydra" principle applied to the
frontend:

- **Embedded Mode UI** — the `?embedded=1` iframe panel SillyTavern used to host.
- **`loadCharInMain()`** — "open this card in SillyTavern's window", ~165 lines.
- **Legacy folder migration** (~280 lines) — moved images from old `CharName`
  gallery folders to `CharName_<gallery_id>`. The archive has exactly one layout.
  Removing it also **closed a documented "known gap"**: the stray
  `404 /api/v1/galleries/<Name>` in devtools was this code probing the legacy
  folder name, not a real missing folder.
- **DataCat → JanitorAI batch re-link** (~580 lines) — wrote `extensions.janitorai`
  and read `getProvider('janitorai')`; both gone.

### Still there, and known

The **linked-lorebook** surface — linking a card to an external world by name
(`extensions.world`), the link picker and Bulk Auto-Link — was left in place
even though the manager went. It is interwoven with the *embedded* lorebook
editor in the same modal, so cutting it is a diffuse edit of its own rather
than a line item in a write-path phase. It degrades to "no lorebooks
available", which is true.

`getHostWindow()` / `getSTContext()` and their guarded call sites
(`notifySTCharacterEdited`, `notifySTCharacterAdded`, persona name, the
settings-load fallbacks) were **left in place**. They always return `null`
standalone so every branch is already inert, but they are diffuse rather than
blocked-out and were not worth the risk in one pass. Same for the shared LLM
client — it still has one live consumer, `lorebook-manager.js`, whose AI
features call SillyTavern's `/backends/chat-completions/generate` and
therefore do not work here.

## How it is wired

```
index.html  ->  archive-api.js       (ours, loaded first)
            ->  library-sections/*   (vendored + trimmed; library.js cut into
                                       ~42 files at its own `// ====` section
                                       comments, loaded in order as classic
                                       scripts sharing one global scope --
                                       navigation split, not real modules)
            ->  modules/*            (vendored + trimmed)
```

`archive-api.js` wraps `window.fetch` and translates the SillyTavern URL space
into `/api/v1` calls. It is the seam: as parts of the frontend get reworked,
routes come out of its table and nothing else moves. See the file's header for
why the translation lives on the client rather than in FastAPI.

**What a fetch interceptor cannot reach is the reason for most of the edits
below.** An `<img src>` or `<video src>` never passes through `fetch()`, so any
URL that ends up as an element attribute has to be correct at the point it is
built. Those call sites are patched in place; everything reachable through
`fetch()` is left alone and handled by the adapter.

## Changes from upstream

### Files added (not upstream)

| File | Why |
| --- | --- |
| `archive-api.js` | The adapter. Ours entirely. |
| `manifest.json` | Upstream's lives one directory up, as an ST extension manifest. The version banner reads it. |
| `tests/` | Node tests for the adapter (`cd web && node --test`, or `make test-js`). Also holds the ported upstream `tag-*.test.mjs` suite for `vendor/tag-tools/` (vitest → node:test, no behavioral changes). |
| `vendor/notosans/`, `vendor/fontawesome/css/`, `vendor/fontawesome/webfonts/` | Fonts upstream pulled from SillyTavern's server root (`/webfonts`, `/css`). Nothing serves that root now. Noto Sans is trimmed from 18 weights woff+woff2 (7.3 MB) to the 5 weights the stylesheets declare, woff2 only (1.6 MB) — see `vendor/notosans/notosans.css`. |
| `vendor/tag-tools/` | `tag-analysis.js`, `tag-delta.js`, `tag-dictionary.json` vendored **verbatim** from `~/workspaces/SillyTavern-Character-Tools` (not the Character Library repo) for Phase 5's tag-consolidation merge — see `docs/PHASE_5_TAGS_PLAN.md`. Pure ES modules, no DOM/SillyTavern globals; `package.json` (`"type": "module"`) scopes ESM parsing to this one directory so `node --test` elsewhere in `web/` stays CommonJS as before. `fixtures/pattern-vectors.json` is the regression evidence for the dictionary's glob rules, also vendored verbatim. All tag-matching semantics live here; the server only applies a literal `{rename, remove}` plan (`POST /api/v1/tags/apply`) — see §4 of the plan for why this is not ported to Python. |

### Files renamed

- `app/library.html` → `index.html`. `app/` and `modules/` were flattened into
  this one directory, so `../modules/module-loader.js` in the script tags became
  `modules/module-loader.js`.

### `index.html`

1. Font stylesheet links repointed from SillyTavern's root to `vendor/`.
2. `<script src="archive-api.js">` added **before** `library.js`. It is a plain
   script, not a module: modules are deferred, and a deferred adapter would
   install itself after `library.js` had already hit the network.
3. Title changed to "Character Archive".

### `library.js`

Split into `library-sections/NN-*.js` (see the wiring diagram above); the
filename `library.js` below refers to that pre-split monolith the edits were
made against.

Every edit is marked in place with a comment beginning `ARCHIVE FORK`, so
`grep -rn 'ARCHIVE FORK' library-sections/` is the authoritative list.

1. **`prepareCharacterKeys()`** — takes `char.token_estimate` from the server
   when present. The list endpoint sends no prose, so `computeTokenEstimate()`
   would sum five empty strings and score every card 0. The server computes the
   same sum of the same five fields at parse time (`prompt_chars`).
2. **`DEFAULT_SETTINGS.uniqueGalleryFolders`** — `false` → `true`. Upstream
   defaults it off because a SillyTavern install may hold either gallery layout.
   This archive holds exactly one: all 3,804 folders are `<Name>_<gallery_id>`.
   Left off, every gallery looks empty until the user finds the setting.
3. **`getCharacterAvatarUrl()`**, **`getCharacterAvatarStThumbUrl()`**,
   **`getCharacterAvatarThumbUrl()`** — repointed at
   `/api/v1/characters/<id>/{png,thumb}`. These three build every avatar URL in
   the app and their results become `<img src>`. The large grid tier maps to
   `?size=<n>` against the archive server's own thumbnail route.
4. **`galleryFileUrl()`** — new helper, and 11 call sites that inlined
   `/user/images/<folder>/<file>` now go through it. Deliberately *not* applied
   to the `deletePath` variables: those are request payloads naming a file, not
   URLs to load.
5. **`saveGallerySettings()`** — POSTs the blob to `/api/settings/save`.
   Upstream has **no HTTP save path at all**: it writes SillyTavern's in-memory
   `extensionSettings` and lets ST flush that to disk, so standalone the only
   thing that ran was the `localStorage` backup. See "Settings" below.
6. **`getAllCharLore()`** — returns `null` unconditionally, before any of its
   reads. **This one is load-bearing for data safety on the receiving end** and
   is explained under "Settings"; do not restore it to upstream without a real
   additional-lorebook store.
7. **`handleGalleryFolderRename()`** — body deleted, returns success. The
   archive resolves galleries by `gallery_id`, so there is nothing to move. See
   "Writes".
8. **The six world-file helpers** (`getWorldInfoData`, `saveWorldInfoData`,
   `listWorldInfoFiles`, `createWorldInfo`, `deleteWorldInfo`,
   `renameWorldInfo`) — answer locally instead of posting to `/worldinfo/*`.
   The archive stores no standalone world files; see "The trim".

`modules/batch-tagging.js` carries one too: `applyBatchTags()` posts the whole
selection to `/api/v1/characters/tags` in a single request.

### `modules/gallery-viewer.js`

The fullscreen viewer built its media URLs inline; repointed at
`/api/v1/galleries/.../files/...` for the same `<img src>` reason.

### `modules/media-download-queue.css`

Gained the **notifications-center shell** (the topbar bell and its dropdown),
which upstream kept in `gallery-sync.css`. Gallery sync is gone but the
notifications center is not — the media-download queue is still a section in it —
so the shell moved to the one module that still registers a section, and
`.gallery-sync-{container,btn,dropdown}` were renamed to `.notifications-*`.
`multi-select.js` anchors its toolbar button to that container and was repointed
with it.

### Everything else

Untouched apart from the trim. `modules/batch-transfer.js` still addresses
`/user/images/...`, but it reaches it through `fetch()`, so `archive-api.js`
handles it and no edit is needed. `modules/media-dedup.js` is gone as of
Phase 3C step 5 — dedup and the dead-URL ledger moved server-side.

## Verifying a change

There is no re-vendor path any more (see the top of this file). To check the app
still works after touching it:

1. `cd web && node --test` — adapter tests only; they do not cover vendored code.
2. Load the app against a running server and confirm: the grid renders,
   thumbnails appear, a detail portrait loads, a gallery shows images, **every
   settings section opens**, and **every Help & Tips section opens**.

That last pair matters more than it sounds. Panels only execute when opened, so a
handler broken by a deletion stays silent until someone clicks the section — one
over-broad cut during the trim removed `updateGalleryMigrationStatus()` and was
invisible until the Gallery Folders panel was actually opened.

Watch `console.warn` too, not just errors: `multi-select.js` degrades to a warning
and simply never injects its button.

## Settings

The UI's settings — provider tokens, followed creators, display preferences,
117 keys — live in **`data/settings.json`**, served at `/api/v1/settings` and
mapped onto ST's `/api/settings/{get,save}` by the adapter. Seed an install from
an existing SillyTavern with `make settings-import ARGS=--apply`.

They previously lived in `localStorage`, which was a live hazard rather than
merely untidy. localStorage is keyed by **origin**; SillyTavern's stock port is
also **8000**; the archive serves 8000. So the standalone app was reading a
bucket SillyTavern itself had filled while running there earlier — it appeared
to "remember" a Chub token and 19 followed creators that no code in this repo
had ever stored, with SillyTavern not even running. All of it would have
vanished the moment the port or host changed, which is precisely what
containerizing does.

Two vendored edits were unavoidable:

- **`saveGallerySettings()` had no HTTP path to intercept.** It wrote ST's
  in-memory context and `localStorage`, full stop. A fetch interceptor cannot
  hook a call that was never made, so the POST is added at the call site — the
  same class of problem as `<img src>`, and worth expecting again.
- **`getAllCharLore()` now returns `null` outright.** Serving real settings
  *re-arms the `auxWorlds` trap below*: that function reads
  `settings.world_info_settings.world_info.charLore`, and **any** settings
  object makes the read succeed, which yields `[]` — the destructive value. The
  archive genuinely has no charLore store, so `null` ("unreadable") is the
  honest answer and the only one that keeps bundles safe. The adapter also omits
  `world_info_settings` from the payload as a second layer, so losing this patch
  in a re-vendor is not by itself enough to do damage.

Writes are coalesced in the adapter (400 ms) because the frontend saves on every
change including per-keystroke, and flushed on `pagehide`/`visibilitychange` so
a tab closed just after pasting a token does not lose it. The file is written
atomically (temp + `os.replace`) and lands mode `0600` — it is the only copy of
those credentials once the browser-storage copy is gone.

## Bundle export

Bundle `.zip` export works unmodified — no vendored edit was needed and none of
the writer moved to Python. `batch-transfer.js` assembles the zip client-side
with its own zip64-aware `ZipWriter` (`ZIP_STORED`), and every input it needs is
something the adapter already serves: the card PNG off `/characters/<file>` and
the gallery files off `/user/images/<folder>/<file>`.

The two things that *were* wrong were both adapter replies, not vendored code,
and neither one failed loudly:

1. **`/api/settings/get` returned `{ settings: {} }`**, which made
   `getAllCharLore()` report a successful read of an empty charLore map instead
   of an unreadable one — so the exporter wrote **`auxWorlds: []`** onto every
   character. On an *Overwrite* import that array means "restore no lorebooks"
   and strips lorebook links from the cards it lands on. It now returns `{}`.
2. **`/api/characters/chats` answered 501**, which the exporter counts as a
   per-character failure; a completely clean run ended in "N file(s) failed".
   Chat *lists* now answer `200 []` (the archive stores no chats, so zero is the
   truth); reading or writing an actual chat still refuses.

Both are pinned by tests in `tests/archive-api.test.js`. If a future re-vendor
or refactor reintroduces the `{ settings: {} }` shape, the bundle silently
becomes destructive again — that test is the guard.

**The ceiling worth knowing:** the zip is assembled in browser memory before it
downloads. A 94-character export with 1,083 gallery files (454 MB) completed
fine, but this scales with selection size and a whole-archive export would not
fit. Moving the writer server-side (`zipfile`, streamed off disk) is the fix
when bulk export becomes a real workflow; it was not worth a second
implementation of a format the client already writes correctly.

## Writes

Phase 3 made the archive writable. The vendored frontend still calls
SillyTavern's endpoints and `archive-api.js` translates them, exactly as it does
for reads:

| the frontend calls | the archive gets |
| --- | --- |
| `POST /api/characters/merge-attributes` | `PUT /api/v1/characters/<id>` — the whole card |
| `POST /api/characters/edit-avatar` | `PUT /api/v1/characters/<id>/avatar` — multipart |
| `POST /api/characters/delete` | `DELETE /api/v1/characters/<id>?gallery=keep` |
| `POST /api/images/upload` | `POST /api/v1/galleries/<folder>/files` — multipart |
| `POST /api/images/delete` | `DELETE /api/v1/galleries/<folder>/files/<name>` |

Three things are worth knowing before touching any of it.

**A card edit never re-encodes the image.** `pngtools.embed_card` rewrites only
the tEXt chunks and copies every other chunk byte for byte, so a
pngquant-compressed avatar survives an edit exactly. Verified on a real 5.4 MB
palette-quantized card with a 221-entry lorebook: pixel chunks identical.
`tests/test_api_writes.py` pins it, and that is the test to keep working.

An edit does normalize the embedded JSON to this repo's serialization, which is
a **one-time** size change for the ~15% of cards that were imported with compact
JSON (that 5.4 MB card grew 63 KB on its first edit, then stayed byte-stable
across every later one). The other 85% were written here and do not move at all.

**A rename moves nothing.** Not the card file — `char.avatar` is the key the
grid, the DOM, the thumbnail cache and every URL hold, and the filename is a
derived `<slug(name)>_<id8>` label that already diverges for any name with
punctuation. Not the gallery folder either: the archive resolves a gallery by
its `_<gallery_id>` tail rather than by the card's current name
(`proxy/gallery.py:resolve_folder`), which is the same rule the dedupe check
uses — *the id, never the name*. That makes renames free and orphaned folders
structurally impossible, and it is why `handleGalleryFolderRename()` in
`library.js` is now a no-op: upstream moved a gallery by downloading and
re-uploading every file one at a time, which on a 400-image gallery was 800
requests to achieve nothing.

**Nothing is unlinked.** Deleted cards, gallery folders and gallery files move
to `data/.trash/<date>/`, which is never scanned, indexed or exported — the same
contract as `data/_quarantine/`. Emptying it is the only operation here that
actually destroys anything.

Two smaller notes. Card writes accept `If-Match` and answer **412** on a stale
ETag; two tabs on one card is the ordinary case and a whole-document replace has
no partial overlap to soften the loss. And **batch tagging goes straight to
`/api/v1/characters/tags`**, bypassing the adapter — there is no ST endpoint for
it, and inventing a URL to translate would be pretending otherwise. It replaced
a per-card loop that hydrated and wrote each character separately: 1,000 round
trips for a 500-card selection, against one request now.

## Known gaps

- **Search does not match creator notes.** The list endpoint carries no prose;
  notes alone are 13.3 MB across the archive, which would more than double the
  boot payload for one search field. Name, creator, page title, filename and
  tags all match. Adding it means an `include=notes` on the list endpoint.
- **Acquiring a card from Chub or DataCat now works** (Phase 3B, see
  `docs/PHASE_3B_PLAN.md`): the provider is a pure capture layer — it fetches
  the raw provider JSON and POSTs it to `/build-chub` / `/build-datacat`,
  which run the full intake pipeline server-side (macro sanitize, avatar crop
  and resize, pngquant, provenance stamping) instead of storing whatever the
  browser embedded. `characters/create`, `characters/import` and
  `content/importURL` still refuse with 501 — they back the local-PNG-file
  and URL-import modal (a different, still-unbuilt feature) and
  `web/modules/batch-transfer.js`, unrelated to provider acquisition.
  Editing, deleting, replacing an image and gallery writes all work; see
  "Writes" below.
- **The shared LLM client is dead code.** `lorebook-manager` was its last live
  consumer and went in Phase 3. ~250 lines in `library.js`, still exported
  through `core-api.js`, reachable by nothing.
- **Some frontend state still lives in `localStorage`.** Filter presets,
  playlists — everything the frontend stores as a file under `user/files/`.
  The settings blob has moved to `data/settings.json` (above); this is the
  remainder, and it is origin-keyed with the same consequences. The media
  dedup/dead-URL ledger that used to be the largest blob here moved
  server-side in Phase 3C step 5 (`proxy/media_manifest.py`), so it no longer
  counts against the ~5 MB quota.
- **Dead provider settings keys remain in `DEFAULT_SETTINGS`.**
  `pygmalion*`, `wyvern*`, `botbooru*`, `saucepan*`, `ctCookie` and the
  `janitorai*` pair are still declared and still written into
  `data/settings.json`. Their UI and wiring are gone; only the keys are left.

[cl]: https://github.com/SillyTavern/SillyTavern-CharacterLibrary
