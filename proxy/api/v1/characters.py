"""`/api/v1` character routes: browse the archive, read one card in full, and
the write half -- replace contents, replace the image, retag in bulk, bin a card
-- plus the card's own PNG and thumbnail.

Every write goes through `proxy.cards.edit`; read that module's docstring before
changing anything here that mutates. A field edit must never re-encode pixels,
every write is atomic, and nothing is ever unlinked.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, Response, UploadFile

from proxy.api.schemas import (
    BulkTagsIn,
    BulkTagsOut,
    CardDetailOut,
    CardListOut,
    CardOut,
    CardWriteIn,
    DeletedOut,
    GalleryOut,
)
from proxy.api.v1 import _shared
from proxy.archive import catalog
from proxy.cards import edit, gallery, pngtools
from proxy.config import settings

logger = logging.getLogger("jai_proxy.api")

router = APIRouter()

# What `sort` accepts, mapped to the record attribute it orders by. A whitelist
# rather than a getattr on user input, and small on purpose -- these are the
# orderings a browse grid has a use for.
_SORTS: dict[str, str] = {
    "name": "name",
    "creator": "creator",
    "modified": "mtime",
    # When the card arrived, not when its file was last touched. The better
    # default for "recently added" -- see CardOut.linked_at.
    "added": "linked_at",
    "size": "size",
    "greetings": "greeting_count",
    "lore": "lore_entry_count",
    "description": "description_chars",
    "prompt": "prompt_chars",
}

def _card_out(record: catalog.CardSummary, *, extensions: bool = False) -> CardOut:
    quoted = quote(record.filename, safe="")
    return CardOut(
        extensions=record.extensions if extensions else None,
        id=record.filename,
        name=record.name,
        creator=record.creator,
        page_name=record.page_name,
        tags=list(record.tags),
        source_kind=record.source_kind,
        source_url=record.source_url,
        card_id=record.card_id,
        fragment=record.fragment,
        gallery_id=record.gallery_id,
        character_version=record.character_version,
        greetings=record.greeting_count,
        lore_entries=record.lore_entry_count,
        description_chars=record.description_chars,
        prompt_chars=record.prompt_chars,
        has_creator_notes=record.has_creator_notes,
        has_example_dialogue=record.has_example_dialogue,
        size=record.size,
        modified=datetime.fromtimestamp(record.mtime, tz=timezone.utc),
        linked_at=record.linked_at,
        thumb_url=f"{_shared.PREFIX}/characters/{quoted}/thumb",
        png_url=f"{_shared.PREFIX}/characters/{quoted}/png",
        error=record.error or None,
    )


def _gallery_out(record: catalog.CardSummary) -> GalleryOut:
    """A card's gallery, measured on disk. One `scandir` of one directory, so it
    belongs on the detail view and not on a list of thousands.

    `folder` reports the directory that actually holds the images, which after a
    rename is not the name the card's own fields would compute -- see
    `gallery.resolve_folder`."""
    wanted = gallery.folder_name(record.name, record.gallery_id)
    folder = gallery.resolve_folder(settings.galleries_dir, wanted) or wanted
    out = GalleryOut(
        gallery_id=record.gallery_id, folder=folder, exists=False, images=0, bytes=0
    )
    if not folder:
        return out
    path = settings.galleries_dir / folder
    try:
        with os.scandir(path) as entries:
            files = [e for e in entries if e.is_file() and not e.name.startswith(".")]
    except (OSError, ValueError):
        return out
    out.exists = True
    out.images = len(files)
    out.bytes = sum(e.stat().st_size for e in files)
    return out


def _matches(
    record: catalog.CardSummary,
    *,
    terms: list[str],
    tags: list[str],
    creator: str | None,
    source: str | None,
    has_lorebook: bool | None,
    has_gallery: bool | None,
) -> bool:
    # AND across search terms so a second word narrows rather than widens --
    # "korny abbie" should find the one card, not every card by either.
    if any(term not in record.haystack for term in terms):
        return False
    if tags:
        present = {t.casefold() for t in record.tags}
        if not all(t in present for t in tags):
            return False
    if creator is not None and record.creator.casefold() != creator:
        return False
    if source is not None and record.source_kind.casefold() != source:
        return False
    if has_lorebook is not None and bool(record.lore_entry_count) != has_lorebook:
        return False
    if has_gallery is not None and bool(record.gallery_id) != has_gallery:
        return False
    return True


def _etag_of(path: Path) -> str:
    """The validator `_shared.serve_file` hands out, recomputed for a write's
    precondition check. Same (mtime_ns, size) pair the index invalidates on, so
    a client that has read a card can prove it is writing over what it read."""
    st = path.stat()
    return f'"{st.st_mtime_ns:x}-{st.st_size:x}"'


def _check_precondition(path: Path, if_match: str | None) -> None:
    """Enforce `If-Match` when the client sent one.

    Optional, and worth having even so. Two tabs open on the same card is the
    ordinary case here, and the loser of that race silently reverts the winner's
    edit -- with a whole-document replace there is no partial overlap to soften
    it. A client that sends the ETag it read gets told (412) instead.
    """
    if not if_match or if_match == "*":
        return
    current = _etag_of(path)
    if current not in [t.strip() for t in if_match.split(",")]:
        raise HTTPException(
            status_code=412,
            detail="the card changed since you read it; reload before saving over it",
        )


@router.get("/characters", response_model=CardListOut, summary="List and filter cards")
def list_characters(
    q: str | None = Query(
        None,
        description="Free text over name, creator, page title, filename and tags. Space-separated terms are ANDed. Prose is not searched.",
    ),
    tag: list[str] = Query(default=[], description="Repeatable; a card must carry every tag given."),
    creator: str | None = Query(None, description="Exact creator match, case-insensitive."),
    source: str | None = Query(None, description="Exact `source_kind` match, e.g. `chub_import`."),
    has_lorebook: bool | None = Query(None),
    has_gallery: bool | None = Query(None, description="Whether the card carries a gallery_id at all."),
    health: Literal["ok", "broken", "all"] = Query(
        "ok",
        description="`ok` lists parseable cards (the default), `broken` the ones that fail to parse, `all` both.",
    ),
    sort: str = Query(
        "name",
        description="One of name, creator, added, modified, size, greetings, lore, description, prompt. Prefix with `-` to reverse.",
    ),
    limit: int = Query(60, ge=0, le=5000, description="0 means no limit -- the whole filtered set."),
    offset: int = Query(0, ge=0),
    include: list[Literal["extensions"]] = Query(
        default=[],
        description="Optional heavier fields. `extensions` attaches each card's `data.extensions` -- provider links, gallery_id, version uids -- at roughly 790 bytes a card.",
    ),
) -> CardListOut:
    idx = _shared.index()
    if health == "ok":
        records = idx.cards()
    elif health == "broken":
        records = idx.broken()
    else:
        records = idx.all()

    terms = [t for t in (q or "").casefold().split() if t]
    wanted_tags = [t.casefold() for t in tag if t.strip()]
    matched = [
        r
        for r in records
        if _matches(
            r,
            terms=terms,
            tags=wanted_tags,
            creator=creator.casefold() if creator else None,
            source=source.casefold() if source else None,
            has_lorebook=has_lorebook,
            has_gallery=has_gallery,
        )
    ]

    descending = sort.startswith("-")
    key_name = _SORTS.get(sort.lstrip("-"))
    if key_name is None:
        raise HTTPException(
            status_code=422,
            detail=f"unknown sort {sort!r}; expected one of {', '.join(sorted(_SORTS))} optionally prefixed with '-'",
        )
    if key_name in ("name", "creator"):
        # Case-insensitive, and tie-broken on the filename so the order is total:
        # 3,839 cards include plenty of shared names, and a browse grid that
        # reshuffles equal rows between requests breaks pagination.
        matched.sort(key=lambda r: (getattr(r, key_name).casefold(), r.filename), reverse=descending)
    else:
        matched.sort(key=lambda r: (getattr(r, key_name), r.filename.casefold()), reverse=descending)

    window = matched[offset:] if limit == 0 else matched[offset : offset + limit]
    want_extensions = "extensions" in include
    return CardListOut(
        total=len(matched),
        limit=limit,
        offset=offset,
        items=[_card_out(r, extensions=want_extensions) for r in window],
    )


@router.get("/characters/{card_id}", response_model=CardDetailOut, summary="One card in full")
def get_character(card_id: str) -> CardDetailOut:
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    # The index already diagnosed this card on the scan that found it, and its
    # reason is more specific than anything recoverable here (a file that is not a
    # PNG, versus a PNG that was never a card, versus a corrupt payload). Report
    # that one rather than a second, vaguer opinion.
    if not record.ok:
        raise HTTPException(status_code=422, detail=record.error)
    path = idx.root / record.filename
    try:
        envelope = pngtools.read_envelope(path.read_bytes())
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"cannot read card: {exc}") from exc
    if envelope is None:
        # Only reachable when the card changed between the scan and this read.
        raise HTTPException(status_code=422, detail="file carries no character card")
    outer, data = envelope
    return CardDetailOut(
        **_card_out(record).model_dump(),
        spec=str(outer.get("spec", "")),
        spec_version=str(outer.get("spec_version", "")),
        card=data,
        gallery=_gallery_out(record),
    )


@router.put("/characters/{card_id}", response_model=CardDetailOut, summary="Replace a card's contents")
def put_character(
    card_id: str,
    body: CardWriteIn,
    if_match: str | None = Header(None, alias="If-Match"),
) -> CardDetailOut:
    """Rewrite the card embedded in this PNG, leaving its pixels untouched.

    The card is re-embedded through `pngtools.embed_card`, which rewrites only
    the tEXt chunks -- so a pngquant-compressed avatar survives an edit byte for
    byte, and a card edited here is shaped exactly like a freshly built one.

    The filename does not change when the name does. It is `<slug(name)>_<id8>`,
    a derived label rather than the name itself, and it is what the frontend,
    the DOM, the thumbnail cache and every URL key on; moving it mid-edit would
    404 the card the user is looking at. It already diverges for every card with
    punctuation in its name, and the id8 fragment -- which is the archive's
    dedupe key, on its own, never the name -- is unaffected either way.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    path = idx.root / record.filename
    _check_precondition(path, if_match)

    incoming = body.card
    name = incoming.get("name")
    if not isinstance(name, str) or not name.strip():
        # The name is the one field with no sane default: it is what the card is
        # called everywhere, and an empty one turns a card into an unfindable
        # blank in the grid.
        raise HTTPException(status_code=422, detail="the card must have a non-empty `name`")

    try:
        _, existing = edit.read_card(path)
        edit.patch_card(path, edit.merge_card(existing, incoming))
    except edit.WriteError as exc:
        raise _shared.write_error(exc) from exc

    # The client is about to read its own write, and the index would otherwise
    # sit behind its two-second debounce.
    catalog.index().refresh(force=True)
    return get_character(record.filename)


@router.delete("/characters/{card_id}", response_model=DeletedOut, summary="Bin a card")
def delete_character(
    card_id: str,
    gallery_action: Literal["keep", "delete"] = Query(
        "keep",
        alias="gallery",
        description="`delete` bins the card's gallery folder along with it. Default keeps it -- images are often the expensive half and are not always re-downloadable.",
    ),
) -> DeletedOut:
    """Move a card into the bin. Nothing here unlinks anything.

    See `proxy.cards.edit` for why: this is the one archive operation with no undo
    and no second copy, and `data/.trash/` costs disk where the alternative costs
    the card. Emptying the bin is a separate, deliberate act.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    path = idx.root / record.filename

    try:
        binned_gallery = (
            edit.trash_gallery(record.name, record.gallery_id)
            if gallery_action == "delete"
            else None
        )
        binned_card = edit.to_trash(path)
    except edit.WriteError as exc:
        raise _shared.write_error(exc) from exc

    # A freed filename can be taken by a future card, and the avatar cache has no
    # staleness check -- leaving the thumb behind would show the deleted card's
    # face on its replacement.
    _shared.thumbnail_store.forget(record.filename)
    if binned_gallery is not None:
        _shared.thumbnail_store.forget_gallery(binned_gallery[0])
    catalog.index().refresh(force=True)

    return DeletedOut(
        id=record.filename,
        card=str(binned_card),
        gallery=str(binned_gallery[1]) if binned_gallery else None,
    )


@router.put("/characters/{card_id}/avatar", response_model=CardDetailOut, summary="Replace a card's image")
def put_character_avatar(
    card_id: str,
    image: UploadFile = File(description="The new image. Anything Pillow opens -- png, jpeg, webp."),
    if_match: str | None = Header(None, alias="If-Match"),
) -> CardDetailOut:
    """Give a card new pixels, keeping every field of the embedded card.

    The only write that re-encodes, and it runs intake's pipeline -- normalize,
    crop a detected panel stack, cap the longest side, quantize -- so a card
    whose image was replaced is indistinguishable from one that arrived that way.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    path = idx.root / record.filename
    _check_precondition(path, if_match)

    payload = image.file.read()
    if not payload:
        raise HTTPException(status_code=422, detail="the uploaded image is empty")
    try:
        edit.replace_avatar(path, payload)
    except edit.WriteError as exc:
        raise _shared.write_error(exc) from exc

    # Same filename, different pixels: without this the cached thumb is the old
    # face, served indefinitely, since the avatar cache has no staleness check.
    _shared.thumbnail_store.forget(record.filename)
    catalog.index().refresh(force=True)
    return get_character(record.filename)


@router.post("/characters/tags", response_model=BulkTagsOut, summary="Add and remove tags across many cards")
def bulk_tags(body: BulkTagsIn) -> BulkTagsOut:
    """Apply one tag change to a selection, in a single pass.

    Removals are matched case-insensitively and additions preserve the case they
    arrive in, which is how the archive's tags actually behave -- `Female` and
    `female` are the same tag written twice, and a bulk cleanup exists largely to
    collapse pairs like that.

    Partial success is reported, not rolled back. There is no transaction across
    3,000 PNG rewrites, and pretending otherwise by unwinding the ones that
    worked would turn one unreadable card into a no-op for the other 2,999.
    """
    if not body.add and not body.remove:
        raise HTTPException(status_code=422, detail="give at least one tag to add or remove")

    idx = _shared.index()
    drop = {t.casefold() for t in body.remove if t.strip()}
    add = [t.strip() for t in body.add if t.strip()]

    changed = unchanged = 0
    failed: dict[str, str] = {}
    for card_id in body.ids:
        record = idx.get(card_id)
        if record is None:
            failed[card_id] = "no such card in the archive"
            continue
        path = idx.root / record.filename
        try:
            _, data = edit.read_card(path)
            current = [t for t in data.get("tags", []) if isinstance(t, str)]
            kept = [t for t in current if t.casefold() not in drop]
            present = {t.casefold() for t in kept}
            for tag in add:
                if tag.casefold() not in present:
                    kept.append(tag)
                    present.add(tag.casefold())
            if kept == current:
                unchanged += 1
                continue
            data["tags"] = kept
            edit.patch_card(path, data)
            changed += 1
        except edit.WriteError as exc:
            failed[record.filename] = str(exc)

    if changed:
        catalog.index().refresh(force=True)
    return BulkTagsOut(changed=changed, unchanged=unchanged, failed=failed)


@router.get("/characters/{card_id}/png", summary="Download the card PNG")
def get_character_png(card_id: str, request: Request) -> Response:
    """The card file itself, bytes for byte -- the V3 tEXt chunks intact, so what
    comes out of here imports into SillyTavern directly. This is the single-card
    export; no re-encoding happens anywhere in the path, because re-encoding is
    what would strip the card."""
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    return _shared.serve_file(
        idx.root / record.filename,
        media_type="image/png",
        request=request,
        download_as=record.filename,
    )


@router.get("/characters/{card_id}/thumb", summary="Card thumbnail")
def get_character_thumb(
    card_id: str,
    request: Request,
    size: int | None = Query(
        None,
        ge=48,
        le=1024,
        description="Thumbnail height in pixels; the 2:3 grid aspect is fixed. Omit for the inherited 96x144 cache, which covers the whole archive already and costs nothing to serve.",
    ),
) -> Response:
    """A ~10 KB derivative of the card, generated on a cache miss.

    Falls back to the full PNG when a thumb cannot be made -- a card too broken
    to render still has to appear in the grid, since being visible is how it gets
    noticed and fixed.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    thumb = _shared.thumbnail_store.avatar(record.filename, size=size)
    if thumb is None:
        logger.info("thumbs: falling back to the full PNG for %s", record.filename)
        return _shared.serve_file(idx.root / record.filename, media_type="image/png", request=request)
    return _shared.serve_file(
        thumb.path,
        # Sniffed from the file's magic number, never its extension: the
        # inherited cache is JPEG data behind a `.png` name. See proxy/archive/thumbs.py.
        media_type=thumb.media_type,
        request=request,
        cache_control=_shared.THUMB_CACHE_CONTROL,
    )


