# web/ — the vendored Character Library frontend

This directory is a **copy** of [SillyTavern-CharacterLibrary][cl] 7.0.4, taken
from `~/workspaces/SillyTavern-CharacterLibrary` on branch `upstream-fixes`, and
adapted to run against the archive server instead of SillyTavern.

It is vendored rather than rewritten on purpose. `library.js` alone is 29,700
lines in one file with module-scope globals: it is not trimmable, and a rewrite
is a project rather than a step. The bet is that the *API contract* is the
durable artifact and this UI is replaceable later, so the goal here is the
smallest possible diff against upstream — every change listed below, and nothing
else.

## How it is wired

```
index.html  ->  archive-api.js   (ours, loaded first)
            ->  library.js       (vendored, 1.3 MB)
            ->  modules/*        (vendored)
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
| `tests/` | Node tests for the adapter (`cd web && node --test`, or `make test-js`). |
| `vendor/notosans/`, `vendor/fontawesome/css/`, `vendor/fontawesome/webfonts/` | Fonts upstream pulled from SillyTavern's server root (`/webfonts`, `/css`). Nothing serves that root now. Noto Sans is trimmed from 18 weights woff+woff2 (7.3 MB) to the 5 weights the stylesheets declare, woff2 only (1.6 MB) — see `vendor/notosans/notosans.css`. |

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

Every edit is marked in place with a comment beginning `ARCHIVE FORK`, so
`grep -n 'ARCHIVE FORK' library.js` is the authoritative list.

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
   `?size=<n>` rather than to the cl-helper plugin, which no longer exists.
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

### `modules/gallery-viewer.js`

The fullscreen viewer built its media URLs inline; repointed at
`/api/v1/galleries/.../files/...` for the same `<img src>` reason.

### Everything else

Untouched. `modules/batch-transfer.js` and `modules/media-dedup.js` still
address `/user/images/...`, but they reach it through `fetch()`, so
`archive-api.js` handles them and no edit is needed.

## Re-vendoring from upstream

1. Copy `app/*` and `modules/*` over the top, keeping `archive-api.js`,
   `manifest.json`, `tests/`, `VENDORED.md` and `vendor/notosans`,
   `vendor/fontawesome/{css,webfonts}`.
2. Rename `library.html` → `index.html` and redo the three `index.html` edits.
3. Reapply the `ARCHIVE FORK` edits above.
4. `cd web && node --test` — the adapter tests do not cover the vendored edits,
   so also load the app and check: grid thumbnails appear, a detail portrait
   loads, a gallery shows images.
5. `grep -rn 'ARCHIVE FORK' .` should list exactly the edits in this document.

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

## Known gaps

- **Search does not match creator notes.** The list endpoint carries no prose;
  notes alone are 13.3 MB across the archive, which would more than double the
  boot payload for one search field. Name, creator, page title, filename and
  tags all match. Adding it means an `include=notes` on the list endpoint.
- **Every write refuses with 501.** Card edits, deletes, imports, gallery
  uploads and world info all answer with a message the UI shows in a toast. The
  archive API is read-only through Phase 1.
- **Chats, the character creator, the recommender, card updates, playlists and
  the CSS assistant are still present in the UI** but have no server behind
  them. They were dropped by the pivot's scope decision and their menu entries
  have not been removed yet.
- **Some frontend state still lives in `localStorage`.** Filter presets, the
  media-dedup ledger, playlists — everything the frontend stores as a file under
  `user/files/`. The settings blob has moved to `data/settings.json` (above);
  this is the remainder, and it is origin-keyed with the same consequences. The
  ~5 MB quota is a real limit for the ledger on a large library; a write that
  would overflow fails loudly rather than truncating. Moving it beside the
  settings is the obvious next step — it was left out because the settings were
  urgent (they hold credentials that exist nowhere else) and a ledger rebuilds.
- **A missing gallery folder logs a 404 in devtools.** The adapter turns it into
  an empty listing, which is correct, but the underlying request is still
  visible. The API 404s on a folder that does not exist rather than creating it
  the way SillyTavern did.

[cl]: https://github.com/SillyTavern/SillyTavern-CharacterLibrary
