# UI parity ledger

Every user-visible capability of the old `web/` UI and of the mock, with its
status in the new `frontend/` app.

`web/` was deleted at the Stage 7 cut-over (2026-08-19). Every `web/…` path
below still resolves — on the **`legacy-web`** branch, which exists to keep
this file checkable: `git show legacy-web:web/modules/…`.

## Why this file exists

Five rounds of "missed" work all had the same shape: a stage deferred something
to a later stage, the later stage shipped without mentioning it, and
`UI_REWRITE_PLAN.md` §5.2 ("Deliberate losses") never gained the entry. The plan
then read as complete. Two full verification sessions did not catch it, because
there was nothing to check *against* — only prose to re-read.

This file is the thing to check against.

**The rule: a stage may not be marked DONE while it owns an `open` row.**
`dropped` requires a reason in the row. `shipped` requires a file reference.

## Status vocabulary

| status | meaning |
|---|---|
| `shipped` | built and verified, with evidence |
| `dropped` | deliberately not built — **reason required in the row** |
| `open` | not built and not decided. Blocks the owning stage. |

## Method (reproducible, not from memory)

Seeded from three mechanical sweeps, so nothing can hide between them:

1. **`UI_REWRITE_PLAN.md` §1.2** — "Real functionality that must survive", every row.
2. **`docs/mockups/d-archive.html`** — every `<button>`, `<select>`, `<input>`
   in the markup (84/4/5 respectively), grouped by its route or popover
   container, extracted by script rather than by reading.
3. **`web/modules/providers/`** — every provider capability flag (`hasFollowing`,
   `supportsFollowingManager`) and every row of the provider settings schemas
   (`chub-provider.js:548-563`, `datacat-provider.js`).
4. **The provider *browse views***, added 2026-08-19 — `chub-browse.js` (3,845
   lines), `datacat-browse.js` (4,073) and `browse-view.js` (2,086): every sort
   catalogue, every view mode, every modal section, every toggle.

### Why sweep 4 had to be added

Sweep 3 read the provider *settings schemas*. It never touched the ~10,000
lines that are the actual Discover UI, and sweep 2 could not cover the gap
because **the mock's Discover route is deliberately thin** — a grid, a chip bar
and a sort button, against a Library/Detail/Tags/Settings design that is
detailed. A mock-driven sweep therefore produced a mock-shaped Discover: no way
to open a card, one provider with no sort control at all, and both Following
feeds built as if they were filters over browse.

**The rule this adds: where the mock is thinner than `web/`, `web/` is the
spec.** The mock is a design for surfaces it designed. It is not an inventory.

Re-run sweeps 2 and 4 before any future cut-over sign-off.

---

## Library / browse

| capability | status | evidence |
|---|---|---|
| Grid over 3,868 cards, server-paged | `shipped` | `pages/CharactersPage.tsx`, `lib/browse.ts` |
| Sort — all 6 options + Reverse | `shipped` | `lib/browse.ts:42-49`, `components/SortPopover.tsx:57` |
| Chip filters: Favorites, Lorebook, Multiple greetings, Added this week, Untagged | `shipped` | `lib/browse.ts:15,155-160`, `components/ChipStrip.tsx` |
| "Missing media" chip | `shipped` | `lib/browse.ts:159`, `proxy/api/v1/characters.py:293` — was `open` for two stages; caught at the pre-cut-over pass |
| Tag include/exclude chips + ＋ Filter popover | `shipped` | `components/FilterPopover.tsx` (full catalogue, `limit=0`) |
| "Recently added" shelf, See all / Hide | `shipped` | `components/RecentShelf.tsx`, persisted via `ui2.showRecentShelf` |
| Search overlay, scopes All/Name/Creator/Tags | `shipped` | `GET /characters?scope=`, plan §3.9 |
| Search scope: Description | `dropped` | Index carries `description_chars` only; would mean holding 3,839 descriptions in memory or reading 3,839 PNGs per query (§3.9) |
| Card size — Dense / Default / Large | `dropped` | Mock `d-archive.html:487-488`. Intentionally dropped during the mock design phase; its appearance as `open` was this ledger mistakenly promoting a rejected mock control. Decided 2026-08-19. |
| Badge lore & greeting counts on tiles (toggle) | `dropped` | Mock `d-archive.html:491-492`. Tiles badge unconditionally; leave as always-on, no per-card toggle. Decided 2026-08-19. |
| Advanced filter builder | `dropped` | §5.2 — deliberate, decided pre-Stage 1 |
| Client-side whole-archive duplicate scanning | `dropped` | §5.2 — 2,582 lines replaced by the server-side `have` guard |

## Card detail

| capability | status | evidence |
|---|---|---|
| 7 tabs in the mock's order | `shipped` | `components/detail/panes-def.ts` |
| Prev / next pager + J/K | `shipped` | `pages/CharacterDetailPage.tsx`; typing guard added at the pre-cut-over pass |
| Download card | `shipped` | `CharacterDetailPage.tsx:180-182` |
| Favourite | `shipped` | `components/detail/PortraitActions.tsx:77-89` |
| Replace avatar | `shipped` | `PortraitActions.tsx:91-105` |
| Inline editing (prose, greetings, tags, lorebook) | `shipped` | §4.4 decision; `components/detail/editors.tsx` |
| Creator notes, sandboxed iframe | `shipped` | `components/detail/CreatorNotes.tsx`; markdown-image bug fixed at Stage 6 |
| Gallery lightbox | `shipped` | `components/detail/Lightbox.tsx` |
| Delete card | `shipped` | `PortraitActions.tsx:109-129` |
| "More" menu — export, duplicate | `dropped` | Mock promised three actions; Export **is** Download card, Duplicate has no endpoint. The surviving single-item menu is a Stage 6B fix (Part D5). |
| "Open gallery · N images" shortcut button | `dropped` | Mock `d-archive.html` rDetail. The Gallery tab already reaches the same place; redundant. Decided 2026-08-19. |
| Card duplication | `dropped` | §5.2 — no endpoint, no demand |
| charLore | `dropped` | §5.2 — SillyTavern-era |

## Tags

| capability | status | evidence |
|---|---|---|
| Consolidation editor, buckets, find, New canonical, Reset, Apply | `shipped` | `pages/TagsPage.tsx`, `components/tags/` |
| `tag-analysis` / `tag-delta` / dictionary | `shipped` | Ported verbatim, 80-test suite (§1.3 items 2-3) |
| Tag apply against the real archive | `shipped` | §5.1 #6, discharged 2026-08-19 as a **dry run**: the old tag-tools checked out of `legacy-web` and run beside the new TypeScript over the same 3,869 cards and the same real 38-override delta. Identical plan — 168 renames, 50 removals — and identical again through the editor path the page posts. Base dictionary byte-identical between the trees. Nothing written. |

## Discover / providers

Rewritten 2026-08-19 from sweep 4. The previous version of this section had 12
rows, 10 of them `shipped`, and was wrong: it described a surface built from the
mock rather than from `web/`. Rows marked **(regression)** were claimed
`shipped` here while broken or absent in the app.

| capability | status | evidence |
|---|---|---|
| Chub browse + search | `shipped` | `lib/providers/chub.ts` `searchChub` |
| Chub sort — all 11 discovery presets (sort **+ time window + special_mode**) | `shipped` | **(regression: was 3 bare sorts)** `CHUB_PRESETS` in `lib/discover-state.ts`, ported from `chub-browse.js:68-80`; params assembled per `chub-browse.js:2618-2656` |
| DataCat browse | `shipped` | `lib/providers/datacat.ts` `searchDatacat` |
| DataCat sort — `recent` + 5 orderings × 2 windows | `shipped` | **(regression: the control was hidden entirely for DataCat)** `fetchDatacatFresh` over `/api/characters/fresh`; `DATACAT_FRESH_SORTS` |
| Sort control present for every provider and feed | `shipped` | Mock `d-archive.html:371` — `components/DiscoverSort.tsx`, options from `discoverSortOptions` |
| **Read a provider card before keeping it** | `shipped` | **(regression: did not exist)** `POST /api/v1/discover/preview` runs the *same* mapper `/build-*` runs (`proxy/api/v1/discover.py`); rendered by the archive's own detail panes via `components/detail/CardDetailLayout.tsx` at `/discover/:provider/:id`. `web/` had a modal per provider; the mock opens every card, Discover's included (`d-archive.html:882`) |
| Preview is read-only | `shipped` | `EditProvider readOnly` — `edit-context.tsx`; asserted by the smoke gate |
| Preview prev/next + J/K over the grid | `shipped` | `DiscoverPreviewPage`, same trick as `CardTile` — the tile carries Discover's query string |
| Refresh | `shipped` | `pages/DiscoverPage.tsx` |
| Hide cards I have + duplicate guard | `shipped` | `POST /characters/have` |
| Add to archive (Get) | `shipped` | **(regression: 404 on every click in dev — `/build-` was missing from `vite.config.ts`'s proxy list)** `useAddToArchive` |
| Chub linked lorebook on import | `shipped` | **(regression: never fetched, so cards with `related_lorebooks` were written without their lorebook)** `fetchChubLinkedLorebook` (v4 git API), ported from `chub-api.js:186-216`. Verified live: 29 entries on `chub/3054` |
| DataCat lorebook script hydration on import | `shipped` | **(regression: never called, so lorebooks behind a per-script janitorai fetch imported empty)** `hydrateDatacatScripts`, ported from `datacat-api.js:591-621`; must run in the browser (TLS fingerprint — `/proxy` is a guaranteed 403) |
| Chub Following — timeline **+ per-author supplement** | `shipped` | **(regression: timeline only, one page of 20, cursor misread)** `chubFollowingFeed`. `/api/timeline/v1` is page-numbered and always answers `cursor: null`; measured, it surfaces 30 of 61 followed authors, which is why `web/` supplements. Verified live: 1,312 cards, 19 creators in the first 60 |
| DataCat Following — feed over every followed creator | `shipped` | **(regression: returned 0 cards)** `datacatFollowingFeed`. Two faults: `/api/creators/{id}/characters` answers `{total, list}`, not `{totalCount, characters}`; and the feed is an aggregate, not network pagination — every creator's cards merged, deduped, sorted. Verified live: 1,197 cards from 19 creators. Since 2026-08-19 each creator contributes their newest page (`FOLLOWING_PER_CREATOR = 50`) instead of their whole catalogue — one request per creator, the count line says `showing the most recent 50 per creator` when any was cut, and `?creator=` still reads a catalogue whole |
| Following sort (newest / oldest / name / most messages) | `shipped` | `FOLLOWING_SORTS`, applied across the merged feed (`datacat-browse.js:2114-2131`) |
| Following manager — add / remove / jump to a creator | `shipped` | **(was Settings-only)** `components/FollowingManager.tsx`, per `browse-view.js:1285-1592`. DataCat writes; Chub read-only by the decision below |
| Creator browse mode + creator sorts | `shipped` | **(did not exist)** creator name on a tile is a link; `CHUB_CREATOR_SORTS` / `DATACAT_CREATOR_SORTS`, back banner, `creator` in the URL |
| Chub API token (`chubToken`, URQL_TOKEN → `Authorization: Bearer`) | `shipped` | `chubHeaders`, Settings → Providers `ChubTokenRow` |
| Chub follow / unfollow writes | `dropped` | Managed on chub.ai itself; avoids write paths against a third-party account that cannot be tested safely. Decided 2026-08-18, reaffirmed 2026-08-19 |
| DataCat token — persist, refresh, clear | `shipped` | `DatacatSessionRow`; `setSavedDatacatToken` restores it in `AppShell` before the first call |
| Discover tag include/exclude chips + catalogue | `shipped` | `DiscoverTagFilter`; `matchesTagFilters`, client-side only, 12 vitest |
| NSFW/NSFL per provider | `shipped` | `nsfwParams`; toggles in Settings → Providers |
| Persistent tag excludes (`providerExcludeTags`) | `shipped` | `withPersistentExcludes`, a floor the chips cannot re-admit |
| Discover state in the URL (linkable, back-button-correct) | `shipped` | `lib/discover-state.ts` — also what makes the preview route's prev/next possible |
| Hide possible duplicates (fuzzy name+creator tiers) | `dropped` | `browse-view.js:626-805`. The exact `_<id8>` have-guard covers the common case; fuzzy matching is a judgement call worth revisiting only if re-uploads prove a real problem. Decided 2026-08-19 |
| Creator bulk download (whole catalogue, progress, cancel) | `dropped` | `browse-view.js:1593-1848`, and gated behind a setting even in `web/`. Decided 2026-08-19 |
| Paste a card URL to import directly | `dropped` | Same call as "Import from URL" in the Import section below — in the post-cutover backlog |
| Media/gallery extraction from the preview | `dropped` | `cdDatacatExtract`. Media is a post-import concern here: the archive's own pipeline handles it once the card is in (`MediaDiscovery`) |
| Infinite scroll toggle (`infiniteScroll`) | `dropped` | Always-on is the wanted behaviour. Decided at Stage 6B |
| Provider order (`providerOrder`) | `dropped` | Two providers. Decided at Stage 6B |
| JanitorAI / Supabase auth, MeiliSearch, Hampter, saucepan, botbooru, wyvern, pygmalion providers | `dropped` | §5.2 + the `web/` trim — providers cut to Chub + DataCat before the rewrite. This also drops those groups from DataCat's sort menu |
| Provider-link management UI | `dropped` | §5.2 |

## Settings

| capability | status | evidence |
|---|---|---|
| Library: default sort, shelf visibility | `shipped` | Real settings since Stage 6 |
| Archive & storage: live `/stats`, data directory | `shipped` | `components/settings/sections.tsx` |
| Archive: avatar compression, duplicate handling | `dropped` | Fixed server policy, no per-request knob — shown as **informational rows** rather than dead toggles (`sections.tsx:81-89`) |
| Archive: "Reveal" data directory | `dropped` | A browser cannot open a host filesystem path |
| Providers: Chub/DataCat enable toggles, outbound proxy + Test | `shipped` | `sections.tsx`; proxy verified live |
| Userscripts: bridge picker, generate, copy/download | `shipped` | Over the existing `/api/v1/userscripts` |
| Maintenance: index stats, `POST /refresh` | `shipped` | Verified live at Stage 6 |
| Media section | `shipped` | `MediaSection` — Localize all + Rescan everything, with live progress. The three fixed-policy rows stay dropped, each with its own reason |
| Media: download-on-import, images-only, concurrent downloads | `dropped` | Fixed server policy — see `jai_proxy_images_only_policy` |
| About section | `dropped` | Nothing in the API tracks a version to show |
| NSFW blur | `dropped` | §6 Q5 — no NSFW signal in the API to key it off |
| Theme customizer | `dropped` | §1.1 — one designed theme, sage-on-dark |

## Import

| capability | status | evidence |
|---|---|---|
| Upload PNG cards (multi-file) | `shipped` | `components/ImportPopover.tsx` |
| Import a folder | `shipped` | Multi-file upload |
| Search providers → Discover | `shipped` | `ImportPopover.tsx` |
| Import from URL | `dropped` | §3.10 deferred it, §6 Q4 said "Decide at Stage 5" — Stage 5 never revisited it. Deferred to the post-cutover backlog (see below), not blocking Stage 7. Decided 2026-08-19. |
| Restore a bundle (.zip) | `dropped` | §5.3 — deferred past cut-over, to be rebuilt server-side as `POST /api/v1/bundle`. Documented and decided. |
| Bundle export (.zip) | `dropped` | §5.2 — works in `web/` today, dies with it |

## Media pipeline

| capability | status | evidence |
|---|---|---|
| URL discovery (`extractMediaUrls`) ported to Python | `shipped` | `proxy/media/discovery.py`, acceptance suite `tests/media/test_discovery.py` |
| Per-card scan → count → download | `shipped` | `components/detail/MediaDiscovery.tsx` |
| Job progress polling | `shipped` | `GET /media/jobs/{id}` |
| Bulk "Localize All Characters" | `shipped` | `POST /media/jobs {scope:"all"}` — server-side, survives the tab closing (the old UI's browser loop did not) |
| Rescan permanently-dead URLs | `shipped` | `skip_complete: false` re-visits cards whose last run was clean |
| `lorebook` download surface | `shipped` | Confirmed: `phase` is a manifest label, not a filter — `discover` downloads both surfaces in one run (`_discovered_items`) |
| Gallery extractor — chub (renamed from legacy's `providerGallery` phase) | `shipped` | `proxy/media/extractors.py:resolve_chub_gallery`, called directly by `_discovered_items` off `extensions.chub.id`. Chub's own first-party gallery for a character (`gateway.chub.ai/api/gallery/project/{id}`), not a link in the card's text — renamed 2026-08-19 so "provider gallery" doesn't read as a mystery fifth phase; it's just a different style of image host, same as the other four. **318 cards / 5,247 files already downloaded under the old UI** (`data/galleries/*/chubgallery_*`) were previously unreachable from this pipeline; now they are. |
| Gallery extractor — mega | `shipped` | **61 cards.** `proxy/media/mega.py`: MEGA API list + AES key-hierarchy walk (ECB) + attribute decrypt (CBC) + content decrypt (CTR), via `pycryptodome` (new dependency). Fully server-side by design (not the browser `/media/bytes` door) so it works inside `scope=all` bulk localize unattended. `mega://` pseudo-URL carries key/nonce/size so `writer.download_item` can dispatch it through the ordinary pipeline; 12 pytest in `tests/media/test_mega.py` build a real encrypted fixture independently of the decrypt code under test. |
| Gallery extractors — catbox album, imgchest, imgbb album, postimg | `shipped` | `proxy/media/extractors.py`, 15 pytest; wired as the `extGallery` phase in `_discovered_items` |
| Gallery extractor — gdrive | `dropped` | 2 cards, and the host most dependent on browser session cookies |
| Gallery extractor — imgbox | `dropped` | **Measured: 0 cards need it.** All 11 cards mentioning imgbox carry direct `images2.imgbox.com/...` URLs the existing `embedded` phase already handles |

**Measured 2026-08-18** over all 3,868 cards: 122 unique cards (3.2%) carry any
external album link. Direct-file URLs are unaffected — 285 cards use
`files.catbox.moe/...` directly and always worked.

## Cross-cutting

| capability | status | evidence |
|---|---|---|
| Favourites round-trip old ↔ new UI | `shipped` | Same bytes in the same card |
| Settings read-modify-write preserves old-UI tokens | `shipped` | `hooks/use-settings.ts:44-76`, proven by `use-settings.test.ts` |
| Activity feed | `dropped` | §3.6 — cards arrive with no browser involved; only honest implementation is server-side |
| Batch transfer to SillyTavern | `dropped` | §5.2 |
| Mobile | `shipped` | Responsive desktop-first (§6 Q3) |

---

## Post-cutover backlog

Decided 2026-08-19, not blocking Stage 7:

- **Import from URL** — table above. Revisit alongside the item below.
- **Lorebook tab navigation/browsing** — current implementation ships as-is;
  Matt wants to rework how it's navigated/browsed. Not a parity gap (the tab
  shipped at Stage 2) — a post-cutover refinement, tracked here so it isn't
  lost.

## Open rows blocking Stage 7

**Stage 7 cut over on 2026-08-19 with 0 open rows.** What follows is the count
as it stood, kept because how the number moved is the useful part.

Counted 2026-08-18: 17 open rows. Stage 6B Parts B, C and D closed 12. Four
more decided 2026-08-19 (dropped: card size, badge toggle, gallery shortcut
button, import from URL — see rows above and the backlog note). The remaining
two (`providerGallery`/chub gallery, mega) shipped 2026-08-19 — see Media
pipeline above.

**0 decisions remain.**

### What the Discover rewrite says about that count

The count was never the problem — the *inventory* was. Every Discover row above
marked `shipped` on 2026-08-18 was signed off against a ledger that had never
read the code it was describing, and the surface it certified turned out to
have no way to open a card, a 404 on every Get, no sort control for one of two
providers, and two Following feeds that returned 20 cards and 0. A row is only
worth what the sweep behind it was. Sweep 4 exists so the next section that
looks complete has been checked against something.

**1 needs a real run, not a decision** (tag apply, the other one, was
discharged as a dry run at the cut-over — see the Tags row):

- One full `scope=all` bulk localize against the archive — also the first
  real-world exercise of the chub and mega extractors, since neither has run
  outside pytest yet. Hours of network and GBs of writes, so it wants a
  deliberate start rather than riding along with a cut-over.
