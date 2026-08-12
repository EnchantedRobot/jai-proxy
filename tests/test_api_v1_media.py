"""`POST /api/v1/characters/{id}/media` and `GET .../media` -- the download
route and manifest read, wired on top of `proxy/media_writer.py`
(docs/PHASE_3C_PLAN.md §3, step 4). `media_writer.download_item` itself is
covered exhaustively in tests/test_media_writer.py; these tests are about the
route's own job: resolving the gallery folder from the card (creating it and
its gallery_id on first use), streaming NDJSON, and persisting the manifest
and ledger a run produces.
"""

from __future__ import annotations

import json

import pytest

from proxy import media_manifest, media_writer
from proxy.api import v1


def _ndjson(response) -> list[dict]:
    return [json.loads(line) for line in response.text.strip().splitlines()]


@pytest.fixture
def stub_download_item(monkeypatch):
    """Replaces the real network-touching pipeline with a scripted outcome
    per URL, keyed by a simple counter -- the route's own logic (folder
    resolution, streaming, manifest persistence) is what these tests check,
    not the pipeline itself."""

    calls: list[dict] = []

    async def fake(client, gallery_dir, folder_name, *, url, filename_hint, prefix, index, index_state, manifest, ledger, thumbnail_store):
        calls.append({"gallery_dir": gallery_dir, "folder_name": folder_name, "url": url})
        outcome = media_writer.DownloadOutcome("saved", url, file=f"localized_media_{index}_x.webp", bytes=123)
        media_manifest.record_saved(manifest, url, outcome.file, "deadbeef")
        return outcome

    monkeypatch.setattr(v1.media_writer, "download_item", fake)
    return calls


def test_download_creates_gallery_folder_for_a_card_with_no_folder_yet(client, populated_archive, stub_download_item):
    # Bella carries a gallery_id but has no folder on disk (the common real
    # case: images never downloaded yet).
    resp = client.post(
        "/api/v1/characters/Bella_11112222.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/pic.png"}]},
    )
    assert resp.status_code == 200
    lines = _ndjson(resp)
    assert lines[0]["type"] == "item"
    assert lines[0]["url"] == "https://cdn.example.com/x/pic.png"
    assert lines[0]["status"] == "saved"
    assert lines[0]["file"].startswith("localized_media_")
    assert lines[0]["bytes"] == 123
    assert lines[-1]["type"] == "done"
    assert lines[-1] == {"type": "done", "saved": 1, "skipped": 0, "errors": 0, "total": 1}

    folder = populated_archive["galleries"] / "Bella_BBBBBBBBBBBB"
    assert folder.is_dir()
    assert (folder / media_manifest.MANIFEST_NAME).is_file()


def test_download_resolves_existing_folder_for_a_card_that_already_has_one(client, populated_archive, stub_download_item):
    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/a.png"}]},
    )
    assert resp.status_code == 200
    assert stub_download_item[0]["folder_name"] == "Abbie_kzbYR2QbpncC"


def test_download_mints_a_gallery_id_for_a_card_that_has_none(client, populated_archive, stub_download_item, monkeypatch):
    from tests.conftest import card_png, jai_extensions

    (populated_archive["characters"] / "NoGallery_55556666.png").write_bytes(
        card_png("NoGallery", extensions=jai_extensions("55556666-0000-0000-0000-000000000000", gallery_id=None))
    )
    client.post("/api/v1/refresh")

    resp = client.post(
        "/api/v1/characters/NoGallery_55556666.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/a.png"}]},
    )
    assert resp.status_code == 200
    folder_name = stub_download_item[0]["folder_name"]
    assert folder_name.startswith("NoGallery_")
    assert (populated_archive["galleries"] / folder_name).is_dir()

    # The minted id was written back onto the card.
    detail = client.get("/api/v1/characters/NoGallery_55556666.png").json()
    assert detail["card"]["extensions"]["gallery_id"]


def test_download_unknown_card_is_404(client, stub_download_item):
    resp = client.post(
        "/api/v1/characters/DoesNotExist_00000000.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/a.png"}]},
    )
    assert resp.status_code == 404
    assert stub_download_item == []


def test_get_media_manifest_for_a_card_never_downloaded_is_empty(client):
    resp = client.get("/api/v1/characters/Cleo_33334444.png/media")
    assert resp.status_code == 200
    assert resp.json() == {"folder": "Cleo_CCCCCCCCCCCC", "files": {}, "dead": {}, "runs": []}


def test_get_media_manifest_reflects_a_completed_run(client, populated_archive, stub_download_item):
    client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/a.png"}], "phase": "embedded"},
    )
    manifest = client.get("/api/v1/characters/Abbie_0d162f5f.png/media").json()
    assert manifest["folder"] == "Abbie_kzbYR2QbpncC"
    assert "https://cdn.example.com/x/a.png" in manifest["files"]
    assert manifest["runs"][-1]["phase"] == "embedded"
    assert manifest["runs"][-1]["saved"] == 1


def test_download_totals_count_mixed_outcomes(client, populated_archive, monkeypatch):
    async def fake(client, gallery_dir, folder_name, *, url, filename_hint, prefix, index, index_state, manifest, ledger, thumbnail_store):
        if "ok" in url:
            outcome = media_writer.DownloadOutcome("saved", url, file="localized_media_0_ok.webp", bytes=1)
            media_manifest.record_saved(manifest, url, outcome.file, "abc")
            return outcome
        if "dup" in url:
            return media_writer.DownloadOutcome("skipped", url, file="localized_media_0_ok.webp", reason="filename match")
        return media_writer.DownloadOutcome("error", url, reason="boom", permanent=False)

    monkeypatch.setattr(v1.media_writer, "download_item", fake)

    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media",
        json={
            "items": [
                {"url": "https://cdn.example.com/ok.png"},
                {"url": "https://cdn.example.com/dup.png"},
                {"url": "https://cdn.example.com/bad.png"},
            ]
        },
    )
    lines = _ndjson(resp)
    assert lines[-1] == {"type": "done", "saved": 1, "skipped": 1, "errors": 1, "total": 3}


# --------------------------------------------------------------------------
# POST /characters/{id}/media/bytes -- the browser-fetch door (MEGA/Pixiv,
# docs/PHASE_3C_PLAN.md §6). No network mock needed: media_writer.finish_item
# is plain sync code operating on bytes already in the request body.
# --------------------------------------------------------------------------


def _png_bytes() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, "PNG")
    return buf.getvalue()


def test_media_bytes_saves_an_already_fetched_item(client, populated_archive):
    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media/bytes",
        data={"url": "mega://folder/handle#key", "filename": "cool pic", "prefix": "extgallery"},
        files={"file": ("photo.png", _png_bytes(), "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "saved"
    assert body["file"].startswith("extgallery_")
    assert body["file"].endswith(".webp")

    folder = populated_archive["galleries"] / "Abbie_kzbYR2QbpncC"
    assert (folder / body["file"]).is_file()

    manifest = client.get("/api/v1/characters/Abbie_0d162f5f.png/media").json()
    assert "mega://folder/handle#key" in manifest["files"]


def test_media_bytes_defaults_prefix_to_extgallery(client, populated_archive):
    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media/bytes",
        data={"url": "mega://folder/handle2"},
        files={"file": ("photo.png", _png_bytes(), "image/png")},
    )
    assert resp.status_code == 200
    assert resp.json()["file"].startswith("extgallery_")


def test_media_bytes_invalid_content_is_an_error(client, populated_archive):
    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media/bytes",
        data={"url": "mega://folder/bad"},
        files={"file": ("error.html", b"<!DOCTYPE html>error</html>", "text/html")},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "error"


def test_media_bytes_empty_upload_is_422(client, populated_archive):
    resp = client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media/bytes",
        data={"url": "mega://folder/empty"},
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert resp.status_code == 422


def test_media_bytes_unknown_card_is_404(client):
    resp = client.post(
        "/api/v1/characters/DoesNotExist_00000000.png/media/bytes",
        data={"url": "mega://folder/handle"},
        files={"file": ("photo.png", _png_bytes(), "image/png")},
    )
    assert resp.status_code == 404
