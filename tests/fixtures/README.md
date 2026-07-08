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

## `profile_*.html`
Real `outerHTML` captures of JanitorAI profile pages, source: `~/workspaces/saucepan/`
(that directory hosts several old experiments; only files with the `janitorai_*` naming —
or otherwise confirmed via `twitter:title`/`characterInfoMarkdownContainer` markers — are
genuine janitorai.com captures. `mindy.html` in that directory is from an unrelated
"Saucepan"-branded site, not JanitorAI, and must not be used here). Primary fixtures for
`html_parser.py` (M2):
- `profile_akane_kujo.html` ← `janitorai_kamii.html` — overlaps with
  `system_prompt_open_akane_kujo.txt` and `reference_jai/Akane_Kujo.png`, so this one
  character has DOM + system-prompt + reference-PNG triangulation.
- `profile_mio.html`, `profile_amelia.html`, `profile_vivienne.html` ← `janitorai_mio.html`,
  `janitorai_amelia.html`, `vivienne.html` — additional real structural variants (no
  system-prompt/PNG cross-check).

## `reference_jai/`
V3 PNGs exported directly from JanitorAI (via a prior run of the `janitorai-export`
Tampermonkey script's pure DOM scrape, no chat capture) for the same three **public**
characters as the `system_prompt_open_*` files.

**Not authoritative ground truth** — spot-checking (`Akane_Kujo.png`'s `creator_notes`)
found a literal `<h1>` HTML tag leaked into a field that should be markdown, which the
current `richToMd`/`getCreatorNotesRoot` logic in
`~/workspaces/saucepan/janitorai-export.user.js` (the live script, run via Tampermonkey in
Firefox) would not produce — almost certainly a bug in whichever version of the script
produced these captures, since that script is under active iteration. Treat these PNGs
like `reference_datacat/`: a loose sanity check for rough field content (name, tags,
creator, presence/absence), not a byte-for-byte formatting oracle. Where the Python port's
output disagrees with these PNGs, prefer matching the *current* script's documented logic
(fixing a bug if found, rather than reproducing it) over matching these files exactly.

## `reference_datacat/`
V2 PNGs pulled from a third-party site (datacat.run) for the three **hidden** characters,
matching `system_prompt_hidden_{lyra,ari,aubrey_evans}.txt`. Quality/accuracy unverified —
treat as a loose sanity check only, not authoritative ground truth (there is no DOM-based
ground truth possible for hidden cards by definition).

## `hampter_script_kamii_university.json`, `akane_kujo_jai_lorebook.json`, `akane_kujo_st_lorebook.json`
Real lorebook fixtures for Akane Kujo's "Kamii University: A Living Campus" script — added
for M5 (`lorebook.py`). Same character as `system_prompt_open_akane_kujo.txt` /
`profile_akane_kujo.html`, so this is a fourth, lorebook-specific facet of that same real
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
  confirmed via `~/workspaces/saucepan/console-export-2026-6-22_22-15-50.log` lines
  106-183 (a browser console dump made while probing JanitorAI's `/hampter/*` endpoints —
  confirms the real endpoint is `/hampter/script/<id>` singular, not `/hampter/scripts/<id>`
  or `/hampter/lorebooks/<id>`, both 404 there). This is the fixture `LorebookMapper.map()`
  tests actually feed in, since it's the shape a real `/build` `lorebooks[].raw` payload
  has.

**Do NOT confuse with `~/workspaces/saucepan/lorebook_chapter0.json` /
`lorebook_chapter1.json`.** Those are a different, obfuscated shape entirely —
`{index, title, text_fragments: {version, mask, fragments: [{text, key, proof}, ...]}}` —
from an unrelated masking/scrambling experiment in that same directory, not a real
`/hampter/script` response, and were not used here. `text_fragments`'s `proof`/`mask`
fields don't correspond to anything `mapLoreEntry`/`buildLorebook` reads.

Cross-check: entry 0's `content` field (the "Kamii University: The Living Campus..."
prose) also appears **verbatim, completely undelimited** at the tail of
`system_prompt_open_akane_kujo.txt` (lines 90-105) — real proof that an activated lore
entry gets folded straight into the chat system prompt with zero structural markers. See
`proxy/prompt_parser.py`'s comment on trailing content and `proxy/capture_store.py`'s
comment on why `lore_entries` accumulation from raw prompt text isn't attempted.
