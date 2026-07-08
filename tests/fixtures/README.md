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
