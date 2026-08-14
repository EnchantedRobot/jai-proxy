# Phase 6 — UI Simplification

**Status:** PLANNED (2026-08-14). Authority for this work; supersedes nothing.
**Audience:** the implementing session. Read this file top to bottom before touching code.

## Why

`web/` is a vendored SillyTavern extension (Character Library) that no longer has a
SillyTavern behind it. What's left is a UI shaped for a host we deleted: a wordmark for a
different product, a topbar that becomes unusable when the window narrows, an Online tab
whose filter bar grew per-provider instead of per-need, a character modal that splits one
card across a read-only "Details" tab and a lock-gated "Edit" tab, dead Versions links
pointing at a module that no longer exists, and a Tag Consolidation modal that renders a
preview nobody can act on selectively.

Phase 6 is a **subtractive** pass. The visual language stays (rounded cards, glass
buttons, the dark palette). What changes is how much there is.

## Ground rules

1. **Delete, don't hide.** Removed features come out of `index.html`, the JS, and
   `library.css`. A `display:none` left behind is not done.
2. **No new build step.** `library-sections/*.js` stay classic ordered `<script>` tags
   sharing one global scope; `web/lib/` and `web/modules/` stay ES modules. Do not convert
   anything as part of this work.
3. **Server contract is already sufficient.** Every write this plan needs already exists
   under `/api/v1` (see §Server surface). Do **not** add routes.
4. **`web/archive-api.js` is the only place ST-shaped URLs are translated.** If a change
   makes an ST route unreachable, remove its entry there too and say so in `VENDORED.md`.
5. Work the sections in order. §1 and §2 are independent; §3 depends on §2 only for the
   shared filter-bar helper; §4 is self-contained; §5 is a two-line change.

## Server surface (already built — read, don't extend)

| Need | Route |
| --- | --- |
| Single-card PNG download | `GET /api/v1/characters/{card_id}/png` (byte-exact, `Content-Disposition` set) |
| Save a card edit | `PUT /api/v1/characters/{card_id}` — body `{card: {...}}`, merge semantics, forces an index refresh before replying |
| Force a rescan | `POST /api/v1/refresh` |
| Apply a tag plan | `POST /api/v1/tags/apply` |

`PUT` requires a non-empty `card.name` (422 otherwise) and **never renames the file** — the
filename/`id8` fragment is the archive's identity. Nothing in this plan may assume a rename
moves anything.

---

## 1. Topbar / navigation

**Problem:** one flat row holding wordmark + view toggle + search + advanced-filter panel +
sort + tags + notifications + ⋮, kept alive at narrow widths by duplicating buttons into the
⋮ menu and swapping them with `.topbar-overflow-item` / `.topbar-overflow-item-narrow`
media queries at 1700/1400/1100/900px. Below ~1000px it is unusable.

**Target:** two rows, one responsive scheme, no duplicated controls.

```
Row 1 (always):   [◧ Archive]  [ Characters | Online ]  [ search ……………………… ]  [⋮]
Row 2 (per view): Characters → [Sort ▾] [Tags ▾] [★] [⟳] [Select]
                  Online     → (see §3)
```

### 1.1 Wordmark

`index.html` `.logo-area` (~line 82): the `<h1>Character<span>Library</span></h1>` becomes
`<h1>Archive</h1>`. Keep the `fa-layer-group` accent icon. Update `<title>` to `Archive`.
Grep `CharacterLibrary` / `Character Library` across `web/` and fix user-visible strings
only — **leave** the ones in comments/`VENDORED.md` that describe the upstream project's
provenance, and leave `SillyTavernCharacterGallery` (the localStorage key) alone; renaming
it orphans real settings.

### 1.2 Structure

- Wrap the current `.filter-area#filterArea` and `.filters-wrapper` contents in a single
  `<div class="topbar-row topbar-row-controls">`, with row 1 as
  `<div class="topbar-row topbar-row-main">`. `.topbar` becomes
  `display: grid; grid-template-rows: auto auto;`.
- Row 2 shows exactly one of `#filterArea` (Characters) or `#onlineFilterArea` (Online) —
  the existing view-switch in
  `library-sections/08-view-management-top-level-view-switching-character.js` already
  toggles these; keep that logic, just re-parent the elements.
- Row 2 gets `overflow-x: auto; scrollbar-width: none;` and its children `flex: 0 0 auto`.
  Narrow windows scroll the control row instead of hiding controls.

### 1.3 Kill the overflow duplication

Delete from `index.html`'s `#moreOptionsMenu`: `#menuMultiSelectBtn`, `#menuSortBtn`,
`#menuFavoritesBtn`, `#menuTagsBtn` and the `.topbar-overflow-item` divider. Delete their
handlers (grep each id; most are in
`library-sections/21-notifications-center-section-based-topbar-dropdown.js`). Delete the
`.topbar-overflow-item` / `-narrow` rules and the 1700 / 1400 / 1100 / 900px `.topbar`
blocks in `library.css` (~lines 10930, 10974, 11018–11045, 11386–11410). Replace with **one**
breakpoint at 700px that shrinks row-1 items to icon-only (`.view-toggle-btn span { display:none }`)
and drops the search placeholder text.

Keep in `#moreOptionsMenu`: Import Characters, Find Duplicates, Tag Consolidation,
Settings. (Auto-Link leaves in §2; Refresh is promoted in §1.4.)

### 1.4 Refresh on the Characters view

`#menuRefreshBtn`'s handler (`21-…notifications….js:376`) currently clears the grid and calls
`fetchCharacters(true)` + `performSearch()`. Promote it to a row-2 icon button
(`id="refreshLibraryBtn"`, `fa-sync`), and have it **first** `POST /api/v1/refresh` so a
card changed on disk outside the app is picked up, then run the existing body. Spin the icon
while in flight. Remove `#menuRefreshBtn` from the ⋮ menu.

### 1.5 Untouched

`#advFilterPanel` (advanced filters + presets), `#searchSettingsMenu`, the notifications
container, and the multi-select toolbar keep their behaviour. Multi-select moves from the
⋮ menu to a row-2 button (`fa-object-group`, label "Select") wired to the same handler.

---

## 2. Remove Auto-Link Characters

**⚠️ The one real trap in this section:** `saveProviderLink()` is *defined* in
`library-sections/26-bulk-auto-link-feature.js:779` but *called* from
`25-provider-link-feature.js:403,457` and `27-update-lock.js:45,77`. Deleting the file
wholesale silently breaks all provider linking (and, because these are classic scripts in
one global scope, it fails at click time, not load time).

Steps:

1. **Move** `saveProviderLink` (26-…:779 to EOF) verbatim into
   `library-sections/25-provider-link-feature.js`, above its first call site. Do not
   otherwise edit it.
2. Delete `library-sections/26-bulk-auto-link-feature.js` and its `<script>` tag in
   `index.html` (~line 2013).
3. Delete `#bulkAutoLinkBtn` from `#moreOptionsMenu` and the whole `#bulkAutoLinkModal`
   block (`index.html` ~997–1055).
4. Delete the `bulk-auto-link-*` CSS block in `library.css`.
5. Grep `bulkAutoLink` / `AutoLink` — zero hits outside `docs/` when done.

---

## 3. Online mode

**Target filter bar — identical for every provider, no per-provider variation in *shape*:**

```
[ Browse | Following ]   [ Sort ▾ ]   [ Tags ▾ ]   [👁 owned]  [👁 possible]   [ ⟳ ]
```

Only the *contents* of Sort and Tags differ by provider. Everything else is fixed chrome.

### 3.1 Share the chrome

Add to `web/modules/providers/browse-view.js` an exported helper:

```js
export function renderBrowseFilterBar({ prefix, viewBtnAttr, sortSelectsHtml, hasFollowing = true })
```

It emits the full skeleton above, deriving ids as `${prefix}TagsBtn`,
`${prefix}HideOwnedBtn`, `${prefix}HidePossibleBtn`, `${prefix}RefreshBtn`, and interpolating
`sortSelectsHtml` (the provider's `<select>`s, unchanged) into `.browse-sort-container`.
`chub-browse.js:renderFilterBar()` and `datacat-browse.js:renderFilterBar()` shrink to a call
into it. **Keep the existing element ids** (`chubTagsBtn`, `datacatRefreshBtn`, …) by passing
`prefix: 'chub'` / `'datacat'` — hundreds of `getElementById` sites depend on them.

### 3.2 Delete the Features dropdown

Gone entirely from both providers — the button, the dropdown, and the dropdown-registry
entries (`{ dropdownId: 'chubFiltersDropdown', buttonId: 'chubFiltersBtn' }`, and datacat's
equivalent).

Removed controls and their state (delete the variables, the persistence keys, the handlers,
and every read of them in the fetch/param builders):

- chub: `#chubFilterImages`, `#chubFilterLore`, `#chubFilterGreetings`,
  `#chubFilterCustomPrompt`, `#chubFilterExampleDialogues`, `#chubExcludeForks`,
  `#chubFilterFavorites`, `#chubMinTokens`, `#chubMaxTokens`, `#chubMinAiRating`,
  and `updateChubFeatureFilterAvailability()` (3 call sites).
- datacat: `#datacatFilterHideJanitor`, `#datacatFilterHideSaucepan`,
  `#datacatFilterSourceSection`, and `updateSourceFilterVisibility()` (its
  "single-source mode" logic dies with it).

The chub Tags dropdown's `#chubAdvancedOptions` block loses Min/Max Tokens and Min AI
Score. **Keep Sort Direction** (`#chubSortDirection`) — the user named it explicitly. Move
it out of the dropdown and into the sort container, next to the sort `<select>`, as a small
asc/desc icon toggle. Give datacat the same control if its sort API supports a direction;
if it does not, omit it there rather than faking one.

### 3.3 Hide Owned / Hide Possible become topbar toggles

Two icon buttons in the fixed chrome, styled like the existing `.nsfw-toggle` (single
`glass-btn` that changes state), using the badge colours already in
`browse-shared.css`: owned = the gray/white check (`.browse-feature-badge.in-library`),
possible = the amber check (`.possible-library`). Use `aria-pressed` for state and a
`.is-active` class for styling; the tooltip carries the long wording ("Hide characters
already in your archive" / "Hide likely duplicates"), the button itself is icon-only.

Rewire, don't reimplement: the reload path and the persisted defaults
(`defaults.hideOwned` / `defaults.hidePossible`, `chub-browse.js:851–861`) stay exactly as
they are — only the input element changes from a checkbox to a button. The
possible-match sensitivity setting (`possibleMatchMinScore`) is unaffected and stays in
Settings.

### 3.4 Delete the NSFW toggle

`#chubNsfwToggle`, `#datacatNsfwToggle`, `updateChubNsfwToggle`-style helpers, and the
persisted preference all go. Replace the state variable with a module constant
`const NSFW_ALLOWED = true;` and leave every `params.set('nsfw', …)` / `nsfl` call sending
`true` (both providers' APIs need the parameter present). Delete the client-side
`nodes = nodes.filter(c => !c.nsfw)` branch (`chub-browse.js:3166–3168`). The per-card
`.browse-nsfw-badge` stays — it's information, not a filter.

### 3.5 Tag filtering — do NOT fix here

Both tag pickers are fully wired (`renderChubTagsDropdownList`, `renderTagsList` /
`renderJannyTagsList`), so the failure is upstream of the UI. Leave the button and dropdown
in place, unchanged apart from re-parenting.

Record for the follow-up session (do not act on it now): the most likely chub cause is
`fetchChubPopularTags()` failing (the list renders "No tags available" when
`chubPopularTags` is empty and `chubTagsLoaded` is true); datacat's path depends on
`fetchFacetedTags()` and additionally hides the button entirely in hampter sort modes
(`updateTagsVisibility()`). Start by opening each dropdown with the network tab up and
recording which request fails and how.

### 3.6 Wording

Unify the two picker labels so the bar reads the same on both providers: the sort control is
always `Sort`, the tag control always `Tags` (with `(n)` when filters are active — the
existing `updateTagsButton` / `updateChubTagsButtonState` already do this).

---

## 4. Character modal

The largest section. Target tab set:

```
[ Card ]  [ Gallery ]  [ Related ]  [ Info ]  [ Raw ]
```

**Details and Edit merge into one tab, "Card".** Header actions become:
`[Apply] [Revert]  ★  ⤓  🗑  ✕` — Apply and Revert are hidden until the form is dirty.

### 4.1 The Card tab

Delete `#pane-details` and rename `#pane-edit` → `#pane-card` (`data-tab="card"`); the
edit pane's markup is the base because it already has every field. Then:

- **Delete the lock.** `.edit-lock-header`, `#editLockStatus`, `#toggleEditLockBtn`,
  `setEditLock()` (`15-card-image-…:1949`), `cancelEditing()` (`:2075`), and every
  `readonly`/`disabled` toggle they drive. Fields are always editable.
- **Delete `#editFormActions`** (`#saveEditBtn`, `#cancelEditBtn`) — replaced by the
  header buttons.
- **Delete the diff confirmation.** `showSaveConfirmation()` (`:1612`),
  `generateChangesDiff()` (`:1342`), `findFirstDifference`, `findLastDifference`,
  `getChangeExcerpts`, `buildHighlightedString` and their CSS. Apply writes directly.
- **Keep** `collectEditValues()` (`:1320`) and `performSave()` (`:1669`) — Apply calls
  `performSave()` unchanged.
- **Carry over from Details anything Edit lacks**, into a compact meta line at the top of
  the pane: created/modified date (`#modalDate`), author link (`#modalAuthor` — the
  click-to-filter-by-creator behaviour must survive), the provider link indicator
  (`#providerLinkIndicator`), the name-preference toggle (`#namePreferenceToggle`), and the
  provider tagline row. These are display-only; leave their existing handlers wired.
- **Field order and default expansion.** Always expanded, in this order: Creator's Notes,
  Description, First Message. Collapsed `<details>` below, in this order: Alternate
  Greetings, Personality, Scenario, Example Dialogue, System Prompt, Post-History
  Instructions, Embedded Lorebook. Name / Creator / Version / Tagline / Listing Name stay as
  the plain input row at the top. Tags stay in the sidebar with the existing inline editor
  (`18-visual-tag-editing-in-sidebar.js`) — but drop its dependency on the lock state.
- Creator's Notes is a rich HTML field on display and a textarea on edit today
  (`#modalCreatorNotes` vs `#editCreatorNotes`). **Show the rendered notes** (the
  `37-creator-notes-module.js` sandboxed render) with an edit affordance that swaps in the
  textarea in place; do not show both at once, and do not drop the sandboxing.

### 4.2 Dirty tracking, Apply and Revert

- One `isCardDirty` flag, set by a delegated `input`/`change` listener on `#pane-card`
  plus the existing pending-avatar and sidebar-tag hooks (`refreshSaveButtonState()` at
  `15-…:28` is the existing seam — keep it, rename it to `refreshApplyState()`).
- **Apply**: calls `performSave()`, toasts on success, clears the flag. No confirmation
  dialog, no diff.
- **Revert**: global only, no per-field affordance. Re-runs the pane population from
  `activeChar` (i.e. `populateEditPane()` with `_editPanePopulated = false` first), clears
  the pending avatar via the existing `clearPendingAvatar()`, restores sidebar tags, clears
  the flag. Ask for confirmation only if the form is dirty — a single `showConfirm`.
- Closing the modal while dirty must warn (there is already a close path at
  `15-…:60` — hook it, don't write a new one).

### 4.3 New: Raw tab

`<div class="tab-pane" id="pane-raw">` containing a monospace `<textarea id="rawCardJson">`
and a small `Copy` button.

- On tab activation, fill with `JSON.stringify(card, null, 2)` where `card` is the **full**
  card object the modal holds — hydrate first if `activeChar._slim` (the Info tab already
  does exactly this dance at `14-…:1550`+; copy that hydration, don't invent one).
- Validate on `input` (debounced): `JSON.parse` in a try/catch. On failure show the parser
  message inline and mark the tab dirty-invalid; Apply is disabled while invalid.
- Apply on the Raw tab sends the parsed object through the same save path as the Card tab.
  It must go through `PUT /api/v1/characters/{id}` with `{card: parsed}` — the server merges
  and re-embeds. Reject with a toast if `name` is missing or blank before sending (the
  server 422s, but a local check gives a better message).
- Editing Raw and Card in the same modal session is allowed; whichever tab you Apply from
  wins. Repopulate the other from the response.
- **Delete `#copyRawCardDataBtn` and `copyRawCardData()`** (`15-…:348,367`) from the Info
  tab; `copyTextToClipboard` stays (Raw's Copy button uses it).

### 4.4 Info tab always visible

Delete the `showInfoTab` setting (`05-settings-persistence-…:98`), its Settings checkbox
(`#settingsShowInfoTab`, wired in `06-settings-migrations.js:328,906`), and the gate at
`14-…:1541–1547`. Remove `class="hidden"` from `#infoTabBtn`. Content unchanged.

### 4.5 Single-character export

Add `⤓` (`fa-download`, `id="downloadCharBtn"`) to the modal header beside ★ and 🗑.
`downloadCharacterPng(char)` already exists (used by `exportCharacter` in
`modules/context-menu.js:708`) — export it from that module and call it. Do **not** route
through the `exportAsLinks` setting here: the header button always downloads the PNG; the
context menu keeps its current link/PNG behaviour.

### 4.6 Gallery: drop "Use Local Media"

Local media is authoritative whenever it exists; remote is the fallback. Concretely:

- Delete `#charLocalizeToggle` and its label from `index.html`, its handler
  (`31-unified-media-download-pipeline.js:227–288`), the read at `14-…:1396–1400`, and the
  global `mediaLocalizationEnabled` setting + its Settings checkbox
  (`06-settings-migrations.js:882,1263`) + the per-character override map
  `mediaLocalizationPerChar`.
- In `33-on-the-fly-media-localization-url-replacement.js`, `isMediaLocalizationEnabled()`
  and `getMediaLocalizationStatus()` / `setCharacterMediaLocalization()` go away;
  every caller behaves as if enabled. The URL-substitution itself already no-ops when the
  gallery has no matching local file — that is what makes "always on" safe, and it is why
  this is a deletion rather than a rewrite.
- **Keep** `#localizeMediaBtn` ("Download Media") — that is the acquisition action, not a
  display preference. Also keep `importAutoDownloadMedia` in the import modal, but read its
  default from `true` rather than from the deleted setting
  (`23-utility-functions.js:741`).

### 4.7 Remove Versions

`CoreAPI.getModule('character-versions')` resolves to nothing — the module was deleted, so
every one of these is already a no-op click. Remove:

- `#editPaneVersionsBtn` (`index.html` ~424) and its markup.
- `#providerLinkVersionsBtn` (`index.html` ~694) and its handler
  (`25-provider-link-feature.js:200,765–773`).
- The "Version History" item in `modules/context-menu.js:296–306`.
- Any `.version-*` CSS left orphaned.

Leave the card's own `version` **field** (`#editVersion`) alone — that is card metadata, a
different thing.

### 4.8 Related tab

No changes.

---

## 5. Tag Consolidation — minimal fix only

The user's decision: **hide the noise now, defer the real rework.**

Single change in `web/modules/tag-manager.js`, `renderGroups()` (~line 210): a group is only
rendered when at least one *observed* variant is **not** the canonical — i.e. when applying
the plan would actually rename something. Today a group survives if any variant has
`count > 0`, so a canonical observed on its own renders a one-pill group that changes
nothing.

```js
.map((g) => ({ canonical: g.canonical, variants: g.variants.filter((v) => v.count > 0) }))
.filter((g) => g.variants.some((v) => v.tag !== g.canonical))
```

Do not change `buildBuckets` / `buildApplyPayload` in `web/vendor/tag-tools/` — they are the
single decision point shared by the preview and the server payload, and the plan must keep
matching what Apply writes. This is display-side only.

Update the modal's empty-state text so "no groups" reads as "nothing to merge" rather than
"no observed tags match a dictionary canonical".

**TBD — carried forward, not in scope:** the Tag Consolidation UI is materially worse than
the original extension's. It has no per-group or per-tag opt-in, no way to assign an
unassigned tag to a canonical, no way to create or edit canonicals, and no search. The
vendored `web/vendor/tag-tools/tag-delta.js` (`diffDictionary` / `applyDelta`) exists for
exactly that editor and is currently unused — a real fix means an editable dictionary delta
plus somewhere to persist it. Budget several sessions; do not start it inside Phase 6.

---

## Verification

Run all of these; a section is not done until its row passes.

| What | How |
| --- | --- |
| Python suite | `make test` (619+ tests) — should be untouched by this work; a failure means something server-side moved that shouldn't have. |
| JS unit tests | `make test-js` (`web/` + `userscript/`). |
| Console-clean boot | `python web/tests/smoke.py http://127.0.0.1:8002 phase6` with the app running. **Zero** console errors and zero failed same-origin requests, excluding the expected `501`s. |
| Topbar | At 1920 / 1280 / 1024 / 768 / 480px: every control reachable, nothing overlapping, row 2 scrolls rather than hiding. |
| Modal | Open a card, edit Description → Apply → reopen and confirm it persisted. Edit → Revert → fields restored. Edit → close → warned. |
| Raw tab | Valid edit applies; deliberately broken JSON disables Apply with a parse message; a card with a blank name is refused. |
| Download | ⤓ produces a PNG that re-imports (drop it back into the Import modal — it should be recognised as an existing card by its `id8`). |
| Online | Both providers: Browse/Following, sort, sort direction, hide-owned, hide-possible, refresh all work. NSFW cards appear. No dropdown is left orphaned. |
| Provider linking | **Explicitly re-test after §2** — link a card to a provider from the modal, and toggle the update lock. This is what the `saveProviderLink` move can break. |
| Dead references | `grep -rn "bulkAutoLink\|charLocalizeToggle\|showInfoTab\|mediaLocalizationEnabled\|editPaneVersionsBtn\|topbar-overflow-item\|copyRawCardData" web/` returns nothing outside `docs/`. |

Also click **every** section of the Settings and Help modals afterwards and watch the
console: the last `web/` trim proved that a deleted setting leaves a handler that only
fails when its section is opened, and nothing else surfaces it.

## Out of scope

Chats. Card versions (the feature is gone and stays gone). Tag-filter *repair* in Online
(§3.5). The Tag Consolidation editor (§5 TBD). Any change to `proxy/`. Any change to the
card format.
