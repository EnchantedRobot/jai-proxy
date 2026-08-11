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
- **Frontend state lives in `localStorage`.** Filter presets, custom CSS, the
  media-dedup ledger. The ~5 MB quota is a real limit for the ledger on a large
  library; a write that would overflow fails loudly rather than truncating.
- **A missing gallery folder logs a 404 in devtools.** The adapter turns it into
  an empty listing, which is correct, but the underlying request is still
  visible. The API 404s on a folder that does not exist rather than creating it
  the way SillyTavern did.

[cl]: https://github.com/SillyTavern/SillyTavern-CharacterLibrary
