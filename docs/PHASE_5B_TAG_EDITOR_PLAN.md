# Phase 5B — Tag editor: bring `tag-manager` to parity with the upstream Tag Dictionary editor

> Status: **PLANNED (2026-08-15).** Nothing in this document is built.
>
> This finishes the half of `docs/PHASE_5_TAGS_PLAN.md` §5 that shipped reduced. That plan
> called for "the three-bucket editor ported from upstream `ui-editor.js` (675 lines)…
> Clicking a chip moves it; every edit saves the delta." What actually landed in step 7 was
> a **read-only preview**: it renders `buildBuckets` output and posts the plan, but nothing
> is editable and no dictionary is ever persisted. Phase 5B builds the editor.
>
> The intake half of Phase 5 (`proxy/text/tags.py`, the shared normalizer) is done and is
> **out of scope here**. So is `name_repair`.

---

## 0. Read this first

**Upstream is `~/workspaces/SillyTavern-Character-Tools`** (a SillyTavern extension; git
repo, `fd39db1` at time of writing). The relevant files:

| upstream file | lines | role |
|---|---|---|
| `ui-editor.js` | 675 | **the editor being ported** — modal, category tree, chip menus, buckets, bulk bar |
| `index.js` | 500 | extension entry; its **top third (lines 31–156)** is the dictionary-ownership layer being ported |
| `style.css` | 372 | the `ctm-*` rules; ~line 141 onward is the category tree |
| `tag-analysis.js` | 381 | **already vendored, byte-identical** |
| `tag-delta.js` | 118 | **already vendored, byte-identical** |
| `tag-dictionary.json` | 4,348 | **already vendored, byte-identical** |

Verified 2026-08-15: `diff web/vendor/tag-tools/{tag-analysis.js,tag-delta.js,tag-dictionary.json}`
against upstream is **clean for all three**. The decision-making half of the feature is
already here and already tested (`web/tests/tag-{analysis,delta,dictionary}.test.mjs`,
ported vitest → node:test). **Do not modify anything under `web/vendor/tag-tools/`.**

**No Python changes.** `POST /api/v1/tags/apply` (`proxy/api/v1/characters.py:534`) already
takes the literal `{rename, remove}` plan and applies it by string equality. It needs
nothing from this phase. Do not touch it, and do not add tag-matching logic to the server.

---

## 1. What we have vs. what upstream has

### Ours today — `web/modules/tag-manager.js` (329 lines)

Lazy-loaded from `web/modules/module-loader.js:304`, opened by `#tagManagerBtn`
(`web/index.html:173`). On open it:

1. `loadDictionary()` → fetches `../vendor/tag-tools/tag-dictionary.json`, runs
   `flattenDictionary()` → `{mapping, removedTags}`.
2. `buildBuckets(characters, mapping, removedTags)` and
   `buildApplyPayload(characters, mapping, removedTags)`.
3. Renders four blocks: stat tiles, "Renames, by canonical", Unassigned, Removed.
4. Apply posts `currentPlan` verbatim, then `refreshCharacters(true)` + reopen.

### The five gaps (the user's list, mapped to code)

| # | gap | where it dies today |
|---|---|---|
| 1 | **can't move tags between canonicals** | there is no editable state at all — `renderGroups`/`renderFlat` emit static `<span>`s with no handlers |
| 2 | **no persisted state** | `saveDictionary`/`diffDictionary` are never called; the dictionary is re-read from the shipped JSON on every open, so an edit could not survive even if you made one |
| 3 | **no base + delta layering** | ditto — `tag-delta.js` is vendored and tested but has **zero callers in `web/`** |
| 4 | **no canonical categories** | `flattenDictionary()` (`tag-manager.js:151`) iterates `Object.values(raw.mapping)` and **discards the category keys**. Upstream's `loadBaseDictionary()` (`index.js:69`) keeps them as `canonicalCategories` + `categoryOrder`. This single omission is why we render one flat alphabetical list |
| 5 | **no collapsible sections / counts** | no category tree to collapse; `renderGroups` also **filters to observed-renames only** (`.filter(g => g.variants.some(v => v.tag !== g.canonical))`), so ~375 canonicals are invisible and there is nothing to move a tag *into* |

Plus the auto-collapse/green behaviour from the screenshots: upstream opens only the
categories that contain a real rename and paints the rest green (`ctm-category--clean`),
so "what's going to be applied" is visible at a glance.

---

## 2. Architecture

Three files change, two are new. **No Python. No vendored-file edits.**

```
NEW  web/modules/tag-dictionary.js     ~110 lines   port of index.js:31-156 (ownership layer)
EDIT web/modules/tag-manager.js        329 → ~650   port of ui-editor.js into our modal shell
EDIT web/modules/tag-manager.css       151 → ~330   port of style.css ctm-* rules, re-themed
EDIT web/library-sections/05-settings-persistence-*.js   +2 lines   one DEFAULT_SETTINGS key
NEW  web/tests/tag-dictionary-module.test.mjs   ~120 lines   unit tests for the new module
```

Data flow, once built:

```
tag-dictionary.json (shipped, vendored)
        │  loadBaseDictionary()          ← keeps categories this time
        ▼
   base {mapping, removedTags, canonicalCategories, categoryOrder}
        │
        │  applyDelta(base, settings.tagDictionaryDelta)      [tag-delta.js, vendored]
        ▼
   working {mapping, removedTags}
        │
        │  buildBuckets(characters, …)                        [tag-analysis.js, vendored]
        ▼
   editor state {groups[], unassigned[], removed[]}   ←── user edits move variants
        │                                              │
        │  rebuildMapping()  ───────────────────────────┘
        ▼
   diffDictionary(base, working) → delta → setSetting('tagDictionaryDelta', …) → data/settings.json
        │
        │  Apply Tags: buildApplyPayload(FRESH characters, working mapping, removed)
        ▼
   POST /api/v1/tags/apply   {rename, remove}      (server: literal string equality only)
```

---

## 3. Step 1 — `web/modules/tag-dictionary.js` (new)

Port of upstream `index.js` lines 31–156, minus everything SillyTavern-shaped. This module
is **pure-ish and DOM-free on purpose** — it is the part `web/tests/` can cover, since we
have no jsdom (see `web/tests/README.md`).

### Exports

```js
export async function loadBaseDictionary()   // {mapping, removedTags, canonicalCategories, categoryOrder} | null
export async function ensureDictionary()     // {mapping, removedTags, canonicalCategories, categoryOrder, baseMapping, baseRemovedTags}
export async function saveDictionary(mapping, removedTags)   // diff vs base → setSetting
export function rebuildMapping(state)        // editor state → {mapping, removed}   (see §4.3)
export function dictSnapshot(mapping, removedTags)           // stable string, for dirty-check
```

### `loadBaseDictionary()`

Copy upstream `index.js:69-95` verbatim in behaviour, changing only the fetch URL to
`new URL('../vendor/tag-tools/tag-dictionary.json', import.meta.url)` (what
`tag-manager.js:142` uses today). **Keep the module-level cache** — it is a static file.

It must return all four fields:

```js
{
  mapping: { [canonical]: string[] },      // flattened, exactly as today
  removedTags: string[],
  canonicalCategories: { [canonical]: categoryName },   // ← the bit we drop today
  categoryOrder: string[],                              // Object.keys(json.mapping) order
}
```

`categoryOrder` is the JSON's key order and must be preserved — it is the display order in
the screenshots (Genre, Tone / Mood, Setting / Era, …, Mental Health / Condition; 19
categories). Do not sort it.

Then **delete `flattenDictionary()` and `loadDictionary()` from `tag-manager.js`** — this
replaces them. Leaving both would give us two loaders that disagree about categories.

### `ensureDictionary()`

```js
const base = await loadBaseDictionary();
const delta = CoreAPI.getSetting('tagDictionaryDelta') ?? { overrides: {}, blanks: {} };
const working = base ? applyDelta(base, delta) : { mapping: {}, removedTags: [] };
return { ...working, canonicalCategories, categoryOrder, baseMapping, baseRemovedTags };
```

**Skip upstream's legacy migration entirely** (`index.js:112-126`). That block folds a
previously-persisted *full expanded dictionary* into a delta. We have never persisted a
dictionary in any form — `tagDictionaryDelta` is a brand-new key — so there is nothing to
migrate and the code would be dead on arrival. Do not port it.

Also do not port upstream's `getExtSettings()`; our equivalent is
`CoreAPI.getSetting/setSetting`, and defaulting happens in `DEFAULT_SETTINGS` (step 2).

### `saveDictionary(mapping, removedTags)`

```js
const base = await loadBaseDictionary();
if (!base) return;                       // never persist a delta against a base we failed to load
CoreAPI.setSetting('tagDictionaryDelta', diffDictionary(base, { mapping, removedTags }));
```

The `if (!base) return` guard matters: `diffDictionary` against an empty base would emit an
override for **every tag in the dictionary**, permanently bloating `data/settings.json` and
pinning the user to today's dictionary. Upstream has the same guard (`index.js:61`).

`setSetting` → `saveGallerySettings([key])` → surgical per-key write + `POST
/api/settings/save` (`web/library-sections/06-settings-migrations.js:80`). That path is
fire-and-forget and already coalesces; **do not add debouncing of your own** and do not
call `setSettings` (wholesale) — a surgical single-key write is what keeps a concurrent tab
from reverting other keys.

---

## 4. Step 2 — the settings key

In `web/library-sections/05-settings-persistence-system-uses-sillytavern-s-ext.js`, add to
`DEFAULT_SETTINGS` (line 8), in a clearly-commented spot near the other non-credential
blobs:

```js
    // Tag dictionary edits, stored as a delta against the shipped base (see
    // web/modules/tag-dictionary.js and web/vendor/tag-tools/tag-delta.js).
    // Only the user's moves are persisted, so a re-vendored base dictionary keeps
    // flowing through for everything they haven't touched.
    tagDictionaryDelta: { overrides: {}, blanks: {} },
```

No migration entry in `06-settings-migrations.js` — nothing to migrate from.

**Object-default caveat:** `gallerySettings = { ...DEFAULT_SETTINGS, ...saved }` is a
shallow merge, so this object literal is *shared* until a save replaces it. Never mutate
the delta in place; always `setSetting('tagDictionaryDelta', <fresh object from
diffDictionary>)`. `diffDictionary` returns a new object every call, so following §3 gets
this right for free — just don't "optimize" it into an in-place edit.

---

## 5. Step 3 — port `ui-editor.js` into `tag-manager.js`

The port is mostly mechanical. Keep upstream's **model** exactly; replace its **chrome**.

### 5.1 Substitution table

| upstream | ours |
|---|---|
| `#ctm-overlay` / `.ctm-modal` built by `el()` and appended on open | our **existing** `#tagManagerModal` `.cl-modal`, injected once in `injectModal()`, shown by `.classList.add('visible')` |
| `menu_button` | `cl-btn` / `cl-btn-secondary` / `cl-btn-danger` (see current footer) |
| `text_pole` | our input styling — reuse whatever `batch-tagging.js` uses for text inputs |
| `toastr.success/error/info(msg, 'Character Tools')` | `CoreAPI.showToast(msg, 'success'\|'error'\|'info')` |
| `confirmDialog()` (upstream's in-modal overlay, `ui-editor.js:631-649`) | `CoreAPI.showConfirm({title, message, icon, iconColor, confirmLabel, cancelLabel, danger})` → `Promise<boolean>` |
| `escapeHtml()` (local copy) | `CoreAPI.escapeHtml` |
| `characterList` from `fetchCharacterTags(user)` | `CoreAPI.getAllCharacters()` — single-user archive, **no user picker** |
| `saveDictionary` / `loadBaseDictionary` from `index.js` | the new `./tag-dictionary.js` |
| `onApplyTagsCb` (panel callback running an SSE job) | our existing `applyPlan()`, in-module |

**Drop entirely:** the user `<select>`, SSE progress, `fetchCharacterTags`, the panel, the
`probePlugin` warning. None of it has an analogue here.

**Keep our `el()` helper** — copy upstream's (`ui-editor.js:35-39`); it is three lines and
the whole port is written in terms of it.

### 5.2 State model — port verbatim

```js
let state = null;   // { groups: [{id, canonical, variants[], patterns[], category}], unassigned[], removed[], removedPatterns[] }
let groupSeq = 0;
let bucketFilter = { unassigned: '', removed: '' };
let selectionBucket = null;      // 'unassigned' | 'removed' | null
let selected = new Set();        // variant objects
let baseSnapshot = null;         // dictSnapshot of the base, for the Reset dirty-check
```

`loadState(mapping, removedTags)` = upstream `ui-editor.js:109-127` unchanged, including
`category: canonicalCategories[g.canonical] ?? ''`.

`openModal()` does the **double `loadState`** upstream does (`ui-editor.js:146-148`): load
the *base* first to compute `baseSnapshot`, then load the *working* dictionary for real.
That is how "Reset Tags" knows whether it's dirty. Don't collapse it into one call.

### 5.3 The two invariants that must survive the port

These are the ones that corrupt the dictionary if you get them wrong. Port
`rebuildMapping()` (`ui-editor.js:73-81`) exactly, comments included:

1. **Only `declared` variants are persisted.** A chip can be on screen because a card's tag
   matched via `norm()` or a glob rule (`matchedBy: 'norm' | 'pattern:*x*'`). Persisting
   those would re-declare every incidental spelling a card happens to use as an intentional
   alias, and they reattach automatically on the next load anyway.
2. **`patterns` are re-emitted verbatim.** Glob rules (`*monster*`) live only in the
   shipped dictionary. They are held apart from `variants` (no chip, no count, not
   movable), and they **must** be written back on save or the next `diffDictionary` would
   read their absence as a user deletion. `tag-delta.js`'s `isPattern()` guards refuse them
   in the delta in both directions — that is what makes them core-only.

Consequences to preserve in the UI: the row ✕ **refuses to delete a canonical that owns a
pattern** (`ui-editor.js:249-252`), and rule chips are inert (`buildRuleChip`, no handlers).

### 5.4 Rendering

`renderBody()` → summary, category tree, Unassigned bucket, Removed bucket.

**Summary.** Keep upstream's counts line *and* our stat tiles — ours are strictly more
informative and already built (`renderSummary`, `computeStats`). Layout:

```
[375 renames] [32 removals] [81 cards affected] [520 → 416 vocabulary]     ← our .tm-summary tiles
375 canonical tags, 0 unassigned, 560 removed.                              ← upstream's counts
Click a tag to move it between canonicals, Unassigned, or Removed. ✕ on a
variant sends it back to Unassigned. Edits save automatically.              ← upstream's hint
```

`computeStats` must be recomputed on every `renderBody()` now, not once at open — the
numbers are the point of the screen and they change with every move. It needs the plan;
build it from the live state (see §5.6).

**Category tree** = upstream `buildTable()` (`ui-editor.js:262-302`), unchanged:

- group `state.groups` by `group.category || 'Custom'`;
- order = `categoryOrder` filtered to present, then any leftovers (i.e. `Custom`) appended;
- one `<details class="ctm-category">` per category, `<summary>` = name + count;
- `hasChanges = groups.some(groupHasRename)`; `open` iff `hasChanges`; class
  `ctm-category--clean` iff not;
- inside, a `<table>`: Canonical tag (text input) | Merged variants (chips) | Cards | ✕.

`groupHasRename(g)` = `g.variants.some(v => v.count > 0 && v.tag !== g.canonical)` — a real
rename on a real card. Rows that fail it get `ctm-row--muted`.

`cardCount(group)` = size of the **union of `v.avatars`** across variants (not the sum of
counts — one card carrying two variants of the same canonical must count once). Our list
payload sets `avatar: card.id` (`web/archive-api.js:134`), so this works; verify in the
browser that the numbers are sane before calling the step done.

**Critically: render every canonical, not only the ones that would rename.** Delete our
`.filter(g => g.variants.some(v => v.tag !== g.canonical))`. The full tree is what you drag
tags *into*, and it is what the counts in the screenshots describe.

**Buckets** = upstream `buildBucket()` + `BUCKET_META` (`ui-editor.js:345-436`), unchanged:
header with count and a Select/Cancel link, a filter input, a chip strip, sorted (removed
by count desc, unassigned alphabetically with leading `#` stripped), plus the bulk action
bar when a selection exists.

### 5.5 Interaction — port `moveVariant` / `openChipMenu` / `bulkMoveSelected` verbatim

`moveVariant(variant, from, to)` (`ui-editor.js:597-628`) is the single mutation path:
remove from source, add to destination, set `declared` (`true` everywhere except
`unassigned`, which sets `false`), drop a group that just went empty, `persist()`,
`renderBody()`. Every other handler funnels through it or `bulkMoveSelected`.

`syncFromDom()` (`ui-editor.js:191-198`) reads the canonical `<input>` values back into the
model and **must be called before any mutation that re-renders**, or an in-flight rename
typed into a text box is lost. Upstream calls it at the top of `moveVariant`,
`bulkMoveSelected`, `openChipMenu`, `onNewEmptyGroup` and the row-✕ handler. Keep all five.

**Chip menu placement — this is the one place a verbatim port will not work.** Upstream
appends `chipMenuEl` to `.ctm-modal` and positions it *relative to that box*, with
flip-up/flip-left fallbacks (`ui-editor.js:578-588`). Our `.cl-modal-content`
(`web/library.css:10541`) has **`overflow: hidden`** (it's what clips the glass border
radius) and **no `position: relative`** — so an absolutely-positioned child would be both
clipped at the modal edge and positioned against `.cl-modal`, which is `position: fixed`
over the whole viewport. The menu would land in the wrong place and get its bottom sliced
off. Do not "fix" this by removing `overflow: hidden`.

Instead: append `chipMenuEl` to `document.body`, style it `position: fixed`, and position
it from `anchor.getBoundingClientRect()` directly in **viewport** coordinates (drop the
`modalRect` subtraction; keep the flip logic, clamped to `window.innerWidth/innerHeight`).
Give it `z-index: 10001` — one above `.cl-modal`'s `10000`. Because it is then a sibling of
the modal rather than a descendant, the Escape handler's `_overlayIsAbove` resolves it by
z-index, which is exactly what §5.8 needs. Remember to `closeChipMenu()` on modal close,
and on scroll inside `.cl-modal-body` (a fixed menu does not follow a scrolling anchor).

### 5.6 Apply — the one behaviour change from today

Today `currentPlan` is computed **once at open** (`tag-manager.js:63`). The moment the
modal becomes editable that is a live bug: you edit, hit Apply, and the *pre-edit* plan
lands on disk.

Rebuild the plan at click time, from a **fresh character list**:

```js
async function applyPlan() {
    syncFromDom();
    const { mapping, removed } = rebuildMapping(state);
    const characters = await CoreAPI.refreshCharacters(true);   // re-survey, don't reuse
    const plan = buildApplyPayload(characters, mapping, removed);
    if (!Object.keys(plan.rename).length && !plan.remove.length) {
        CoreAPI.showToast('The dictionary changes nothing on these cards — nothing to apply.', 'info');
        return;
    }
    // …existing confirm + POST + toast + refresh + re-render…
}
```

This is upstream's `getRunPlan()` reasoning (`index.js:139-156`) and it is deliberate: the
plan is keyed by the exact tag strings found on disk, so it is only valid for the corpus it
was built from. A card imported since the modal opened would otherwise be silently skipped.

The server rejects an empty plan with 422, so the early return is also what keeps that from
surfacing as an error toast.

After a successful apply, re-run the open path (rebuild buckets from the same working
dictionary against the refreshed characters) rather than calling `openModal()` recursively
as today — a recursive `openModal()` would now also re-read the dictionary and reset scroll
and open/closed section state.

### 5.7 Footer

Four buttons, matching the screenshots:

| button | behaviour |
|---|---|
| **Apply Tags** | §5.6. Danger-styled, disabled when the plan is empty |
| **New canonical** | `onNewEmptyGroup()` — pushes `{canonical: 'New Tag', variants: []}`, persists, re-renders. Lands in `Custom` (it has no category) |
| **Reset Tags** | `onResetTags()` (`ui-editor.js:652-675`) via `CoreAPI.showConfirm`. Reloads the base, `saveDictionary(base…)`, clears selection/filters, re-renders. Disabled-styled when `dictSnapshot(current) === baseSnapshot` |
| **Close** | `closeModal()` |

`updateResetBtn()` runs after every `persist()`.

### 5.8 Overlay / Escape

`registerOverlay({ id: 'tagManagerModal', tier: 7, close, visible })` already exists
(`tag-manager.js:39`) — keep it. But the global Escape handler
(`web/library-sections/40-core-api-bridge.js:31-77`) closes the **topmost registered
overlay**, and the chip menu is not registered — so today Escape over an open chip menu
would blow away the whole modal.

Two things:

1. Keep upstream's `filterInput` `keydown` handler that swallows Escape and closes only the
   chip menu (`ui-editor.js:572-575`). The global handler is registered with `capture: true`,
   so a bubble-phase `stopPropagation` **will not beat it** — attach the chip-menu Escape
   handler in the **capture phase** on the menu element, or register the chip menu itself as
   an overlay nested inside `.cl-modal-content` (the handler's `_overlayIsAbove` already
   gives a descendant precedence over its ancestor, which is the cleaner fix).
2. `closeModal()` must call `closeChipMenu()` first (upstream does, `ui-editor.js:48`).

Also keep the existing click-outside behaviour, extended per upstream
(`ui-editor.js:163-166`): a click that is neither on a chip nor inside the chip menu closes
the chip menu.

---

## 6. Step 4 — CSS

Port `~/workspaces/SillyTavern-Character-Tools/style.css` lines ~72–330 (the `ctm-*` rules
from `.ctm-summary` through `.ctm-bulk-clear`) into `web/modules/tag-manager.css`, keeping
the `ctm-` prefix so the port stays diffable against upstream. Skip `.ctm-overlay`,
`.ctm-modal`, `.ctm-header`, `.ctm-footer`, `.ctm-body`, `#ctm-panel` — our `.cl-modal`
shell already provides all of that. Skip `.ctm-ignored-*` and `.ctm-deleted-*` (dead
upstream classes, no JS references them).

Re-theme against our tokens (`web/library.css` around line 259 documents the palette):

| upstream literal | ours |
|---|---|
| `var(--SmartThemeQuoteColor, #4a9eff)` | `var(--accent)` |
| `#81c784` (clean-category green) | `var(--cl-success)` (or `--cl-success-pale` if it reads dim on the glass background) |
| `#e57373` (dismiss red) | `var(--cl-error)` |
| `opacity`-dimmed label text | `var(--text-secondary)` / `var(--text-faint)` |
| hardcoded `13px` / `11px` | the `--font-sm` / `--font-xs` scale |
| bare `rgba(255,255,255,0.x)` | keep — they're neutral overlays and already match our idiom |

The token names above are the documented set at `web/library.css:255-287` — read that
comment block before inventing a variable.

Keep the existing `.tm-*` rules (summary tiles, status, empty states) — they're still used.
The `.tm-groups` / `.tm-group` / `.tm-group-pills` / `.tm-tag-*` rules become dead once
`renderGroups` is replaced; **delete them in the same pass** rather than leaving them.

Extend the existing `html.cl-mobile` block at the bottom for the new surfaces (category
headers, table, bulk bar). The table needs to stay usable narrow — let the variants cell
wrap and let `.ctm-table-wrap` scroll horizontally rather than forcing the modal wide.

The modal is currently capped at `720px` (`tag-manager.js:288`); the screenshots are a
three-column table with room for chips. Widen to ~900px, same `var(--modal-scale)` idiom.

---

## 7. Step 5 — tests

We have **no jsdom** (`web/tests/README.md`), and adding one is not in scope. So keep the
testable logic out of the DOM and test that.

New `web/tests/tag-dictionary-module.test.mjs` (node:test, zero deps, `.mjs` because it
imports the ES-module vendor subtree — follow `tag-delta.test.mjs`'s style exactly). Stub
`fetch` and `window.getSetting/setSetting` in the module scope before importing.

Cover:

1. **`loadBaseDictionary` keeps categories** — feed a two-category fixture; assert
   `canonicalCategories` maps each canonical to its category and `categoryOrder` preserves
   JSON key order. *(This is the regression that caused gap #4.)*
2. **`loadBaseDictionary` still flattens correctly** — `mapping` matches what today's
   `flattenDictionary` produced, so the port changes nothing about matching.
3. **Delta round-trip through the settings stub** — `saveDictionary(edited)` writes a delta
   containing only the moved tag; a fresh `ensureDictionary()` reconstructs the edited
   dictionary.
4. **New base entries flow through** — persist a delta, then swap in a base with an extra
   canonical; `ensureDictionary()` returns the edit *and* the new canonical. This is the
   whole point of the delta (user's list item 3) and is worth an explicit test.
5. **`saveDictionary` no-ops when the base fails to load** — `fetch` rejects → `setSetting`
   never called. Guards the bloat failure in §3.
6. **`rebuildMapping` drops undeclared variants and preserves patterns** — the §5.3
   invariants, on a hand-built state object.

Then run the full gate:

```
make test-js       # userscript/ and web/ node --test
make test          # 619+ Python tests must stay green (nothing here should touch them)
```

Manual verification (there is no automated DOM coverage, so this is the real gate — walk
all of it and capture the console):

- open the modal on the live archive: 19 categories, counts on each header, only
  rename-bearing ones auto-open, the rest green;
- expand a category: canonical inputs, variant chips with counts, per-row card counts;
- move a chip to another canonical → chip relocates, counts update, summary updates;
- reload the page → the move is still there (this is the delta round-trip end to end);
- confirm it landed: `python -c "import json;print(json.load(open('data/settings.json')).get('tagDictionaryDelta'))"`
  shows a *small* object, not hundreds of overrides;
- ✕ a variant → Unassigned; move it back; select-mode bulk-move several at once;
- rename a canonical in its text box, then immediately click a chip — the rename survives
  (`syncFromDom`);
- try to delete a canonical that owns a glob rule → refused with a toast;
- Reset Tags → back to shipped, button goes disabled-styled;
- Escape with a chip menu open closes only the menu; Escape again closes the modal;
- **Apply on a scratch copy of the archive first**, then verify the diff is what the
  preview said.

`web/tests/smoke.py` does not open this modal today; if it's cheap, add a click on
`#tagManagerBtn` + one category expand to it, since a broken handler is otherwise silent.

---

## 8. Order of work

Each step ends green; don't start the next until it is.

1. `web/modules/tag-dictionary.js` + the `DEFAULT_SETTINGS` key + its tests. **No UI
   changes yet.** `make test-js` green.
2. Repoint `tag-manager.js` at `ensureDictionary()` (still read-only, still today's
   rendering). Delete `flattenDictionary`/`loadDictionary`. Nothing should visibly change —
   that's the point. Verify in the browser.
3. Category tree: replace `renderGroups` with `buildTable()` + `buildRow()`, all canonicals,
   `<details>`, auto-open/green. Still no editing. Verify against the screenshots.
4. Editing: `moveVariant`, chip menus, row ✕, New canonical, `persist()`. Verify the delta
   lands in `data/settings.json`.
5. Buckets: filters, select mode, bulk bar.
6. Apply rebuild (§5.6) + Reset Tags + dirty state.
7. CSS pass, mobile overrides, dead-rule deletion.
8. Full manual walk-through (§7), then apply for real.

---

## 9. Decisions already made — don't relitigate

- **Auto-save on every edit**, matching upstream ("Edits save automatically"). This is *not*
  the Phase 6 Apply/Revert model, and that's deliberate: this modal edits a *dictionary*,
  and the destructive step is the separate Apply Tags button that writes cards. Phase 6's
  Apply/Revert governs the card editor, which writes PNGs on save.
- **Keep the `ctm-` class prefix** so the port stays diffable against upstream.
- **Keep our stat tiles** alongside upstream's counts line.
- **No user picker** — single-user archive.
- **No server changes.** If you find yourself editing `proxy/`, stop; something has been
  misread.
- **Don't touch `web/vendor/tag-tools/`.** If a vendored file seems wrong, that's a finding
  to report, not a file to edit — its tests are the ported upstream suite.

## 10. Known unknowns to check while building

- `getCardTags(char)` prefers `char.data.tags` then `char.tags`; our list payload supplies
  root `tags` (`web/archive-api.js:138`) and no `data`. Today's preview works, so this is
  fine — but confirm the list payload isn't **truncating** tags the way `creator_notes` was
  blanked (see the creator-notes hydration bug). Spot-check a card known to carry many tags
  against its detail payload.
- `cardCount` depends on `char.avatar` being present and unique per card. It's `card.id`
  in the adapter; sanity-check one category's numbers against a manual count.
- `CoreAPI.showToast(message, type)` takes `'info' | 'success' | 'warning' | 'error'`
  (`web/library-sections/12-…js:665`) — no title argument, unlike `toastr`.
- The modal is capped at `max-height: calc(80vh * var(--modal-scale))` with the body
  scrolling. With 19 expandable categories, check that expanding several doesn't push the
  footer off-screen — the footer must stay pinned.
