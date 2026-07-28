"""Map a datacat character-card export onto the neutral fields the CardBuilder
consumes -- the third source path alongside janitor_mapper and saucepan_mapper.

datacat is a closed-source retriever that pulls JanitorAI cards very much the
way this project's own engine does, and writes the result straight into a PNG
as an embedded `chara`/`ccv3` character card (chara_card_v3). Bulk-grabbing a
bucket of those cards is faster than the send-a-chat-then-capture flow, so the
import pipeline re-homes them into the cards folder as `<name>_<id8>.png`.

Two facts about datacat exports shape the mapping:

  * No lorebook. datacat does not retrieve `character_book`; this project's
    retriever does. So imported cards simply carry no book (that's the tradeoff
    -- fine for the many hidden cards whose creators use no lorebook, and the
    reason a full retrieval of the same card is never overwritten by an import).
  * Macros intact. Like saucepan (and unlike this project's hidden-capture
    path), datacat definitions keep {{user}}/{{char}} as real macros, so there
    is no literal-persona-name reversal step -- a straight open-card build.
    `creator_notes` arrives as raw JanitorAI HTML, so it's run through the same
    html_to_md sanitizer the JanitorAI path uses.

The card's `data.name` is the character name (the same value this project keys
on) and `extensions.datacat.{id,creatorName,pageName}` carry the JanitorAI
character id, creator, and page name.
"""

from __future__ import annotations

from typing import Any

from proxy import pngtools
from proxy.html_md import html_to_md
from proxy.models import ProfileFields

# A datacat card originates from JanitorAI; reconstruct the canonical character
# URL from the id so imported cards match the source_url/character_version
# convention of natively retrieved cards.
_JANITOR_CHARACTER_BASE = "https://janitorai.com/characters/"


def _s(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def extract_card(png: bytes) -> dict[str, Any] | None:
    """Return the embedded character-card `data` object from a datacat PNG, or
    None if the PNG carries no readable card. Thin alias for the shared
    pngtools.extract_embedded_card reader (datacat writes the same
    base64(JSON) `ccv3`/`chara` chunks every tavern card does)."""
    return pngtools.extract_embedded_card(png)


def datacat_block(data: dict[str, Any]) -> dict[str, Any]:
    """The `extensions.datacat` provenance block, or {} if absent."""
    block = (data.get("extensions") or {}).get("datacat")
    return block if isinstance(block, dict) else {}


def is_datacat(data: dict[str, Any]) -> bool:
    """Whether this card looks like a datacat export (has the datacat block).
    Guards the import loop against a stray PNG that isn't one."""
    return bool(datacat_block(data))


def card_id(data: dict[str, Any]) -> str:
    """The JanitorAI character id (from the datacat block). Drives the `_<id8>`
    filename fragment and the acquired-detection glob."""
    return _s(datacat_block(data).get("id"))


def name(data: dict[str, Any]) -> str:
    """The character name (`data.name`) -- the same value the native path and
    chub_mapper key card filenames on. Mirrors chub_mapper.name."""
    return _s(data.get("name"))


def creator(data: dict[str, Any]) -> str:
    """Creator name -- the datacat block first, falling back to the card's own
    `creator` field (they agree in practice)."""
    return _s(datacat_block(data).get("creatorName")) or _s(data.get("creator"))


def page_name(data: dict[str, Any]) -> str:
    """The JanitorAI page name (datacat records the character name here; it does
    not capture the separate card-title blurb the native path stores)."""
    return _s(datacat_block(data).get("pageName")) or _s(data.get("name"))


def source_url(data: dict[str, Any]) -> str | None:
    cid = card_id(data)
    return f"{_JANITOR_CHARACTER_BASE}{cid}" if cid else None


def to_profile_fields(data: dict[str, Any]) -> ProfileFields:
    """Map a datacat card's `data` object onto ProfileFields. datacat puts the
    whole definition in `description` (its `personality` field is unused), so
    that maps straight across; `creator_notes` is de-HTML'd."""
    return ProfileFields(
        name=_s(data.get("name")),
        creator=creator(data),
        tags=[t for t in (data.get("tags") or []) if isinstance(t, str) and t.strip()],
        description=_s(data.get("description")),
        scenario=_s(data.get("scenario")),
        mes_example=_s(data.get("mes_example")),
        creator_notes=html_to_md(data.get("creator_notes") or ""),
    )


def greetings(data: dict[str, Any]) -> list[str]:
    """The card's greetings: the primary `first_mes` first, then any
    `alternate_greetings`. Blank/dupe entries are dropped; the CardBuilder makes
    element 0 the first_mes."""
    out: list[str] = []
    for g in [data.get("first_mes"), *(data.get("alternate_greetings") or [])]:
        text = g if isinstance(g, str) else ""
        if text.strip() and text not in out:
            out.append(text)
    return out
