# Phase 3B — Make the online browsers actually work

> Status: **DONE, verified live (2026-08-11).** Phase 3A ("write path") is complete for
> archive-local writes and is not being revisited. This doc covers the part that was
> deferred and then mistaken for done: acquiring a card from Chub or DataCat through
> the browser. Both providers now work end to end: S1–S4 + B1–B4 shipped, B5 was
> found not-yet-safe (see below) and left alone. Chub was verified live in the prior
> session (delete → re-acquire → diff against the archive twin, exact match modulo
> `linkedAt`/`sourceKind`). DataCat was verified the same way this session, plus a
> genuine live import through the browser UI (Playwright) that wrote a real new card
> (`Asari-Sensei_c9f1aaaf.png`) — see `jai_proxy_datacat_phase3b` in memory for the
> details, including the one real bug the live data caught (`primary_content_source_kind`
> arrives as `"janitor_core"`, not the bare `"janitor"` this project's
> `extensions.datacat.sourceKind` vocabulary expects — sources.datacat.normalized_source_kind
> fixes it). B5 (deleting the `characters/create` / `characters/import` /
> `content/importURL` 501 stubs) is NOT done: the local-PNG/URL import modal and
> `web/modules/batch-transfer.js` still call them for an unrelated, still-unbuilt
> feature — deleting the stubs would turn their errors from a clean 501 message into
> a raw 404. `provider-utils.js:importFromPng` (and its now-orphaned helpers) WAS
> deleted, since nothing calls it anymore now that both providers use `postCapture()`.
>
> **B4 finished 2026-08-12.** It was recorded as shipped above but only the
> `CL_HELPER_PLUGIN_BASE` repoint had actually happened; the UI was still there and the
> boot probe still fired, which is what kept the Playwright gate failing on three 404s
> (`/plugins/cl-helper/health`, `/avatar-thumb-stats`, `/avatar-thumb-populate-status`).
> Now deleted: the probe and its cached state, the update banner + self-update flow, the
> `clHelperStatusGroup`, the thumb banner, the avatar-thumb cache-management row (no
> route ever backed it), the `minClHelperVersion` provider gate (dead — neither chub nor
> datacat overrides it) and `compareVersions` with it. ~215 lines out of
> `06-settings-migrations.js`. The thumbnail size selector was **kept and relabelled**:
> it drives a real archive route, only the "cl-helper" naming was fiction. The gate now
> exits 0 with zero console errors.
>
> Still cl-helper-shaped and deliberately left: the Civitai / Pixiv / botbooru key-sync
> handlers and four gallery extractors. They fire only on user action, degrade to a clear
> message, and cover a measured handful of corpus URLs — see the 3C plan's status header.

## 1. What went wrong in Phase 3A

Phase 3A scoped "writable archive" as **archive-local** writes — edit a card, delete it,
replace its avatar, write gallery files. All of that works. **Acquiring a card from
outside was explicitly deferred**, and it is written down as such:

- `web/VENDORED.md:366` — "Acquiring a card still refuses with 501."
- `web/archive-api.js:675-677` — `characters/create`, `characters/import`,
  `content/importURL` all answer `notImplemented()`.

So the 501 was never a regression. What went wrong is that **nothing else in Phase 3A
distinguished "the provider code is present" from "the provider works."** The web/ trim
(9 providers → 2) was a code survey: it picked chub + datacat off a real archive survey
and verified the module graph still loaded. It never crossed the origin. Both things a
provider needs at runtime belonged to the host we deleted — SillyTavern's `corsProxy`
middleware and the `cl-helper` plugin — and neither got a FastAPI replacement.

The lesson is the same one the web/ trim already recorded and we then under-applied: a
view that renders is not a view that works. §7 makes that checkable this time.

## 2. The three defects

### A. DataCat has no transport at all

Every DataCat call goes through the plugin proxy:

- `modules/providers/datacat/datacat-api.js:131` — `dcFetch()` →
  `apiRequest('/api/plugins/cl-helper/dc-proxy' + path)`
- session management → `/dc-init`, `/dc-set-token`, `/dc-validate`, `/dc-clear-token`
- extraction submit → `/dc-extract`

`web/archive-api.js:535` 404s the entire `cl-helper` prefix except `gallery-thumb`. So
`checkDcPluginAvailable()` returns false and `datacat-browse.js:4017` renders its
"plugin required" panel before it ever asks DataCat anything. That is the message you saw.

The needed surface is **7 endpoints**, and the hard part already exists in Python:
`proxy/sources/datacat_client.py` performs DataCat's anonymous session handshake
(`POST /api/liberator/identify`), confirmed live from a plain server-side request with no
login and no Cloudflare gate.

### B. Chub has no landing zone, and the browser pipeline is the wrong shape

Browse works because `api.chub.ai` is CORS-open and hit directly
(`chub-api.js:104`). Import doesn't:

`chub-browse.js:4178` → `chub-provider.js:691` → `provider-utils.js:721`, which builds the
card **in the browser** (map fields → `embedCharacterDataInPng` → `POST
/api/characters/import`) and hits the 501. It should raise a toast at
`chub-browse.js:4224`; confirm live whether that fires (see §7 step 0) — a silent button
would mean something throws earlier.

Even with a landing zone, that pipeline is wrong for this archive. It would store whatever
the browser embedded, skipping every intake rule we own: macro sanitize, creator-notes
taming, tag cleanup, avatar crop/resize/pngquant, `extensions.jai` / `extensions.datacat`
provenance, id-fragment dedupe, and the `<name>_<id8>.png` filename contract.

### C. There is no CORS proxy

`provider-utils.js:217` `fetchWithProxy()` falls back to `/proxy/<b64url>`, which was ST's
middleware. The archive has no such route — verified, it 404s (not, as
`proxy/server.py:490` claims, an index.html fallback; `StaticFiles(html=True)` only
rewrites directory requests and looks for a `404.html`. That comment is wrong and should be
corrected while we're in there).

**But this defect mostly evaporates under the design in §3.** The server does the outbound
fetching now, so the browser only needs the proxy for `fetch()`-based transport, not for
display — `<img src>` never passes through `fetch` and is not CORS-gated. What is left:
DataCat's `dc-proxy` (covered by S2) and post-import gallery-image download for Chub
(deferred, see §6).

## 3. The design — capture in the browser, build on the server

The provider becomes a **capture layer, exactly like a userscript**. It collects the raw
provider JSON and posts it; the server maps, cleans, assembles, and writes through the
pipeline that already exists. `/build-chub` and `/build-datacat` join `/build-jai` (JanitorAI)
and `/build-saucepan` as peers.

    browser: fetch raw provider JSON  ──POST──▶  server: map → clean → CardBuilder
             (no card assembly,                          → avatar fetch/normalize
              no PNG embedding)                          → PngWriter → archive

These are **always direct pulls**. There is no hidden state, no chat relay, no capture
store — the server always receives a fully formed JSON blob and only ever walks the happy
path. That is what makes this simpler than `/build-jai`.

### Why this lands cleanly: the seams already line up

Both browser-side V2 builders are **pure functions over JSON** — no DOM, no browser API —
so porting them to Python is mechanical and testable against real fixtures:

| Browser (JS) | Emits | Server-side consumer that already exists |
| --- | --- | --- |
| `chub-api.js:247` `buildCharacterCardFromChub()` (~40 lines) | V2 `data` dict | `sources.chub.clean_card()` → `to_payload()` → `PngWriter.write_payload()` |
| `datacat-api.js:714` `buildV2FromDatacat()` / `:785` `buildV2FromDownload()` (+ `pickRecoveryVariant`, `extractCharacterBookFromScripts`, `resolveTagNames`, `stripDatacatMarkers`) | V2 `data` dict | `sources.datacat.to_profile_fields()` + `greetings()` → `CardBuilder` |

`sources.datacat.to_profile_fields()` reads exactly the keys `buildV2FromDatacat` writes.
`sources.chub.clean_card()` eats exactly the `data` object `buildCharacterCardFromChub`
produces. The port target is not guesswork.

### The one structural fork: Chub cannot use `_assemble_and_write`

Chub is a **raw-dict passthrough** — it must never round-trip through the pydantic
`LoreEntry` model, which drops `priority` / `probability` / `selectiveLogic` and coerces
Chub's mixed int-or-string `position` (see `sources.chub.py` module docstring, and the
`jai_proxy_chub_import` memory). So `/build-chub` uses `PngWriter.write_payload()`, the way
`scripts/import_cards.py:_import_chub` does — not the `CardBuilder` path.

But it *does* need the avatar tail that `_assemble_and_write` owns (fetch → `normalize_avatar`
→ pngquant), because unlike a file import there is no source PNG to lift pixels from.

→ **Refactor `_assemble_and_write` into two pieces**: `build_card()` (source-specific) and
`fetch_avatar_and_write()` (shared, plus the dedupe check and the dashboard record). Chub
uses the tail with its own payload; DataCat uses both halves as today.

## 4. Server work

**S1. Split `_assemble_and_write`** (then in `proxy/server.py`, now `proxy/api/build.py`) into `build_card` / `fetch_avatar_and_write`
so the payload path and the CardBuilder path share the avatar, dedupe and dashboard tail.
Pure refactor; `/build-jai` and `/build-saucepan` must be unchanged behaviourally.

**S2. DataCat transport in FastAPI.** Seven routes backed by `proxy/sources/datacat_client.py`'s session
handshake, promoted from a one-shot avatar resolver into a reusable session-holding client:

| Route | Does |
| --- | --- |
| `health` | replaces the plugin probe |
| `dc-init` | anonymous `identify` handshake → session token |
| `dc-set-token` / `dc-validate` / `dc-clear-token` | token lifecycle |
| `dc-proxy/{path...}` | authenticated GET passthrough to `datacat.run` |
| `dc-extract` | POST a JanitorAI URL to DataCat's extraction queue |

Decision: serve these at a clean `/api/v1/datacat/*` and repoint `CL_HELPER_PLUGIN_BASE`
(`provider-utils.js:14`) — one constant, and it ends the cl-helper fiction. Then delete the
404 stubs at `archive-api.js:535,547` and the plugin-status UI (§5, B4).

**S3. `POST /build-chub`.** Body mirrors `/build-saucepan`: the raw Chub node from
`/api/characters/{fullPath}?full=true`, plus the linked lorebook JSON if the card has one,
plus an optional avatar URL. Server: port `buildCharacterCardFromChub` → `sources.chub.clean_card`
→ `extensions.jai` provenance (`sourceKind: "chub_core"`, distinct from the importer's
`chub_import`) → `write_payload` → shared avatar tail.

**S4. `POST /build-datacat`.** Body: the character detail JSON, the `/download` payload if
present, and the hydrated scripts (lorebook) array. Server: port the two V2 builders and
their helpers → `sources.datacat` → `CardBuilder` → `_assemble_and_write`. Avatar URL
resolution (`resolveDatacatAvatarUrl` with `preferOriginal`) ports too — the server holds
the same JSON, so the browser should not pre-resolve it.

**S5. Response contract.** Both endpoints return `BuildResponse` extended with the written
**filename** and the **built card payload**. The browse views need the filename to target
post-import steps at the right card, and need the card to feed `findCharacterMediaUrls` /
`findCharacterGalleryUrls` for the import-summary modal — which the browser can no longer
derive itself, since it no longer builds the card.

## 5. Browser work

**B1.** Delete `provider-utils.js:importFromPng` (PNG embedding, `ensurePng`, placeholder
generation, and the ST filename-sanitize restore hack at `:735-765`, all of which exist only
to satisfy SillyTavern's import endpoint). Replace with a small `postCapture()` that POSTs the
blob and normalizes the response into the existing `ProviderImportResult` shape, so
`browse-view.js` and both browse modules keep working unchanged.

**B2.** `chub-provider.js:importCharacter` → capture `metadata` + linked lorebook, POST.

**B3.** `datacat-provider.js:importCharacter` → capture detail + download + hydrated scripts,
POST. Keep `hydrateDatacatScripts` in the browser (it is per-script `dc-proxy` transport that
the session already covers) or move it server-side — either works; browser-side is a smaller diff.

**B4.** Repoint `CL_HELPER_PLUGIN_BASE`; delete the cl-helper banners and status UI
(`index.html` — 12 sites incl. `datacatPluginBanner:2161`, `clHelperStatusGroup:2541`; and
`library-sections/06-settings-migrations.js:295-476`, which includes a plugin self-update
flow that is pure dead weight now).

**B5.** Delete the `/api/characters/import` and `/api/content/importURL` 501 routes from
`archive-api.js` once nothing calls them.

## 6. Known divergences and risks

- **DataCat lorebooks are new.** `sources.datacat`'s docstring says "No lorebook. datacat does
  not retrieve `character_book`" — true of the PNG exports the bulk importer eats, but the
  browser flow *does* get one via `extractCharacterBookFromScripts` + `hydrateDatacatScripts`.
  Pass it through to `CardBuilder` as `book`. This makes a browser import strictly better than
  a file import, and it means the §7 byte-diff oracle will legitimately differ for DataCat
  cards that have lorebooks.
- **Chub raw-dict rule.** S3 must not route the lorebook through pydantic. This is the single
  easiest way to silently damage cards; assert it in a test with a real Chub fixture carrying
  `priority` / `probability` / `selectiveLogic` and an int `position`.
- **Dedupe interaction.** `_assemble_and_write` refuses a card whose id is already on disk and
  reports `duplicate: true`. The browse views run their own pre-import duplicate check and
  *delete first* when replacing (`chub-browse.js:4163`), so the order works — but the id
  fragment must be derived the same way both paths derive it (`extensions.jai.id`, per the
  `jai_proxy_dedupe_key` memory; Chub ids are numeric, DataCat ids are JanitorAI UUIDs).
- **Chub gallery download after import is out of scope here.** It needs `fetch()` against
  `avatars.charhub.io` / the gallery CDN and therefore a real CORS proxy. Deferred; the
  import-summary modal should say so rather than failing opaquely.
- **`proxy/server.py:490` comment is factually wrong** about `StaticFiles(html=True)`. Fix
  while nearby.

## 7. Acceptance — how we know it works this time

**Step 0, before any code:** start the server, open the browser, click Import on a Chub card
and open the DataCat tab. Record what actually happens (toast text, console warnings). This
both confirms the diagnosis above and produces the fixtures for step 2.

**The oracle:** both providers already have a file-import path that produces a known-good
card. So for a card that exists in the archive via `make import`:

1. delete it,
2. re-acquire it through the browser,
3. diff the embedded JSON of the two PNGs.

They should match except for `linkedAt` and the `sourceKind` suffix (`chub_core` vs
`chub_import`), plus the DataCat lorebook divergence noted in §6. That is a hard, checkable
result — not "the page rendered."

**Fixtures:** capture the raw JSON blobs from the live browse session into `tests/fixtures/`
so the ported Python mappers get real-data tests, per the standing rule that parsers are
validated against real captured data and never synthetic fixtures.

**Console discipline:** capture `console.warn` / `console.error` across the whole flow. The
web/ trim found that broken handlers stay invisible otherwise.

## 8. Sequencing

1. **Step 0** — verify live, capture fixtures (§7).
2. **S1** — split the assemble/write tail. Existing tests must stay green.
3. **Chub end-to-end** — S3 + B1 + B2, verified against its archive twin. Chub first because
   its browse already works, so only the import leg is new.
4. **DataCat transport** — S2 + B4. Success is the browse grid loading real results.
5. **DataCat end-to-end** — S4 + B3, verified against its archive twin.
6. **Cleanup** — B5, the stale `server.py` comment, `VENDORED.md` known gaps, memory.

Phase 4 stays parked until step 5 passes.
