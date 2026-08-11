"""`/api/v1` -- browse, download and edit over the card archive.

Every endpoint here is a plain `def`, not `async def`, on purpose: they all touch
the filesystem, and FastAPI runs sync handlers in a threadpool where blocking is
harmless. Declaring them `async` would block the event loop for the duration of a
stat sweep or a 1.2 MB read, which is precisely the workload this API is made of.

This is the archive's own contract, deliberately not SillyTavern's. Teaching it
to answer `/characters/edit-attribute` would relocate the compatibility burden
rather than end it; the translation lives in `web/archive-api.js`, on the client,
in one deletable file.

The write half is Phase 3, and its mechanics live in `proxy/cardwrite.py` -- read
that module's docstring before changing anything here that mutates: a field edit
must never re-encode pixels, every write is atomic, and nothing is ever unlinked.
"""

from __future__ import annotations

import logging
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse

from proxy import archive, cardwrite, gallery, pngtools, settings_store, thumbs
from proxy.api.models import (
    BulkTagsIn,
    BulkTagsOut,
    CardDetailOut,
    CardListOut,
    CardOut,
    CardWriteIn,
    DeletedOut,
    FacetsOut,
    FacetValue,
    GalleryFileOut,
    GalleryFilesOut,
    GalleryFileWrittenOut,
    GalleryFolderOut,
    GalleryOut,
    IndexStatsOut,
    StatsOut,
    ThumbStatsOut,
)
from proxy.config import settings

logger = logging.getLogger("jai_proxy.api")

router = APIRouter(prefix="/api/v1", tags=["archive"])

thumbnail_store = thumbs.ThumbnailStore()

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

# Thumbs are content-addressed by (mtime, size) via their ETag, so a long
# max-age costs nothing: a regenerated thumb changes its ETag and the
# revalidation picks it up.
_THUMB_CACHE_CONTROL = "public, max-age=86400"


def _settings_store() -> settings_store.SettingsStore:
    """Built per call so a test that repoints `settings.settings_file` -- or a
    hand-edit of the file between requests -- is picked up without a restart.
    Construction is just holding a path; there is nothing to cache."""
    return settings_store.SettingsStore(settings.settings_file)


def _index() -> archive.ArchiveIndex:
    """The archive index, brought in step with the directory first.

    Refreshing per request rather than once at startup is what makes a card
    acquired by a userscript -- or dropped in by hand, or renamed by `make
    names` -- appear without restarting the server. It costs one stat per file
    (21 ms across 3,839 cards) and is debounced, so a browse page's worth of
    parallel requests sweeps the directory once between them.
    """
    idx = archive.index()
    idx.refresh()
    return idx


def _require(idx: archive.ArchiveIndex, card_id: str) -> archive.CardSummary:
    record = idx.get(card_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"no card named {card_id!r} in the archive")
    return record


def _card_out(record: archive.CardSummary, *, extensions: bool = False) -> CardOut:
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
        thumb_url=f"{router.prefix}/characters/{quoted}/thumb",
        png_url=f"{router.prefix}/characters/{quoted}/png",
        error=record.error or None,
    )


def _gallery_out(record: archive.CardSummary) -> GalleryOut:
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
    record: archive.CardSummary,
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
    idx = _index()
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


@router.get("/facets", response_model=FacetsOut, summary="Filter values with counts")
def facets(
    limit: int = Query(0, ge=0, description="Cap each facet to its most common N values; 0 for all."),
) -> FacetsOut:
    idx = _index()
    tags: Counter[str] = Counter()
    creators: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    for record in idx.cards():
        tags.update(record.tags)
        if record.creator:
            creators[record.creator] += 1
        if record.source_kind:
            sources[record.source_kind] += 1

    def top(counter: Counter[str]) -> list[FacetValue]:
        # Count first, then name: the useful order for a filter list, and stable
        # because the name breaks the tie.
        items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0].casefold()))
        return [FacetValue(value=v, count=c) for v, c in (items[:limit] if limit else items)]

    return FacetsOut(tags=top(tags), creators=top(creators), sources=top(sources))


@router.get("/stats", response_model=StatsOut, summary="Archive and index health")
def stats() -> StatsOut:
    idx = _index()
    records = idx.all()
    healthy = [r for r in records if r.ok]
    filenames = [r.filename for r in records]
    cached = sum(1 for name in filenames if thumbnail_store.avatar_path(name).is_file())
    galleries = sum(
        1
        for r in healthy
        if r.gallery_id
        and (settings.galleries_dir / gallery.folder_name(r.name, r.gallery_id)).is_dir()
    )
    last = idx.last_stats
    return StatsOut(
        cards=len(healthy),
        unreadable=len(records) - len(healthy),
        bytes=sum(r.size for r in records),
        creators=len({r.creator for r in healthy if r.creator}),
        tags=len({t for r in healthy for t in r.tags}),
        galleries=galleries,
        archive_dir=str(settings.archive_dir),
        thumbs=ThumbStatsOut(
            cached=cached,
            missing=len(filenames) - cached,
            stale=len(thumbnail_store.stale(filenames)),
        ),
        index=IndexStatsOut(
            scanned=last.scanned,
            parsed=last.parsed,
            unchanged=last.unchanged,
            removed=last.removed,
            seconds=round(last.seconds, 4),
        ),
    )


@router.post("/refresh", response_model=IndexStatsOut, summary="Force a rescan")
def refresh() -> IndexStatsOut:
    """Rescan now, ignoring the debounce. Endpoints already refresh on their own;
    this is for a client that has just written to the archive and wants to read
    its own write back immediately."""
    stats_ = archive.index().refresh(force=True)
    return IndexStatsOut(
        scanned=stats_.scanned,
        parsed=stats_.parsed,
        unchanged=stats_.unchanged,
        removed=stats_.removed,
        seconds=round(stats_.seconds, 4),
    )


@router.get("/settings", summary="The browser UI's stored settings")
def get_settings() -> dict:
    """The settings blob, or `{}` if nothing has been stored yet.

    Deliberately untyped: this is an opaque object owned by the frontend. Giving
    it a pydantic model would put the vendored UI's 117-key schema into the
    server's contract, and every UI change would then need a matching change
    here -- the compatibility burden the whole pivot exists to shed.
    """
    try:
        return _settings_store().read()
    except settings_store.SettingsError as exc:
        # 500, not an empty object. Handing back {} would look like a fresh
        # archive, and the frontend would fill in defaults and save them
        # straight over the damaged file, turning a recoverable problem into
        # a lost Chub token.
        logger.error("settings unreadable: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/settings", summary="Replace the browser UI's stored settings")
def put_settings(blob: dict) -> dict:
    """Replace the whole blob and return what was stored.

    Whole-document replace rather than a merge: the frontend already holds the
    complete settings object in memory and treats itself as the owner, and a
    merge endpoint could never express a *deleted* key -- which the frontend's
    own boot migrations rely on being able to do.
    """
    try:
        return _settings_store().write(blob)
    except settings_store.SettingsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Which element a gallery file is for, by extension. Sniffing the bytes would be
# more honest but needs an open per file, and this list exists so a folder of 400
# files can be described in one scandir.
_GALLERY_KINDS: dict[str, str] = {
    **{ext: "image" for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff")},
    **{ext: "video" for ext in (".mp4", ".webm", ".mov", ".m4v", ".mkv")},
    **{ext: "audio" for ext in (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac")},
}
# What `gallery(...)` can actually render. A `.gif` thumbnails to its first frame,
# which is what a grid wants; video and audio get no thumb at all rather than a
# placeholder the client would have to recognise.
_THUMBABLE = frozenset((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"))


def _safe_child(root: Path, *parts: str) -> Path:
    """A path under `root`, or a 400.

    Gallery folder and file names arrive from the client -- they are how the
    frontend addresses images -- so every one of them is a path traversal until
    proven otherwise. Rejecting separators and `..` up front is not enough on its
    own (a symlink inside the galleries directory would still escape), so the
    resolved result is checked against the resolved root as well.
    """
    for part in parts:
        if not part or part in (".", "..") or "/" in part or "\\" in part or "\x00" in part:
            raise HTTPException(status_code=400, detail=f"illegal path component {part!r}")
    candidate = root.joinpath(*parts)
    try:
        resolved = candidate.resolve()
        if not resolved.is_relative_to(root.resolve()):
            raise HTTPException(status_code=400, detail="path escapes the gallery root")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"cannot resolve path: {exc}") from exc
    return candidate


def _gallery_dir(folder: str, *, create: bool = False) -> Path:
    """The directory a client's gallery folder name refers to.

    Validation first (the name is a path traversal until proven otherwise), then
    resolution by gallery id, so a card renamed after its images were downloaded
    still finds them. `create` is for uploads, which are allowed to bring a
    gallery into existence; every other caller wants the miss.
    """
    checked = _safe_child(settings.galleries_dir, folder)
    resolved = gallery.resolve_folder(settings.galleries_dir, folder)
    if resolved is not None:
        return settings.galleries_dir / resolved
    if create:
        checked.mkdir(parents=True, exist_ok=True)
    return checked


@router.get("/galleries", response_model=list[GalleryFolderOut], summary="Gallery folders on disk")
def list_galleries() -> list[GalleryFolderOut]:
    """Every folder in the galleries directory, each paired with the card that
    claims it.

    Claimed by gallery *id*, not by folder name: the name is derived from the
    card's current name and drifts the moment a card is renamed, whereas the id
    is the actual link. So `card_id: null` now means a folder no card carries the
    id for -- genuinely orphaned -- rather than merely misnamed.
    """
    idx = _index()
    claimed = {r.gallery_id: r.filename for r in idx.cards() if r.gallery_id}
    try:
        with os.scandir(settings.galleries_dir) as entries:
            folders = sorted(e.name for e in entries if e.is_dir() and not e.name.startswith("."))
    except OSError:
        return []
    return [GalleryFolderOut(folder=f, card_id=claimed.get(gallery.id_of(f))) for f in folders]


@router.get("/galleries/{folder}", response_model=GalleryFilesOut, summary="Files in one gallery")
def list_gallery_files(folder: str) -> GalleryFilesOut:
    """A gallery folder's contents. 404 when the folder is not there -- unlike
    SillyTavern's `/api/images/list`, which creates the directory as a side
    effect of being asked about it, so the frontend could never tell an empty
    gallery from a missing one."""
    path = _gallery_dir(folder)
    try:
        with os.scandir(path) as entries:
            files = sorted(
                (e for e in entries if e.is_file() and not e.name.startswith(".")),
                key=lambda e: e.name.casefold(),
            )
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"no gallery folder {folder!r}") from exc

    quoted_folder = quote(folder, safe="")
    items: list[GalleryFileOut] = []
    total_bytes = 0
    for entry in files:
        st = entry.stat()
        total_bytes += st.st_size
        suffix = Path(entry.name).suffix.casefold()
        quoted_name = quote(entry.name, safe="")
        base = f"{router.prefix}/galleries/{quoted_folder}/files/{quoted_name}"
        items.append(
            GalleryFileOut(
                name=entry.name,
                kind=_GALLERY_KINDS.get(suffix, "other"),
                size=st.st_size,
                modified=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                url=base,
                thumb_url=f"{base}/thumb" if suffix in _THUMBABLE else None,
            )
        )
    return GalleryFilesOut(folder=folder, total=len(items), bytes=total_bytes, items=items)


@router.get("/galleries/{folder}/files/{filename}", summary="One gallery image")
def get_gallery_file(folder: str, filename: str, request: Request) -> Response:
    path = _safe_child(_gallery_dir(folder), filename)
    return _serve_file(
        path,
        media_type=thumbs.media_type_of(path),
        request=request,
        cache_control=_THUMB_CACHE_CONTROL,
    )


@router.get("/galleries/{folder}/files/{filename}/thumb", summary="Gallery image thumbnail")
def get_gallery_thumb(
    folder: str,
    filename: str,
    request: Request,
    size: int = Query(thumbs.GALLERY_THUMB_SIZE, ge=32, le=1024),
) -> Response:
    """A fitted derivative of one gallery image, generated on a cache miss.

    Unlike the avatar thumb this does *not* fall back to the original on failure:
    a gallery page asks for 100 of these at once, and answering a failure with a
    4 MB source is how one unrenderable file takes the page down with it.
    """
    directory = _gallery_dir(folder)
    source = _safe_child(directory, filename)
    if not source.is_file():
        raise HTTPException(status_code=404, detail=f"no file {filename!r} in gallery {folder!r}")
    # Cached under the folder's name *on disk*, not the one the client asked by,
    # so a renamed card keeps hitting the 3,446 inherited thumb folders instead
    # of re-rendering the lot under a second name.
    thumb = thumbnail_store.gallery(source, directory.name, filename, size)
    if thumb is None:
        raise HTTPException(status_code=415, detail=f"{filename!r} cannot be thumbnailed")
    return _serve_file(
        thumb.path,
        media_type=thumb.media_type,
        request=request,
        cache_control=_THUMB_CACHE_CONTROL,
    )


@router.get("/characters/{card_id}", response_model=CardDetailOut, summary="One card in full")
def get_character(card_id: str) -> CardDetailOut:
    idx = _index()
    record = _require(idx, card_id)
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


def _etag_of(path: Path) -> str:
    """The validator `_serve_file` hands out, recomputed for a write's
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


def _write_error(exc: cardwrite.WriteError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


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
    idx = _index()
    record = _require(idx, card_id)
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
        _, existing = cardwrite.read_card(path)
        cardwrite.patch_card(path, cardwrite.merge_card(existing, incoming))
    except cardwrite.WriteError as exc:
        raise _write_error(exc) from exc

    # The client is about to read its own write, and the index would otherwise
    # sit behind its two-second debounce.
    archive.index().refresh(force=True)
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

    See `proxy.cardwrite` for why: this is the one archive operation with no undo
    and no second copy, and `data/.trash/` costs disk where the alternative costs
    the card. Emptying the bin is a separate, deliberate act.
    """
    idx = _index()
    record = _require(idx, card_id)
    path = idx.root / record.filename

    try:
        binned_gallery = (
            cardwrite.trash_gallery(record.name, record.gallery_id)
            if gallery_action == "delete"
            else None
        )
        binned_card = cardwrite.to_trash(path)
    except cardwrite.WriteError as exc:
        raise _write_error(exc) from exc

    # A freed filename can be taken by a future card, and the avatar cache has no
    # staleness check -- leaving the thumb behind would show the deleted card's
    # face on its replacement.
    thumbnail_store.forget(record.filename)
    if binned_gallery is not None:
        thumbnail_store.forget_gallery(binned_gallery[0])
    archive.index().refresh(force=True)

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
    idx = _index()
    record = _require(idx, card_id)
    path = idx.root / record.filename
    _check_precondition(path, if_match)

    payload = image.file.read()
    if not payload:
        raise HTTPException(status_code=422, detail="the uploaded image is empty")
    try:
        cardwrite.replace_avatar(path, payload)
    except cardwrite.WriteError as exc:
        raise _write_error(exc) from exc

    # Same filename, different pixels: without this the cached thumb is the old
    # face, served indefinitely, since the avatar cache has no staleness check.
    thumbnail_store.forget(record.filename)
    archive.index().refresh(force=True)
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

    idx = _index()
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
            _, data = cardwrite.read_card(path)
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
            cardwrite.patch_card(path, data)
            changed += 1
        except cardwrite.WriteError as exc:
            failed[record.filename] = str(exc)

    if changed:
        archive.index().refresh(force=True)
    return BulkTagsOut(changed=changed, unchanged=unchanged, failed=failed)


@router.post(
    "/galleries/{folder}/files",
    response_model=GalleryFileWrittenOut,
    status_code=201,
    summary="Add a file to a gallery",
)
def upload_gallery_file(
    folder: str,
    file: UploadFile = File(description="The image, video or audio file to store."),
) -> GalleryFileWrittenOut:
    """Store one file in a gallery, creating the folder if it is not there yet.

    Multipart rather than the base64-in-JSON shape SillyTavern used: these are
    multi-megabyte binaries, and base64 inflates them by a third for the whole
    round trip. The adapter converts on the client side, where the frontend's
    encoded copy already exists.
    """
    directory = _gallery_dir(folder, create=True)
    name = Path(file.filename or "").name
    if not name:
        raise HTTPException(status_code=422, detail="the upload has no filename")
    target = _safe_child(directory, name)
    payload = file.file.read()
    if not payload:
        raise HTTPException(status_code=422, detail=f"{name} is empty")

    try:
        cardwrite.write_atomic(target, payload)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"cannot write {name}: {exc}") from exc

    # An overwrite reuses the name, and gallery thumbs are keyed on it.
    thumbnail_store.forget_gallery(directory.name, name)
    quoted_folder = quote(directory.name, safe="")
    quoted_name = quote(name, safe="")
    return GalleryFileWrittenOut(
        folder=directory.name,
        name=name,
        size=len(payload),
        path=f"user/images/{directory.name}/{name}",
        # Must match what `list_gallery_files` builds -- the `/files/` segment is
        # part of the route, and dropping it yields a URL that 404s.
        url=f"{router.prefix}/galleries/{quoted_folder}/files/{quoted_name}",
    )


@router.delete("/galleries/{folder}/files/{filename}", status_code=204, summary="Bin a gallery file")
def delete_gallery_file(folder: str, filename: str) -> Response:
    """Move one gallery file to the bin. Binned rather than unlinked for the same
    reason cards are -- see `proxy.cardwrite`."""
    directory = _gallery_dir(folder)
    path = _safe_child(directory, filename)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no file {filename!r} in gallery {folder!r}")
    try:
        cardwrite.to_trash(path)
    except cardwrite.WriteError as exc:
        raise _write_error(exc) from exc
    thumbnail_store.forget_gallery(directory.name, filename)
    return Response(status_code=204)


@router.get("/characters/{card_id}/png", summary="Download the card PNG")
def get_character_png(card_id: str, request: Request) -> Response:
    """The card file itself, bytes for byte -- the V3 tEXt chunks intact, so what
    comes out of here imports into SillyTavern directly. This is the single-card
    export; no re-encoding happens anywhere in the path, because re-encoding is
    what would strip the card."""
    idx = _index()
    record = _require(idx, card_id)
    return _serve_file(
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
    idx = _index()
    record = _require(idx, card_id)
    thumb = thumbnail_store.avatar(record.filename, size=size)
    if thumb is None:
        logger.info("thumbs: falling back to the full PNG for %s", record.filename)
        return _serve_file(idx.root / record.filename, media_type="image/png", request=request)
    return _serve_file(
        thumb.path,
        # Sniffed from the file's magic number, never its extension: the
        # inherited cache is JPEG data behind a `.png` name. See proxy/thumbs.py.
        media_type=thumb.media_type,
        request=request,
        cache_control=_THUMB_CACHE_CONTROL,
    )


def _serve_file(
    path: Path,
    *,
    media_type: str,
    request: Request,
    download_as: str | None = None,
    cache_control: str | None = None,
) -> Response:
    """Send a file with a conditional-GET short circuit.

    A browse grid asks for hundreds of thumbnails per scroll and re-asks on every
    navigation, so answering the repeats with a 304 and no body is the difference
    between a warm grid costing kilobytes and costing tens of megabytes. The
    validator is (mtime_ns, size) -- the same pair the index invalidates on, so a
    card and its thumb can never disagree about whether they changed.
    """
    try:
        st = path.stat()
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"{path.name} is not on disk") from exc

    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    headers: dict[str, str] = {"ETag": etag}
    if cache_control:
        headers["Cache-Control"] = cache_control
    if download_as:
        # RFC 6266: an ASCII fallback plus a UTF-8 form, because card names are
        # full of curly apostrophes and em dashes that a bare filename= mangles.
        ascii_name = download_as.encode("ascii", "replace").decode("ascii").replace('"', "_")
        headers["Content-Disposition"] = (
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(download_as)}'
        )

    if etag in [t.strip() for t in (request.headers.get("if-none-match") or "").split(",")]:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=media_type, headers=headers)
