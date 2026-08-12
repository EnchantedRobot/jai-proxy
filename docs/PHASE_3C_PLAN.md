# Phase 3C — Media download: one path, and the server owns the bytes

> Status: **BUILT AND EXERCISED — all acceptance items have evidence (2026-08-12).**
>
> Sequencing steps 1–8 have landed. `proxy/media/{names,writer,manifest,jobs,guard}.py`
> exist, the server owns the bytes, both 3C-1 (the route) and 3C-2 (the job runner,
> `POST /api/v1/media/jobs`) shipped, and the three poisoned `localStorage` blobs are
> gone — the §1 defect below is fixed, not pending. Step 8 ran on 2026-08-12: 1,993
> gallery files converted to WebP plus 2 pre-existing jpg/webp duplicates binned, so
> `find data/galleries -name '*.jpg' | wc -l` is now **0**; `sync_thumbs.py --galleries`
> reports **0 missing / 0 orphans** (12,319 thumbs regenerated after the renames, 4,327
> orphans pruned, 521 dead cache folders dropped). The Playwright smoke gate exits 0
> with zero console errors and zero failed requests.
>
> **Exercised for the first time on 2026-08-12** — a 14-card sample run through the
> real browser path (`downloadCharacterMedia`, embedded + lorebook phases). All seven
> acceptance items now have evidence; see §10.
>
> Two defects the sample found and closed, both outside the pipeline itself:
>
> - **`extractMediaUrls` mangled paren-bearing text** (`30-…:240`). Its bare-URL
>   pattern excluded `{}` but not `()`, so a markdown closer left a trailing `)` on
>   **1,323 URLs** corpus-wide and JanitorAI's `![]{{random:(a.jpg),(b.jpg)}}` macro
>   ran a whole list into one unfetchable string. Those fabricated URLs 404ed and were
>   filed as permanently dead — §1's laundering, one layer earlier than §1 looked.
>   Excluding parens drops 1,323 junk URLs, loses **0** real ones (the genuine
>   paren URLs — postimg's `(16).jpg` — come through the markdown branch, which
>   balances them on purpose) and **recovers 385 URLs across 3 cards** that had never
>   been downloadable. Regression test: `web/tests/media-urls.test.js`.
> - **A name-match skip recorded nothing in the manifest**, while the hash-match skip
>   beside it did. So a card whose media all predates this pipeline — 18,097 inherited
>   files — reported `files: 0` from `/media/status` forever. `GalleryIndex` already
>   hashes the folder, so the mapping costs one `stat`.
>
> Also fixed: `MediaManifestFileOut` omitted `size`, so `GET /characters/{id}/media`
> dropped a field that was on disk.
>
> **Read §1 as history, not as a live bug** — but read it, because it is why the two
> localStorage blobs were discarded rather than migrated.
>
> One thing this plan did not enumerate: four gallery extractors (dropbox, civitai,
> imgchest, pixiv) still call `/plugins/cl-helper/*` routes that do not exist. Measured
> against the corpus this is small — pixiv 10 URLs, civitai 17, dropbox 1, and
> imgchest's 1,104 hits are direct `cdn.imgchest.com` links that need no extractor at
> all (only password-protected posts use the unlock route). They degrade to a clear
> error message, so they were left alone deliberately.

## 1. The headline defect

A character whose remote media is CORS-blocked is **marked "media complete" on its first
run, and every one of its URLs is permanently retired as dead.** It takes four hops:

1. `downloadMediaToMemory` tries a direct `fetch()`; CORS rejects it, so it falls back to
   `/proxy/<encoded url>` — SillyTavern's middleware
   (`web/library-sections/30-media-localization-feature.js:919`).
2. The archive has no such route. Verified: `GET /proxy/…` → **404** (it reaches the
   `StaticFiles` mount at `/` and misses). This was called out and deferred in
   `docs/PHASE_3B_PLAN.md` §2C.
3. The 404 is attached to the error as `httpStatus` (`30-…:930`), and
   `MediaDedup.classifyFailure` reads `PERMANENT_HTTP.has(404)`
   (`web/modules/media-dedup.js:56,283`) → **permanent on attempt one**.
4. A permanent failure counts as `skipped`, not `errors` (`30-…:177`) — deliberately, so
   genuinely-gone media doesn't pin a character in a retry loop. But `incomplete` is
   `errors > 0` (`31-…:219`), so zero errors → `markMediaLocalizationComplete`
   (`32-…:676`).

So the guard designed to spare the user from chasing dead links is being fed our own
missing route, and it launders "we never tried" into "confirmed gone, don't ask again."

**Consequence for the migration:** the two localStorage blobs that hold this state —
`_cl_media_dead_urls.json` and `_cl_media_loc_completed.json` — are contaminated by an
unknown amount. **Do not migrate them. Start clean server-side.** (§6.)

## 2. The rest of what's broken

**D2 — dedup pulls the whole local gallery through the browser.** The default path
(`fastFilenameSkip: false`, `05-…:93`) is content-hash dedup: `getExistingFileHashes`
(`30-…:503`) fetches *every file in the folder* into the tab and SHA-256s it. The archive
is **27,040 gallery files / 6.9 GB across 3,806 folders**. "Bulk Localize All Characters"
therefore re-downloads the entire local corpus into a browser tab before it downloads
anything new.

**D3 — gallery thumbnails are switched off by a probe that can never succeed.**
`checkClHelperPlugin` (`06-…:296`) sets `_galleryThumbsAvailable = available &&
data?.thumbnails === true` from `/api/plugins/cl-helper/health`, which 404s (verified).
So `getGalleryThumbUrl` returns null (`14-…:809`), `prewarmThumbnails` returns immediately
(`14-…:820`), `cleanupThumbCache` no-ops (`14-…:815`) — and the gallery grid renders
full-size images instead. Meanwhile `GET /api/v1/galleries/{folder}/files/{file}/thumb`
**exists, works, generates on miss, and has 25,315 cached thumbs across 3,446 inherited
folders behind it**. The entire Media → Thumbnails settings group
(`index.html:2348-2367`) is a dead control behind a "cl-helper plugin required" banner.

**D4 — three download loops, three naming schemes, no single owner.**

| Loop | Writes | Has |
| --- | --- | --- |
| `downloadEmbeddedMediaForCharacter` (`30-…:89`) | `localized_media_*`, `lorebook_media_*`, `extgallery_*` | hash dedup, name dedup, rename/reclassify, ledger |
| `ProviderInterface.downloadGallery` (`provider-interface.js:553`) | `{provider}gallery_{hash8}_*` | its own dedup, its own fallback dedup state, **no** rename path |
| `renameToLocalizedFormat` (`30-…:325`) | reclassifies between the two by delete + re-upload | — |

**D5 — all progress state lives in `localStorage`.** `/user/files/*` is backed by
`localStorage` at the adapter (`web/archive-api.js:299-317`): the completed set, the dead
ledger (capped at 5,000 entries), and the background queue share a ~5 MB origin-keyed
quota. `archive-api.js:293-297` already names the ledger as the blob that can approach it.
This is the same hazard that forced settings onto disk in Phase 1 — and here it also means
the "which characters are done" answer dies with a port change.

**D6 — every byte makes a pointless round trip.** `saveMediaFromMemory` base64-inflates
the file by 4/3 into a JSON body (`30-…:1051`), which `archive-api.js:606-632` immediately
decodes back to a `Blob` and re-posts as multipart.

**D7 — no format normalization.** Files are saved as whatever the CDN happened to serve.
On disk today: **24,616 webp, 1,937 jpg, 45 png, 13 jpeg, 325 gif**, plus audio/video.

**D8 — the gallery thumb cache has no orphan sweep.** `thumbnail_store.forget_gallery` is
called on write and delete, but nothing prunes thumbs for files that left by any other
route, and nothing generates the ~1,725 missing ones. `scripts/sync_thumbs.py` covers
*avatar* thumbs only.

## 3. The design — the server fetches the bytes

The browser keeps the one job it is uniquely able to do — **discovery**: scanning card
text, calling authed provider gallery APIs, running the ten gallery-page extractors with
their session cookies. It hands the resulting URL list to the server and renders progress.

Everything downstream of "here is a URL" moves to FastAPI:

    browser: discover URLs         ──POST──▶  server: guard → fetch → sniff → normalize
             (card scan, provider                        → dedupe → write → thumb
              gallery list, extractors)                  → manifest → ledger

This is the same shape Phase 3B chose for card acquisition (capture in the browser, build
on the server), for the same reasons, and it dissolves D1, D2, D6 outright:

- **No CORS.** The server has no origin. The `/proxy/` fallback and its 404 poisoning both
  disappear rather than getting a replacement route.
- **Dedup is a `scandir`.** The name index and content hashes are computed where the files
  are, not over HTTP.
- **No base64.** Bytes never enter the browser at all.

### The one centralized route

```
POST /api/v1/characters/{card_id}/media
{
  "items":  [ {"url": "...", "filename": "optional real name from an extractor"}, ... ],
  "prefix": "localized_media",      // or lorebook_media | extgallery | <provider>gallery
  "phase":  "embedded"              // label only, for the manifest run record
}
```

Answers **NDJSON, streamed** — one line per item, plus a final totals line. The existing UI
callbacks (`onLog` / `onLogUpdate` / `onProgress`, used by all four trigger surfaces) map
onto those events 1:1, so the modals, the bulk progress bars and the notification-bell
queue keep working without being rewritten.

Per item the server does, in order:

1. **Guard.** Port `isUrlSafeForDownload` (`30-…:809`) and the 50 MB cap
   (`readBodyWithCap`, `30-…:839`) to Python. See §6 — this is now load-bearing, not
   decorative.
2. **Name index** — already have a file under an equivalent key → `skipped`.
3. **Dead ledger** — known permanently gone → `skipped`, with the reason. Never fetched.
4. **Fetch** via `httpx`, honouring `settings.http_proxy`.
5. **Sniff** magic bytes (port `validateMediaContent`, `30-…:622`, including the MP4
   audio-vs-video atom walk) — the content type decides the extension, never the header.
6. **Normalize to WebP** (§4).
7. **Content hash** → dedupe against the folder.
8. **Write** atomically via `cards.edit.write_atomic`, as `{prefix}_{index}_{name}.webp`.
9. **Thumbnail** immediately via `thumbs.generate_gallery` — no prewarm pass, no setting.
10. **Record** in the manifest and, on failure, in the ledger.

The gallery folder is resolved **server-side from the card's `gallery_id`**
(`gallery.folder_name` / `resolve_folder`), so the client stops passing `folderName` and a
renamed card can't miss its own gallery.

### The CL abstractions become one Python module

Item 3 of the brief — *"use the CharacterLibrary localized-media abstractions everywhere"*
— is a hard compatibility constraint, not a style preference. The on-the-fly URL
replacement that makes localized media actually *show* (`33-…:119,174-190`) matches remote
URLs to local files by reconstructing the sanitized name. If the server sanitizes even
slightly differently from `extractSanitizedUrlName`, media downloads fine and then renders
as a broken remote link across the whole archive.

→ **`proxy/media/names.py`**, ported verbatim from the JS and tested against it:
`CDN_VARIANT_NAMES`, `extract_sanitized_url_name`, `media_key`, the
`{prefix}_{index}_{name}.{ext}` format, and the prefix-priority ladder
(`localized_media` 4 > `lorebook_media` 3 > `extgallery` 2 > `{provider}gallery` 1).
It becomes the single source of truth; the JS keeps only the *lookup* half.

### The per-gallery manifest — items 5 and 6

`data/galleries/<folder>/.media.json` (dotfile → already excluded from every listing and
scan: `v1.py:list_gallery_files`, `gallery.py:_scan`):

```json
{ "version": 1, "updated": "...",
  "files": { "<source url>": {"file": "localized_media_…_x.webp", "sha256": "…", "at": "…"} },
  "dead":  { "<source url>": {"reason": "HTTP 404", "attempts": 3, "at": "…"} },
  "runs":  [ {"at": "…", "phases": ["embedded","providerGallery"], "saved": 12,
              "skipped": 3, "dead": 1, "errors": 0} ] }
```

It travels with the gallery, survives a card rename (folders resolve by gallery id), and
needs no global blob. A card is **complete** when its last run finished with zero errors —
a recorded fact with a timestamp and a breakdown, not a name in a 5 MB set.

Two reads on top:

- `GET /api/v1/characters/{card_id}/media` — one card's manifest.
- `GET /api/v1/media/status` — `card_id → {files, bytes, complete, dead, last_run}` for the
  whole archive in one call, so Bulk Localize can skip completed characters without 3,806
  requests. Cheap: one `stat` per manifest.

A small **global** ledger stays at `data/state/dead_urls.json` for the cross-character win
(the same dead catbox link appears on dozens of cards), with the same permanent/transient
split — now correct, since our own 404 is no longer in the input.

**Graceful failure is preserved exactly** (item 6): permanent means permanent — reported as
`skipped` with a human reason, never as an error, never re-fetched, never blocking
"complete". What changes is only that the classification is now true.

## 4. WebP, at intake and once over the corpus

**At intake (item 4).** Still images — png, jpg, jpeg, bmp, and single-frame gif/webp —
are decoded with Pillow and re-encoded as WebP (`quality=82, method=4`) before they are
written. There is no second pass and no "optimize later" setting. Skipped: **animated** gif
and webp, svg, video and audio, all stored as-is (§6).

**Once over what's already there.** `scripts/normalize_gallery_media.py`, dry-run by
default, `--apply` to act: converts the ~1,995 jpg/jpeg/png stills to WebP, retires the
source to `data/.trash/`, forgets the stale thumb, updates the manifest. Renaming the
extension is safe because every consumer keys on the name *without* it — the localization
map (`33-…:174-176`), `MediaDedup.mediaKey` (`media-dedup.js:103`), and
`_GALLERY_KINDS` (which already lists `.webp` as an image).

## 5. Thumbnails (items 7 and 8)

- **Generated at write time**, in the same request that saved the file. Prewarm as a
  concept goes away.
- **The cl-helper probe goes away.** `_galleryThumbsAvailable` is unconditionally true —
  the endpoint is part of this application now, not a plugin that might be installed.
- **The Media → Thumbnails settings group is deleted**, along with the `galleryThumbnails`
  and `galleryThumbPrewarm` settings and the "cl-helper plugin required" banner.
- **`POST /api/v1/galleries/{folder}/thumbs/prune`** replaces cl-helper's
  `gallery-thumb-cleanup`, and `scripts/sync_thumbs.py` grows a `--galleries` mode that
  does for gallery thumbs what it already does for avatars: generate the ~1,725 missing,
  retire thumbs whose source file is gone, drop folders whose gallery is gone.

## 6. Risks and divergences

- **SSRF becomes a real server-side concern.** Today's guard runs in the browser, where it
  protects nothing that matters. Once FastAPI is the fetcher, it is issuing requests to
  URLs written by strangers into character cards, from inside a home LAN. The port of
  `isUrlSafeForDownload` (private v4/v6, loopback, link-local, CGNAT, metadata hosts,
  non-http schemes) and the 50 MB cap are **not optional**, and both need their own tests.
- **Do not migrate the two poisoned blobs.** Per §1, an unknown share of the dead ledger
  and of the completed set records our own missing route. Discard both; the first bulk run
  rebuilds them correctly. Say so in the UI rather than silently re-scanning everything.
- **Animated GIF stays GIF in this phase.** 325 files and the largest per-file bytes in the
  corpus, so the temptation is real — but Pillow's animated-WebP encoder can quietly change
  frame timing and drop frames. It is a separate, separately-verified pass.
- **MEGA and Pixiv cannot move server-side.** MEGA's per-file AES-CTR decrypt
  (`gallery-extractors/mega.js:437`) and Pixiv's session-proxied image fetch
  (`pixiv.js:190`) produce bytes *in the browser* via `downloadFn`. Those keep the existing
  multipart upload door — but `POST /api/v1/galleries/{folder}/files` gains the same
  normalize + thumb + manifest treatment, so **one writer, two entry doors**. Nothing
  reaches disk down a path that skips the manifest.
- **Card avatars are untouched.** They stay PNG through pngquant; a V3 card is a PNG.
- **`extgallery` still needs the browser's extractors.** Only the fetch moves, not the
  page-scraping — so external-gallery discovery keeps the `/api/v1/proxy` question open.
  Resolved the same way: the *extractor* asks the server to fetch the page for it, rather
  than the archive growing a general-purpose open CORS proxy.

## 7. The two stages

**3C-1 — the route and the writer.** All four triggers (Settings → Bulk Localize,
Character → Gallery → Download Media, Import → Ask me, Import → background queue) keep
their current UI and their current client-side loop; each iteration just calls the new
route instead of downloading in the tab. Ships: `media_names.py`, the download route,
WebP-at-intake, write-time thumbs, the manifest, the status endpoints, the two cleanup
scripts, the settings/probe deletions.

**3C-2 — the job runner.** Move the loop itself to the server, so "Bulk Localize All
Characters" over 3,806 cards and "download in the background" both survive a closed tab.
`POST /api/v1/media/jobs` + a status stream; `media-download-queue.js` becomes a view of
server state instead of the owner of it.

**Recommendation: do both, in that order.** 3C-1 is the correctness fix and is independently
shippable. 3C-2 is what makes the bulk trigger genuinely usable — a multi-hour run that
dies when the tab closes is the actual complaint behind "still not really fully working" —
but it is a job runner, and it should not be entangled with getting the bytes right.

## 8. Acceptance

**Step 0, before any code.** Start the server, open a character with known CORS-blocked
media (catbox / postimg are reliable), click Download Media, and record what happens —
toast text, console, and the resulting ledger entries. This confirms §1 from the outside
and produces the fixtures.

Then:

1. **The §1 bug is gone.** That same character, run through the new route, lands its files
   on disk. Its URLs are absent from the dead ledger.
2. **Truly-dead is still graceful.** A card with a genuine 404 reports `skipped` with a
   reason, is not re-fetched on a second run, and still reaches `complete`.
3. **Format.** Every file written by a run is WebP (or gif/audio/video passthrough).
   `find data/galleries -name '*.jpg' | wc -l` → 0 after `normalize_gallery_media.py --apply`.
4. **Thumbs.** Every image written by a run has its thumb on disk before the response
   closes. The gallery grid requests thumbs, not originals (check the network panel).
   `sync_thumbs.py --galleries` reports 0 missing and 0 orphans afterwards.
5. **Tracking.** `GET /api/v1/media/status` answers for all 3,839 cards in one call, and a
   second Bulk Localize skips everything the first one completed — reading it from the
   server, with `localStorage` empty.
6. **Parity.** Pick a character whose gallery was populated under SillyTavern +
   CharacterLibrary; run the new path against a copy and diff the file *names* (modulo
   extension) — the CL naming abstractions must produce the same keys, or §3's localization
   lookup breaks.
7. **Console discipline.** Capture `console.warn` / `console.error` across all four
   triggers. The web/ trim's lesson stands: broken handlers stay invisible otherwise.

## 9. Sequencing

1. Step 0 — verify live, capture fixtures.
2. `proxy/media/names.py` + tests against the JS behaviour. Nothing else can be right first.
3. The URL guard + size cap, with tests. Before the first outbound request exists.
4. The writer: fetch → sniff → WebP → dedupe → write → thumb → manifest, behind
   `POST /api/v1/characters/{id}/media`. The multipart upload route joins it on the same
   writer.
5. Browser: `downloadEmbeddedMediaForCharacter` and `ProviderInterface.downloadGallery`
   collapse into thin clients of the route. Delete the dead code (`downloadMediaToMemory`,
   `saveMediaFromMemory`, `getExistingFileHashes`, `renameToLocalizedFormat`,
   `arrayBufferToBase64`, the JS SSRF guard and magic-byte validator).
6. Status endpoints; retire the three `localStorage` blobs.
7. Thumbnails: probe deleted, settings group deleted, `sync_thumbs.py --galleries`.
8. `normalize_gallery_media.py`, dry-run reviewed, then `--apply`.
9. 3C-2 — the job runner.
10. Memory + `web/VENDORED.md` known-gaps updated.

## 10. The first real run (2026-08-12)

A 14-card sample, driven through the browser's own `downloadCharacterMedia` so
discovery stayed where §3 puts it. Cards were picked to span the corpus's shapes:
already-complete (the common case — 3,144 of the 3,187 cards carrying media URLs
were fully downloaded under SillyTavern), partially complete, never downloaded,
no gallery folder at all, and genuinely-dead links.

| # | Acceptance item | Evidence |
| --- | --- | --- |
| 1 | §1 bug gone | Asari-Sensei (no gallery folder at all) → folder created, 2 files saved, 0 dead. Cassandra/Nyx/Rosalind → **385 files saved, 0 errors** after the discovery fix. |
| 2 | Truly-dead is graceful | Sera (`files.catbox.moe/pmf0ex.webp`) and Ali (`i.redd.it/…`) → `skipped` with `HTTP 404`, both confirmed genuinely 404 by an independent `curl`. Recorded in `dead`, still `complete: true`, and the second run finished in 441 ms without re-fetching. |
| 3 | Format | Every file written by the run is WebP — 100/100 for Cassandra, 126/126 for Nyx. `find data/galleries -name '*.jpg'` → 0. |
| 4 | Thumbs | 100 files → 100 thumbs, 126 → 126, present the moment the response closed. `sync_thumbs.py --galleries` → 0 missing, 0 dead cache folders. |
| 5 | Tracking | `GET /api/v1/media/status` answers for the whole archive in one call. Re-running Cassandra's 100 items took **485 ms with zero network**. |
| 6 | Parity | The decisive test, and it is the corpus-wide case: cards whose galleries were filled by SillyTavern + CharacterLibrary report `skipped (filename match)` on every URL — Aelin 3/3, Ashley 3/3, Akari, Emma, Chika, Amelia, Vyxen 3/3. `names.py` reproduces CL's keys exactly; a divergence would have shown up as re-downloads. |
| 7 | Console discipline | 0 console errors/warnings and 0 failed same-origin requests across every run, and the Playwright smoke gate still exits 0. |

**Not covered by this sample**, and still unexercised: the `providerGallery` and
`extGallery` phases (the run restricted itself to `embedded` + `lorebook`), the
`POST .../media/bytes` door (MEGA/Pixiv), and the background job runner
(`POST /api/v1/media/jobs`) — the sample called the streaming route directly.

**Ledger hygiene.** The pre-fix run wrote 45 fabricated URLs into
`data/state/dead_urls.json` and 41 into two manifests; all were purged (any dead
URL containing a paren). The ledger holds 3 real entries.
