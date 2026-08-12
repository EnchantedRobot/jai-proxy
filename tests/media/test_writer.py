"""proxy/media/writer.py: the server-side download pipeline for one media URL
-- guard, name-index skip, dead-ledger skip, fetch, sniff, WebP normalize,
content-hash dedupe, write, thumbnail, manifest record
(docs/PHASE_3C_PLAN.md §3, step 4).

`sniff_media` is a verbatim port of `validateMediaContent`
(web/library-sections/30-media-localization-feature.js:622-725); the magic
bytes here are exactly what that function checks, not re-derived by hand.
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

import httpx
import pytest
from PIL import Image

from proxy.archive import thumbs
from proxy.media import manifest as media_manifest, writer as media_writer

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _png_bytes(size=(4, 4), color=(255, 0, 0)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _jpeg_bytes(size=(4, 4), color=(0, 255, 0)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "JPEG")
    return buf.getvalue()


def _animated_gif_bytes() -> bytes:
    frames = [Image.new("RGB", (4, 4), c) for c in [(255, 0, 0), (0, 255, 0)]]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    return buf.getvalue()


def _still_gif_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (0, 0, 255)).save(buf, "GIF")
    return buf.getvalue()


def _mp4_atom(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _mp4_with_handler(handler_type: bytes) -> bytes:
    hdlr_payload = b"\x00" * 8 + handler_type + b"\x00" * 4
    hdlr = _mp4_atom(b"hdlr", hdlr_payload)
    ftyp = _mp4_atom(b"ftyp", b"isom" + b"\x00" * 8)
    # Trailing padding so the scan's `pos < len - 24` boundary check (the
    # same one the JS it's ported from uses) still has room to read the
    # hdlr atom sitting right at the end of the buffer.
    return ftyp + hdlr + b"\x00" * 24


# --------------------------------------------------------------------------
# sniff_media
# --------------------------------------------------------------------------


def test_sniff_png():
    r = media_writer.sniff_media(_png_bytes(), None)
    assert r.valid and r.media_type == "image/png"


def test_sniff_jpeg():
    r = media_writer.sniff_media(_jpeg_bytes(), None)
    assert r.valid and r.media_type == "image/jpeg"


def test_sniff_gif():
    r = media_writer.sniff_media(_still_gif_bytes(), None)
    assert r.valid and r.media_type == "image/gif"


def test_sniff_webp():
    data = b"RIFF" + struct.pack("<I", 20) + b"WEBPVP8 " + b"\x00" * 12
    r = media_writer.sniff_media(data, None)
    assert r.valid and r.media_type == "image/webp"


def test_sniff_bmp():
    r = media_writer.sniff_media(b"BM" + b"\x00" * 20, None)
    assert r.valid and r.media_type == "image/bmp"


def test_sniff_mp4_audio_brand():
    data = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00" + b"\x00" * 20
    r = media_writer.sniff_media(data, None)
    assert r.valid and r.media_type == "audio/mp4"


def test_sniff_mp4_with_video_handler_is_video():
    data = _mp4_with_handler(b"vide")
    r = media_writer.sniff_media(data, None)
    assert r.valid and r.media_type == "video/mp4"


def test_sniff_mp4_with_sound_handler_is_audio():
    data = _mp4_with_handler(b"soun")
    r = media_writer.sniff_media(data, None)
    assert r.valid and r.media_type == "audio/mp4"


def test_sniff_webm():
    r = media_writer.sniff_media(b"\x1a\x45\xdf\xa3" + b"\x00" * 8, None)
    assert r.valid and r.media_type == "video/webm"


def test_sniff_mp3_id3():
    r = media_writer.sniff_media(b"ID3" + b"\x00" * 8, None)
    assert r.valid and r.media_type == "audio/mpeg"


def test_sniff_mp3_sync_word():
    r = media_writer.sniff_media(bytes([0xFF, 0xFB]) + b"\x00" * 8, None)
    assert r.valid and r.media_type == "audio/mpeg"


def test_sniff_ogg():
    r = media_writer.sniff_media(b"OggS" + b"\x00" * 8, None)
    assert r.valid and r.media_type == "audio/ogg"


def test_sniff_wav():
    data = b"RIFF" + struct.pack("<I", 20) + b"WAVEfmt " + b"\x00" * 8
    r = media_writer.sniff_media(data, None)
    assert r.valid and r.media_type == "audio/wav"


def test_sniff_flac():
    r = media_writer.sniff_media(b"fLaC" + b"\x00" * 8, None)
    assert r.valid and r.media_type == "audio/flac"


def test_sniff_svg():
    r = media_writer.sniff_media(b'<?xml version="1.0"?><svg></svg>', None)
    assert r.valid and r.media_type == "image/svg+xml"


def test_sniff_html_error_page_is_invalid():
    r = media_writer.sniff_media(b"<!DOCTYPE html><html><body>404</body></html>", None)
    assert not r.valid
    assert r.media_type == "text/html"


def test_sniff_unknown_bytes_with_media_content_type_trusts_header():
    r = media_writer.sniff_media(b"\x01\x02\x03\x04\x05\x06\x07\x08", "image/avif")
    assert r.valid and r.media_type == "image/avif"


def test_sniff_unknown_bytes_no_content_type_is_invalid():
    r = media_writer.sniff_media(b"\x01\x02\x03\x04\x05\x06\x07\x08", None)
    assert not r.valid


def test_sniff_too_small_is_invalid():
    r = media_writer.sniff_media(b"\x89PNG", None)
    assert not r.valid


# --------------------------------------------------------------------------
# extension_for / classify_failure
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "media_type,expected",
    [
        ("image/png", "png"),
        ("image/jpeg", "jpg"),
        ("audio/mp4", "m4a"),
        ("video/mp4", "mp4"),
    ],
)
def test_extension_for_known_types(media_type, expected):
    assert media_writer.extension_for(media_type, "https://x/y") == expected


def test_extension_for_unknown_audio_subtype_uses_subtype():
    assert media_writer.extension_for("audio/opus", "https://x/y") == "opus"


def test_extension_for_unknown_type_falls_back_to_url_suffix():
    assert media_writer.extension_for("application/octet-stream", "https://x/y/pic.bmp") == "bmp"


def test_extension_for_totally_unknown_defaults_png():
    assert media_writer.extension_for("application/octet-stream", "https://x/y/pic") == "png"


def test_classify_failure_blocked_is_permanent():
    assert media_writer.classify_failure(blocked=True, status=None, message="") is True


@pytest.mark.parametrize("status", [400, 404, 410, 451])
def test_classify_failure_permanent_statuses(status):
    assert media_writer.classify_failure(blocked=False, status=status, message="") is True


@pytest.mark.parametrize("status", [401, 403, 429, 500, 502, 503])
def test_classify_failure_transient_statuses(status):
    assert media_writer.classify_failure(blocked=False, status=status, message="") is False


def test_classify_failure_network_error_is_transient():
    assert media_writer.classify_failure(blocked=False, status=None, message="timeout") is False


# --------------------------------------------------------------------------
# normalize_to_webp
# --------------------------------------------------------------------------


def test_normalize_still_png_becomes_webp():
    data, media_type = media_writer.normalize_to_webp(_png_bytes(), "image/png")
    assert media_type == "image/webp"
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def test_normalize_still_jpeg_becomes_webp():
    data, media_type = media_writer.normalize_to_webp(_jpeg_bytes(), "image/jpeg")
    assert media_type == "image/webp"


def test_normalize_still_gif_becomes_webp():
    data, media_type = media_writer.normalize_to_webp(_still_gif_bytes(), "image/gif")
    assert media_type == "image/webp"


def test_normalize_animated_gif_passes_through():
    original = _animated_gif_bytes()
    data, media_type = media_writer.normalize_to_webp(original, "image/gif")
    assert media_type == "image/gif"
    assert data == original


def test_normalize_audio_passes_through_untouched():
    original = b"ID3" + b"\x00" * 20
    data, media_type = media_writer.normalize_to_webp(original, "audio/mpeg")
    assert data == original and media_type == "audio/mpeg"


def test_normalize_svg_passes_through_untouched():
    original = b"<svg></svg>"
    data, media_type = media_writer.normalize_to_webp(original, "image/svg+xml")
    assert data == original and media_type == "image/svg+xml"


# --------------------------------------------------------------------------
# GalleryIndex
# --------------------------------------------------------------------------


def test_gallery_index_builds_name_and_hash_keys(tmp_path: Path):
    payload = _png_bytes()
    (tmp_path / "localized_media_1_forest_scene.webp").write_bytes(payload)
    idx = media_writer.GalleryIndex.build(tmp_path)
    assert idx.find_by_name("https://cdn.example.com/x/forest_scene.png", None, "localized_media") == (
        "localized_media_1_forest_scene.webp"
    )
    import hashlib

    assert idx.find_by_hash(hashlib.sha256(payload).hexdigest()) == "localized_media_1_forest_scene.webp"


def test_gallery_index_never_downgrades_a_higher_priority_prefix(tmp_path: Path):
    (tmp_path / "localized_media_1_thing.webp").write_bytes(_png_bytes())
    idx = media_writer.GalleryIndex.build(tmp_path)
    # A lorebook_media write for the same name must not treat the
    # higher-priority localized_media file as "not yet under my prefix" --
    # it should still report the match (never re-download), matching the
    # JS's wouldDowngrade rule.
    match = idx.find_by_name("https://cdn.example.com/x/thing.png", None, "lorebook_media")
    assert match == "localized_media_1_thing.webp"


def test_gallery_index_ignores_non_media_files(tmp_path: Path):
    (tmp_path / media_manifest.MANIFEST_NAME).write_text("{}")
    (tmp_path / "notes.txt").write_text("hi")
    idx = media_writer.GalleryIndex.build(tmp_path)
    assert idx.by_key == {}
    assert idx.by_hash == {}


# --------------------------------------------------------------------------
# download_item -- end to end against a mocked transport
# --------------------------------------------------------------------------


@pytest.fixture
def gallery_dir(tmp_path: Path) -> Path:
    d = tmp_path / "gallery"
    d.mkdir()
    return d


@pytest.fixture
def thumbnail_store(tmp_path: Path) -> thumbs.ThumbnailStore:
    return thumbs.ThumbnailStore(root=tmp_path / "thumbs", archive_dir=tmp_path)


def _client_for(handler) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


@pytest.mark.asyncio
async def test_download_item_saves_a_new_image(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)
    body = _png_bytes()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "image/png"})

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client,
            gallery_dir,
            "gallery",
            url="https://cdn.example.com/x/photo.png",
            filename_hint=None,
            prefix="localized_media",
            index=1,
            index_state=index_state,
            manifest=manifest,
            ledger=ledger,
            thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "saved"
    assert outcome.file.startswith("localized_media_1_photo")
    assert outcome.file.endswith(".webp")
    written = gallery_dir / outcome.file
    assert written.is_file()
    assert written.read_bytes()[:4] == b"RIFF"
    assert "https://cdn.example.com/x/photo.png" in manifest["files"]
    # Thumbnail generated immediately, per step 9 of the plan.
    thumb = thumbnail_store.gallery_path("gallery", outcome.file)
    assert thumb.is_file()


@pytest.mark.asyncio
async def test_download_item_404_is_permanent_and_recorded_in_manifest_and_ledger(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client,
            gallery_dir,
            "gallery",
            url="https://cdn.example.com/x/gone.png",
            filename_hint=None,
            prefix="localized_media",
            index=1,
            index_state=index_state,
            manifest=manifest,
            ledger=ledger,
            thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "skipped"
    assert outcome.permanent is True
    assert "https://cdn.example.com/x/gone.png" in manifest["dead"]
    assert media_manifest.is_dead(ledger, "https://cdn.example.com/x/gone.png")


@pytest.mark.asyncio
async def test_download_item_blocked_url_never_touches_the_network(gallery_dir, thumbnail_store):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, content=b"should never be requested")

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client,
            gallery_dir,
            "gallery",
            url="http://127.0.0.1:8000/secrets",
            filename_hint=None,
            prefix="localized_media",
            index=1,
            index_state=index_state,
            manifest=manifest,
            ledger=ledger,
            thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "skipped"
    assert outcome.permanent is True
    assert calls == []
    assert "http://127.0.0.1:8000/secrets" in manifest["dead"]


@pytest.mark.asyncio
async def test_download_item_second_call_skips_by_name_index(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)
    body = _png_bytes()
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, content=body, headers={"content-type": "image/png"})

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        first = await media_writer.download_item(
            client, gallery_dir, "gallery",
            url="https://cdn.example.com/x/photo.png", filename_hint=None,
            prefix="localized_media", index=1, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )
        assert first.status == "saved"

        second = await media_writer.download_item(
            client, gallery_dir, "gallery",
            url="https://other-cdn.example.com/y/photo.png", filename_hint=None,
            prefix="localized_media", index=2, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )

    assert second.status == "skipped"
    assert second.reason == "filename match"
    assert len(calls) == 1  # the second URL was never fetched


@pytest.mark.asyncio
async def test_download_item_cross_character_dead_ledger_skips_without_fetch(gallery_dir, thumbnail_store):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, content=b"nope")

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    media_manifest.record_failure(
        ledger, "https://cdn.example.com/x/gone.png", permanent=True, status=404, message="HTTP 404"
    )
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client, gallery_dir, "gallery",
            url="https://cdn.example.com/x/gone.png", filename_hint=None,
            prefix="localized_media", index=1, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "skipped"
    assert calls == []


@pytest.mark.asyncio
async def test_download_item_content_hash_dedupe_against_existing_file(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)
    original_png = _png_bytes()
    # Pre-normalize to what the writer would have written, so the hash matches.
    webp_data, _ = media_writer.normalize_to_webp(original_png, "image/png")
    (gallery_dir / "localized_media_1_existing.webp").write_bytes(webp_data)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=original_png, headers={"content-type": "image/png"})

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client, gallery_dir, "gallery",
            # A name that would NOT match the name index, so this exercises
            # the content-hash path specifically.
            url="https://cdn.example.com/totally/different/name.png", filename_hint=None,
            prefix="localized_media", index=5, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "skipped"
    assert outcome.file == "localized_media_1_existing.webp"
    assert outcome.reason == "already have this content"


@pytest.mark.asyncio
async def test_download_item_html_error_page_is_transient_not_permanent(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<!DOCTYPE html><html>error</html>", headers={"content-type": "text/html"})

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client, gallery_dir, "gallery",
            url="https://cdn.example.com/x/errorpage.png", filename_hint=None,
            prefix="localized_media", index=1, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "error"
    assert outcome.permanent is False
    assert "https://cdn.example.com/x/errorpage.png" not in manifest["dead"]


@pytest.mark.asyncio
async def test_download_item_respects_size_cap(gallery_dir, thumbnail_store, monkeypatch):
    monkeypatch.setattr(media_writer, "_preflight_dns", lambda url: None)
    monkeypatch.setattr(media_writer.media_guard, "MAX_MEDIA_BYTES", 16)
    big = _png_bytes(size=(64, 64))
    assert len(big) > 16

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big, headers={"content-type": "image/png"})

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    async with _client_for(handler) as client:
        outcome = await media_writer.download_item(
            client, gallery_dir, "gallery",
            url="https://cdn.example.com/x/huge.png", filename_hint=None,
            prefix="localized_media", index=1, index_state=index_state,
            manifest=manifest, ledger=ledger, thumbnail_store=thumbnail_store,
        )

    assert outcome.status == "error"
    assert list(gallery_dir.iterdir()) == []


# --------------------------------------------------------------------------
# finish_item -- bytes already in hand, no network (the browser-fetch door:
# MEGA/Pixiv, docs/PHASE_3C_PLAN.md §6)
# --------------------------------------------------------------------------


def test_finish_item_saves_bytes_already_fetched(gallery_dir, thumbnail_store):
    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    outcome = media_writer.finish_item(
        gallery_dir,
        "gallery",
        url="mega://folder/handle#key",
        filename_hint="cool pic",
        prefix="extgallery",
        index=1,
        index_state=index_state,
        manifest=manifest,
        ledger=ledger,
        body=_png_bytes(),
        content_type="image/png",
        thumbnail_store=thumbnail_store,
    )

    assert outcome.status == "saved"
    assert outcome.file.startswith("extgallery_1_cool_pic")
    assert outcome.file.endswith(".webp")
    written = gallery_dir / outcome.file
    assert written.is_file()
    assert "mega://folder/handle#key" in manifest["files"]
    thumb = thumbnail_store.gallery_path("gallery", outcome.file)
    assert thumb.is_file()


def test_finish_item_invalid_bytes_are_an_error_not_permanent(gallery_dir, thumbnail_store):
    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    outcome = media_writer.finish_item(
        gallery_dir,
        "gallery",
        url="mega://folder/bad-handle",
        filename_hint=None,
        prefix="extgallery",
        index=1,
        index_state=index_state,
        manifest=manifest,
        ledger=ledger,
        body=b"<!DOCTYPE html><html>error</html>",
        content_type="text/html",
        thumbnail_store=thumbnail_store,
    )

    assert outcome.status == "error"
    assert list(gallery_dir.iterdir()) == []


def test_finish_item_content_hash_dedupe_against_existing_file(gallery_dir, thumbnail_store):
    existing = gallery_dir / "extgallery_0_old.webp"
    body = _png_bytes()
    normalized, _ = media_writer.normalize_to_webp(body, "image/png")
    existing.write_bytes(normalized)

    manifest = media_manifest.empty_manifest()
    ledger: dict = {}
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    outcome = media_writer.finish_item(
        gallery_dir,
        "gallery",
        url="mega://folder/dup-handle",
        filename_hint="dup",
        prefix="extgallery",
        index=1,
        index_state=index_state,
        manifest=manifest,
        ledger=ledger,
        body=body,
        content_type="image/png",
        thumbnail_store=thumbnail_store,
    )

    assert outcome.status == "skipped"
    assert outcome.file == "extgallery_0_old.webp"
    assert len(list(gallery_dir.iterdir())) == 1
