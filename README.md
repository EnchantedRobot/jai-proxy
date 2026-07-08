# jai-proxy

Archives JanitorAI character cards as SillyTavern-compatible Character Card V3
PNGs, for personal use. See `docs/PLAN.md` for the design and `docs/IMPLEMENTATION.md`
for the execution spec.

## Setup (macOS)

```bash
uv sync
uv run python -m proxy.server        # serves http://127.0.0.1:8000
```

MLX must already be running separately with an OpenAI-compatible endpoint at
`http://127.0.0.1:8011/v1` with `Llama-3.2-3B-Instruct-4bit` loaded.

Install `userscript/janitorai-export.user.js` in Tampermonkey. In JanitorAI's
proxy/config settings, set the endpoint to
`http://127.0.0.1:8000/v1/chat/completions` (any model name — the server
overrides it). A pill in the bottom-right corner shows 🟢/🔴 for server
reachability (and the loaded MLX model + capture count once connected).

An **⬇ Export card** button sits just above the pill. Click it on a
character's profile page to build and save a V3 PNG to `./cards/`:

- **Public cards** work immediately — no chat needed.
- **Hidden-definition cards** need one chat message sent first (the server
  captures the hidden personality/scenario/example-dialogs out of the system
  prompt automatically the moment JanitorAI's chat request passes through the
  proxy; nothing extra to configure).
- **Alternate greetings and lorebooks are collected automatically** by the
  Export button — it walks the greeting carousel and mines any attached
  lorebook script IDs itself; there's no separate lorebook-export step.

The button's text reports the result: `✅ saved` on a clean export, or
`⚠️ saved — N warnings: ...` if something was degraded (e.g. an unresolved
macro or a missing field) — hover the button for the full warning list.
`⚠️ failed` means the build request itself errored; check the server logs.

## Tests

```bash
uv run pytest
```

118 tests, all server-side logic (parsers, mappers, card builder, PNG
round-trip) validated against real captured fixtures in `tests/fixtures/`
(see `tests/fixtures/README.md` for provenance). The userscript's DOM/fiber
interaction has no automated tests — see the Status section below for what's
been confirmed live vs. only unit-tested against static HTML captures.

## Status

- **M0 — Scaffold:** done.
- **M1 — Gate:** done. Verified on the live site: pill 🟢, JanitorAI's
  request to a hidden card reaches the server directly (no `FetchHook`
  interception was even required — JanitorAI calls the configured proxy URL
  straight from the browser), MLX's reply renders in JanitorAI with no
  crash, and the server logged the full hidden system prompt. Captured
  prompt saved as `tests/fixtures/system_prompt_hidden_lyra.txt` for the M2
  parser.
- **M2 — Parser:** done. `prompt_parser.py` (system-prompt tag extraction),
  `html_parser.py` (profile HTML → fields, HTML → markdown), `macros.py`
  (macro repair) all unit-tested against real captured fixtures.
- **M3 — Public build:** done. `cardbuilder.py` + `PngWriter` + `avatar.py`;
  `/build` route; userscript `Collector.profileHtml()`/`avatarUrl()` +
  `ExportButton`. PNG chunk round-trip tested. Not yet confirmed live: the
  `<main>` profile-container selector and whether the Export button actually
  works when clicked on janitorai.com.
- **M4 — Hidden merge:** done. `CaptureStore.get(name)` wired into `/build`
  with visible-DOM-wins-else-capture-fills-the-gap precedence; validated
  against real fixtures end-to-end.
- **M5 — Greetings + lorebook:** done. `Collector.walkGreetings()` (accordion
  + Next-button walk) and `mineLorebookIds()`/`fetchScripts()` (React-fiber
  mining + `/hampter/script` fetch) ported into the userscript;
  `lorebook.py`'s `LorebookMapper` validated field-for-field against a real
  20-entry script export and its SillyTavern re-import
  (`tests/fixtures/akane_kujo_*`). Lore-entry accumulation from raw
  chat-prompt text was investigated and found not implementable — real
  captures show no structural markers once a lore entry lands in the prompt,
  so `character_book` population goes exclusively through the
  `/hampter/script` path, not prompt-scraping.
- **M6 — Polish:** done. Export toast now surfaces warning counts (and the
  first warning, truncated) directly in the button text instead of only
  logging to the console; this README brought up to date. Streaming stayed
  at "v1" (single-chunk SSE, not true token passthrough) — nothing has
  surfaced a need for real streaming, and per the project's own rule this
  upgrade is only in scope if JanitorAI actually demands it.
  **Still unverified live** (server-side logic behind these features is
  fully unit-tested against real captures, but the in-page DOM/fiber code
  has never been exercised in a real browser session since the M1 gate):
  the `<main>` profile selector, `walkGreetings()`'s accordion/counter/
  Next-button walk, and `mineLorebookIds()`'s fiber mining + `/hampter/script`
  fetch. Run the manual checklist in `docs/PLAN.md` §6 (steps 3-6) to close
  this out.
