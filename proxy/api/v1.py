"""`/api/v1` -- read-only browse and download over the card archive.

Every endpoint here is a plain `def`, not `async def`, on purpose: they all touch
the filesystem, and FastAPI runs sync handlers in a threadpool where blocking is
harmless. Declaring them `async` would block the event loop for the duration of a
stat sweep or a 1.2 MB read, which is precisely the workload this API is made of.

Read-only is the whole of Phase 1. Nothing here mutates a card.
"""

from __future__ import annotations

import logging
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from proxy import archive, gallery, pngtools, thumbs
from proxy.api.models import (
    CardDetailOut,
    CardListOut,
    CardOut,
    FacetsOut,
    FacetValue,
    GalleryFileOut,
    GalleryFilesOut,
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
    belongs on the detail view and not on a list of thousands."""
    folder = gallery.folder_name(record.name, record.gallery_id)
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


@router.get("/galleries", response_model=list[GalleryFolderOut], summary="Gallery folders on disk")
def list_galleries() -> list[GalleryFolderOut]:
    """Every folder in the galleries directory, each paired with the card that
    claims it. A folder with `card_id: null` is orphaned -- the card was renamed
    and nothing computes that folder name any more."""
    idx = _index()
    claimed = {
        gallery.folder_name(r.name, r.gallery_id): r.filename
        for r in idx.cards()
        if r.gallery_id
    }
    try:
        with os.scandir(settings.galleries_dir) as entries:
            folders = sorted(e.name for e in entries if e.is_dir() and not e.name.startswith("."))
    except OSError:
        return []
    return [GalleryFolderOut(folder=f, card_id=claimed.get(f)) for f in folders]


@router.get("/galleries/{folder}", response_model=GalleryFilesOut, summary="Files in one gallery")
def list_gallery_files(folder: str) -> GalleryFilesOut:
    """A gallery folder's contents. 404 when the folder is not there -- unlike
    SillyTavern's `/api/images/list`, which creates the directory as a side
    effect of being asked about it, so the frontend could never tell an empty
    gallery from a missing one."""
    path = _safe_child(settings.galleries_dir, folder)
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
    path = _safe_child(settings.galleries_dir, folder, filename)
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
    source = _safe_child(settings.galleries_dir, folder, filename)
    if not source.is_file():
        raise HTTPException(status_code=404, detail=f"no file {filename!r} in gallery {folder!r}")
    thumb = thumbnail_store.gallery(source, folder, filename, size)
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
