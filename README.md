# jai-proxy

Archives JanitorAI character cards as SillyTavern-compatible **Character Card V3**
PNGs, for personal use. It captures both **public** cards and **creator-hidden**
definitions, and saves each as a self-contained PNG (definition + all greetings +
lorebook + avatar) into the cards folder — `./cards/` by default, or straight
into SillyTavern's own characters directory (see
[Configuration](#configuration-env)).

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

### Configuration (`.env`)

Defaults live in `proxy/config.py`; override them per-machine in a git-ignored
`.env` at the repo root, which the server, every script under `scripts/`, and the
test suite all read:

```bash
cp .env.template .env
```

The two keys that matter most:

| key | default | what it does |
| --- | --- | --- |
| `JAI_PROXY_OUTPUT_DIR` | `./cards` | where cards land |
| `JAI_PROXY_CARD_LAYOUT` | `flat` | `flat` = `<name>_<id8>.png`; `nested` = `<creator>/<name>_<id8>.png` |

**Pointing `JAI_PROXY_OUTPUT_DIR` at SillyTavern's characters folder** (typically
`…/SillyTavern/data/default-user/characters`) makes SillyTavern the archive
itself rather than a copy of it: a card you edit there is edited in the archive,
a card you delete there is gone from the archive, and a newly retrieved card is
in SillyTavern the moment it's written. There is no sync step because there is
only one folder. This is what `flat` is for — SillyTavern reads its characters
folder **non-recursively**, so a `nested` archive is invisible to it. Nothing is
lost by going flat: the creator stays on the card (`extensions.jai.creatorName`),
and the `_<id8>` filename fragment keeps names unique across creators.

Two things to know if you do share the folder with SillyTavern:

- SillyTavern re-encodes a card's PNG whenever you save an edit to it, so that
  card loses its pngquant compression (the data — including `extensions.jai`,
  `gallery_id` and the lorebook — round-trips intact; it seeds its write from
  the card's original JSON).
- SillyTavern's explicit **Rename** action renames the file to `<Name>.png`,
  dropping the `_<id8>` fragment that marks a card as already-acquired. Ordinary
  saves keep the filename; renames don't. A renamed card can be retrieved again
  as a duplicate.

Working state (`state/captures`, `state/lorecache`) is deliberately kept out of
the cards folder, since that folder may not be ours.

Install `userscript/jai-proxy-bridge.user.js` in Tampermonkey. In JanitorAI's
proxy/config settings, set the endpoint to
`http://127.0.0.1:8000/v1/chat/completions` (any model name — the server
overrides it with the loaded MLX model).

The userscript is **compiled** from small modules under `userscript/src_jai/`.
After editing any of them, rebuild the single-file bundle with:

```bash
make compile        # -> userscript/jai-proxy-bridge.user.js
                    #    + userscript/saucepan-proxy-bridge.user.js
```

(A twin **saucepan** bridge is compiled the same way from
`userscript/src_saucepan/` — same server, same purple export button and
connection pill. It detects hidden companions too (`🟢 saucepan · hidden ✗`,
read from `open_definition`), but can't capture them — a hidden saucepan
definition isn't exposed by the API — so those export only their public blurb,
with a server warning.)

## Usage

A pill in the bottom-right corner shows 🟢/🔴 for server reachability and, on a
card page, whether the card in view is exportable right now — **without** naming
the character (the server pulls that cleanly from the API at build time). Open
cards show `🟢 jai-proxy · ready ✓`; hidden cards show `· hidden ✓` once captured
(`· hidden ✗` before). Off a card the pill is just `🟢 jai-proxy`. It carries a
small **CLEAR** link on its right edge.

Just above the pill is the purple **⬇ Export to card** button; it dims slightly
when the card in view isn't exportable yet. Export progress (`Fetching…`,
`✓ Saved`) appears in a status line just above the button.

### Public cards

Open the character's page and click **⬇ Export to card**. The card is read
straight from JanitorAI's JSON API — no chat needed, and no name prompt (the
server saves it under the real `chat_name`; JanitorAI's card title is often a
scenario blurb rather than the character name). The status line reports
`✓ Saved` on a clean export. Alternate greetings and public lorebooks are
fetched automatically during export; there's no separate step.

### Hidden-definition cards

A hidden card's JSON omits the definition and its primary greeting — both only
exist in the chat. So there's **one** extra step:

1. **Open a chat** with the character and **send any message** (e.g. `hello`).
   As the server relays that request it captures the hidden definition from the
   system prompt *and* the primary greeting from the chat's first message in one
   shot (pill shows `· hidden ✓`).
2. Click **⬇ Export to card** (on the character page, or from the chat).

If you click Export to card on a hidden card before it's been captured, the build
**hard-fails** with a message telling you to send a chat message first — it never
writes a broken card. Everything else a hidden card needs (name, tags, creator
notes, alternate greetings, avatar, lorebooks) still comes from the JSON.

### Clearing the cache

Hidden cards are matched by character name against accumulated captures, so name
collisions get likelier as captures pile up. The pill's **CLEAR** link wipes all
captured system prompts and greetings (`./state/captures/`) and also resets the
plugin's own remembered state (last card id / hidden flag). Finished card PNGs
are not affected.

### Reading the result

The status line above the button reports the outcome: `✓ Saved`, or
`⚠️ Saved — N warning(s)` if something was degraded (e.g. an unresolved macro or
a missing field — hover the button for the full list), or `⚠️ <message>` if the
build request itself failed (the hidden-card gate reports its reason here;
otherwise check the server logs).

### Browsing (hiding what you already have)

Any page that renders character tiles — the logged-in homepage, search, tag
browse, a creator's profile — gets a **🙈 Hide saved** toggle above the export
button. Turning it on folds away every tile that is either already saved to your
cards folder or skipped by the include/exclude tag filter in
`userscript/src_jai/config.js`, so what's left is the stuff you don't have and
would actually want. The button then reads `👁 Show hidden (N)`; clicking it
again puts everything back.

Both verdicts come from the tile itself — the character id from its link, the
tags from its own chips — so no extra listing requests are made and the toggle
follows whatever segment/sort you've picked. "Already saved" is the same
`_<id8>` filename check the bulk sweep uses, so it stays accurate no matter what
you renamed the card to. Hiding is purely a CSS class on the tile; nothing on
JanitorAI's side is touched.

### Importing cards (datacat & Chub.ai)

Some sources hand you a PNG that already embeds a `chara`/`ccv3` character card.
Dropping a bucket of those into `./import` and re-homing them is faster than the
send-a-chat-then-capture flow — no server needed:

```bash
# drop card PNGs into ./import, then:
make import
```

Each card lands in the configured cards folder under the same `<name>_<id>.png`
naming the native retriever produces (so it shows as **acquired** on the next
scan, which keys off the `_<id>` filename fragment), running the shared avatar
normalize + pngquant compression. Two source formats are auto-detected:

- **datacat** (a closed-source JanitorAI retriever) — a bare definition with
  **no lorebook**. It's rebuilt through the card builder (macro sanitize,
  creator-notes HTML→markdown) with a `datacat_import` provenance block. Because
  it lacks the `character_book`, a card whose creator uses one is still better
  grabbed via the send-a-chat capture flow.
- **Chub.ai** (recognised by `extensions.chub`) — an already-complete
  `chara_card_v3` with its **own lorebook and rich extensions**. It's passed
  through near-verbatim: macros are sanitized and `creator_notes` is converted
  from Chub's styled HTML (its `<style>`/CSS shell is stripped, not leaked) to
  markdown, but the `extensions` block (including the `depth_prompt` injection)
  and the whole `character_book` — down to entry fields like `probability` /
  `selectiveLogic` and Chub's int-or-string `position` — are preserved exactly.

A card whose id is **already** in the cards folder is skipped, never overwritten,
so a fuller retrieval is never downgraded to an import. To replace one, delete
the existing file and re-run.

### Gallery ids (SillyTavern-CharacterLibrary)

CharacterLibrary gives each character its own image-gallery folder, keyed on the
character name **plus** an `extensions.gallery_id` — a random 12-character
alphanumeric string it mints for characters that don't have one. Without an id
the folder is keyed on the name alone, so two characters called "Aurora" share
(and overwrite) one gallery.

Every card written here carries one: `PngWriter` stamps it at write time, using
the same alphabet and length CharacterLibrary does, so our cards drop in and work
unchanged. An id already on a card is never regenerated — an import keeps the id
its source carried, and re-exporting a character keeps the id the card on disk
already has, so a gallery folder is never orphaned.

Cards built before this (or imported from a source with no id) can be caught up
in place:

```bash
make gallery-ids              # read-only report: which cards lack an id
make gallery-ids ARGS=--apply # mint and patch them in (pixels preserved)
```

## Tests

```bash
uv run pytest        # server (proxy/)
make test-js          # userscript (userscript/src_jai/)
```

All server-side logic (JanitorAI-JSON→V3 mapper, system-prompt parser, macro
repair, lorebook mapper, card builder, PNG round-trip, HTML→markdown, the datacat
and Chub import mappers, and the FastAPI routes) is validated against **real
captured fixtures** in `tests/fixtures/` (8 real `/hampter/characters/<id>`
payloads in `tests/fixtures/hampter/`, 2 real datacat card exports in
`tests/fixtures/datacat/`, a real Chub export in `tests/fixtures/chub/`) — see
`tests/fixtures/README.md` for provenance.

The userscript is authored as small modules under `userscript/src_jai/*.js`,
concatenated into one IIFE at compile time (`scripts/compile_userscript_jai.py`).
`userscript/tests/` (Node's built-in `node:test`, no dependencies) reproduces
that same concatenation for just the module(s) a test needs — see
`userscript/tests/helpers/load-src.js` — so pure logic can be unit-tested
without a browser. So far this only covers the bulk-download tag filter
(`bulk.tag-filter.test.js`) as a smoke test; the rest of the userscript's
DOM/network/in-page JSON+auth interaction still has no automated coverage and
is verified live.

## Status

`uv run pytest` green (283). Server-side JSON refactor complete; datacat + Chub.ai
bulk import live; live end-to-end verification of the userscript export flows is
pending.

Deliberately out of scope unless a real need surfaces: true token-by-token
streaming (the server wraps MLX's full reply as a single SSE chunk, which
JanitorAI accepts fine), and reconstructing lorebook entries from raw prompt
text (real captures show no structural markers to recover them — lorebooks come
exclusively via the `/hampter/script` path).
