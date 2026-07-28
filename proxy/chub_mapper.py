"""Map a Chub.ai (chub / charhub) character-card PNG export onto a clean,
SillyTavern-ready chara_card_v3 -- the fourth source path alongside
janitor_mapper, saucepan_mapper and datacat_mapper.

Unlike the JanitorAI paths, a Chub export is *already* a well-formed
chara_card_v3, carrying its own lorebook (`character_book`) and a rich
`extensions` block (a `chub` metadata block, a `depth_prompt` author's-note
injection, `fav`). So the import is deliberately a light touch -- a passthrough
that keeps the card almost verbatim and only:

  * sanitizes macros (typo + broken-bracket repair, pronoun fold) in the
    definition text fields and lorebook-entry content -- macros stay intact,
    there's no persona-name reversal (Chub is a fully open card, like datacat),
  * converts `creator_notes` from Chub's authored HTML to markdown (Chub notes
    wrap the blurb in a heavily styled shell with a `<style>` CSS block
    SillyTavern chokes on -- html_to_md now drops those), and
  * strips emoji/hash noise from tags.

Everything else is preserved AS IS: `extensions` (untouched -- including the
`depth_prompt` prompt and the `chub` block), `system_prompt`,
`post_history_instructions`, `character_version`, and the whole
`character_book`. Crucially that includes lorebook-entry fields our own
LoreEntry model doesn't carry (`priority`, `probability`, `selectiveLogic`) and
Chub's mixed int-or-string `position`. That's why the mapping edits the raw
parsed dict in place rather than round-tripping through the pydantic card models
-- a round-trip would silently drop those extras and coerce the int positions.

Identification + naming: a Chub card is recognized by `extensions.chub`. Its
`data.name`/`data.creator` are the character name and creator, and
`extensions.chub.id` (a unique numeric id, not a hash) drives the
`<name>_<id>.png` filename layout and the acquired-detection glob.
"""

from __future__ import annotations

import copy
from typing import Any

from proxy.html_md import clean_tag, html_to_md
from proxy.macros import MacroSanitizer

# Reconstruct the canonical Chub character URL from the card's full_path so an
# imported card can record a source_url the way natively retrieved cards do.
_CHUB_CHARACTER_BASE = "https://chub.ai/characters/"

# The chara_card_v3 fields carrying authored prose + macros. Sanitized in place;
# every other top-level field is left exactly as Chub wrote it.
_TEXT_FIELDS = (
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "system_prompt",
    "post_history_instructions",
)


def _s(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def chub_block(data: dict[str, Any]) -> dict[str, Any]:
    """The `extensions.chub` metadata block, or {} if absent."""
    block = (data.get("extensions") or {}).get("chub")
    return block if isinstance(block, dict) else {}


def is_chub(data: dict[str, Any]) -> bool:
    """Whether this embedded card is a Chub export (has the `chub` block).
    Guards the import loop against a PNG that isn't one."""
    return bool(chub_block(data))


def card_id(data: dict[str, Any]) -> str:
    """Chub's unique character id (numeric, e.g. "5655941" -- not a hash).
    Drives the `_<id>` filename fragment and the acquired-detection glob."""
    cid = chub_block(data).get("id")
    return str(cid).strip() if cid not in (None, "") else ""


def name(data: dict[str, Any]) -> str:
    return _s(data.get("name"))


def creator(data: dict[str, Any]) -> str:
    return _s(data.get("creator"))


def page_name(data: dict[str, Any]) -> str:
    """Chub's display page name (falls back to the character name)."""
    return _s(chub_block(data).get("pageName")) or _s(data.get("name"))


def source_url(data: dict[str, Any]) -> str | None:
    full_path = _s(chub_block(data).get("full_path"))
    return f"{_CHUB_CHARACTER_BASE}{full_path}" if full_path else None


def clean_card(
    data: dict[str, Any], sanitizer: MacroSanitizer
) -> tuple[dict[str, Any], list[str]]:
    """Return a cleaned deep copy of the parsed Chub `data` object plus any
    unresolved-macro warnings.

    Sanitizes the definition text fields and lorebook-entry content, converts
    `creator_notes` HTML to markdown, and cleans tags. Everything else --
    extensions, character_book structure and entry extras, system_prompt /
    post_history_instructions macros aside -- is carried through unchanged."""
    card = copy.deepcopy(data)
    warnings: list[str] = []

    def scrub(text: str) -> str:
        cleaned, unknown = sanitizer.sanitize(text)
        for macro_name in unknown:
            w = f"unresolved macro: {{{{{macro_name}}}}}"
            if w not in warnings:
                warnings.append(w)
        return cleaned

    for field in _TEXT_FIELDS:
        if isinstance(card.get(field), str):
            card[field] = scrub(card[field])

    if isinstance(card.get("alternate_greetings"), list):
        card["alternate_greetings"] = [
            scrub(g) if isinstance(g, str) else g for g in card["alternate_greetings"]
        ]

    # creator_notes: authored HTML (+ a <style> CSS block) -> markdown, then
    # sanitize any macros left in the prose.
    card["creator_notes"] = scrub(html_to_md(card.get("creator_notes") or ""))

    # tags: strip leading emoji / "#" SillyTavern can't render, drop any that
    # clean down to nothing.
    if isinstance(card.get("tags"), list):
        card["tags"] = [
            cleaned
            for cleaned in (clean_tag(t) for t in card["tags"] if isinstance(t, str))
            if cleaned
        ]

    # Lorebook entry *content* carries the same macros; sanitize only the prose,
    # leaving keys / positions / probabilities / ids exactly as Chub wrote them.
    book = card.get("character_book")
    if isinstance(book, dict):
        for entry in book.get("entries") or []:
            if isinstance(entry, dict) and isinstance(entry.get("content"), str):
                entry["content"] = scrub(entry["content"])

    return card, warnings


def to_payload(data: dict[str, Any]) -> dict[str, Any]:
    """Wrap a cleaned Chub `data` object in the canonical chara_card_v3
    envelope -- spec header plus the top-level V2 mirror -- the exact structure
    CharacterCardV3.to_dict emits, so PngWriter.write_payload embeds it the same
    way it embeds a natively built card."""
    payload = {"spec": "chara_card_v3", "spec_version": "3.0", "data": data}
    payload.update(data)  # V2-compat top-level mirror
    return payload
