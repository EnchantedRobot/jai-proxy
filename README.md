# jai-proxy

Archives JanitorAI character cards as SillyTavern-compatible **Character Card V3**
PNGs, for personal use. It captures both **public** cards and **creator-hidden**
definitions, and saves each as a self-contained PNG (definition + all greetings +
lorebook + avatar) into `./cards/`.

## How it works

A **thin userscript bridge** does only what must happen inside JanitorAI's
authenticated page — relaying the chat request, and reading a character straight
from JanitorAI's own JSON API (`GET /hampter/characters/<id>` for the card,
`/hampter/script/<id>` for public lorebooks), both bearer-authenticated in-page.
A local **FastAPI server** does everything else: maps the JSON onto Character
Card V3, repairs macros, converts the creator-notes blurb HTML→markdown,
assembles the V3 JSON, fetches the avatar, and embeds it into the PNG `tEXt`
chunks (via Pillow). Because the mapping lives in Python, a JanitorAI schema
change is fixed by editing the server and restarting — no userscript reinstall.

Hidden definitions are never served by the API; they only exist in the chat
**system prompt** sent to the model, and the card's primary greeting only in the
chat's first message. The server captures both as it relays the chat request to
a local MLX model, so nothing leaves your machine, and merges them with the JSON
(alternate greetings, tags, creator notes, avatar) at export.

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

The userscript is **compiled** from small modules under `userscript/src/`. After
editing any of them, rebuild the single-file bundle with:

```bash
make compile        # -> userscript/jai-proxy-bridge.user.js
```

## Usage

A pill in the bottom-right corner shows 🟢/🔴 for server reachability. On a
character page it also shows the character and, for hidden cards, its capture
state, e.g. `🟢 Ari · Sys ✓ · Greet ✗` (open cards just show `· open ✓`).

Just above the pill is the **⬇ Export card** button; it turns green when the card
in view can be exported right now. The pill carries a small **CLEAR** link on its
right edge.

### Public cards

Open the character's page and click **⬇ Export card**. The card is read straight
from JanitorAI's JSON API — no chat needed. You're prompted for the card name
(`Save card as:`, prefilled with the real name (`chat_name`) but editable, since
JanitorAI's card title is often a scenario blurb rather than the character name).
The button reports `✅ saved` on a clean export. Alternate greetings and public
lorebooks are fetched automatically during export; there's no separate step.

### Hidden-definition cards

A hidden card's JSON omits the definition and its primary greeting — both only
exist in the chat. So there's **one** extra step:

1. **Open a chat** with the character and **send any message** (e.g. `hello`).
   As the server relays that request it captures the hidden definition from the
   system prompt *and* the primary greeting from the chat's first message in one
   shot (pill shows `Sys ✓ · Greet ✓`).
2. Click **⬇ Export card** (on the character page, or from the chat).

If you click Export card on a hidden card before it's been captured, the build
**hard-fails** with a message telling you to send a chat message first — it never
writes a broken card. Everything else a hidden card needs (name, tags, creator
notes, alternate greetings, avatar, lorebooks) still comes from the JSON.

### Clearing the cache

Hidden cards are matched by character name against accumulated captures, so name
collisions get likelier as captures pile up. The pill's **CLEAR** link wipes all
captured system prompts and greetings (`./cards/.captures/`) and also resets the
plugin's own remembered state (last card name / id / hidden flag). Finished PNGs
in `./cards/` are not affected.

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

160 tests. All server-side logic (JanitorAI-JSON→V3 mapper, system-prompt parser,
macro repair, lorebook mapper, card builder, PNG round-trip, HTML→markdown, and
the FastAPI routes) is validated against **real captured fixtures** in
`tests/fixtures/` (8 real `/hampter/characters/<id>` payloads in
`tests/fixtures/hampter/`) — see `tests/fixtures/README.md` for provenance. The
userscript's in-page JSON/auth interaction has no automated tests; it's verified
live.

## Status

`uv run pytest` green (160). Server-side JSON refactor complete; live end-to-end
verification of the userscript export flows is pending.

Deliberately out of scope unless a real need surfaces: true token-by-token
streaming (the server wraps MLX's full reply as a single SSE chunk, which
JanitorAI accepts fine), and reconstructing lorebook entries from raw prompt
text (real captures show no structural markers to recover them — lorebooks come
exclusively via the `/hampter/script` path).
