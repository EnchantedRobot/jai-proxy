"""Read-only previews of a provider card, before it is anything on disk.

Discover lets you look at a card on Chub or DataCat and decide whether to keep
it. Deciding means reading it -- description, greetings, lorebook, creator notes
-- and that means mapping the provider's payload into a tavern card. That
mapping already exists, in Python, in `proxy.sources.chub` and
`proxy.sources.datacat`, and it is *the same code* `/build-chub` and
`/build-datacat` run when the card is actually written.

So the preview runs it too, rather than the browser re-implementing it in
TypeScript. The point is not to save the typing: it is that a second mapper
would drift, and a preview that disagrees with what lands in the archive is
worse than no preview. Everything below the mapper call is shared with the
build routes by construction -- `catalog.summarize_data` is the counting the
archive applies to a card on disk, called here on a card that is not.

Nothing here writes, fetches an avatar, or checks for duplicates. The browser
already knows what it holds (`POST /characters/have`), and the write is a
separate, deliberate action.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from proxy import deps
from proxy.api.build import CHUB_AVATAR_BASE, build_card
from proxy.archive import catalog
from proxy.cards.models import CharacterBook
from proxy.sources import chub, datacat

router = APIRouter()

SAUCEPAN_ORIGIN = "https://saucepan.ai"


class DiscoverPreviewIn(BaseModel):
    """What the browser captured on the provider, unchanged.

    The fields mirror `ChubBuildRequest` / `DatacatBuildRequest` exactly, minus
    the write-only ones (`avatar_b64`, `gallery_id`), so the same captured
    payload can be previewed and then built without being re-fetched or
    reshaped.
    """

    provider: Literal["chub", "datacat"]
    # -- chub
    node: dict[str, Any] | None = Field(
        default=None,
        description="Chub's `GET /api/characters/{fullPath}?full=true` node. Required for provider=chub.",
    )
    linked_lorebook: dict[str, Any] | None = Field(
        default=None,
        description="The linked-project lorebook, when the node carries `related_lorebooks`. Resolved browser-side through Chub's v4 git API.",
    )
    # -- datacat
    character: dict[str, Any] | None = Field(
        default=None,
        description="DataCat's `GET /api/characters/{id}` detail payload, with `scripts[]` already hydrated. Required for provider=datacat.",
    )


class DiscoverPreviewOut(BaseModel):
    """A provider card described in the archive's own terms.

    Deliberately *not* a `CardDetailOut`: there is no file, so there is no
    filename, size, mtime, thumbnail or gallery, and inventing them would make
    the type lie. What it does share is every field derived from the card
    itself, under the same names, so the detail panes render a preview and an
    archived card with the same components.
    """

    provider: str
    name: str
    creator: str
    page_name: str
    tags: list[str]
    source_kind: str
    source_url: str
    card_id: str = Field(description="The provider's own id for the character.")
    fragment: str = Field(description="The `_<id8>` slice the archive would file it under.")
    character_version: str
    greetings: int = Field(description="Primary greeting plus alternates.")
    lore_entries: int
    description_chars: int
    prompt_chars: int
    has_creator_notes: bool
    has_example_dialogue: bool
    create_date: str
    spec: str
    spec_version: str
    card: dict[str, Any] = Field(description="The card's `data` object, exactly as the build route would write it.")
    avatar_url: str | None = Field(
        default=None,
        description="The provider's image for the card. Served from the provider, not the archive -- nothing has been downloaded.",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="What the same cleaning pass the build route runs would flag -- unresolved macros, mostly. Shown so a card's problems are visible before it is kept.",
    )


def _chub_preview(req: DiscoverPreviewIn) -> DiscoverPreviewOut:
    """`build_chub`'s first half, stopping before the write.

    Mirrors `proxy/api/build.py:build_chub` line for line down to `to_payload`;
    the only difference is that `extensions.jai` carries no `linkedAt` -- the
    card has not been acquired, and stamping a time would be a claim about
    something that has not happened.
    """
    node = req.node or {}
    raw_data = chub.build_v2_from_chub(node, req.linked_lorebook)
    cleaned, warnings = chub.clean_card(raw_data, deps.chub_sanitizer)

    card_id = chub.card_id(cleaned) or ""
    cleaned["extensions"] = {
        **(cleaned.get("extensions") or {}),
        "jai": {
            "source_url": chub.source_url(cleaned),
            "id": card_id,
            "sourceKind": "chub_core",
            "creatorName": chub.creator(cleaned),
            "pageName": chub.page_name(cleaned),
        },
    }
    payload = chub.to_payload(cleaned)
    full_path = node.get("fullPath") or ""
    avatar_url = (
        node.get("max_res_url")
        or node.get("avatar_url")
        or (f"{CHUB_AVATAR_BASE}{full_path}/avatar.webp" if full_path else None)
    )
    return _assemble(
        provider="chub",
        payload=payload,
        data=cleaned,
        avatar_url=avatar_url,
        warnings=warnings,
    )


def _datacat_preview(req: DiscoverPreviewIn) -> DiscoverPreviewOut:
    """`build_datacat`'s first half, stopping before the write.

    Goes through `build_card` (CardBuilder) rather than using the mapped dict
    directly, because that is what `/build-datacat` does -- CardBuilder is
    where a datacat card's greetings get assembled and its fields normalised,
    so a preview that skipped it would show a different card than the one that
    lands.
    """
    character = req.character or {}
    v2 = datacat.build_v2_from_character(character)
    if v2 is None:
        raise HTTPException(status_code=422, detail="datacat: no usable character data")

    data = v2["data"]
    profile = datacat.to_profile_fields(data)
    book_dict = data.get("character_book")
    book = CharacterBook.model_validate(book_dict) if book_dict else None

    raw_card_id = character.get("character_id") or character.get("characterId")
    card_id = str(raw_card_id) if raw_card_id else ""

    source_kind = datacat.normalized_source_kind(character)
    if source_kind == "saucepan":
        source_url = f"{SAUCEPAN_ORIGIN}/companion/{card_id}" if card_id else None
    else:
        source_url = f"https://janitorai.com/characters/{card_id}" if card_id else None

    avatar_url = datacat.resolve_avatar_url(character)
    card, warnings = build_card(
        profile=profile,
        greetings=datacat.greetings(data),
        book=book,
        avatar_url=avatar_url,
        character_version=source_url or "jai-proxy",
        extensions={
            "jai": {
                "source_url": source_url,
                "id": card_id,
                "sourceKind": "datacat_core",
                "creatorName": profile.creator,
                "pageName": datacat.page_name(data),
            },
        },
    )
    payload = card.to_dict()
    return _assemble(
        provider="datacat",
        payload=payload,
        data=payload["data"],
        avatar_url=avatar_url,
        warnings=warnings,
    )


def _assemble(
    *,
    provider: str,
    payload: dict[str, Any],
    data: dict[str, Any],
    avatar_url: str | None,
    warnings: list[str],
) -> DiscoverPreviewOut:
    """The counting half, shared by both providers and with the archive itself.

    `summarize_data` is `catalog.summarize`'s content half (`proxy/archive/
    catalog.py`), so a preview's greeting count, lore-entry count and prompt
    weight are produced by the same code that produces them for a card on disk.
    """
    summary = catalog.summarize_data(data, payload)
    return DiscoverPreviewOut(
        provider=provider,
        name=summary["name"],
        creator=summary["creator"],
        page_name=summary["page_name"],
        tags=list(summary["tags"]),
        source_kind=summary["source_kind"],
        source_url=summary["source_url"],
        card_id=summary["card_id"],
        fragment=summary["fragment"],
        character_version=summary["character_version"],
        greetings=summary["greeting_count"],
        lore_entries=summary["lore_entry_count"],
        description_chars=summary["description_chars"],
        prompt_chars=summary["prompt_chars"],
        has_creator_notes=summary["has_creator_notes"],
        has_example_dialogue=summary["has_example_dialogue"],
        create_date=summary["create_date"],
        spec=str(payload.get("spec", "")),
        spec_version=str(payload.get("spec_version", "")),
        card=data,
        avatar_url=avatar_url,
        warnings=warnings,
    )


@router.post(
    "/discover/preview",
    response_model=DiscoverPreviewOut,
    summary="Read a provider card without keeping it",
)
def preview(req: DiscoverPreviewIn) -> DiscoverPreviewOut:
    """Map a captured provider payload into a tavern card and describe it.

    The one door Discover's card view goes through. See the module docstring
    for why this is a server route and not a TypeScript mapper.
    """
    if req.provider == "chub":
        if not req.node:
            raise HTTPException(status_code=422, detail="chub: `node` is required")
        return _chub_preview(req)
    if not req.character:
        raise HTTPException(status_code=422, detail="datacat: `character` is required")
    return _datacat_preview(req)
