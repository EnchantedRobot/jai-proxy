# Phase 3D — `library-sections/` → real modules, starting with the leaves

Phase 3B/3C left `web/library-sections/` at **43 files / 25,769 lines**, loaded as ordered
classic `<script>` tags sharing one global scope. That split was navigation only — it made
the old 26k-line `library.js` editable, but bought no encapsulation. This phase converts the
subset that can become real ES modules *cheaply*, and deliberately stops before the hubs.

The goal is not "modularize the frontend." It is to remove the files that have no business
being in a shared global scope, so the remaining list is short enough to reason about.

---

## 1. The three facts this plan rests on

These were measured, not assumed. Re-verify only if the tree has moved.

**1. There are zero inline event handlers.** No `onclick=` / `on*=` in `index.html`, and none
in any generated template string across all 43 sections (`grep -c "onclick=" index.html
library-sections/*.js` → 0 everywhere). The usual blocker for de-globalizing a UI codebase
does not exist here. **Nothing is pinned to `window` by markup.**

**2. Cross-section consumption is runtime-only, with two exceptions.** Every candidate symbol
was checked for depth-0 (load-time) references from other sections. Outside the bridge there
are exactly two:

    web/library-sections/20-advanced-filter.js:264   const debouncedAdvFilterSearch = debounce(triggerAdvFilterSearch, 150);
    web/library-sections/20-advanced-filter.js:719   const debouncedSearch = debounce(performSearch, 150);

Everything else is referenced only inside function bodies and event handlers, which run long
after deferred module scripts have executed.

**3. `window.X = X` keeps existing bare call sites working.** Window properties sit on the
global scope chain, so a classic section calling bare `formatDateTime(...)` at runtime still
resolves once a module has assigned `window.formatDateTime`. **Consumers need no edits.**
This is what makes Tier 1 cheap; do not "improve" it by rewriting call sites to
`window.formatDateTime(...)` — that is churn for no behavior change.

---

## 2. The one real hazard: `40-core-api-bridge.js`

`web/library-sections/40-core-api-bridge.js` is the **last classic script** and contains 115
`window.* = <bare global>` assignments harvested from 30 other sections. It is the seam that
publishes library internals to `web/modules/` via `core-api.js`.

When a section becomes a module, its symbols leave the classic global scope. The bridge line
that re-exports them then throws **`ReferenceError`** — and because it is one long top-level
script, that error **aborts every remaining assignment in the file**. The app will not crash
loudly; it will come up with an arbitrary suffix of the bridge missing, and modules will
degrade quietly (`multi-select.js`, for one, downgrades to a `console.warn` and silently never
injects its toolbar button).

**Rule: for every symbol you move, delete its line from `40-core-api-bridge.js` in the same
edit, and re-publish it from the new module instead.** The bridge lines to remove for the
sections in this plan:

| Section moving | Line(s) to delete from `40-core-api-bridge.js` |
|---|---|
| `02-mobile-mode` | `window.isMobileMode = isMobileMode;` (:93) |
| `10-api-endpoints` | `window.ENDPOINTS = ENDPOINTS;` (:203) |
| `34-duplicate-detection` | `window.calculateHash = calculateHash;` (:193) |
| `27-update-lock` | `window.isUpdateLocked` / `window.setUpdateLocked` (:212–213) |
| `39-theme-customizer` | `window.applyCustomCSS` / `window.CUSTOM_CSS_MAX_BYTES` (:180–181) |
| `03-performance-utilities` | `window.debounce` / `window.truncate` (:91–92) |

Line numbers are from the pre-change tree — match on text, not on number.

---

## 3. Where the converted code lives

Create **`web/lib/`** for migrated library code, with a single aggregator entry point.

`web/modules/` is *not* the right home: that directory is the CL feature-module system, with a
`ModuleLoader` registry, `init(dependencies)` lifecycle, lazy proxy stubs and per-module CSS.
The Tier 1 leaves have none of that — they are plain library functions, and registering them
as lifecycle modules would be ceremony around a date formatter.

    web/lib/
      index.js          <- imports every migrated module, publishes the window bridge
      mobile-mode.js
      api-endpoints.js
      fallback-images.js
      ...

`web/lib/index.js` holds all `window.*` publication in one place, so the bridge surface stays
greppable instead of scattering across a dozen files:

```js
import { isMobileMode } from './mobile-mode.js';
import { ENDPOINTS } from './api-endpoints.js';
import './scrollbar-auto-hide.js';   // side-effect only
// ...

window.isMobileMode = isMobileMode;
window.ENDPOINTS = ENDPOINTS;
```

`index.html` gains **one** line, placed immediately before `module-loader.js`:

```html
<script type="module" src="lib/index.js?v=1"></script>
<script type="module" src="modules/module-loader.js?v=47"></script>
```

Order matters and is guaranteed: module scripts execute in document order, so the window
bridge is populated before `module-loader.js` initializes its Tier 1 modules. Both run after
every classic script, which is exactly what fact #2 establishes as safe.

Delete each migrated file from `web/library-sections/` and its `<script>` tag from
`index.html`. Leaving a stale copy loaded is worse than not migrating — the classic global
would shadow nothing but would drift.

---

## 4. Tier 1 — the free batch (8 files, ~341 lines, no consumer edits)

Ordered easiest first.

| Section | L | Notes |
|---|---|---|
| `41-world-info-api` | 42 | **Already written as `window.X = async function…`.** Pure file move, zero code change, no bridge line. |
| `01-scrollbar-auto-hide` | 46 | Self-contained IIFE, **0 symbols in, 0 out**. Becomes a side-effect import; the IIFE wrapper can be dropped (module scope already isolates). |
| `09-fallback-images` | 7 | One const `FALLBACK_AVATAR_SVG`, 1 consumer. |
| `02-mobile-mode` | 11 | One fn, 0 deps, 6 consumers + `modules/`. |
| `10-api-endpoints` | 22 | One const `ENDPOINTS`, 0 deps, 6 consumers + `modules/`. |
| `28-search-highlighting-utilities` | 41 | `highlightText`, `clearHighlights`. 0 deps, 2 consumers. No bridge line. |
| `38-keyboard-navigation` | 62 | Defines nothing; a single `keydown` listener. Already reaches its deps through `window.ProviderRegistry` and bare `closeModal` (runtime-only — stays working). |
| `16-date-utilities` | 110 | 5 pure date fns, 0 deps, 3 consumers. No bridge line. |

Only 4 of the 8 need a bridge edit at all. `38` and `01` export nothing — they are listener
installs, so `web/lib/index.js` imports them purely for side effect.

---

## 5. Tier 2 — real features, small surface

Do these one at a time, smoke-testing between each.

- **`19-expand-field-modal-for-larger-text-editing` (1026 L)** — the standout. Only **1
  consumer file / 3 symbols** (`18-visual-tag-editing` calls its three `init*ExpandButtons`
  fns). Publishes `resetBrowseSectionCollapseState` + `setBrowseAltGreetings` for `modules/`.
  Its 7 dep files are all runtime-only. Best lines-moved-per-unit-risk in the tree — take it
  as the first substantial migration, alone, in its own commit.
- `39-theme-customizer` (300 L) — 3 consumers / 5 syms; deps on `06-settings-migrations`.
- `22-lorebook-editor-functions` (277 L) — 6 fns out, 1 dep file, no bridge line.
- `29-help-tips-modal` (90 L) — 0 consumers, already window-publishing
  (`openGalleryInfoModal`). Has top-level DOM wiring (`if (helpModal)`) — still fine, deferred
  modules run after parse.
- `34-duplicate-detection-feature` (59 L) — `calculateHash`, one bridge line.

---

## 6. Tier 3 — needs a prerequisite first

- **`03-performance-utilities` (51 L)** — blocked *only* by the two top-level `debounce()`
  calls in `20-advanced-filter.js` (fact #2). Make those two lazy (build the debounced fn on
  first use, or inside the existing init path) and this drops straight to Tier 1. Worth the
  detour: 6 consumer files plus `modules/` use `debounce`/`truncate`.
- **`26-bulk-auto-link` (817 L) + `27-update-lock` (191 L)** — move as a pair or not at all.
  `27` pulls **14 symbols** from `26`; they are one feature that got split across two files by
  the mechanical `// ====` cut.
- `24-import-summary-modal` (351 L), `42-additional-character-lorebooks-charlore` (338 L) —
  moderate dep webs; reassess after Tier 2.

---

## 7. Explicitly out of scope

Leave these in `library-sections/`:

`14-virtual-scrolling` (1780 L, 29 consumer files / 69 syms), `23-utility-functions` (1995 L,
23 consumers / 100 syms), `06-settings-migrations` (3110 L, 22 consumers),
`12-smart-image-relocation` (920 L, 23 consumers), `13-slim-index`, `05-settings-persistence`,
`07-core-helper-functions`, `00-preamble`.

These are the hubs — `14` and `23` alone are referenced by more than half the codebase. They
need **decomposition**, not relocation, and moving them wholesale into `web/lib/` would
produce a module that imports 20 others and exports 80 symbols: the same coupling with extra
syntax. That is a separate phase, and it should start by splitting `23` along its actual
seams rather than by where its comment banners happened to fall.

---

## 8. Acceptance

After **each** batch (Tier 1 as one; every Tier 2 file individually):

1. `make test-js` — both trees green (`userscript/`, `web/`).
2. `make test` — Python suite unaffected (it is; this is frontend-only), as a regression guard.
3. **Playwright smoke — the real gate:**

       JAI_PROXY_PORT=8002 uv run python -m proxy.server &
       ~/.pyenv/versions/3.13.11/bin/python web/tests/smoke.py http://127.0.0.1:8002

   It fails on **any** console error *or warning* and any failed request, and it clicks
   through every settings section and every Help section on purpose — panels only execute
   when opened, so a handler broken by a moved symbol stays invisible until someone opens
   that section. Playwright lives under pyenv 3.13.11, not the uv venv.

4. Manual spot-check of what each batch actually touched: for Tier 1, scroll a long list
   (scrollbar auto-hide), press PageDown/Home/End and Escape (keyboard nav), open the Help
   modal and search within it (highlighting), and confirm card dates render.

**Definition of done for Tier 1:** 8 files and 8 `<script>` tags gone from `index.html`,
`library-sections/` down to 35 files / ~25.4k lines, `web/lib/` exists with its aggregator,
4 bridge lines deleted, smoke test clean.

---

## 9. Sequencing

1. Scaffold `web/lib/` + `index.js` + the one `index.html` tag, migrating **`41-world-info-api`
   only** — it needs no code change and no bridge edit, so it isolates "does the loading
   mechanism work" from "did I break a symbol." Smoke.
2. The remaining 7 Tier 1 files as one batch. Smoke.
3. `19-expand-field-modal` alone. Smoke.
4. Remaining Tier 2, one at a time. Smoke between each.
5. Reassess Tier 3 — including whether the `26`+`27` pair is worth it at all.

Stop after step 3 if the value has been captured; steps 4–5 are optional continuation, not
commitments. Roughly 1,370 lines leave `library-sections/` by the end of step 3, without
touching anything that has a real dependency web.
