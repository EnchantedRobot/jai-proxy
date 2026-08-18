# Session prompt — plan the Archive UI rewrite

Paste everything below into a fresh session started in `~/workspaces/jai-proxy`.

---

I want to plan (not yet build) a full replacement of the `web/` frontend, using
`docs/mockups/d-archive.html` as the design target.

## Context you should load first

- **`docs/mockups/d-archive.html`** — the approved design target. Open it in a browser
  (Playwright lives under `~/.pyenv/versions/3.13.11`) and click through every tab before
  planning anything. It is a static mock running on 98 real cards from `data/characters`
  (`cards-data.js`, mock-only, never ships). `docs/mockups/index.html` lists the earlier
  drafts A/B/C that it was fused from — read the mock, not the drafts.
- **`web/`** — the thing being replaced: ~68k lines of vendored CharacterLibrary across 98
  JS/CSS/HTML files (`library-sections/` is a 43-file split of one 26k-line monolith,
  loaded as ordered classic `<script>` tags sharing one global scope). Assume none of it
  survives. It carries a large amount of dead weight from its SillyTavern-extension
  origins: fetch adapters, provider shims, settings that key off localStorage, patched
  globals. Do not port it file by file.
- **`proxy/api/v1/`** — the real backend: `characters.py`, `galleries.py`, `media.py`,
  `network.py`, `system.py`, `userscripts.py`, plus `proxy/api/{datacat,chub,...}`.
  FastAPI. This is the contract the new frontend consumes; the plan should treat the API
  as fixed unless there is a concrete reason to extend it, and should call out each such
  extension explicitly.
- **`~/workspaces/cbz-tagger/frontend`** — the reference stack and the house style to
  match: React 19, Vite, TypeScript, Tailwind v4 (`@tailwindcss/vite`), radix-ui +
  class-variance-authority (shadcn-style), TanStack Query, react-router, lucide-react,
  and **`openapi-fetch` against a generated `openapi.json`** for a typed API client.
  Vitest + Testing Library, oxlint, prettier.

## What the mock establishes (design decisions already made — don't relitigate)

- Four tabs: **Characters · Favorites · Discover · Tags**. Favorites is the Characters
  view with a filter. No Collections.
- One sticky section bar per page: title, count, a single rounded **chip strip** carrying
  both preset filters and tags (click to include, click again to exclude, `＋ Filter`
  opens a popover with the full tag list), and an understated text **Sort** at the right.
  No density control — tile size is fixed and the grid auto-fills.
- Optional **Recently added** shelf: exactly one grid row, measured from the grid's own
  column count, never a horizontal scroller. Hidden whenever a filter is active.
- Character detail is a **full-page route**, not a modal: sticky back bar with prev/next
  (J/K), portrait column with Download as the primary action, and tabs
  **Overview · Creator notes · Greetings · Lorebook · Gallery · Related · Info**
  (Info = file/provenance/content facts plus the raw `card.json` block).
- **Tags** is the consolidation editor as a first-class page: staged-change stats,
  category accordions, rows of `canonical tag | merged variants | cards`, staged apply.
- **Discover** controls are only: provider (Chub/DataCat), Discover/Following, hide cards
  I have, tag filters, Refresh. No NSFW toggle, no download queue.
- Settings is a route with a section nav, not a modal.
- Palette: dark, sage accent (`#57c2a2`), Figtree + Instrument Serif for display text.
  Rounded, generous, calm — pills and 12–16px radii, not boxy.

## What I want out of this session

A written plan (a `docs/` markdown doc, in the style of the existing phase plans) that
covers, at minimum:

1. **Inventory of real functionality** in today's `web/` — what genuinely must survive the
   rewrite versus what is SillyTavern-era baggage that dies with it. Be specific and
   evidence-based; this is the part I most want to be right.
2. **Stack + scaffolding decision** — where the app lives in the repo, how Vite builds
   into something FastAPI serves, how the typed client is generated from the FastAPI
   OpenAPI schema, and how dev mode proxies to the running server.
3. **API gap analysis** — every mock affordance that has no endpoint behind it today
   (tag consolidation apply, activity feed, favorites, settings persistence, Discover
   following, …), and for each: extend the API, fake it client-side, or cut it.
4. **Component/route breakdown** matching the mock, including which shadcn/radix
   primitives cover the popovers, accordions, tabs, and toggles.
5. **A staged migration path** where the new UI can be developed and served alongside the
   old one until it reaches parity, with an explicit definition of "parity" and an
   explicit cut-over step that deletes `web/`.
6. **Open questions for me** — including, at least, where card editing lives. Every
   `Edit` in the mock is a stub; my inclination is inline-editable fields on the detail
   page, but the plan should make a recommendation.

Ask me about anything ambiguous before writing the plan. Do not write application code
this session.
