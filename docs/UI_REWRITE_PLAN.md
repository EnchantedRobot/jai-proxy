# UI rewrite — replacing `web/` with a React archive client

**Status:** in progress — Stages 0–3 done, Stage 4 next. Authority for the work; supersedes the Phase 3D
(`library-sections` → modules) and Phase 6 (UI simplification) plans, both of
which were incremental improvements to a frontend this plan deletes.

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

**Stage 5 — Discover + media.**
Provider browse at mock fidelity, `have` guard, add-to-archive. Media discovery
ported to Python (§3.4), the scan/job UI, gallery download. Salvage items 1, 5,
6.

**Stage 6 — Settings.**
Settings route with its sections, userscript generator, proxy test, stats.
This is the last stage before cut-over; Activity is dropped (§3.6).

**Stage 7 — cut-over.** One commit:
- `frontend` base flips to `/`, mounted at `/`.
- `rm -rf web/`; delete the `web/` mount, `NoCacheStaticFiles`, `WEB_DIR`, the
  `web/` COPY in the Dockerfile, the `cd web && node --test` half of `make
  test-js`.
- One-off script prunes the dead keys from `data/settings.json`.
- `isHostShaped` and the 501 stubs in `proxy/api/v1/` are reviewed for whether
  anything still calls them.

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

Named here so they are decisions and not discoveries: bundle restore until the
server-side writer lands (§5.3), the Activity feed (§3.6), the advanced filter
builder, the theme customizer, client-side whole-archive duplicate scanning,
batch transfer to SillyTavern, charLore, provider-link management UI, the seven
gallery extractors, description-scoped search, card duplication.

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
5. **NSFW blur.** The Settings mock has "Blur NSFW thumbnails until hover", but
   there is no NSFW signal in the API — it would have to key off a tag
   (`NSFW`), which the Tags page is in the business of renaming. Keep it as a
   tag-driven toggle, or drop the row? Decide at Stage 6.

And one with a standing recommendation:

6. **`web/tests/smoke.py`** — RESOLVED at Stage 1: rewritten against the new app
   as `frontend/tests/smoke.py`, run with `make frontend-smoke` against a live
   server. Same contract as the old one (any console error, any failed request
   to our own origin, any broken image is a failure), driving what Stage 1
   built; later stages extend `drive()` rather than adding a second gate. It
   stays out of CI for the same reason the old one did — it needs a browser and
   a real archive. `web/tests/smoke.py` dies with `web/` at cut-over.
