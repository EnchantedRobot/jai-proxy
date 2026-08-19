# UI rewrite — replacing `web/` with a React archive client

**Status:** DONE — Stages 0–7 shipped and verified end to end against the real
archive. The cut-over landed 2026-08-19: `web/` is deleted, the client owns
`/`, and the old directory is preserved on the **`legacy-web`** branch.
Authority for the work; superseded the Phase 3D (`library-sections` → modules)
and Phase 6 (UI simplification) plans, both of which were incremental
improvements to a frontend this plan deleted.

**Design target:** `docs/mockups/d-archive.html`. Its decisions are settled and
are not relitigated here — four tabs, one chip strip, full-page detail, tag
consolidation as a page, sage-on-dark. What follows is how it gets built.

---

## 0. The governing principle: salvage, do not port

`web/` is 115 files and ~68,000 lines of vendored CharacterLibrary, written as a
SillyTavern extension and then bent to stand alone. The instinct with a body of
code that large is to migrate it — module by module, preserving behaviour, so
nothing regresses. That instinct is wrong here, and the reason is worth stating
plainly because every decision below follows from it:

**Nothing in `web/` has to keep working with anything else in `web/`.**

The new app is a separate program. It talks to `/api/v1`, which is a stable,
documented, typed contract that already exists. It does not talk to
`library.js`, to `CoreAPI`, to the `window.*` bridge, or to the settings blob's
117-key schema. So when a piece of logic in `web/` is worth having — the media
URL extractor, the tag bucket builder, Chub's query-string shape — the correct
move is to **lift that one algorithm out, rewrite it in its new language, cover
it with its existing tests, and leave the file it came from to die.** No
interface negotiation, no compatibility shim, no worrying whether the extraction
still fits back into the monolith. It never goes back.

Two consequences, both deliberate:

- **Duplication during the overlap is fine and expected.** The extractor will
  exist in JS in `web/` and in Python in `proxy/` at the same time. That is not
  technical debt, it is the cost of a clean cut, and it is paid off in one
  commit when `web/` is deleted.
- **`web/lib/`, `web/vendor/`, `web/modules/` and `web/library-sections/` all
  die entirely.** There is no "keep the good modules" tier. `lib/` and
  `vendor/` were staging areas for a refactor that this plan cancels. The only
  things that survive are the salvage items enumerated in §1.3 — and they
  survive as *new files in the new app*, not as retained old ones.

The scope of the work is therefore not "68k lines" — it is the mock, plus the
salvage list, plus the API extensions in §3.

---

## 1. Inventory of `web/`

Measured: 115 files, 68,128 lines across JS/CSS/HTML.

| Subtree | Files | Lines |
|---|---:|---:|
| `library-sections/` (the split monolith) | 32 | 22,084 |
| `modules/` (providers, tag manager, gallery, media queue) | 42 | 29,179 |
| `lib/` (the in-progress ES-module extraction) | 11 | 1,640 |
| `vendor/` (fontawesome, dompurify, tag-tools) | 9 | 520 |
| `tests/` | 8 | 1,949 |
| `index.html` + `library.css` + `archive-api.js` | 3 | 13,770 |

### 1.1 Dies with the rewrite — SillyTavern-era baggage

These exist because the frontend was once an extension inside another app.
None of them describe anything the archive actually needs.

| What | Where | Why it dies |
|---|---|---|
| ST fetch adapter | `archive-api.js` (854) | Its entire job is translating ST's `/api/characters/all`, `/thumbnail?type=avatar`, `/user/images/…` onto `/api/v1`. The new client calls `/api/v1` directly. This file is the single clearest measure of the win. |
| Settings persistence + migrations | `05-` (402), `06-` (2,145) | A 117-key blob with years of migrations for keys the new UI will never define. New app defines a small, new settings schema (§3.7). |
| `window.*` bridge + CoreAPI | `40-core-api-bridge.js` (214), `modules/core-api.js` (1,433) | An abstraction layer between a monolith and its lazily-loaded modules. React + TanStack Query is that layer. |
| Module loader / cache-buster | `modules/module-loader.js` | Vite. The `MODULE_VERSION` hand-bump and the static-cache trap it works around both disappear with content-hashed assets. |
| Virtual scrolling | `14-` (1,720) | Replaced by server-paged infinite scroll (§4.3). |
| Custom `<select>` | `04-` (377) | radix Select. |
| Advanced filter builder | `20-` (726) | The mock replaced it with the chip strip. Deliberate loss of expressiveness. |
| Theme customizer | `39-` (294) | The mock is one designed theme, not a token editor. |
| Gallery folder system | `11-` (1,653) | The server owns folder naming and resolution now (`proxy/cards/gallery.py`); a rename moves nothing. This is client-side code for a job that moved. |
| Smart image relocation | `12-` (920) | A one-time migration from shared to per-character folders. It ran. It is done. |
| Duplicate detection system | `34-`/`35-`/`36-` (2,582) | Client-side hashing of the whole archive to find duplicates. Replaced for the one case that matters (pre-import guard) by the existing `POST /existing`, which answers from the id8 fragment on disk. |
| charLore | `42-` (337) | Additional lorebooks stored in *SillyTavern's* settings, reachable only through a live ST window handle. There is no ST. |
| Update lock, provider link | `27-` (14), `25-` (803) | Extension-era coupling; provider linking is superseded by `extensions.<provider>` written at intake. |
| Batch transfer to ST | `modules/batch-transfer.js` (1,104) | Export is `png_url`. The bulk path is the bundle zip, deferred (§3.10). |
| Import summary modal, notifications centre | `24-` (350), `21-` (691) | Replaced by inline toasts. (The Activity popover that was to absorb them is dropped — §3.6.) |
| Mobile mode, scrollbar auto-hide, search highlighting, keyboard nav, expand-field modal, date utilities, fallback images, api-endpoints, world-info-api | `lib/*` (1,640) | The staging area for a cancelled refactor. Each is either trivially re-derived in React or answers a need the new design does not have. `world-info-api.js` in particular serves standalone ST world-info files, which the archive refuses (501) by design. |
| FontAwesome | `vendor/fontawesome/` | lucide-react. |
| `library.css` | 10,958 | Tailwind v4 + the mock's tokens. |
| Everything in `web/tests/` except two files | `tests/` | Tests of code being deleted. |

### 1.2 Real functionality that must survive (in some form)

| Capability | Lives today in | Fate |
|---|---|---|
| Browse / filter / sort 3,839 cards | `13-slim-index.js`, `14-` | Rebuilt on the server-paged list endpoint |
| Card detail: prose, greetings, lorebook, gallery, related, raw JSON | `index.html` panes + `15-` | Rebuilt as the mock's 7-tab detail route |
| Card editing (fields, tags, lorebook, avatar replace) | `15-` (1,825), `18-`, `22-` | Rebuilt inline on the detail page (§4.4) |
| Favourites | `17-` (143) | Rebuilt on a new API field (§3.1) |
| Creator-notes rendering (sandboxed iframe) | `37-` (1,056) | **Salvaged** — see §1.3 |
| Tag consolidation editor | `modules/tag-manager.js` (800), `modules/tag-dictionary.js`, `vendor/tag-tools/` | **Salvaged** — the analysis/delta logic and the dictionary are the asset; the UI is rebuilt from the mock |
| Media URL discovery | `30-` (972), `31-`, `32-`, `33-` | **Salvaged into Python** — see §1.3 and §3.4 |
| Media download progress UI | `modules/media-download-queue.js` (528) | Rebuilt thin, against the existing `/media/jobs` polling API |
| Gallery lightbox | `modules/gallery-viewer.js` (1,029) | Rebuilt (radix Dialog + keyboard nav); ~150 lines in the new stack |
| Chub browse | `modules/providers/chub/*` (5,000+) | **Query shapes salvaged**, UI rebuilt at mock fidelity |
| DataCat browse | `modules/providers/datacat/*` (6,000+) | Same; the `dc-*` session transport on the server is unchanged |
| Userscript generator UI | `lib/userscript-generator.js` | Rebuilt as a Settings section over the existing `/api/v1/userscripts` |
| Bundle export (.zip) | in `library-sections` | Deferred (§3.10) |

### 1.3 The salvage list — the only things lifted out of `web/`

Everything here is copied into the new app (or into `proxy/`) as a new file,
with its tests, and its source is then abandoned in place.

1. **`extractMediaUrls`** — `30-media-localization-feature.js`. The markdown /
   `<img>` / `{{random:(a),(b)}}` URL extractor, including the paren-handling
   fixes that cost a session to find. Ported to **Python**, because discovery
   moves server-side (§3.4). `web/tests/media-urls.test.js` is the port's
   acceptance suite — every case in it must pass in pytest before the Python
   version is trusted.
2. **`vendor/tag-tools/tag-analysis.js` + `tag-delta.js`** (~520 lines) — the
   bucket builder, the apply-payload builder, and the base-vs-session delta. Pure
   functions, already covered by `tag-analysis.test.mjs` / `tag-delta.test.mjs`.
   Ported to TypeScript, tests ported to vitest.
3. **`vendor/tag-tools/tag-dictionary.json`** — curated data, hundreds of
   canonicals and their categories. Copied verbatim as a static asset of the new
   app. This is the single most valuable file in `web/`.
4. **Creator-notes sandbox policy** from `37-creator-notes-module.js` — not the
   1,056 lines, the ~150 that matter: the sandboxed-iframe attribute set, the
   height-measurement handshake, and the min/max clamp. Creator notes are
   untrusted third-party HTML; the server already strips the palette
   (`proxy/text/notes_html.py`) but the isolation boundary is the client's job.
   DOMPurify comes back as an npm dependency, not a vendored blob.
5. **Provider request shapes** — the exact Chub query string (`chub-api.js`) and
   the DataCat session/browse calls (`datacat-api.js`), including the
   direct-fetch-then-`/proxy`-fallback pattern in `provider-utils.js`. Knowledge,
   transcribed into ~200 lines of typed query functions, not code moved.
6. **The two tag-filter traps**, as comments in the new code: both providers
   truncate per-card tag lists in list payloads, and tag include/exclude must
   never be sent as a server query param to either.

Nothing else. If something turns out to be missing during the build, it is
re-derived from the API, not excavated.

---

## 2. Stack and scaffolding

### 2.1 Where it lives

New app at **`frontend/`**, at the repo root, matching cbz-tagger exactly.
`web/` is untouched for the whole build and deleted in one commit at cut-over
(§5). No shared files, no shared build, no interleaving.

```
frontend/
  index.html
  package.json  vite.config.ts  tsconfig*.json  components.json
  openapi.json                  # generated from FastAPI, committed
  src/
    main.tsx  App.tsx  index.css
    lib/      api-client.ts  api-schema.ts (generated)  utils.ts  …
    components/ui/              # shadcn primitives
    components/                 # app components
    pages/                      # route components
    data/tag-dictionary.json    # salvaged
    test/setup.ts
```

### 2.2 Dependencies

Pinned to cbz-tagger's set, no additions except where noted:

React 19 · Vite · TypeScript · `@tailwindcss/vite` (Tailwind v4) · `radix-ui` +
`class-variance-authority` + `clsx` + `tailwind-merge` (shadcn-style) ·
`@tanstack/react-query` · `react-router` · `lucide-react` · `openapi-fetch`.
Dev: vitest + `@testing-library/*` + jsdom + msw · `openapi-typescript` · oxlint
· prettier · shadcn CLI.

Additions this app needs that cbz-tagger does not have:

- **`dompurify`** — creator-notes sanitisation (salvage item 4).
- **Figtree + Instrument Serif** via `@fontsource` packages, not a Google Fonts
  link. This app runs on a LAN with an outbound proxy; it must not need the
  internet to render its own type.
- **No virtualizer.** See §4.3 — server-paged infinite scroll instead, so
  `@tanstack/react-virtual` stays out unless measurement says otherwise.

### 2.3 The typed client

Same two-step as cbz-tagger, wired into the Makefile:

```make
api-schema:                     ## Regenerate the typed TS client from FastAPI
	uv run python -m scripts.export_openapi_schema
	cd frontend && npx openapi-typescript openapi.json -o src/lib/api-schema.ts
```

`scripts/export_openapi_schema.py` imports `proxy.server:app` and writes
`frontend/openapi.json`. Both generated files are committed, and CI re-runs the
target and fails on a diff — that is the mechanism that keeps the client honest
against FastAPI, and it is the reason to treat every §3 extension as a schema
change first and a UI change second.

### 2.4 Dev mode

`npm run dev` on :5173, with `vite.config.ts` proxying to the running server:

```ts
server: { proxy: { '/api': 'http://localhost:8000', '/proxy': …, '/health': … } }
```

`/proxy` and the `dc-*` routes must be proxied too, or Discover cannot work in
dev. The archive server runs as it does today (`make run`, or the container).

### 2.5 Serving from FastAPI

Mirrors cbz-tagger's `ImmutableStaticFiles` + SPA fallback, with one difference:
during the overlap both frontends are mounted, so the new one lives under a
prefix.

- Build with `base: '/next/'`; mount `frontend/dist/assets` at `/next/assets`
  with `Cache-Control: public, max-age=31536000, immutable` (safe — Vite
  content-hashes), and `index.html` with `no-store`.
- Mount order matters and is already load-bearing in `proxy/server.py`: the
  `web/` `StaticFiles` at `/` swallows everything and is mounted last. `/next`
  must be registered **before** it.
- At cut-over: `base: '/'`, mount at `/`, delete the `web/` mount and the
  `NoCacheStaticFiles` class with it.

The client-side router needs the SPA fallback (`FileResponse(index.html)` for
unknown paths) — the current `html=True` StaticFiles does not provide it, which
is why today's UI has no deep links and the new one will.

### 2.6 Docker and CI

- `Dockerfile` gains a `node:2x-alpine` builder stage that runs `npm ci && npm
  run build`, and the runtime stage copies `frontend/dist` only.
- `.dockerignore` is load-bearing (11GB → 12KB context). It must **exclude**
  `frontend/node_modules` and `frontend/dist` and **include** `frontend/`
  source. Getting this wrong is the one change here that can silently balloon
  the build context.
- `.github/workflows/test.yml` gains `frontend-lint:check`, `frontend-typing`,
  `frontend-test`, and the `api-schema` drift check.
- Makefile: `frontend-install`, `frontend-lint`, `frontend-typing`,
  `frontend-test`, `frontend-build`, `api-schema` — same names as cbz-tagger.

---

## 3. API gap analysis

The contract is treated as fixed. Each extension below is listed with its
verdict and its justification; nothing is added merely because it would be
convenient.

### 3.1 Favourites — **EXTEND** (decided)

Today: `extensions.fav` inside the PNG, read via `?include=extensions`, written
by a whole-card `PUT`. Keeping it in the card is right — it survives export and
round-trips through SillyTavern — but the API hides it.

- `CardOut.favorite: bool`, read off the index (which already parses
  `extensions`). Costs one boolean per card, not the 790-byte extensions blob.
- `GET /characters?favorite=true` filter.
- `POST /characters/{id}/favorite {value: bool}` — a dedicated toggle so
  starring a card is not a read-detail → mutate → `PUT` with `If-Match` dance
  over a 1.2 MB payload. This is the one place a targeted write beats the
  whole-document rule, because it is a single boolean the user flips from a grid
  tile, and the rule exists to prevent *ambiguous partial prose updates*.

### 3.2 Chip-strip filters — **EXTEND** `GET /characters`

The mock's chip strip needs more than the current query supports. Add, all
optional, all cheap over the in-memory index:

| Chip | Parameter |
|---|---|
| tag *exclude* (second click) | `exclude_tag` (repeatable) |
| Multi-greeting | `min_greetings=2` |
| Untagged | `untagged=true` |
| Added this week | `added_after=<iso>` (against `linked_at`) |
| Favourites | `favorite=true` (§3.1) |

Not added: tag OR-semantics (the mock's chips are AND), and free-text search
over description prose — see §3.9.

### 3.3 "Needs media" chip — **NO CHANGE**, and deferred to Stage 5

`GET /media/status` already returns per-card `{files, complete, dead}` for every
card with a manifest. The client fetches it once, caches it, and intersects
ids. A dedicated filter parameter would put manifest I/O inside the hot list
path for a chip that is used occasionally.

**RESOLVED at the pre-cut-over pass (2026-08-18): built as `needs_media=true`.**
The first of the two options below, with the manifest read hoisted out of the
per-record predicate. See the verification-pass entry in §5.

**Stage 1 note:** an id intersection does not compose with server-side paging.
The grid asks for cards 100–199 of the *filtered* set; a client that then
removes some of them is showing a short page and a wrong total, and cannot ask
for the rest. So the chip is not in the Stage 1 strip. It lands in Stage 5 with
the rest of media, and the decision to make there is between a real
`needs_media=true` parameter (manifest I/O in the list path, but only when the
chip is on) and a cached set of ids the *server* intersects before it pages.

### 3.4 Media discovery — **EXTEND** (decided: move server-side)

Today the browser scans a card's fields, resolves provider galleries and
extractor pages, and hands the server a URL list. That is the largest and
gnarliest block of JS in the inventory, and it is pure text processing over data
the server already holds.

- Port `extractMediaUrls` to Python (salvage item 1), against
  `web/tests/media-urls.test.js` as the acceptance suite.
- `POST /characters/{id}/media/scan` → the discovered URL list (dry run, so the
  UI can show "43 images found" before committing).
- `POST /media/jobs` gains `discover: true` as an alternative to an explicit
  `items` list — the server scans, then downloads, in one job.
- The UI then only ever: triggers a job, polls `GET /media/jobs/{id}`, renders
  progress. `/media/jobs` already returns exactly the event stream that needs.

Explicitly **not** ported: the seven gallery extractors under
`modules/gallery-extractors/` (catbox, gdrive, imgbb, imgbox, imgchest, mega,
postimg). They resolve a hosting page into direct image URLs, some of them with
session cookies the browser happens to hold. Each can be reconsidered
server-side later, on evidence of a real card that needs it -- not up front.

### 3.5 Tag consolidation — **NO CHANGE**

`POST /tags/apply` takes a literal `{rename, remove}` plan and already exists,
tested and verified against the real corpus. The staged-change stats
(renames/removals/cards affected/vocabulary before→after) are computed
client-side from `GET /facets` and the working dictionary, exactly as today. The
dictionary itself persists in the settings blob (§3.7). The mock's Tags page is
a UI rebuild with zero server work — the cheapest page in the plan.

### 3.6 Activity feed — **DROPPED** (decided 2026-08-18)

The bell comes out of the top bar. No endpoint, no JSONL, no `ActivityPopover`.

The reasoning that made it optional is the reasoning that killed it: cards
arrive from the userscripts and from bulk imports with no browser involved, so
the only honest implementation is server-side, and an ~80-line append-only log
plus a feed UI is not worth it for an affordance nobody asked for. Import
results surface as inline toasts instead.

### 3.7 Settings persistence — **NO CHANGE, with a data-loss trap**

`GET`/`PUT /api/v1/settings` stores an opaque blob. The new app defines its own
small schema (grid prefs, default sort, shelf on/off, provider toggles, tag
dictionary delta, followed creators).

**Trap:** `PUT` is a whole-document replace, and that blob is the only copy of
the Chub and DataCat tokens. During the overlap both frontends read and write
it. The new client must therefore **read-modify-write**: fetch the blob, merge
its own keys under a `ui2` namespace, `PUT` the whole thing back. A naive
"write my settings" implementation destroys the tokens the first time the new
UI saves, and the failure surfaces later, in Discover, looking like an auth bug.

At cut-over, the old keys can be dropped in a one-off script; not before.

### 3.8 Discover — **EXTEND (small), reusing `POST /existing`**

- Provider browse: unchanged. Chub goes browser-direct with the `/proxy`
  fallback; DataCat goes through the existing `dc-init` / `dc-proxy` /
  `dc-extract` session routes. Both already work.
- Adding to the archive: `POST /build-chub` / `POST /build-datacat`, unchanged.
- "Hide cards I have" **and** the pre-import duplicate guard (both wanted):
  `POST /existing` already answers "which of these id8 fragments are on disk",
  archive-wide, and is what the userscript's bulk path uses. Re-expose it as
  `POST /api/v1/characters/have` so the new client is not reaching into the
  userscript namespace; the implementation is one call to
  `deps.png_writer.existing`. The 2,582-line client-side duplicate scanner is
  not replaced by anything else.
- Following: the followed-creator list is settings data (§3.7); the provider
  query for "cards by creator X" already exists in both APIs.

### 3.9 Search overlay — **NO CHANGE, one mock affordance cut**

`?q=` ANDs terms over name, creator, page title, filename and tags. The mock's
scope chips (All fields / Name / Creator / Tags / Description) mostly map onto
existing parameters — except **Description**, which the index deliberately does
not carry (`description_chars` only; the prose is never loaded into the index).

Verdict: **cut the Description scope chip** for v1. Adding it means either
holding 3,839 descriptions in memory or reading 3,839 PNGs per query, and the
mock's other four scopes cover the real use.

**Revised at Stage 1 — the other four did not map after all.** `?q=` matches one
fused haystack; there was no way to say "only names". The three ways to fake it
client-side are all worse than they look: exact `creator=` is not a substring
search, narrowing a *page* of results is wrong wherever the match count is
shown, and narrowing the whole result set means fetching it. So `GET
/characters` gained **`scope=all|name|creator|tags`** — about fifteen lines,
folding on demand rather than carrying four more derived strings on every index
record. A narrower scope only ever narrows: `all` is the union of the others
plus page title and filename, so nothing matches in a scope that would not have
matched without one.

### 3.10 Import popover — **partly deferred**

| Mock item | Verdict |
|---|---|
| Upload PNG cards… | Ships. `POST /characters` exists; multi-file is a client loop. |
| Search providers… | Ships. Routes to Discover. |
| Import from URL… | **Deferred.** Refused 501 today. Needs a small server route (guarded fetch → intake); not v1. |
| Import a folder… | Ships as multi-file upload (the browser cannot read a folder otherwise). |
| Restore a bundle (.zip) | **Deferred past cut-over**, then rebuilt server-side. See §5.3. |

### 3.11 Detail "Info" tab — **EXTEND (optional, small)**

`CardDetailOut` covers file, id, gallery id, spec, size, provenance, counts. Not
available: avatar pixel dimensions, whether pngquant ran, and the
unresolved-macro count. All three are already computable server-side
(`proxy/cards/avatar_image.py`, `proxy/text/macros.py`).

Verdict: add an optional `image: {width, height, compressed}` and
`unresolved_macros: int` to `CardDetailOut` — it is one card's worth of work per
request, not the list path — or drop those three rows from the Info tab. Low
priority either way.

**RESOLVED at Stage 2 (2026-08-18): dropped.** `CardDetailOut` is unchanged; the
Info tab shows only what the detail payload already carries. The rows can come
back as an optional block later if they are missed.

### 3.12 Card "More" menu

`Export` = `png_url` (exists). `Delete` = `DELETE /characters/{id}` with
`gallery_action` (exists). **`Duplicate` has no endpoint** — cut it from the
menu rather than fake it with a download-and-reupload round trip.

---

## 4. Routes and components

### 4.1 Routes (react-router)

| Path | Page |
|---|---|
| `/` | Characters |
| `/favorites` | Characters, favourites filter pre-applied |
| `/discover` | Discover |
| `/tags` | Tag consolidation |
| `/characters/:id` | Card detail (7 tabs, `?tab=` for deep links) |
| `/settings/:section?` | Settings |

Deep-linkable, which today's UI is not — that is what the SPA fallback in §2.5
buys.

### 4.2 Primitive mapping (radix / shadcn)

| Mock affordance | Primitive |
|---|---|
| `＋ Filter`, Sort, Import popovers | `Popover` (+ `Command`-style filtered list inside Filter) |
| ⌘K search overlay | `Dialog`, full-bleed variant |
| Detail tabs, Settings section nav | `Tabs` (Settings nav = `Tabs` with vertical orientation, or plain links to `/settings/:section`) |
| Tags page category accordions | `Accordion` (type=multiple) |
| Settings toggles | `Switch` |
| Settings selects | `Select` |
| Gallery lightbox | `Dialog` + `useEmblaCarousel`-free keyboard nav (~150 lines) |
| Delete / apply confirmations | `AlertDialog` |
| Toasts | `Toast` |
| Tag chips, badges, buttons | CVA variants over plain elements — not radix |

### 4.3 The grid, and why there is no virtualizer

3,839 cards. Today: an in-house virtual scroller (1,720 lines) over a 5.9 MB
whole-archive boot payload.

New approach: **server-paged infinite scroll.** `GET /characters` already does
filtering, sorting and `limit`/`offset` server-side and returns `total`.
`useInfiniteQuery` with `limit=100` gives a first paint of 100 tiles from a
~40 KB response, and the DOM only grows as the user scrolls. Filters and sorts
become new queries, not client-side re-sorts of 3,839 objects.

This deletes the virtualizer, the whole-archive fetch, and the client-side sort
comparators in one move. If a real workload shows the DOM growing past comfort
during a long scroll, `@tanstack/react-virtual` is added then — measured, not
pre-emptively.

The mock's "Recently added" shelf is one extra query: `sort=-added&limit=<cols>`,
where `cols` is read from the grid's own computed `grid-template-columns`,
exactly as the mock does it.

### 4.4 Card editing — inline on the detail page (decided)

Each Overview/Greetings/Lorebook/Tags section becomes click-to-edit in place:
an `Edit` button swaps the rendered prose for a textarea (or the tag row for a
tag input), with explicit Save / Cancel. Save issues a whole-card
`PUT /characters/{id}` with `If-Match` carrying the ETag from the detail read —
the endpoint already implements the 412 precondition for exactly this reason.

Consequences to build in from the start:

- The detail query holds the full `card` object; an inline edit mutates a copy
  and PUTs it whole. Partial-field editing over a whole-document write is safe
  *because* the client holds the complete document.
- A 412 means another tab (or the old UI, during the overlap) wrote first. The
  UI must say so and offer reload — not retry silently.
- Only one section is in edit mode at a time. This is a deliberate constraint
  that removes the need for a global dirty-state guard.
- Avatar replacement is `PUT /characters/{id}/avatar` — a separate endpoint,
  outside the section model, on the portrait's own menu.

### 4.5 Component inventory (the build list)

Shell: `AppShell`, `TopBar`, `SearchOverlay`, `ImportPopover`.
Browse: `SectionBar`, `ChipStrip`, `FilterPopover`, `SortPopover`,
`RecentShelf`, `CardGrid`, `CardTile`.
Detail: `DetailBar` (back + prev/next + J/K), `PortraitColumn`, `DetailTabs`,
and one component per pane — `OverviewPane`, `NotesPane` (iframe sandbox),
`GreetingsPane`, `LorebookPane`, `GalleryPane`, `RelatedPane`, `InfoPane`.
Editing: `InlineTextField`, `InlineTagEditor`, `LoreEntryEditor`.
Discover: `ProviderBar`, `DiscoverGrid`, `DiscoverTile` (with in-archive badge),
`AddToArchiveButton`.
Tags: `TagStats`, `CategoryAccordion`, `CanonicalRow`, `VariantChip`,
`ApplyBar`.
Settings: `SettingsNav`, `SettingsSection`, `OptionRow`, plus the
`UserscriptsSection` and `ProxyTestRow`.

---

## 5. Staged path and cut-over

Each stage ends in a working, mergeable state. `web/` keeps serving `/`
throughout.

**Stage 0 — scaffold (no features). DONE 2026-08-18.**
`frontend/` created, Vite + Tailwind + shadcn init, `api-schema` generation
wired, dev proxy working, `/next` mount added to `proxy/server.py`, Makefile and
CI targets, Dockerfile builder stage. Verified: the placeholder renders the real
archive's counts at `http://localhost:8000/next/` with no console errors, deep
links fall back to the shell, `:5173` proxies `/api` through, the image builds
with a 21 KB context, 948 pytest + 2 vitest green.

Three things the build turned up that the plan did not anticipate:

- **`typescript` is pinned to `~5.9`, not cbz-tagger's `~7.0`.**
  `openapi-typescript` declares `typescript@^5.x` as a peer and crashes
  outright on 7 (`ts.factory` is undefined) — cbz-tagger has the same
  breakage locally; its committed client predates the bump. Since generating
  the typed client is the load-bearing half of §2.3, the generator wins.
  Revisit when openapi-typescript supports TS 7.
- **`/proxy` had to be split into two routes.** FastAPI writes one operation
  id per *function*, so the `api_route(methods=["GET", "POST"])` emitted the
  same id twice and the generated TypeScript would not compile. Now
  `cors_proxy` / `cors_proxy_post`, both delegating to one `_forward`. Worth
  knowing generally: **any two-method route breaks the client**, and CI's
  schema-drift check will not catch it — `frontend-typing` will.
- **`openapi-fetch` populates `error` only when the failing response had a
  parseable body.** An empty 500 — an unhandled server exception, a dead
  upstream — yields neither `data` nor `error`, and a query function that
  tests `error` alone returns `undefined`, which TanStack Query surfaces as
  "data is undefined". `lib/api-client.ts` exports `unwrap()`, which trusts
  the status; every query should go through it.

**Stage 1 — Characters, read-only. DONE 2026-08-18.**
Shell, top bar, section bar, chip strip, sort, grid, infinite scroll,
recently-added shelf, ⌘K search, plus the API extensions §3.1, §3.2 and the
`scope` parameter above. Verified against the real archive with the rewritten
smoke gate: 3,868 cards browsable, the lorebook chip narrows to 751, sort and
every chip round-trip through the URL, the tag popover lists the real
catalogue, ⌘K searches, `/favorites` and deep links work — zero console errors,
zero failed requests, zero broken thumbnails. 963 pytest + 23 vitest green.

Server: `favorite` on `CardOut` (read from `extensions.fav` *and* the envelope
root, written only to the extensions copy — `embed_card` rebuilds the envelope
from the spec header plus `data`, so a root-level flag does not survive a
patch); `POST /characters/{id}/favorite`, which is the one targeted write in the
API and is proven not to touch a pixel chunk; `exclude_tag`, `untagged`,
`min_greetings`, `added_after`, `favorite` and `scope` on the list route.

Four decisions the build made that the plan did not anticipate:

- **The Favorites chip is hidden on `/favorites`.** The route pins the filter,
  so the chip beside it was a control that could not be switched off — and
  "All" must clear what the user chose without clearing what the route pinned.
  `ChipStrip` takes a `pinned` list for exactly this.
- **The shelf's "new" badge is checked, not assumed.** The shelf shows the
  newest cards whatever the grid is sorted by; on a quiet week the newest card
  is not a recent one, so the badge tests `linked_at` against the same
  day-rounded boundary the Added-this-week chip uses.
- **`added_after` is compared as a string, deliberately.** `linked_at` is stored
  as the raw ISO-8601 the importer stamped, and ISO-8601 sorts lexically — so
  the chip and `sort=added` cannot disagree. A card with no stamp is undated,
  not recent, and drops out.
- **The shelf's Hide is session state.** Persisting it belongs to the settings
  schema, which is Stage 6; until then it resets on reload.

Not yet in the shell: the Import popover (Stage 3, when there is something
behind it) and the "Needs media" chip (§3.3).

**Stage 2 — Detail, read-only. DONE 2026-08-18.**
The full-page detail route with all seven panes, prev/next + J/K, gallery
lightbox, related, and salvage item 4 (the creator-notes iframe sandbox).
Verified against the real archive with the extended smoke gate: a card opens,
all seven tabs render, the notes iframe mounts, J pages to the next card, and a
detail deep link with `?tab=` resolves — zero console errors, zero failed
requests. 45 pytest-side unchanged (no server work) + 39 vitest green.

§3.11 was **resolved by dropping the three rows** (decided): no
`image`/`unresolved_macros` addition to `CardDetailOut`. The Info tab shows
file/id/gallery/spec/size/provenance/counts, all already on the detail payload.
**No server changes at all in this stage** — related is the existing `creator=`
and `tag=` list filters, and the gallery pane is the existing
`GET /galleries/{folder}`.

Salvage item 4 landed as `components/detail/CreatorNotes.tsx`: DOMPurify (the
content boundary) plus a `sandbox="allow-scripts"`-without-`allow-same-origin`
iframe carrying its own CSP (the frame boundary, opaque origin). The height
handshake is a `postMessage` from the frame's own ResizeObserver — the parent
cannot read an opaque-origin document, so the frame measures itself and the
parent trusts only a number, from this iframe, clamped 60–640px.

Three things the build turned up:

- **Prev/next needs the browse set, which the detail URL does not carry.** The
  fix: `CardTile` appends the current filter querystring to its link
  (`useLocation().search`), and the detail page reads it back through
  `readState` and runs the *same* `useCharacters` query — a cache hit when the
  user came from the grid, so J/K walk the exact filtered set the grid showed,
  across page boundaries via `fetchNextPage`.
- **The recently-added shelf had to pass its own ordering.** Its tiles sit on an
  unfiltered page, so they inherited an empty querystring → the detail defaulted
  to name-sort A→Z, where the newest card is not in the first 100 and the pager
  found no position. `CardTile` grew an optional `search` override; the shelf
  passes `?sort=-added`. Any surface with its own ordering must do the same.
- **A malformed `sort=` throws a 422 the console gate catches.** `readState`
  sanitizes flags and scope but passes `sort` through raw, so a hand-edited (or,
  as first bitten here, a double-`?`-fused) URL reaches the list route as an
  unknown sort. Not fixed — the app never generates one — but noted: if a future
  link can malform `sort`, clamp it in `readState` against `SORTS`.

**Stage 3 — Writes. DONE 2026-08-18.**
Inline editing (description, greetings, lorebook, tags), the favourite toggle,
delete, avatar replace, and multi-file PNG import — a card can now be curated
end to end without the old UI. Verified live against the 3,868-card archive with
a reversible write in the smoke gate (favourite toggled then reverted, the
editor opened and cancelled, the Import menu opened): zero console errors, zero
failed requests, archive left as found. 964 pytest (+1, the detail read's ETag)
and 51 vitest (+12: `card-edit` unit tests plus the detail edit/stale/favourite
integration tests) green; tsc, oxlint, prettier and the production build clean.

**One server change, not "zero":** §4.4 wanted the write's `If-Match` to come
"from the detail read", but `GET /characters/{id}` returned no `ETag` header —
the validator only lived on `/png`. Rather than make the client fetch the token
in a second request (a wider TOCTOU window and an extra round trip), the detail
GET now sets `ETag` from the same `_etag_of` a write checks. `get_character`
grew a `response: Response = None` parameter — injected for the HTTP route, left
`None` for the internal callers (`put_*` return `get_character(...)`) — so the
header is set only on the real request. It does not touch the schema.

Three build decisions worth recording:

- **The ETag rides in the detail query's data, not just its response.**
  `useCharacterDetail` now returns `{ card, etag }` (it queries by hand rather
  than through `unwrap`, which keeps only the body), and a successful `PUT`
  writes the *fresh* ETag from its own response straight back into the cache — so
  a second edit in the same session has a current precondition with no refetch.
- **The avatar cache-bust is a deliberate counter, not the ETag.** The portrait
  URL is stable across an avatar swap (same filename, new pixels), so the browser
  must be told to refetch — but a field edit or a favourite also changes the
  ETag/mtime without changing a pixel, and busting on those reloads the portrait
  for nothing. A `?v=<n>` counter bumped only in the avatar mutation's success
  path reloads the image exactly when the pixels changed.
- **One section edits at a time, enforced structurally.** `EditProvider` holds a
  single `editing: string | null`; every `EditButton` hides itself whenever it is
  non-null, so opening one editor closes every other affordance. This is the
  §4.4 constraint, and it removes any need for a cross-section dirty guard — the
  page holds the whole card, an edit mutates a copy, and the PUT sends it whole.

Deviations from the mock, all deliberate: `Duplicate` is cut from the More menu
(no endpoint, §3.12); `Import from URL…` and `Restore a bundle…` are absent
rather than shown dead (§3.10, §5.3); the tagline stays read-only (it is
provider metadata under `extensions.jai`, not a field the card-body PUT owns).
A pre-existing detail-page test asserted the overview rendered `personality`,
which it never has — corrected to assert the tagline it was titled for.

**Stage 4 — Tags page. DONE (2026-08-18).**
Salvage items 2 and 3 landed as `frontend/src/lib/tags/`: `tag-analysis.ts` and
`tag-delta.ts` are verbatim TypeScript ports (behaviour unchanged) and their
node:test suites came across as vitest — 80 tests, the acceptance gate. The
dictionary is copied byte-for-byte to `tag-dictionary.json` (added to
`.prettierignore` so `format` can't reformat the asset). `dictionary.ts` ports
the ownership layer (base imported as a module, not fetched) and `tags-editor.ts`
turns tag-manager.js's mutable model into immutable transforms the page holds in
state. The page is the mock rebuilt on top: stats strip, category accordions,
canonical rows with variant/rule chips, a Popover-based move menu, Unassigned and
Removed buckets with select/bulk, `＋ New canonical`, `↺ Reset`, and an `Apply`
that resolves the working dictionary into the literal `{rename, remove}` plan and
posts it to the existing `/tags/apply`.

Three things worth recording:

1. **Zero server work, as predicted — including "cards affected".** The one stat
   that genuinely needs per-card data is exact because the page fetches the whole
   archive in a single `GET /characters?limit=0&health=all` request (what CardOut
   is shaped to allow) and runs `buildBuckets`/`computeStats` over the real cards,
   exactly as the old UI did with `getAllCharacters`. No facets adapter, and §3.5's
   "computed from `/facets`" was set aside in favour of the faithful path. The
   verbatim `characters`-based signatures are what let the salvage suite port
   unchanged.

2. **§3.7 read-modify-write shipped here, not deferred to Stage 6.** The tag
   dictionary delta has to persist, and the only home is the settings blob — which
   is also the only copy of the old UI's Chub/DataCat tokens. `use-settings.ts`
   does the merge (fetch fresh, merge under `ui2`, PUT the whole document) and
   `use-settings.test.ts` proves the tokens survive a write. Stage 6 builds the
   fuller settings UI on this.

3. **Smoke stays non-mutating for Tags.** `frontend/tests/smoke.py` drives the tab
   live (19 categories render over 3,868 cards, stats + buckets present, find
   narrows to 3, chip menu opens, Apply dialog opens and cancels) but writes
   nothing — the token store and the archive are left as found. The write paths are
   covered deterministically instead: the settings merge in vitest, the
   move/bulk/delete transforms in `tags-editor.test.ts` (12 tests), and the server
   apply was already proven by the Phase 5 dry-run-copy work. A real end-to-end
   apply against a throwaway archive copy is the remaining pre-cut-over parity check
   (§5.1 #6), not a Stage 4 gate.

Verified: 145 vitest + 964 pytest green, tsc / oxlint / prettier / build clean,
schema stable, live smoke passes with zero console errors and zero failed
requests. Next is Stage 5 — Discover + media (salvage items 1, 5, 6).

**Stage 5 — Discover + media. DONE (2026-08-18).**
Provider browse at mock fidelity, the `have` guard, add-to-archive, and the
media scan/job UI — salvage items 1, 5, 6.

Server (§3.4, §3.8 — three additions, all small):
- `proxy/media/discovery.py` — salvage item 1, `extractMediaUrls` /
  `collectCardTextChunks` / `findCharacterMediaUrls` ported to Python
  verbatim (regexes, order, and the "truncated twin" dedupe step included).
  `tests/media/test_discovery.py` ports `web/tests/media-urls.test.js` case
  for case as the acceptance suite the plan named.
- `POST /characters/{id}/media/scan` — the dry-run preview, split into
  `embedded`/`lorebook`. `POST /media/jobs` gained `discover: bool`: true
  scans server-side and downloads everything found (both surfaces, one
  manifest run) instead of taking an explicit `items` list.
- `POST /characters/have` — the `/api/v1` peer of the userscript's own
  `/existing`, one call to the same `deps.png_writer.existing` fragment
  match. Backs Discover's "hide cards I have" and its duplicate guard.

17 new pytest (scan, discover-job, have-guard, plus the 11-case discovery
unit suite); 981 total, all green. `/build-chub` and `/build-datacat`
(§3.8) needed no changes — they already take raw provider JSON from the
browser and were already tested (`tests/api/test_acquisition.py`).

Client (`frontend/src/`):
- `lib/providers/{shared,chub,datacat}.ts` — salvage item 5, the request
  shapes as knowledge rather than moved code. Chub's `/search` (page-based)
  and DataCat's `recent-public` (offset-based, through the existing
  `dc-init`/`dc-proxy` session) at Discover's fidelity, not `web/`'s full
  provider stack — JanitorAI Supabase auth, MeiliSearch, Hampter page-2+,
  and DataCat script hydration are all left out as out of scope for "search
  and add a card." `shared.ts` carries salvage item 6 (the two tag-filter
  traps) as comments, since Discover does no server-side tag filtering to
  carry them in code.
- `hooks/use-discover.ts` — `useDiscoverSearch` (one query shape over both
  providers' different pagination), `useHaveGuard` (`POST
  /characters/have` over the currently-loaded page), `useAddChubToArchive`
  / `useAddDatacatToArchive` (re-fetch the full record, then `POST
  /build-chub` / `/build-datacat`).
- `pages/DiscoverPage.tsx` + `components/DiscoverTile.tsx` — provider
  toggle, hide-have toggle, search box, sort (Chub only), infinite scroll,
  a Have badge and hover Get button per tile. Following (the settings-backed
  creator list) is left for Settings, per §3.8.
- `hooks/use-media-discovery.ts` + `components/detail/MediaDiscovery.tsx` —
  the scan/job UI: Find media → shows a count → Download → polls `GET
  /media/jobs/{id}` (`refetchInterval`, not a hand-rolled timer) → toasts a
  summary and invalidates the detail + gallery caches. Lives at the top of
  `GalleryPane`, shown whether or not a gallery folder exists yet (the
  common real case).

Verified live against the real 3,868-card archive: Chub search (real
network, real results, real "N already in the archive" count from a live
`/characters/have` round trip), DataCat load, both toggles — zero console
errors, zero failed requests, screenshot matched the mock. A real card's
scan (`3M1LY_b8e0b075.png`) found the one embedded URL a server-side script
independently confirmed. "Get" and "Download" were deliberately not
exercised live (a real write plus a real provider fetch); both write paths
have deterministic pytest coverage instead, the same split Stage 4 used for
Tags.

One build fix worth recording: DataCat's session is server-held and starts
empty, so the very first `dc-proxy` call of a page load would always 401
before a reactive retry-after-401 could recover it — noisy in the console
even though harmless. `dcFetch` now warms the session with one `dc-init`
before the first call, and still falls back to bootstrap-and-retry for a
later 401 (an expired held token).

145 vitest + 981 pytest green, tsc / oxlint / production build clean, schema
regenerated and committed. Next is Stage 6 — Settings, the last stage before
cut-over.

**Stage 6 — Settings. DONE (2026-08-18).**
Settings route with its sections, userscript generator, proxy test, stats — no
server changes at all: every section reads/writes routes that already existed
(`/settings`, `/stats`, `/proxy/status`, `/userscripts`, `/refresh`).

Five sections shipped, not the mock's seven: **Library** (default sort,
"Recently added" shelf visibility — both now real settings, not session
state), **Archive & storage** (live `/stats`: cards, bytes, galleries, broken
count, data directory), **Providers** (Chub/DataCat enable toggles that
Discover now reads, the outbound-proxy URL field wired to a live `/proxy/status`
Test plus a Save that writes it back), **Userscripts** (the real bridge
picker → `/userscripts` list → `POST /userscripts/{key}` → copy/download,
salvaging the generator the way §1.3 always intended, just server-side
already), **Maintenance** (live index stats + a real `POST /refresh`).

Dropped, both named explicitly rather than left dead in the nav: **Media**
(the mock's rows — download-on-import, images-only, concurrent downloads —
describe fixed server policy with no per-request knob behind them; see
[[jai_proxy_images_only_policy]]) and **About** (nothing in the API tracks a
version to show). Building either would have been a control wired to
nothing, which is exactly what §0's salvage rule exists to prevent. This also
resolves open question 5 (NSFW blur): **dropped**, not built — there is still
no NSFW signal in the API to key a toggle off.

Two settings that changed real app behaviour, not just their own page:

- **Default sort and shelf visibility now round-trip through Settings.**
  `CharactersPage` applies `ui2.defaultSort` whenever the URL carries no
  `sort=` of its own (an explicit link still wins), and the shelf's own Hide
  button now writes `ui2.showRecentShelf: false` through the same
  `useUpdateUi2` mutation the Settings toggle uses — closing the exact gap
  Stage 1 left open ("the shelf's Hide is session state... Stage 6").
- **The Providers toggle actually changes Discover.** A provider switched off
  disappears from Discover's chip row, and if it was the active one the page
  falls back to whichever provider is still on. `httpProxyUrl` writes at the
  blob's **root**, not under `ui2` — the one documented exception
  (`proxy/runtime/net.py`'s `SETTINGS_KEY`), because that is the flat key the
  server itself reads.

Verified live against the real 3,868-card archive, including a real
configured outbound proxy in this environment (`state: ok`, proxy and direct
IPs genuinely differed): every section renders, Test hit the live
`/proxy/status`, Generate produced a real 60,757-byte compiled bridge, Rescan
ran a real `/refresh` and updated the stats shown — zero console errors, zero
failed requests. 151 vitest (+3, `CreatorNotes.test.tsx` below) + 981 pytest
green, tsc/oxlint/prettier/build clean.

**A real bug, found and fixed while doing the once-over Matt asked for
alongside this stage:** `CreatorNotes.tsx`'s markdown fallback (used by every
source that flattens notes to markdown — JanitorAI, saucepan, datacat,
JannyAI, i.e. most cards) never handled image syntax. `html_to_md`
(`proxy/text/html_md.py`) emits `![alt](url)` for every `<img>`; the frontend's
hand-rolled `markdownToHtml` only matched `[text](url)` links, so an image
note rendered as a stray `!` beside a mangled anchor — exactly what Matt saw
("only text... no images"). Fixed by matching `![alt](url)` into `<img>`
*before* the link pattern runs (it would otherwise consume the inner
`[alt](url)` first). Verified against a real card
(`3M1LY_b8e0b075.png`, found live by scanning the archive for notes containing
`![`) — the image now actually decodes inside the sandboxed iframe. The
smoke gate (`frontend/tests/smoke.py`) now finds such a card itself on every
run and asserts an image loads inside the notes iframe, not just that the
iframe mounted, so this class of bug fails the gate next time.

The other half of the once-over — whether the detail page's seven tabs
render correctly — did **not** reproduce: driven live (`3M1LY`, and again via
the smoke gate's `Violet`), all seven tabs switch content, update `?tab=`, and
carry zero console errors. Most likely a stale build served during an earlier
manual check ([[jai_proxy_static_cache_trap]] — a hard reload does not bypass
a stale lazily-imported chunk); nothing in the current tab-bar code
(`CharacterDetailPage.tsx`) shows a mechanism for what was seen. Left as
resolved-by-non-reproduction rather than a fix with no diff behind it.

**Pre-cut-over verification pass. DONE (2026-08-18).**
A session spent only on checking that Stages 1–6 were built the way they were
planned, run before Stage 7 because two earlier things marked "done" turned out
not to be (the creator-notes images, found at Stage 6). Every page driven live
against the real 3,868-card archive with both frontends still mounted. Four real
defects found and fixed; each one now has a regression test that fails without
its fix.

1. **`ui2.defaultSort` silently broke two shipped behaviours.** One root cause —
   the grid's *effective* sort never reached the URL — with two symptoms, both
   reproduced live. Picking "Name" from the Sort popover did nothing whenever
   the stored default was anything else (`writeState` dropped `sort=name` as
   "the default", the page read the empty URL and re-applied the stored default
   over the top). And a card opened from a default-sorted grid got no pager and
   dead J/K, because `CardTile` carried a querystring with no ordering in it and
   the detail page fell back to name-sort, where the card is not in the first
   page at all. Fixed by making the omitted value the *stored* default rather
   than a hardcoded `name`, and by giving tiles an explicit `tileSearch(state)`
   that always names the sort. That also fixes a third case never noticed
   because favourites is empty on this archive: `/favorites` pins its filter on
   the route, so its tiles carried no `flag=fav` either and prev/next walked the
   whole archive.

2. **J/K paged the card while you were typing into it.** Stage 3 put textareas
   and tag inputs on the page Stage 2 had already given a bare `window` keydown
   listener, and nothing rechecked the pair. Typing any word containing a "j"
   into a description navigated away and discarded the unsaved draft. Guarded
   with `isTypingTarget` (`lib/utils.ts`) plus a modifier check; the lightbox now
   swallows J/K as well as arrows, since paging the card underneath an open
   viewer leaves it showing another card's images.

3. **The "Needs media" chip had been dropped without a decision.** §3.3 deferred
   it to Stage 5; Stage 5 never mentioned it, and it was not in §5.2's list of
   deliberate losses either — the one mock filter that was neither built nor
   consciously cut. Now `needs_media` on `GET /characters`, taking §3.3's
   "manifest I/O, but only when the chip is on" option: the set is computed once
   and applied *after* the cheap predicates, never inside `_matches`. The
   definition is evidence-based — the last run reported errors, or the manifest
   carries dead URLs (31 cards here) — because deciding whether a *never-scanned*
   card has remote media would mean re-reading every card's prose, which is
   exactly the work the list path exists not to do. `/media/scan` still answers
   that, one card at a time.

4. **The ＋ Filter tag list was capped at 400 of 631 tags.** The popover has its
   own search box, so the 231 rare tags below the cap read as nonexistent rather
   than merely unlisted. `/facets` already treats `limit=0` as "all".

**§5.1 #3 discharged on a real card.** `Adelwyn_b56ba353.png` (9 tags, 4 lore
entries, 3 greetings) was edited through the real UI — description, tags,
greetings, lorebook, then favourited — as five separate whole-card writes. The
139 pixel chunks came through **byte-identical** (same SHA-256 before and
after); only the intended fields moved; lore keys, entry count, extensions and
provenance all survived; `scripts/check_cards.py` reported the result clean. The
card was then restored to its original bytes and the archive left exactly as
found (3,868 cards, 0 unreadable, 0 favourites).

Two notes rather than defects: the smoke gate's `discover_chub_results` is
recorded after a fixed wait and can read 0 while the page is in fact fine, so it
proves nothing either way; and Chub is geo-blocked from this machine directly,
which is invisible in the app because the browser falls back to `/proxy`.

The gate now covers all four fixes: `tag_catalogue_complete` and
`needs_media_chip_agrees` check the UI against the API's own answer, and
`editor_survives_jk` types into an open editor and asserts the page did not
move. 987 pytest (+6) + 154 vitest (+6) green, tsc / oxlint / prettier / build clean,
schema regenerated, smoke exits 0 with zero console errors and zero failed
requests.

**Stage 6B — parity repair. Parts A–D DONE (2026-08-19).** It held Stage 7
until its five open decisions were closed (all are, below). A fifth round of
gaps surfaced *after* two sessions spent
verifying that Stages 1–6 matched this plan, and every one of them had the same
shape: **a stage deferred something, the later stage shipped without mentioning
it, and §5.2 never gained the entry.** The plan then read as complete. Prose
cannot be checked against prose, which is why two verification passes missed
what a ten-minute mechanical sweep of the mock found.

The structural fix is `docs/UI_PARITY_LEDGER.md` — one row per user-visible
capability, seeded by script from §1.2, from every control in
`docs/mockups/d-archive.html`, and from every provider capability flag in
`web/modules/providers/`. **A stage may not be marked DONE while it owns an
`open` row, and `dropped` requires a reason in the row.** Building it
immediately surfaced two further silent losses nobody had named (the Library
card-size control and the tile badge-count toggle) and one open question that
was never closed (Import from URL, §6 Q4, "decide at Stage 5").

What Stage 6B closes, in order:

- **A — the ledger itself**, because it is what makes the rest checkable.
- **B — provider parity.** `chubToken` (the URQL_TOKEN, sent as
  `Authorization: Bearer`; *not* GraphQL — it is only the name of chub.ai's
  localStorage key). Chub Following as a read-only timeline feed plus the
  follows list, with follow/unfollow left to chub.ai. The DataCat token
  lifecycle, wiring the three server routes that already exist and are called by
  nothing. DataCat Following built properly on our side, since it is local
  settings data tied to no account — and `data/settings.json` already holds a
  real `datacatFollowedCreators` list to carry over. Discover tag include/exclude
  chips, reusing `FilterPopover`/`ChipStrip` rather than building new UI, and
  client-side only per the two standing traps. Per-provider NSFW (Chub currently
  hardcodes `nsfw:'true', nsfl:'true'` over the saved setting) and
  `providerExcludeTags`.
- **C — media.** Bulk localize returns as a **server-side batch job**
  (`POST /media/jobs {scope:"all"}`) rather than `web/`'s browser loop, so a
  3,868-card run survives the tab closing; one job record, cards sequential,
  because the single serial worker *is* the lock that keeps two runs off the same
  manifest. The Media settings section comes back for the two rows with real
  capability behind them (Bulk Localize, Rescan dead URLs) — it was dropped on a
  reading that named three dead toggles and missed the fourth, live row.
- **D — seven detail-page defects** found by using the app: scrollbar-gutter
  layout shift, a stray shadow beside the creator-notes iframe, the lightbox
  rendering under the fixed bars, no back-to-top, a dropdown menu wrapping a
  single Delete item, uncollapsed long greetings, and the first greeting rendered
  twice (Overview and Greetings).

**Gallery extractors, measured rather than argued.** §3.4 dropped all seven up
front. They are confirmed *separate* from the localize pipeline — one optional
phase of four — so the card's own `embedded` + `lorebook` media always worked and
nothing was thrown away. A scan of all 3,868 cards for album-page links:

| extractor | cards | verdict |
|---|---|---|
| mega | 61 | port |
| catbox album (`/c/`) | 23 | port |
| imgchest (`/p/`) | 19 | port |
| imgbb album | 15 | port |
| postimg gallery | 11 | port |
| gdrive | 2 | drop — cookie-dependent, negligible |
| imgbox album (`/g/`) | **0** | **not needed** |

122 unique cards (3.2%) carry any external album link. Two expectations
corrected by the numbers: **imgbox needs no extractor at all** (all 11 cards
mentioning it use direct `images2.imgbox.com/...` URLs the `embedded` phase
already handles), and catbox splits — 285 cards use direct `files.catbox.moe/...`
URLs that always worked, only 23 use album pages.

Catbox, imgchest, imgbb and postimg shipped as `proxy/media/extractors.py`,
wired in as the `extGallery` phase of `_discovered_items` so a single-card
Download and a whole-archive run cannot disagree about what a card's media is.
Parsing is pure (HTML in, images out) and fetching is synchronous, because both
callers are on a worker thread rather than the event loop.

**Mega did not ship, and is not a fifth extractor.** Every other host resolves
to a plain URL the download pipeline can already fetch; Mega's files are
*encrypted*, so it needs its API protocol, a crypto dependency (AES ECB/CBC/CTR
— the stdlib has none), and a decrypt step inside the download path. That is a
pipeline change. It is the largest single host by card count (61), and it is
recorded `open` in the ledger rather than half-built.

**Verified:** 1,016 pytest (+29), 170 vitest (+16), tsc / oxlint / prettier /
production build clean, schema regenerated. What is *not* yet verified is
anything live — Following against a real Chub token, a real DataCat session, and
one full `scope=all` run against the 3,868-card archive all remain to be driven
before cut-over.

**Still open, all decisions rather than code:** card size, tile badge-count
toggle, "Open gallery" shortcut, Import from URL (§6 Q4), and mega. Plus one
phase Stage 6B's own sweep surfaced and did not close: `providerGallery`, one of
legacy's four download phases, is still neither ported nor recorded as dropped.
See `docs/UI_PARITY_LEDGER.md`.

**Stage 7 — cut-over. DONE 2026-08-19.** `web/` is gone; the client owns `/`.

Everything the stage listed, and what each turned out to involve:

- **`frontend` base flips to `/`.** `vite.config.ts` only; `main.tsx` already
  derived the router basename from `BASE_URL`, so the flip needed no route
  changes. `frontend/tests/smoke.py` drops its `/next/` prefix.
- **`rm -rf web/`** — 115 files, deleted with `git rm` after confirming all 115
  are on the **`legacy-web` branch** (local and `origin/legacy-web`, cut from
  `main` at `56ef9b9`). That branch is now the address the ~30 "ported from
  `web/…`" comments across `proxy/` and `frontend/src/` resolve against, and
  where a bundle `.zip` restore happens until §5.3's writer exists. The
  provenance comments are deliberately left in place.
- **The mount.** `WEB_DIR` and `NoCacheStaticFiles` are gone with it (the
  cache trap they worked around was the hand-bumped `MODULE_VERSION`'s, which
  content-hashed assets retire). The client's assets move to `/assets` and its
  shell route to `/{full_path:path}`, registered last.
- **One thing the plan did not anticipate: the catch-all needed a guard.** A
  route matching every path also matches `/api/v1/charcters`, which would have
  answered 200 with an HTML body — a typo'd endpoint reported to the client as
  a JSON parse failure, and invisible to the smoke gate's "no failed requests"
  check. `SERVER_OWNED_PREFIXES` (proxy/server.py) 404s inside any prefix the
  routers claim, and derives that set **from the routers themselves** rather
  than a hand-written list, so adding a router protects it automatically. The
  `include_router` calls became one `ROUTERS` tuple to make that derivable.
- **`data/settings.json` pruned**, by `scripts/prune_settings.py` — read-only
  by default, timestamped backup on `--apply`, idempotent. 124 keys → 9: the
  provider credentials and `httpProxyUrl` the client reads flat, plus `ui2`.
  The rest was six cut providers' credentials, a theme customizer, a mobile
  mode and a duplicate scanner's thresholds. **One migration rather than a
  drop:** `tagDictionaryDelta` is real user work and changed namespace in the
  rewrite (root → `ui2.`), so it is moved, and only when `ui2` holds none.
- **`isHostShaped` and the 501 stubs: nothing to review.** Both lived entirely
  in `web/archive-api.js` — `grep` finds no 501 anywhere in `proxy/` — so they
  died with the file rather than needing a decision.
- **Stale claims about `web/` in the server's prose, fixed rather than left.**
  Four comments asserted a *live* coupling to a file that no longer exists
  (`/api/v1`'s "the translation lives in archive-api.js", `CHUB_AVATAR_BASE`'s
  "keep the two in sync", DataCat's `DC_SESSION_API_BASE`, the CORS proxy's
  caller list). Each now names its real counterpart in `frontend/src/`. While
  there: `ui_settings.py`'s docstring claimed exactly one server-side reader of
  the blob, and there are two — `proxy.media.extractors` reads `chubToken`.

**§5.1 #6 discharged, as a dry run, against the real archive.** The old
tag-tools were checked out of `legacy-web` and run beside the new TypeScript
over the *same* inputs: all 3,869 cards as `useAllCardTags` fetches them, and
the real stored 38-override delta. The base dictionary is byte-identical
between the two trees. Old and new agree exactly — **168 renames, 50 removals**
— and so does the plan taken through the editor path the page actually posts
(`buildEditorState` → `rebuildMapping` → `buildApplyPayload`), which is the
property that matters: what you previewed is what lands on disk. Nothing was
written; the harness was temporary and is not committed.

**Verified:** 1,048 pytest, 42 node (`make test-js`, one tree now), 173 vitest,
tsc / oxlint / prettier / production build clean, `api-schema` regenerates with
no diff. The smoke gate drives the real 3,869-card archive at `/` and exits 0
with **zero console errors and zero failed requests** — every page, deep links,
prev/next, an editor open, a reversible favourite toggle, both Discover
providers, a preview, and Settings' proxy test / userscript generation /
rescan.

**Still open, and it is a run rather than a decision:** one full `scope=all`
bulk localize over the archive — also the first real-world exercise of the chub
and mega extractors. It writes GBs over hours, so it wants a deliberate start,
not a cut-over side effect. See the ledger.

### 5.1 Definition of parity

Cut-over is allowed when, on the real 3,839-card archive:

1. Every card in the archive is reachable, renders, and its PNG downloads.
2. Filter, sort and search return the same *sets* the old UI returns for the
   filters that survive (the advanced filter builder does not survive, by
   decision).
3. A card can be edited — prose, greetings, tags, lorebook entries, avatar — and
   the resulting PNG is byte-identical in its pixels and correct in its fields,
   verified with `scripts/check_cards.py`.
4. A card can be imported from Chub and from DataCat, end to end, with the
   duplicate guard firing on a card already held.
5. A media download runs to completion on a card with remote images, and the
   manifest afterwards matches what the old pipeline produced for the same card.
6. Tag apply produces the identical plan the old tag manager produces for the
   same dictionary — compared as a dry run before anything is written.
7. Favourites set in the old UI are visible in the new one and vice versa (they
   are the same bytes in the same card).
8. `make test`, `make test-js`, `frontend-test`, and the schema-drift check are
   green.

### 5.2 Deliberate losses

**`docs/UI_PARITY_LEDGER.md` is the authority; this section is a summary.** The
ledger has a row for every capability, not only the lost ones, which is the
point — a list of things we *chose* to drop cannot reveal the things we dropped
without noticing. Five rounds of missed work got in through exactly that gap.
Add new losses to the ledger first, with a reason, and summarise here second.

Named here so they are decisions and not discoveries: bundle restore until the
server-side writer lands (§5.3), the Activity feed (§3.6), the advanced filter
builder, the theme customizer, client-side whole-archive duplicate scanning,
batch transfer to SillyTavern, charLore, provider-link management UI, the seven
gallery extractors, description-scoped search, card duplication, NSFW blur
(open question 5), and the Settings mock's Media and About sections (Stage 6 —
both would have been controls with no real capability behind them).

### 5.3 Bundle (.zip) restore — deferred past cut-over (decided 2026-08-18)

Bundle restore works in `web/` today and nothing in the plan replaces it. The
decision: **rebuild it server-side, later, as `POST /api/v1/bundle` — not in
the client, and not before cut-over.**

The reason it can wait is that a bundle is no longer the archive's real export
format. Every card on disk is a clean V3 PNG carrying its lorebook, greetings,
provenance and `extensions.*` in its own bytes, so the single-PNG path already
delivers a complete, self-describing character into SillyTavern — with or
without CharacterLibrary. The bundle's job was to move *SillyTavern-shaped
state* between installs, and that job shrank when the card stopped needing an
install to be complete.

So: cut-over proceeds without it. Until the server-side writer exists,
restoring an old bundle means checking out `web/` from git history — an
acceptable cost for a path used once, and a smaller one than it looks, because
the cards inside such a bundle are importable individually today.

---

## 6. Open questions

Three were settled on 2026-08-18, before Stage 0; their resolutions are folded
into the sections above and repeated here so the decision and its reason stay
findable.

1. **Bundle restore** — RESOLVED: rebuild server-side, deferred past cut-over.
   See §5.3.
2. **Activity feed** — RESOLVED: dropped, bell removed from the top bar. See
   §3.6.
3. **Mobile** — RESOLVED: **responsive, desktop-first.** One layout that
   reflows; no separate mobile mode and no bottom nav. Concretely that means
   the chip strip scrolls horizontally at narrow widths (the mock already does
   this — `.chipbar{overflow-x:auto}`), the detail page's two columns stack
   with the portrait first, and the grid's `auto-fill` track count falls to one
   or two. It does **not** mean phone-specific components, a touch-tuned
   information architecture, or narrow-width mocks before Stage 1. Usable on a
   phone; designed for a desktop.

Still open, both minor and both late:

4. **Import from URL** (§3.10) — deferred. Worth a small guarded server route,
   or is Discover enough? Decide at Stage 5.
5. **NSFW blur** — RESOLVED at Stage 6: **dropped**. Still no NSFW signal in
   the API to key a toggle off; building the row would have been a control
   wired to nothing.

And one with a standing recommendation:

6. **`web/tests/smoke.py`** — RESOLVED at Stage 1: rewritten against the new app
   as `frontend/tests/smoke.py`, run with `make frontend-smoke` against a live
   server. Same contract as the old one (any console error, any failed request
   to our own origin, any broken image is a failure), driving what Stage 1
   built; later stages extend `drive()` rather than adding a second gate. It
   stays out of CI for the same reason the old one did — it needs a browser and
   a real archive. `web/tests/smoke.py` dies with `web/` at cut-over.
