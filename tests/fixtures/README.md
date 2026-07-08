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

## `reference_jai/`
V3 PNGs exported directly from JanitorAI (via the old `saucepan` Tampermonkey script's
pure DOM scrape, no chat capture) for the same three **public** characters as the
`system_prompt_open_*` files. This is the highest-trust ground truth we have — same
extraction approach this project ports from §8 of the plan — so parser/builder output for
those three characters should be checked against these `chara`/`ccv3` chunks.

## `reference_datacat/`
V2 PNGs pulled from a third-party site (datacat.run) for the three **hidden** characters,
matching `system_prompt_hidden_{lyra,ari,aubrey_evans}.txt`. Quality/accuracy unverified —
treat as a loose sanity check only, not authoritative ground truth (there is no DOM-based
ground truth possible for hidden cards by definition).
