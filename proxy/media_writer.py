"""The server-side media download pipeline -- docs/PHASE_3C_PLAN.md §3, step 4.

One function, `download_item`, does everything the plan lists for one URL, in
order: guard, name-index skip, dead-ledger skip, fetch, sniff, normalize to
WebP, content-hash dedupe, write, thumbnail, manifest record. It is the thing
`POST /api/v1/characters/{id}/media` (proxy/api/v1.py) calls once per item and
streams the result of as one NDJSON line.

**Sniffing never trusts the source.** `sniff_media` is a verbatim port of
`validateMediaContent` (`30-media-localization-feature.js:622-725`), magic
bytes and the MP4 audio-vs-video atom walk included: the content type decides
the extension, never the `Content-Type` header or the URL's own suffix. A CDN
that mislabels a JPEG as `application/octet-stream` still gets sniffed and
saved correctly; a URL that serves an HTML error page gets caught here rather
than saved as a broken image.

**WebP happens once, at intake, for stills only.** png/jpeg/bmp and
single-frame gif/webp are re-encoded (`quality=82, method=4`); animated
gif/webp, svg, audio and video pass through untouched -- see §4 and §6 of the
plan for why animated formats are deliberately out of scope here.

**Dedupe is a local `scandir` and some SHA-256 reads, not an HTTP round
trip** -- the entire point of moving the fetch server-side (§3 "Dedup is a
scandir"). `GalleryIndex.build` scans the folder once per request and is
reused across every item in the batch.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageSequence

from proxy import cardwrite, media_guard, media_manifest, media_names, thumbs

logger = logging.getLogger("jai_proxy.media_writer")

# Verbatim MAX_MEDIA_BYTES already lives in media_guard; re-exported for
# callers that only import this module.
MAX_MEDIA_BYTES = media_guard.MAX_MEDIA_BYTES

# Port of the `mimeToExt` map (30-media-localization-feature.js:993-1017).
MIME_TO_EXT: dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
}

# Still-image types converted to WebP at intake (§4). Anything else --
# animated gif/webp, svg, audio, video -- is stored exactly as sniffed.
_WEBP_CONVERTIBLE_TYPES = {"image/png", "image/jpeg", "image/bmp", "image/gif", "image/webp"}

_WEBP_QUALITY = 82
_WEBP_METHOD = 4

# Verbatim PERMANENT_HTTP (media-dedup.js:56).
PERMANENT_HTTP = frozenset({400, 404, 410, 451})

MEDIA_EXT_RE = re.compile(r"\.(png|jpg|jpeg|webp|gif|bmp|svg|avif|mp3|wav|ogg|m4a|flac|aac|mp4|webm|mov)$", re.I)


@dataclass(frozen=True, slots=True)
class SniffResult:
    valid: bool
    media_type: str | None
    reason: str


def _mp4_has_video_track(data: bytes) -> bool:
    """Port of `mp4HasVideoTrack` (30-media-localization-feature.js:561-610).

    Scans MP4/M4A atoms for a `hdlr` box whose handler type is `vide`; the
    same container shape covers video and audio-only M4A, and this is the
    only way to tell them apart from the bytes.
    """
    length = len(data)
    pos = 0
    container_atoms = {"moov", "trak", "mdia", "minf", "stbl", "udta", "edts"}
    while pos < length - 24:
        atom_size = int.from_bytes(data[pos : pos + 4], "big")
        atom_type = data[pos + 4 : pos + 8].decode("latin-1")

        if atom_type == "hdlr" and atom_size >= 24:
            handler_type = data[pos + 16 : pos + 20].decode("latin-1")
            if handler_type == "vide":
                return True

        if atom_size in (0, 1):
            break
        if atom_type in container_atoms:
            pos += 8
        else:
            pos += atom_size
        if atom_size < 8 and atom_type not in container_atoms:
            break
    return False


def sniff_media(data: bytes, content_type: str | None) -> SniffResult:
    """Port of `validateMediaContent` (30-media-localization-feature.js:622-725)."""
    if not data or len(data) < 8:
        return SniffResult(False, None, "Content too small to be valid media")

    b = data
    if b[0:4] == b"\x89PNG":
        return SniffResult(True, "image/png", "Valid PNG")
    if b[0:3] == b"\xff\xd8\xff":
        return SniffResult(True, "image/jpeg", "Valid JPEG")
    if b[0:4] == b"GIF8":
        return SniffResult(True, "image/gif", "Valid GIF")
    if b[0:4] == b"RIFF" and len(b) >= 12 and b[8:12] == b"WEBP":
        return SniffResult(True, "image/webp", "Valid WebP")
    if b[0:2] == b"BM":
        return SniffResult(True, "image/bmp", "Valid BMP")
    if len(b) >= 12 and b[4:8] == b"ftyp":
        brand = b[8:12].decode("latin-1", "replace")
        if brand in ("M4A ", "M4B ", "M4P "):
            return SniffResult(True, "audio/mp4", "Valid M4A audio (brand)")
        if _mp4_has_video_track(b):
            return SniffResult(True, "video/mp4", "Valid MP4 video (has video track)")
        return SniffResult(True, "audio/mp4", "Valid M4A audio (no video track)")
    if b[0:4] == b"\x1a\x45\xdf\xa3":
        return SniffResult(True, "video/webm", "Valid WebM")
    if b[0:3] == b"ID3" or (b[0] == 0xFF and b[1] in (0xFB, 0xFA, 0xF3, 0xF2)):
        return SniffResult(True, "audio/mpeg", "Valid MP3")
    if b[0:4] == b"OggS":
        return SniffResult(True, "audio/ogg", "Valid OGG")
    if b[0:4] == b"RIFF" and len(b) >= 12 and b[8:12] == b"WAVE":
        return SniffResult(True, "audio/wav", "Valid WAV")
    if b[0:4] == b"fLaC":
        return SniffResult(True, "audio/flac", "Valid FLAC")

    text_start = b[: min(100, len(b))].decode("utf-8", "replace")
    if "<?xml" in text_start or "<svg" in text_start:
        return SniffResult(True, "image/svg+xml", "Valid SVG")
    if "<!DOCTYPE" in text_start or "<html" in text_start or "<HTML" in text_start:
        return SniffResult(False, "text/html", "Content is HTML (likely error page)")

    if content_type and content_type.startswith(("image/", "audio/", "video/")):
        return SniffResult(True, content_type, "Unknown format, trusting content-type")

    return SniffResult(False, None, "Unknown or invalid media format")


def extension_for(media_type: str, url: str) -> str:
    """Port of the extension half of `saveMediaFromMemory`
    (30-media-localization-feature.js:990-1039): exact MIME match first, then
    a subtype-derived guess for audio/video, then the URL's own suffix, then
    `png` as the image default."""
    if media_type in MIME_TO_EXT:
        return MIME_TO_EXT[media_type]
    if media_type.startswith("audio/"):
        subtype = media_type.split("/", 1)[1].split(";")[0]
        return subtype.replace("x-", "") or "audio"
    if media_type.startswith("video/"):
        subtype = media_type.split("/", 1)[1].split(";")[0]
        return subtype.replace("x-", "") or "video"
    match = re.search(r"\.([a-zA-Z0-9]+)(?:\?|$)", url)
    if match:
        return match.group(1).lower()
    return "png"


def _is_animated(data: bytes, media_type: str) -> bool:
    """Whether an image the sniff says is gif/webp actually carries more than
    one frame. Only these two formats can be animated among the still types
    WebP normalization would otherwise touch (§4/§6: animated stays as-is)."""
    if media_type not in ("image/gif", "image/webp"):
        return False
    try:
        with Image.open(io.BytesIO(data)) as image:
            frames = 0
            for _ in ImageSequence.Iterator(image):
                frames += 1
                if frames > 1:
                    return True
    except (OSError, ValueError):
        return False
    return False


def normalize_to_webp(data: bytes, media_type: str) -> tuple[bytes, str]:
    """`(bytes, media_type)` to actually write for a sniffed still image --
    re-encoded to WebP unless it's animated, in which case it passes through
    unchanged. Anything not in `_WEBP_CONVERTIBLE_TYPES` also passes through
    (svg, audio, video)."""
    if media_type not in _WEBP_CONVERTIBLE_TYPES:
        return data, media_type
    if _is_animated(data, media_type):
        return data, media_type
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            has_alpha = "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if has_alpha else "RGB")
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", quality=_WEBP_QUALITY, method=_WEBP_METHOD)
            return buffer.getvalue(), "image/webp"
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        logger.warning("media_writer: cannot normalize %s to WebP: %s", media_type, exc)
        return data, media_type


def classify_failure(*, blocked: bool, status: int | None, message: str) -> bool:
    """Whether a failed attempt is permanent (never worth retrying) -- port
    of `classifyFailure` (media-dedup.js:278-292), server-relevant subset.
    A guard rejection is always permanent: the URL's scheme or hostname
    doesn't change between attempts. An HTTP status is permanent iff it's in
    `PERMANENT_HTTP`. Everything else (network errors, sniff failures, size
    cap) is transient -- the bytes might just be temporarily unreachable or
    the CDN might be serving a temporary error page."""
    if blocked:
        return True
    if status is not None:
        return status in PERMANENT_HTTP
    return False


# --------------------------------------------------------------------------
# Local dedupe -- name index + content hash, both a scandir, never HTTP
# --------------------------------------------------------------------------


@dataclass
class GalleryIndex:
    """One gallery folder's existing files, indexed two ways so an item can
    be skipped before a byte is fetched (name) or after (content hash)."""

    by_key: dict[str, str] = field(default_factory=dict)  # media_key -> filename
    by_hash: dict[str, str] = field(default_factory=dict)  # sha256 -> filename

    @classmethod
    def build(cls, gallery_dir: Path) -> "GalleryIndex":
        idx = cls()
        try:
            entries = sorted(p for p in gallery_dir.iterdir() if p.is_file() and not p.name.startswith("."))
        except OSError:
            return idx
        strong_keys: set[str] = set()
        for path in entries:
            name = path.name
            if not MEDIA_EXT_RE.search(name):
                continue
            stripped = media_names.PREFIXED_NAME_RE.match(Path(name).stem)
            if stripped:
                key = media_names.media_key(stripped.group(1))
                if len(key) >= media_names.MIN_KEY_LENGTH:
                    idx.by_key[key] = name
                    strong_keys.add(key)
            else:
                key = media_names.media_key(Path(name).stem)
                if len(key) >= media_names.MIN_KEY_LENGTH and key not in strong_keys:
                    idx.by_key[key] = name
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                continue
            idx.by_hash.setdefault(digest, name)
        return idx

    def find_by_name(self, url: str, filename_hint: str | None, prefix: str) -> str | None:
        """A filename already on disk that this item's name keys would match,
        honoring the same prefix-priority rule as `prefixPriority`
        (media-dedup.js:140-145): never report a match that would need
        downgrading from a higher-priority prefix to `prefix`."""
        for key in media_names.keys_for_item(url, filename_hint):
            match = self.by_key.get(key)
            if not match:
                continue
            if match.startswith(prefix + "_"):
                return match
            if media_names.prefix_priority(match) >= media_names.PREFIX_PRIORITY.get(prefix, 0):
                return match
        return None

    def find_by_hash(self, digest: str) -> str | None:
        return self.by_hash.get(digest)

    def note_saved(self, url: str, filename_hint: str | None, prefix: str, file_name: str, digest: str) -> None:
        for key in media_names.keys_for_item(url, filename_hint):
            self.by_key[key] = file_name
        self.by_hash.setdefault(digest, file_name)


# --------------------------------------------------------------------------
# The fetch + guard
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DownloadOutcome:
    status: Literal["saved", "skipped", "error"]
    url: str
    file: str | None = None
    reason: str | None = None
    bytes: int | None = None
    permanent: bool | None = None


def _preflight_dns(url: str) -> str | None:
    """A reason string if the URL's host resolves only to blocked addresses
    or doesn't resolve at all, else None. Not a full pin against TOCTOU (see
    media_guard's docstring) -- a best-effort check run immediately before
    the request, closing the common DNS-rebinding case without the
    complexity of pinning the resolved IP through TLS SNI."""
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        media_guard.resolve_safe_addresses(parsed.hostname or "", port)
    except media_guard.UnsafeAddressError as exc:
        return str(exc)
    except socket.gaierror as exc:
        return f"DNS resolution failed: {exc}"
    return None


async def _fetch(client: httpx.AsyncClient, url: str) -> tuple[bytes | None, str | None, str | None]:
    """`(body, content_type, error)` -- exactly one of `body` or `error` is
    set. Streams with the size cap rather than buffering a potentially huge
    body first."""
    try:
        async with client.stream("GET", url, follow_redirects=True) as response:
            if response.status_code >= 400:
                return None, None, f"HTTP {response.status_code}"
            try:
                body = await media_guard.read_body_with_cap(response, media_guard.MAX_MEDIA_BYTES)
            except media_guard.MediaTooLargeError as exc:
                return None, None, str(exc)
            return body, response.headers.get("content-type"), None
    except httpx.HTTPError as exc:
        return None, None, str(exc)


def finish_item(
    gallery_dir: Path,
    folder_name: str,
    *,
    url: str,
    filename_hint: str | None,
    prefix: str,
    index: int,
    index_state: GalleryIndex,
    manifest: dict[str, Any],
    ledger: dict[str, Any],
    body: bytes,
    content_type: str | None,
    thumbnail_store: thumbs.ThumbnailStore,
) -> DownloadOutcome:
    """Steps 5-10 of the plan's §3 list, for bytes already in hand -- shared by
    `download_item` (bytes just fetched by this server) and the
    `POST .../media/bytes` route (bytes the *browser* fetched, e.g. MEGA's
    AES-CTR decrypt or Pixiv's session-proxied image -- see plan §6, "one
    writer, two entry doors")."""

    # 5. Sniff.
    sniff = sniff_media(body, content_type)
    if not sniff.valid:
        result = media_manifest.record_failure(ledger, url, permanent=False, status=None, message=sniff.reason)
        if result["dead"]:
            media_manifest.record_dead(manifest, url, sniff.reason, attempts=result["attempts"])
            return DownloadOutcome("skipped", url, reason=sniff.reason)
        return DownloadOutcome("error", url, reason=sniff.reason, permanent=False)

    media_manifest.record_success(ledger, url)

    # 6. Normalize to WebP (stills only).
    written_bytes, written_type = normalize_to_webp(body, sniff.media_type or "")

    # 7. Content hash dedupe against the folder.
    digest = hashlib.sha256(written_bytes).hexdigest()
    existing_by_hash = index_state.find_by_hash(digest)
    if existing_by_hash:
        media_manifest.record_saved(manifest, url, existing_by_hash, digest)
        return DownloadOutcome("skipped", url, file=existing_by_hash, reason="already have this content")

    # 8. Write, atomically.
    ext = extension_for(written_type, url)
    sanitized_name = (media_names.media_key(filename_hint) if filename_hint else "") or (
        media_names.extract_sanitized_url_name(url) or "media"
    )
    file_name = media_names.local_filename(prefix, index, sanitized_name, ext)
    target = gallery_dir / file_name
    try:
        cardwrite.write_atomic(target, written_bytes)
    except OSError as exc:
        return DownloadOutcome("error", url, reason=f"cannot write {file_name}: {exc}", permanent=False)

    # 9. Thumbnail, immediately.
    thumbnail_store.generate_gallery(target, folder_name, file_name)

    # 10. Record.
    index_state.note_saved(url, filename_hint, prefix, file_name, digest)
    media_manifest.record_saved(manifest, url, file_name, digest)
    return DownloadOutcome("saved", url, file=file_name, bytes=len(written_bytes))


async def download_item(
    client: httpx.AsyncClient,
    gallery_dir: Path,
    folder_name: str,
    *,
    url: str,
    filename_hint: str | None,
    prefix: str,
    index: int,
    index_state: GalleryIndex,
    manifest: dict[str, Any],
    ledger: dict[str, Any],
    thumbnail_store: thumbs.ThumbnailStore,
) -> DownloadOutcome:
    """Everything the plan's §3 numbered list says for one URL, end to end."""

    # 3. Per-gallery dead ledger -- already known gone for this character.
    dead_here = manifest.get("dead", {}).get(url)
    if dead_here:
        return DownloadOutcome("skipped", url, reason=dead_here.get("reason", "known dead"))

    # 1. Guard, before anything touches the network.
    safety = media_guard.is_url_safe_for_download(url)
    if not safety.ok:
        media_manifest.record_failure(ledger, url, permanent=True, status=None, message=safety.reason)
        media_manifest.record_dead(manifest, url, safety.reason)
        return DownloadOutcome("skipped", url, reason=safety.reason, permanent=True)

    # Cross-character dead ledger -- a URL confirmed gone on another card.
    if media_manifest.is_dead(ledger, url):
        reason = media_manifest.dead_reason(ledger, url)
        media_manifest.record_dead(manifest, url, reason)
        return DownloadOutcome("skipped", url, reason=reason)

    # 2. Name index -- already have an equivalent file, before any bytes move.
    existing_name = index_state.find_by_name(url, filename_hint, prefix)
    if existing_name:
        return DownloadOutcome("skipped", url, file=existing_name, reason="filename match")

    dns_reason = _preflight_dns(url)
    if dns_reason:
        media_manifest.record_failure(ledger, url, permanent=True, status=None, message=dns_reason)
        media_manifest.record_dead(manifest, url, dns_reason)
        return DownloadOutcome("skipped", url, reason=dns_reason, permanent=True)

    # 4. Fetch.
    body, content_type, error = await _fetch(client, url)
    if body is None:
        status = int(error.split(" ", 1)[1]) if error and error.startswith("HTTP ") else None
        permanent = classify_failure(blocked=False, status=status, message=error or "")
        result = media_manifest.record_failure(
            ledger, url, permanent=permanent, status=status, message=error or "download failed"
        )
        if result["dead"]:
            media_manifest.record_dead(manifest, url, error or "download failed", attempts=result["attempts"])
            return DownloadOutcome("skipped", url, reason=error, permanent=permanent)
        return DownloadOutcome("error", url, reason=error, permanent=False)

    return finish_item(
        gallery_dir,
        folder_name,
        url=url,
        filename_hint=filename_hint,
        prefix=prefix,
        index=index,
        index_state=index_state,
        manifest=manifest,
        ledger=ledger,
        body=body,
        content_type=content_type,
        thumbnail_store=thumbnail_store,
    )
