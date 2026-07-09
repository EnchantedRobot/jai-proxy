# jai-proxy

Archives JanitorAI character cards as SillyTavern-compatible **Character Card V3**
PNGs, for personal use. It captures both **public** cards and **creator-hidden**
definitions, and saves each as a self-contained PNG (definition + all greetings +
lorebook + avatar) into `./cards/`.

## How it works

A **thin userscript bridge** does only what must happen inside JanitorAI's
authenticated, CSP-protected page — relaying the chat request, reading the DOM,
mining lorebook IDs from React fibers, and fetching cookie-authenticated
`/hampter/script/<id>` lorebooks. A local **FastAPI server** does everything
else: HTML→markdown, macro repair, V3 JSON assembly, avatar fetch, and PNG
`tEXt`-chunk embedding (via Pillow). Because the fragile parsing lives in Python,
a JanitorAI markup change is fixed by editing the server and restarting — no
userscript reinstall.

Hidden definitions are never rendered to the browser; they only exist in the chat
**system prompt** sent to the model. The server captures that prompt as it relays
the chat request to a local MLX model, so nothing leaves your machine.

## Setup (macOS)

```bash
uv sync
uv run python -m proxy.server        # serves http://127.0.0.1:8000
```

MLX must already be running separately with an OpenAI-compatible endpoint at
`http://127.0.0.1:8011/v1` and a model loaded (default `Llama-3.2-3B-Instruct-4bit`).
All defaults (MLX URL/model, port, output dir) live in `proxy/config.py` and are
env-overridable.

Install `userscript/jai-proxy-bridge.user.js` in Tampermonkey. In JanitorAI's
proxy/config settings, set the endpoint to
`http://127.0.0.1:8000/v1/chat/completions` (any model name — the server
overrides it with the loaded MLX model).

## Usage

A pill in the bottom-right corner shows 🟢/🔴 for server reachability. On a chat
page it also shows the current character and its capture state, e.g.
`🟢 Ari · Sys ✓ · Greet ✗`.

Just above the pill are two buttons: a context-aware **Export** button (its label
changes with the page) and a small **🗑 Clear cache** button.

### Public cards

Open the character's profile page and click **⬇ Export card**. Everything is
scraped from the DOM immediately — no chat needed. You're prompted for the card
name (`Save card as:`, prefilled with the detected name but editable, since
JanitorAI's page title is often a scenario blurb rather than the real name). The
button reports `✅ saved` on a clean export.

### Hidden-definition cards

A hidden card's profile shows none of the definition and none of the greetings,
so both must be captured from the chat experience via **two explicit steps**:

1. **Open a chat** with the character. The Export button relabels to
   **⬇ Export greetings** — click it to harvest all starting-message swipes from
   the DOM (`✅ captured N greetings`; pill shows `Greet ✓`).
2. **Send any chat message** (e.g. `hello`). The server captures the hidden
   definition out of the system prompt as it relays the request (pill shows
   `Sys ✓`).
3. **Return to the profile page** and click **⬇ Export card**.

If you click Export card on a hidden profile before both captures exist, the
build **hard-fails** with a message telling you what's missing — it never writes
a broken card.

Alternate greetings and lorebooks are collected automatically during export (the
button walks the greeting carousel / harvests the chat swipes and mines any
attached lorebook script IDs itself); there's no separate lorebook step.

### Clearing the cache

Hidden cards are matched by character name against accumulated captures, so name
collisions get likelier as captures pile up. **🗑 Clear cache** wipes all
captured system prompts and greetings (`./cards/.captures/`). Finished PNGs in
`./cards/` are not affected.

### Reading the result

The Export button's text reports the outcome: `✅ saved`, or
`⚠️ saved — N warnings: ...` if something was degraded (e.g. an unresolved macro
or a missing field — hover the button for the full list), or `⚠️ <message>` if
the build request itself failed (the hidden-card gate reports its reason here;
otherwise check the server logs).

## Tests

```bash
uv run pytest
```

149 tests. All server-side logic (system-prompt parser, HTML/profile parser,
macro repair, lorebook mapper, card builder, PNG round-trip, and the FastAPI
routes) is validated against **real captured fixtures** in `tests/fixtures/` —
see `tests/fixtures/README.md` for provenance. The userscript's in-page
DOM/React-fiber interaction has no automated tests; it's verified live.

## Status

Server-side feature-complete (M0–M7); `uv run pytest` green. The remaining open
item is end-to-end live-browser verification of the hidden-card flow — the
open-card export has been confirmed live end-to-end.

Deliberately out of scope unless a real need surfaces: true token-by-token
streaming (the server wraps MLX's full reply as a single SSE chunk, which
JanitorAI accepts fine), and reconstructing lorebook entries from raw prompt
text (real captures show no structural markers to recover them — lorebooks come
exclusively via the `/hampter/script` path).
