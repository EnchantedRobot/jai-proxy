"""`POST /api/v1/characters/{id}/media` and `GET .../media` -- the download
route and manifest read, wired on top of `proxy/media/writer.py`
(docs/PHASE_3C_PLAN.md §3, step 4). `media_writer.download_item` itself is
covered exhaustively in tests/test_media_writer.py; these tests are about the
route's own job: resolving the gallery folder from the card (creating it and
its gallery_id on first use), streaming NDJSON, and persisting the manifest
and ledger a run produces.
"""

from __future__ import annotations

import json

import pytest

from proxy.media import manifest as media_manifest, writer as media_writer
from proxy.api.v1 import _shared as v1_shared, media as v1_media


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

    monkeypatch.setattr(v1_media.media_writer, "download_item", fake)
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

    monkeypatch.setattr(v1_media.media_writer, "download_item", fake)

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


# --------------------------------------------------------------------------
# GET /media/status -- the archive-wide summary Bulk Localize reads instead
# of one request per card (docs/PHASE_3C_PLAN.md §3).
# --------------------------------------------------------------------------


def test_media_status_omits_cards_with_no_gallery_folder(client):
    body = client.get("/api/v1/media/status").json()
    # Cleo has a gallery_id but no folder on disk yet -- "never downloaded",
    # not a zeroed row.
    assert "Cleo_33334444.png" not in body["cards"]


def test_media_status_omits_cards_with_a_folder_but_no_manifest(client, populated_archive):
    # Abbie's fixture gallery folder has files but no run has ever gone
    # through the download route, so there is no .media.json yet.
    body = client.get("/api/v1/media/status").json()
    assert "Abbie_0d162f5f.png" not in body["cards"]


def test_media_status_reflects_a_completed_run(client, populated_archive, stub_download_item):
    client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/a.png"}]},
    )
    body = client.get("/api/v1/media/status").json()
    entry = body["cards"]["Abbie_0d162f5f.png"]
    assert entry["files"] == 1
    assert entry["dead"] == 0
    assert entry["complete"] is True
    assert entry["last_run"] is not None


def test_media_status_incomplete_when_last_run_had_errors(client, populated_archive, monkeypatch):
    async def fake(client, gallery_dir, folder_name, *, url, filename_hint, prefix, index, index_state, manifest, ledger, thumbnail_store):
        return media_writer.DownloadOutcome("error", url, reason="boom", permanent=False)

    monkeypatch.setattr(v1_media.media_writer, "download_item", fake)
    client.post(
        "/api/v1/characters/Abbie_0d162f5f.png/media",
        json={"items": [{"url": "https://cdn.example.com/x/bad.png"}]},
    )
    body = client.get("/api/v1/media/status").json()
    assert body["cards"]["Abbie_0d162f5f.png"]["complete"] is False


# --------------------------------------------------------------------------
# POST /galleries/{folder}/thumbs/prune -- docs/PHASE_3C_PLAN.md §5, the
# replacement for cl-helper's gallery-thumb-cleanup.
# --------------------------------------------------------------------------


def test_prune_thumbs_drops_orphans_and_keeps_live_ones(client, populated_archive):
    folder = "Abbie_kzbYR2QbpncC"
    gallery_dir = populated_archive["galleries"] / folder
    live_files = [p.name for p in gallery_dir.iterdir() if p.is_file()]
    assert live_files, "fixture gallery must have at least one file"
    live_name = live_files[0]

    thumb_dir = populated_archive["thumbs"] / "gallery" / folder
    thumb_dir.mkdir(parents=True, exist_ok=True)
    (thumb_dir / f"{live_name}_384.jpg").write_bytes(b"jpg")
    (thumb_dir / "ghost.png_384.jpg").write_bytes(b"jpg")

    resp = client.post(f"/api/v1/galleries/{folder}/thumbs/prune")
    assert resp.status_code == 200
    body = resp.json()
    assert body["folder"] == folder
    assert body["removed"] == 1
    assert (thumb_dir / f"{live_name}_384.jpg").is_file()
    assert not (thumb_dir / "ghost.png_384.jpg").is_file()


def test_prune_thumbs_unknown_folder_removes_nothing(client, populated_archive):
    resp = client.post("/api/v1/galleries/NoSuchFolder_ABCDEFGHIJKL/thumbs/prune")
    assert resp.status_code == 200
    assert resp.json()["removed"] == 0


# ------------------------------------------------------------------
# POST /media/jobs -- 3C-2, the job runner (docs/PHASE_3C_PLAN.md §7)
# ------------------------------------------------------------------


def _poll_job(client, job_id: str, *, after: int = 0, timeout: float = 5.0) -> dict:
    """Poll until the job leaves queued/running. The worker runs on the
    TestClient's own portal loop, concurrently with these synchronous
    requests, so a real (short) wait loop is the honest way to test it."""
    import time

    deadline = time.monotonic() + timeout
    body = {"state": "queued"}
    while time.monotonic() < deadline:
        resp = client.get(f"/api/v1/media/jobs/{job_id}", params={"after": after})
        assert resp.status_code == 200
        body = resp.json()
        if body["state"] not in ("queued", "running"):
            return body
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish in time: {body}")


def test_media_job_runs_in_the_background_and_writes_the_manifest(client, populated_archive, stub_download_item):
    resp = client.post(
        "/api/v1/media/jobs",
        json={
            "card_id": "Bella_11112222.png",
            "items": [{"url": "https://cdn.example.com/x/pic.png"}],
            "prefix": "localized_media",
            "phase": "embedded",
        },
    )
    assert resp.status_code == 200
    job_id = resp.json()["job_id"]
    assert resp.json()["total"] == 1

    body = _poll_job(client, job_id)
    assert body["state"] == "done"
    assert body["saved"] == 1
    assert body["done"] == 1
    assert body["events"][0]["status"] == "saved"
    assert body["events"][0]["file"].startswith("localized_media_")

    folder = populated_archive["galleries"] / "Bella_BBBBBBBBBBBB"
    assert (folder / media_manifest.MANIFEST_NAME).is_file()


def test_media_job_events_cursor_only_returns_new_items(client, populated_archive, stub_download_item):
    resp = client.post(
        "/api/v1/media/jobs",
        json={
            "card_id": "Bella_11112222.png",
            "items": [{"url": "https://cdn.example.com/x/a.png"}, {"url": "https://cdn.example.com/x/b.png"}],
        },
    )
    job_id = resp.json()["job_id"]
    body = _poll_job(client, job_id)
    assert body["total"] == 2
    assert len(body["events"]) == 2

    # Re-polling with the cursor the first call handed back yields nothing new.
    resp = client.get(f"/api/v1/media/jobs/{job_id}", params={"after": body["next_cursor"]})
    assert resp.json()["events"] == []


def test_media_job_unknown_card_404s(client, populated_archive):
    resp = client.post(
        "/api/v1/media/jobs",
        json={"card_id": "NoSuchCard.png", "items": [{"url": "https://cdn.example.com/x.png"}]},
    )
    assert resp.status_code == 404


def test_media_job_unknown_job_id_404s(client, populated_archive):
    resp = client.get("/api/v1/media/jobs/does-not-exist")
    assert resp.status_code == 404


def test_cancel_unknown_job_404s(client, populated_archive):
    resp = client.post("/api/v1/media/jobs/does-not-exist/cancel")
    assert resp.status_code == 404


def test_cancel_stops_a_job_before_it_finishes_every_item(client, populated_archive, monkeypatch):
    """A slow-item stub gives the test a window to cancel mid-run."""
    import asyncio

    calls: list[str] = []

    async def slow_fake(client, gallery_dir, folder_name, *, url, filename_hint, prefix, index, index_state, manifest, ledger, thumbnail_store):
        calls.append(url)
        await asyncio.sleep(0.05)
        outcome = media_writer.DownloadOutcome("saved", url, file=f"localized_media_{index}_x.webp", bytes=1)
        media_manifest.record_saved(manifest, url, outcome.file, "deadbeef")
        return outcome

    monkeypatch.setattr(v1_media.media_writer, "download_item", slow_fake)

    resp = client.post(
        "/api/v1/media/jobs",
        json={
            "card_id": "Bella_11112222.png",
            "items": [{"url": f"https://cdn.example.com/{i}.png"} for i in range(5)],
        },
    )
    job_id = resp.json()["job_id"]

    # Give the worker a moment to start, then cancel.
    import time

    time.sleep(0.06)
    cancel_resp = client.post(f"/api/v1/media/jobs/{job_id}/cancel")
    assert cancel_resp.status_code == 200

    body = _poll_job(client, job_id)
    assert body["state"] == "cancelled"
    assert body["done"] < 5


def test_list_media_jobs_filters_by_card_and_active(client, populated_archive, stub_download_item):
    r1 = client.post(
        "/api/v1/media/jobs",
        json={"card_id": "Bella_11112222.png", "items": [{"url": "https://cdn.example.com/a.png"}]},
    )
    r2 = client.post(
        "/api/v1/media/jobs",
        json={"card_id": "Abbie_0d162f5f.png", "items": [{"url": "https://cdn.example.com/b.png"}]},
    )
    _poll_job(client, r1.json()["job_id"])
    _poll_job(client, r2.json()["job_id"])

    resp = client.get("/api/v1/media/jobs", params={"card_id": "Bella_11112222.png"})
    assert resp.status_code == 200
    jobs = resp.json()
    assert len(jobs) == 1
    assert jobs[0]["card_id"] == "Bella_11112222.png"
    assert jobs[0]["events"] == []  # list view omits per-item events

    resp = client.get("/api/v1/media/jobs", params={"active": True})
    assert resp.json() == []
