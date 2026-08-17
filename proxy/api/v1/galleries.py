"""`/api/v1` gallery routes: the image folders that hang off a card.

A gallery folder is named `<Name>_<gallery_id>` and is resolved by its id
suffix, never by the name -- a card rename moves nothing on disk. See
`proxy.cards.gallery`.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile

from proxy.api.schemas import (
    GalleryFileOut,
    GalleryFilesOut,
    GalleryFileWrittenOut,
    GalleryFolderOut,
    ThumbsPrunedOut,
)
from proxy.api.v1 import _shared
from proxy.archive import thumbs
from proxy.cards import edit, gallery
from proxy.config import settings

router = APIRouter()

# Which element a gallery file is for, by extension. Sniffing the bytes would be
# more honest but needs an open per file, and this list exists so a folder of 400
# files can be described in one scandir.
_GALLERY_KINDS: dict[str, str] = {
    **{ext: "image" for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff")},
    **{ext: "video" for ext in (".mp4", ".webm", ".mov", ".m4v", ".mkv")},
    **{ext: "audio" for ext in (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac")},
}
# What `gallery(...)` can actually render -- see proxy/archive/thumbs.py.
_THUMBABLE = thumbs.THUMBABLE_EXTS


@router.get("/galleries", response_model=list[GalleryFolderOut], summary="Gallery folders on disk")
def list_galleries() -> list[GalleryFolderOut]:
    """Every folder in the galleries directory, each paired with the card that
    claims it.

    Claimed by gallery *id*, not by folder name: the name is derived from the
    card's current name and drifts the moment a card is renamed, whereas the id
    is the actual link. So `card_id: null` now means a folder no card carries the
    id for -- genuinely orphaned -- rather than merely misnamed.
    """
    idx = _shared.index()
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
    path = _shared.gallery_dir(folder)
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
        base = f"{_shared.PREFIX}/galleries/{quoted_folder}/files/{quoted_name}"
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
    path = _shared.safe_child(_shared.gallery_dir(folder), filename)
    return _shared.serve_file(
        path,
        media_type=thumbs.media_type_of(path),
        request=request,
        cache_control=_shared.THUMB_CACHE_CONTROL,
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
    directory = _shared.gallery_dir(folder)
    source = _shared.safe_child(directory, filename)
    if not source.is_file():
        raise HTTPException(status_code=404, detail=f"no file {filename!r} in gallery {folder!r}")
    # Cached under the folder's name *on disk*, not the one the client asked by,
    # so a renamed card keeps hitting the 3,446 inherited thumb folders instead
    # of re-rendering the lot under a second name.
    thumb = _shared.thumbnail_store.gallery(source, directory.name, filename, size)
    if thumb is None:
        raise HTTPException(status_code=415, detail=f"{filename!r} cannot be thumbnailed")
    return _shared.serve_file(
        thumb.path,
        media_type=thumb.media_type,
        request=request,
        cache_control=_shared.THUMB_CACHE_CONTROL,
    )


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
    directory = _shared.gallery_dir(folder, create=True)
    name = Path(file.filename or "").name
    if not name:
        raise HTTPException(status_code=422, detail="the upload has no filename")
    target = _shared.safe_child(directory, name)
    payload = file.file.read()
    if not payload:
        raise HTTPException(status_code=422, detail=f"{name} is empty")

    try:
        edit.write_atomic(target, payload)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"cannot write {name}: {exc}") from exc

    # An overwrite reuses the name, and gallery thumbs are keyed on it.
    _shared.thumbnail_store.forget_gallery(directory.name, name)
    quoted_folder = quote(directory.name, safe="")
    quoted_name = quote(name, safe="")
    return GalleryFileWrittenOut(
        folder=directory.name,
        name=name,
        size=len(payload),
        path=f"user/images/{directory.name}/{name}",
        # Must match what `list_gallery_files` builds -- the `/files/` segment is
        # part of the route, and dropping it yields a URL that 404s.
        url=f"{_shared.PREFIX}/galleries/{quoted_folder}/files/{quoted_name}",
    )


@router.delete("/galleries/{folder}/files/{filename}", status_code=204, summary="Bin a gallery file")
def delete_gallery_file(folder: str, filename: str) -> Response:
    """Move one gallery file to the bin. Binned rather than unlinked for the same
    reason cards are -- see `proxy.cards.edit`."""
    directory = _shared.gallery_dir(folder)
    path = _shared.safe_child(directory, filename)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no file {filename!r} in gallery {folder!r}")
    try:
        edit.to_trash(path)
    except edit.WriteError as exc:
        raise _shared.write_error(exc) from exc
    _shared.thumbnail_store.forget_gallery(directory.name, filename)
    return Response(status_code=204)


@router.post(
    "/galleries/{folder}/thumbs/prune", response_model=ThumbsPrunedOut, summary="Drop orphaned gallery thumbs"
)
def prune_gallery_thumbs(folder: str) -> ThumbsPrunedOut:
    """docs/PHASE_3C_PLAN.md §5 -- thumbs are generated at write time now, so
    the only orphans left are ones whose source file left by a route other
    than `DELETE .../files/{filename}` (which already forgets its own
    thumb)."""
    directory = _shared.gallery_dir(folder)
    live = {entry.name for entry in os.scandir(directory) if entry.is_file()} if directory.is_dir() else set()
    removed = _shared.thumbnail_store.prune_gallery(directory.name, live)
    return ThumbsPrunedOut(folder=directory.name, removed=removed)


