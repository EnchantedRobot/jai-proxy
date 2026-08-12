"""Thumbnails for the browse grid.

The archive averages 800 KB a card, so a 40-card viewport is 32 MB of PNG. The
grid cannot serve originals; it needs a small derivative of every card. What it
does *not* need is a thumbnailer built from scratch, because two populated caches
came across at cutover and cover 99.6% of the archive between them:

    data/cache/thumbs/avatar/    <- SillyTavern's thumbnails/avatar
                                    4,663 files, 10.3 KB average, keyed by the
                                    *exact* card filename. 3,823 of 3,839 cards
                                    already have one; 16 need generating, and
                                    840 belong to cards that no longer exist.
    data/cache/thumbs/gallery/   <- CharacterLibrary's user/cl_thumbs
                                    3,446 folders on the <Name>_<gallery_id>
                                    convention.

So the job is inherit, generate on miss, prune the orphans -- and one trap.

**Every inherited avatar thumb is JPEG data behind a `.png` extension.** All
4,663 of them: 96x144, progressive JPEG, named `<card>.png` because SillyTavern
names the thumb after the card and never revisits the extension. Deriving a
`Content-Type` from the extension therefore serves `image/png` for JPEG bytes on
99.6% of the archive. Browsers sniff and cope, but caches and any non-browser
client are entitled not to, so the media type here is always read from the file's
magic number and never from its name.

Thumbs generated on a miss keep both halves of that convention -- the card's
filename and JPEG bytes -- rather than "fixing" the extension. A cache where one
file in 240 is addressed differently from the rest is a worse bug than an
inaccurate extension that is never trusted anyway, and the sniff makes the
inaccuracy harmless. The cache stays drop-in compatible with SillyTavern's in
both directions.

The whole directory is a cache: deleting it costs one regeneration pass, never
data.
"""

from __future__ import annotations

import glob
import io
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from proxy.cards import pngtools
from proxy.config import settings

logger = logging.getLogger("jai_proxy.archive.thumbs")

# SillyTavern's avatar thumbnail geometry, matched deliberately. The inherited
# cache is 3,823 files at 96x144 and a generated thumb has to sit beside them
# without the grid showing two sizes -- so this is fixed by the inheritance, not
# chosen. Raising it means regenerating the whole cache and throwing away the
# 99.6% head start, which is a separate decision from getting the grid working.
THUMB_SIZE = (96, 144)
# CharacterLibrary's gallery-thumb edge, likewise fixed by the 3,446 inherited
# folders rather than chosen: their files are named `<image>_384.jpg`.
GALLERY_THUMB_SIZE = 384
# What `gallery(...)` can actually render. A `.gif` thumbnails to its first frame,
# which is what a grid wants; video and audio get no thumb at all rather than a
# placeholder the client would have to recognise. Shared between the API (which
# extension gets a `thumb_url`) and `scripts/sync_thumbs.py --galleries` (which
# extension gets pre-rendered).
THUMBABLE_EXTS = frozenset((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"))
_JPEG_QUALITY = 90

_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)
_FALLBACK_MEDIA_TYPE = "application/octet-stream"


@dataclass(frozen=True, slots=True)
class ThumbFile:
    """A thumbnail on disk, with the media type its *bytes* say it is."""

    path: Path
    media_type: str


def sniff_media_type(header: bytes) -> str:
    """The media type of an image from its leading bytes. WebP needs both ends of
    its 12-byte RIFF header checked, hence the special case; everything else is a
    plain prefix. Unrecognized bytes get the generic type rather than a guess --
    an unknown thumb is a bug to notice, not to paper over with `image/png`."""
    for magic, media_type in _MAGIC:
        if header.startswith(magic):
            return media_type
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return _FALLBACK_MEDIA_TYPE


def media_type_of(path: Path) -> str:
    """Sniff a thumb file's media type. Never trusts the extension -- see the
    module docstring: the inherited avatar cache is JPEG named `.png`."""
    try:
        with path.open("rb") as fh:
            return sniff_media_type(fh.read(12))
    except OSError:
        return _FALLBACK_MEDIA_TYPE


class ThumbnailStore:
    """The thumbnail cache: look up, generate on miss, prune orphans."""

    def __init__(self, root: Path | None = None, archive_dir: Path | None = None) -> None:
        self.root = root or settings.thumbs_dir
        self.archive_dir = archive_dir or settings.archive_dir

    @property
    def avatar_dir(self) -> Path:
        return self.root / "avatar"

    @property
    def gallery_dir(self) -> Path:
        return self.root / "gallery"

    def avatar_path(self, filename: str, size: int | None = None) -> Path:
        """Where a card's avatar thumb lives. Keyed by the exact card filename,
        extension included, which is SillyTavern's convention and what makes the
        inherited cache usable without a rename pass.

        `size` is the *height* of a larger derivative, and lands in its own
        sibling directory rather than beside the inherited files. The inherited
        cache is 3,839 files at one fixed geometry and it is worth keeping
        exactly as it is: mixing sizes into it would mean either a rename pass
        over the lot or a directory where the size of a file is unknowable from
        its name. `size=None` -- the default -- is that inherited cache.
        """
        if size is None:
            return self.avatar_dir / filename
        return self.root / f"avatar_{size}" / filename

    def gallery_path(self, folder: str, filename: str, size: int = GALLERY_THUMB_SIZE) -> Path:
        """Where a gallery image's thumb lives: `<folder>/<file>_<size>.jpg`.

        CharacterLibrary's `cl_thumbs` convention, kept verbatim -- the size is
        in the *name* rather than a subdirectory, so one folder holds every size
        ever requested for its images. 3,446 folders came across on this scheme
        and renaming them would throw away 780 MB of already-rendered thumbs.
        """
        return self.gallery_dir / folder / f"{filename}_{size}.jpg"

    def gallery(
        self, source: Path, folder: str, filename: str, size: int = GALLERY_THUMB_SIZE
    ) -> ThumbFile | None:
        """A gallery image's thumbnail, generating it if the cache misses.

        `source` is passed in rather than derived because the galleries live
        outside this store's roots -- the store owns the cache, not the images.
        """
        path = self.gallery_path(folder, filename, size)
        if path.is_file():
            return ThumbFile(path, media_type_of(path))
        return self.generate_gallery(source, folder, filename, size)

    def generate_gallery(
        self, source: Path, folder: str, filename: str, size: int = GALLERY_THUMB_SIZE
    ) -> ThumbFile | None:
        """Render one gallery image's thumb and cache it. Returns None for
        anything Pillow cannot open -- a gallery holds video and audio too, and
        those are the caller's problem to present, not this one's to guess at."""
        try:
            data = _render_thumb(source.read_bytes(), size=(size, size), cover=False)
        except (OSError, ValueError, TypeError, Image.DecompressionBombError) as exc:
            logger.info("thumbs: cannot render gallery image %s/%s: %s", folder, filename, exc)
            return None
        path = self.gallery_path(folder, filename, size)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".part")
        temporary.write_bytes(data)
        temporary.replace(path)
        return ThumbFile(path, sniff_media_type(data))

    def avatar(
        self, filename: str, *, size: int | None = None, generate: bool = True
    ) -> ThumbFile | None:
        """A card's avatar thumbnail, generating it if the cache misses.

        Returns None only when the thumb is absent *and* cannot be made -- an
        unparseable card, an unreadable file. Callers fall back to serving the
        full PNG, which is correct but heavy, so a None is worth logging."""
        path = self.avatar_path(filename, size)
        if path.is_file():
            return ThumbFile(path, media_type_of(path))
        if not generate:
            return None
        return self.generate_avatar(filename, size)

    def generate_avatar(self, filename: str, size: int | None = None) -> ThumbFile | None:
        """Render one card's avatar thumb and cache it. Overwrites any existing
        thumb, so this doubles as the repair path for a stale or corrupt one."""
        source = self.archive_dir / filename
        try:
            data = _render_thumb(source.read_bytes(), size=_avatar_box(size))
        except (OSError, ValueError, TypeError, Image.DecompressionBombError) as exc:
            logger.warning("thumbs: cannot render %s: %s", filename, exc)
            return None
        path = self.avatar_path(filename, size)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a browse grid requests dozens of thumbs at once and a
        # reader must never see a half-written file.
        temporary = path.with_name(path.name + ".part")
        temporary.write_bytes(data)
        temporary.replace(path)
        return ThumbFile(path, sniff_media_type(data))

    # --- maintenance ---------------------------------------------------------

    def forget(self, filename: str) -> int:
        """Drop every cached avatar thumb for a card, at every size. Returns how
        many files went.

        Not housekeeping -- correctness. The avatar cache is keyed on the card
        filename and has no staleness check against the card's mtime, because a
        card's pixels never used to change. They do now: replacing an avatar
        rewrites the same filename with different pixels, and deleting a card
        frees its filename for a future card to reuse. Either way a thumb left
        behind is served in place of the real image indefinitely.
        """
        removed = 0
        for directory in sorted(self.root.glob("avatar*")):
            if not directory.is_dir():
                continue
            candidate = directory / filename
            try:
                candidate.unlink()
                removed += 1
            except OSError:
                continue
        return removed

    def forget_gallery(self, folder: str, filename: str | None = None) -> int:
        """Drop cached gallery thumbs -- one image's, at every size, or the whole
        folder's when `filename` is None."""
        directory = self.gallery_dir / folder
        if not directory.is_dir():
            return 0
        if filename is None:
            shutil.rmtree(directory, ignore_errors=True)
            return 1
        removed = 0
        # `<image>_<size>.jpg`, so one image has as many thumbs as sizes asked for.
        for candidate in directory.glob(f"{glob.escape(filename)}_*.jpg"):
            try:
                candidate.unlink()
                removed += 1
            except OSError:
                continue
        return removed

    def prune_gallery(self, folder: str, live_filenames: set[str]) -> int:
        """Delete cached gallery thumbs whose source image is no longer in the
        gallery folder -- docs/PHASE_3C_PLAN.md §5. `live_filenames` is the
        caller's own scandir of the gallery, so this only ever reads the
        thumb cache."""
        directory = self.gallery_dir / folder
        if not directory.is_dir():
            return 0
        removed = 0
        for candidate in directory.iterdir():
            if not candidate.is_file():
                continue
            source = _gallery_thumb_source_name(candidate.name)
            if source is None or source in live_filenames:
                continue
            try:
                candidate.unlink()
                removed += 1
            except OSError:
                continue
        return removed

    def missing(self, filenames: list[str]) -> list[str]:
        """Which of these cards have no avatar thumb yet."""
        return [name for name in filenames if not self.avatar_path(name).is_file()]

    def stale(self, filenames: list[str]) -> list[Path]:
        """Avatar thumbs whose card is gone -- renamed or deleted. 840 of these
        came across at cutover, the residue of every `make names` rename and
        every card removed from the archive over its life."""
        known = set(filenames)
        try:
            entries = sorted(self.avatar_dir.iterdir())
        except OSError:
            return []
        return [p for p in entries if p.is_file() and p.name not in known]


_GALLERY_THUMB_RE = re.compile(r"^(?P<name>.+)_(?P<size>\d+)\.jpg$")


def _gallery_thumb_source_name(thumb_filename: str) -> str | None:
    """The source image a gallery thumb file name (`<image>_<size>.jpg`) was
    rendered from, or None for anything that isn't one of ours."""
    match = _GALLERY_THUMB_RE.match(thumb_filename)
    return match.group("name") if match else None


def _avatar_box(size: int | None) -> tuple[int, int]:
    """The crop box for an avatar thumb of the given height.

    Fixed at THUMB_SIZE's 2:3 aspect whatever the height, because the grid tile
    is 2:3 and a thumb that does not match it either letterboxes or gets
    stretched by the browser. So one number is enough to ask for a bigger one.
    """
    if size is None:
        return THUMB_SIZE
    width, height = THUMB_SIZE
    return (max(1, round(size * width / height)), size)


def _render_thumb(
    source: bytes, *, size: tuple[int, int] = THUMB_SIZE, cover: bool = True
) -> bytes:
    """An image's pixels as a small JPEG.

    Two callers, two geometries. A *card* avatar is cover-cropped to a fixed 2:3
    tile (`cover=True`): the grid is uniform, the source is already a portrait,
    and scaling to fill then trimming the overflow loses less of the subject than
    padding would. A *gallery* image is fitted inside a square instead
    (`cover=False`) -- galleries hold every aspect ratio there is, and cropping a
    wide illustration to a square is destroying the picture to make a tile.

    Either way this matches what the inherited caches already contain, so a
    generated thumb is indistinguishable from an inherited one beside it.

    For a card the text chunks are irrelevant here -- only the pixels matter --
    but they are why the source is large, and why `Image.open` on a 1.2 MB card
    is still the cheap part next to the resize.
    """
    image = Image.open(io.BytesIO(source))
    image.load()
    # JPEG has no alpha. Flatten onto white rather than dropping the channel, so a
    # transparent-background avatar comes out white-backed instead of black.
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        flattened = Image.new("RGB", image.size, (255, 255, 255))
        flattened.paste(image, mask=image.split()[-1])
        image = flattened
    else:
        image = image.convert("RGB")

    target_w, target_h = size
    src_w, src_h = image.size
    # Cover fills the box and overflows; contain fits inside it. `min` also means
    # a gallery image smaller than the box is left alone rather than upscaled
    # into a blur.
    scale = max(target_w / src_w, target_h / src_h) if cover else min(1.0, min(target_w / src_w, target_h / src_h))
    resized = image.resize(
        (max(1, round(src_w * scale)), max(1, round(src_h * scale))),
        Image.LANCZOS,
    )
    if cover:
        left = (resized.width - target_w) // 2
        # Bias the vertical crop upward: on a portrait avatar the face is above
        # centre, and a centred crop of a tall image is the classic way to serve
        # a grid full of torsos.
        top = (resized.height - target_h) // 3
        resized = resized.crop((left, top, left + target_w, top + target_h))

    buffer = io.BytesIO()
    resized.save(buffer, "JPEG", quality=_JPEG_QUALITY, optimize=True, progressive=True)
    return buffer.getvalue()


def has_embedded_card(png: bytes) -> bool:
    """Whether these bytes carry a character card. Only used by the maintenance
    script, to tell a real card apart from a stray image in the archive."""
    try:
        return pngtools.read_envelope(png) is not None
    except (ValueError, TypeError):
        return False
