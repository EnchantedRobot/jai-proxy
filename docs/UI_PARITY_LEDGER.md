# UI parity ledger

Every user-visible capability of the old `web/` UI and of the mock, with its
status in the new `frontend/` app.

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

Re-run sweep 2 before any future cut-over sign-off.

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
| Tag apply against the real archive | `open` | §5.1 #6 — the dry-run comparison was never run for real. Blocks cut-over. |

## Discover / providers

| capability | status | evidence |
|---|---|---|
| Chub browse + search + sort | `shipped` | `lib/providers/chub.ts` |
| DataCat browse | `shipped` | `lib/providers/datacat.ts` |
| Refresh | `shipped` | `pages/DiscoverPage.tsx:184-189` |
| Hide cards I have + duplicate guard | `shipped` | `POST /characters/have` |
| Add to archive (Get) | `shipped` | `/build-chub`, `/build-datacat` — pytest only, never exercised live |
| Chub API token (`chubToken`, URQL_TOKEN → `Authorization: Bearer`) | `shipped` | `lib/providers/chub.ts` `chubHeaders`, Settings → Providers `ChubTokenRow` |
| Chub Following — timeline feed + follows list | `shipped` | `fetchChubTimeline` / `fetchChubFollows`; Discover's Discover/Following toggle |
| Chub follow / unfollow writes | `dropped` | Managed on chub.ai itself; avoids write paths against a third-party API that cannot be tested safely. Decided 2026-08-18. |
| DataCat token — persist, refresh, clear | `shipped` | `DatacatSessionRow`; `setSavedDatacatToken` restores it in `AppShell` before the first call |
| DataCat Following — follow/unfollow + feed | `shipped` | `useDatacatFollows` over the existing `datacatFollowedCreators` key; feed fans out over `creators/{id}/characters` |
| Discover tag include/exclude chips + catalogue | `shipped` | `DiscoverTagFilter`; `matchesTagFilters` in `lib/providers/shared.ts`, client-side only, 12 vitest |
| NSFW/NSFL per provider (`chubNsfw`, `datacatNsfw`) | `shipped` | `nsfwParams` in `lib/providers/chub.ts`; toggles in Settings → Providers |
| Persistent tag excludes (`providerExcludeTags`) | `shipped` | `withPersistentExcludes`, layered as a floor the chips cannot re-admit |
| Infinite scroll per provider (`infiniteScroll`) | `dropped` | Always-on is the wanted behaviour; the key existed but the control never earned itself. Decided at Stage 6B. |
| Provider order (`providerOrder`) | `dropped` | Two providers. Chip-row order is not worth a setting. Decided at Stage 6B. |
| JanitorAI / Supabase auth, MeiliSearch, Hampter, saucepan, botbooru, wyvern, pygmalion providers | `dropped` | §5.2 + the `web/` trim — providers cut to Chub + DataCat before the rewrite |
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

Counted 2026-08-18: 17 open rows. Stage 6B Parts B, C and D closed 12. Four
more decided 2026-08-19 (dropped: card size, badge toggle, gallery shortcut
button, import from URL — see rows above and the backlog note). The remaining
two (`providerGallery`/chub gallery, mega) shipped 2026-08-19 — see Media
pipeline above.

**0 decisions remain.**

**2 need a real run, not a decision:**

- Tag apply against the real archive (§5.1 #6)
- One full `scope=all` bulk localize against the 3,868-card archive — now
  also the first real-world exercise of the chub and mega extractors, since
  neither has run outside pytest yet
