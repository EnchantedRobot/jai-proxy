# Fixture provenance

Captured 2026-07-08 from live JanitorAI via the M1 gate (`uv run python -m proxy.server`
+ userscript, JanitorAI proxy pointed at the local server).

## `system_prompt_*.txt`
Raw hidden-definition captures — the exact text the server saw in the first `system`
message after sending "hello"/"hi" to a character's chat. Primary fixtures for
`prompt_parser.py` (M2).

- `system_prompt_open_{kira,sabrina_hill,akane_kujo}.txt` — public-definition cards.
- `system_prompt_hidden_{lyra,lyra_2,ari,aubrey_evans}.txt` — hidden-definition cards.
  `lyra` and `lyra_2` are two independent captures of the same character (differ by one
  trailing space — a useful whitespace-tolerance edge case, not a meaningful diff).

## `hampter/*.json`
Real `GET /hampter/characters/<id>` API payloads — the clean JSON that replaced DOM
scraping (see the `jai_proxy_janitor_api` memory). Captured 2026-07-16 in-page (bearer
JWT). Primary fixtures for `janitor_mapper.py`. Eight cards, 6 open + 2 hidden — the
`closed_` prefix tracks **lorebook** visibility, NOT the card, so `closed_alaina` and
`closed_lila` are actually open (`showdefinition: true`):
- `open_{nyla,io,akane_kujo,vaelyra}.json`, `closed_{alaina,lila}.json` — open cards:
  `personality`/`scenario`/`example_dialogs` populated, `first_messages[0]` is the primary
  greeting. `open_akane_kujo.json` is the same character as `system_prompt_open_akane_kujo.txt`,
  `reference_jai/Akane_Kujo.png`, and the `akane_kujo_*_lorebook.json` files — quadruple
  cross-check. Its tags map **exactly** to the reference PNG's, and its one LRM-only
  "separator" greeting is dropped to reproduce the reference's 9-greeting count.
- `closed_{amaya,selene}.json` — genuinely hidden (`showdefinition: false`): the server
  omits `personality`/`scenario`/`example_dialogs`/`first_message` and nulls
  `first_messages[0]`, leaking only the alternate greetings. Everything else
  (name/creator/tags/creator_notes/avatar) is still present — those come from the JSON even
  for hidden cards; the definition body + primary greeting come from the chat capture.

## `chat_request_hidden_ari.json`
A real JanitorAI chat-completions request body for a hidden card (Ari):
`[system(hidden def), user ".", assistant(rendered primary greeting), user "USER: hello"]`.
Proof that the primary greeting rides in as the first `assistant` message — the structure
`capture_store.record(..., primary_greeting=...)` depends on. Exercised by
`tests/test_server.py`.

## `reference_jai/`
V3 PNGs exported directly from JanitorAI (via a prior run of the `janitorai-export`
Tampermonkey script's pure DOM scrape, no chat capture) for the same three **public**
characters as the `system_prompt_open_*` files.

**Not authoritative ground truth** — spot-checking (`Akane_Kujo.png`'s `creator_notes`)
found a literal `<h1>` HTML tag leaked into a field that should be markdown — almost
certainly a bug in whichever version of that script produced these captures. Treat these
PNGs like `reference_datacat/`: a loose sanity check for rough field content (name, tags,
creator, presence/absence), not a byte-for-byte formatting oracle.

**The `janitorai-export` script itself is dead (2026-07-15)** — it was jai-proxy's
ancestor, this repo long since superseded it, and `~/workspaces/saucepan/` is archived.
Earlier revisions of this file told you to resolve disagreements by matching "the *current*
script's documented logic." Ignore that: `proxy/` + these tests are the authority now.
Where the Python disagrees with these PNGs, prefer the Python.

## `saucepan/`
**Different site, not JanitorAI. Backs no production code.** Two real chapter responses
(`GET /api/v2/lorebooks/<id>/chapters/<index>`) from saucepan.ai, salvaged 2026-07-15 from
the archived `~/workspaces/saucepan/` before it went away. Shape:
`{index, title, text_fragments: {version, mask, fragments: [{text, key, proof}, ...]}}`.

`fragments` is a shuffled bag of real prose **mixed with decoys** (~25% of each payload).
Reassembly — keep fragments whose `proof` validates, sort by `key XOR mask`, concatenate —
was reverse-engineered from saucepan's minified bundle and is ported in
`userscript/saucepan-export.user.js`, which is **parked** (see that file's comments).

These two files are the only real captures of that format in existence, which is the whole
reason they're here: `tests/test_saucepan_lorebook.py` pins the algorithm against them, so
the reverse-engineering survives even though nothing uses it yet. The trap they document:
decoy ordinals all sort *past* the real prose, so an implementation that skips `proof`
validation emits the correct text and then appends word-salad — it looks right unless you
read the tail. Related DOM captures from that site (`mindy.html`, `saucepan_mio*.html`,
`example.html`, `lorebook.html`) were deliberately **not** salvaged: they back no tests, and
a revived scraper would need fresh captures anyway.

- `lorebook_chapter0.json` — "Eve's Father", mask 1977, 62/82 fragments real → 1827 chars.
- `lorebook_chapter1.json` — "The Bullies", mask 25346, 156/208 real → 4829 chars.
  (`mask` is per-payload, not a build constant.)

## `reference_datacat/`
V2 PNGs pulled from a third-party site (datacat.run) for the three **hidden** characters,
matching `system_prompt_hidden_{lyra,ari,aubrey_evans}.txt`. Quality/accuracy unverified —
treat as a loose sanity check only, not authoritative ground truth (there is no DOM-based
ground truth possible for hidden cards by definition).

## `hampter_script_kamii_university.json`, `akane_kujo_jai_lorebook.json`, `akane_kujo_st_lorebook.json`
Real lorebook fixtures for Akane Kujo's "Kamii University: A Living Campus" script — added
for M5 (`lorebook.py`). Same character as `system_prompt_open_akane_kujo.txt` /
`hampter/open_akane_kujo.json`, so this is a lorebook-specific facet of that same real
capture set.

- `akane_kujo_jai_lorebook.json` — the real 20-entry JanitorAI script array (the parsed
  contents of a `/hampter/script/<id>` response's `script` field), manually exported by
  the owner from `https://janitorai.com/scripts/9e345de7-1e25-4f1b-8aec-6ea0b10b8b6b`
  ("Lorebook source"). This is the ground-truth INPUT to `LorebookMapper.map()`.
- `akane_kujo_st_lorebook.json` — a SillyTavern World Info export for the same character,
  re-exported by the owner from a previously-built card. SillyTavern's own
  `entries: {"0": {...}, ...}` (its native worldinfo shape: `order`/`disable`/`uid`/
  `outletName`/etc, NOT the V3 shape) is **not** directly comparable to our
  `character_book.entries` output — treat it like `reference_jai/`, a loose sanity check,
  not a schema to imitate. Its `originalData` field, however, is gold: SillyTavern
  preserves the *pristine* V3 `character_book` it imported (before flattening into its own
  native entries) verbatim — `{name, description, scan_depth, token_budget,
  recursive_scanning, extensions, entries[]}`, exactly `models.CharacterBook`'s shape. That
  `originalData` covers a two-book merge (Kamii University's 20 entries + a second
  "Sex Positions & Kinks" script's 90, per its `extensions.jai_sources` — the owner only
  handed over the raw JAI-side script for the first book, to keep fixtures compact) so
  `originalData.entries[0:20]` is real ground-truth OUTPUT for mapping
  `akane_kujo_jai_lorebook.json`'s 20 entries, confirmed index-for-index by matching
  `content`/`keys` (see `tests/test_lorebook.py`).

  **Field-for-field validated:** feeding `akane_kujo_jai_lorebook.json` through
  `LorebookMapper.map()` as a single book produces output identical to
  `originalData.entries[0:20]` on every field except `comment` — which differs only by the
  `[Kamii University: A Living Campus] ` prefix `originalData` carries from its original
  two-book merge context (`multi_book=True` there vs `False` in the single-book test); the
  base `comment` (post-prefix) is identical. This is about as strong a real-data validation
  as this port gets.
- `hampter_script_kamii_university.json` — the full raw `/hampter/script/<id>` response
  envelope (`{type, id, title, description, depth, settings, script, ...}`), built by
  wrapping `akane_kujo_jai_lorebook.json`'s 20 real entries in the real envelope fields
  confirmed via a browser console dump made while probing JanitorAI's `/hampter/*`
  endpoints (`console-export-2026-6-22_22-15-50.log` lines 106-183, in the since-archived
  `~/workspaces/saucepan/`) — which confirms the real endpoint is `/hampter/script/<id>`
  singular, not `/hampter/scripts/<id>` or `/hampter/lorebooks/<id>`, both 404 there.
  This is the fixture `LorebookMapper.map()`
  tests actually feed in, since it's the shape a real `/build` `lorebooks[].raw` payload
  has.

**Do NOT confuse with `saucepan/lorebook_chapter*.json`** (see below) — a different,
obfuscated shape entirely, from a different *site*. Correct as of 2026-07-15: those are
**not** "an unrelated masking/scrambling experiment" as this file previously claimed, but
real saucepan.ai API captures. Either way they are not `/hampter/script` responses, and
their `mask`/`proof` fields correspond to nothing `LorebookMapper` reads.

Cross-check: entry 0's `content` field (the "Kamii University: The Living Campus..."
prose) also appears **verbatim, completely undelimited** at the tail of
`system_prompt_open_akane_kujo.txt` (lines 90-105) — real proof that an activated lore
entry gets folded straight into the chat system prompt with zero structural markers. See
`proxy/prompt_parser.py`'s comment on trailing content and `proxy/capture_store.py`'s
comment on why `lore_entries` accumulation from raw prompt text isn't attempted.
