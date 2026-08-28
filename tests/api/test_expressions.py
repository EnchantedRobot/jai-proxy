"""`/api/v1/expressions` -- the same list/get/thumb/upload/delete routes
`/api/v1/galleries` serves, mounted a second time over `data/expressions/`
(`proxy.api.v1.galleries.register_folder_routes`).

`tests/api/test_galleries.py` already proves the shared route logic works --
listing, file serving, thumbnailing, path-traversal rejection, revalidation.
This file only needs to prove three things specific to having *two* mounts:
the expressions mount actually works, it never reads or writes the gallery
root (or vice versa) even though a character can have both under the same
folder name, and the two expressions-only routes -- the detail view's
`expressions` field and the zip exports.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from proxy.config import settings


@pytest.fixture
def expressions_dir(populated_archive: dict[str, Path]) -> Path:
    return populated_archive["expressions"] / "Abbie_kzbYR2QbpncC"


def test_folders_are_claimed_the_same_way_as_galleries(client):
    folders = client.get("/api/v1/expressions").json()
    assert folders == [{"folder": "Abbie_kzbYR2QbpncC", "card_id": "Abbie_0d162f5f.png"}]


def test_files_are_listed_independently_of_the_gallery(client):
    listing = client.get("/api/v1/expressions/Abbie_kzbYR2QbpncC").json()
    names = sorted(f["name"] for f in listing["items"])
    assert names == ["joy-_00001_.webp", "neutral-_00001_.webp"]
    # The gallery folder of the same name carries different files -- the two
    # roots must never bleed into each other.
    gallery_listing = client.get("/api/v1/galleries/Abbie_kzbYR2QbpncC").json()
    assert sorted(f["name"] for f in gallery_listing["items"]) == ["one.jpg", "two.jpg"]


def test_a_missing_expressions_folder_is_a_404_and_is_not_created(client, populated_archive):
    assert client.get("/api/v1/expressions/Nobody_xxxxxxxxxxxx").status_code == 404
    assert not (populated_archive["expressions"] / "Nobody_xxxxxxxxxxxx").exists()


def test_upload_and_delete_round_trip_without_touching_the_gallery_cache(
    client, expressions_dir, populated_archive, tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "trash_dir", tmp_path / "trash")
    resp = client.post(
        "/api/v1/expressions/Abbie_kzbYR2QbpncC/files",
        files={"file": ("admiration-_00001_.webp", b"\xff\xd8\xff" + b"1" * 50, "image/webp")},
    )
    assert resp.status_code == 201
    assert (expressions_dir / "admiration-_00001_.webp").is_file()

    resp = client.delete("/api/v1/expressions/Abbie_kzbYR2QbpncC/files/admiration-_00001_.webp")
    assert resp.status_code == 204
    assert not (expressions_dir / "admiration-_00001_.webp").is_file()
    # Never binned into the gallery's trash path or thumb cache.
    assert (populated_archive["galleries"] / "Abbie_kzbYR2QbpncC" / "one.jpg").is_file()


def test_expression_thumbnails_cache_under_their_own_root(client, expressions_dir, populated_archive):
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (400, 400), (10, 20, 30)).save(buffer, "JPEG")
    (expressions_dir / "big.jpg").write_bytes(buffer.getvalue())

    resp = client.get("/api/v1/expressions/Abbie_kzbYR2QbpncC/files/big.jpg/thumb")
    assert resp.status_code == 200
    cached = populated_archive["thumbs"] / "expression" / "Abbie_kzbYR2QbpncC" / "big.jpg_288.webp"
    assert cached.is_file()
    assert not (populated_archive["thumbs"] / "gallery" / "Abbie_kzbYR2QbpncC" / "big.jpg_288.webp").exists()


def test_expression_paths_cannot_escape_the_expressions_root(client):
    for attempt in ("..", "../..", "%2e%2e"):
        assert client.get(f"/api/v1/expressions/{attempt}").status_code in (400, 404)


# --- the detail view ---------------------------------------------------------


def test_card_detail_reports_the_expressions_folder_alongside_the_gallery(client):
    detail = client.get("/api/v1/characters/Abbie_0d162f5f.png").json()
    assert detail["expressions"]["exists"] is True
    assert detail["expressions"]["folder"] == "Abbie_kzbYR2QbpncC"
    assert detail["expressions"]["images"] == 2
    assert detail["gallery"]["exists"] is True
    # The client must never build this path itself -- see test_galleries.py.
    assert detail["expressions_zip_url"] == "/api/v1/characters/Abbie_0d162f5f.png/expressions.zip"
    assert client.get(detail["expressions_zip_url"]).status_code == 200


def test_card_detail_reports_no_expressions_folder_for_a_card_without_one(client):
    detail = client.get("/api/v1/characters/Bella_11112222.png").json()
    assert detail["expressions"]["exists"] is False
    assert detail["expressions"]["images"] == 0
    assert detail["expressions_zip_url"] is None


# --- zip export ---------------------------------------------------------------


def test_single_character_zip_is_flat_at_the_root(client):
    import io
    import zipfile

    resp = client.get("/api/v1/characters/Abbie_0d162f5f.png/expressions.zip")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    names = sorted(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())
    assert names == ["joy-_00001_.webp", "neutral-_00001_.webp"]


def test_single_character_zip_404s_for_a_card_with_no_expressions(client):
    resp = client.get("/api/v1/characters/Bella_11112222.png/expressions.zip")
    assert resp.status_code == 404


def test_many_character_zip_nests_under_the_on_disk_folder_name(client, populated_archive):
    import io
    import zipfile

    other = populated_archive["expressions"] / "Cleo_CCCCCCCCCCCC"
    other.mkdir()
    (other / "neutral-_00001_.webp").write_bytes(b"\xff\xd8\xff" + b"2" * 40)

    resp = client.get(
        "/api/v1/expressions/export.zip",
        params=[("id", "Abbie_0d162f5f.png"), ("id", "Cleo_33334444.png")],
    )
    assert resp.status_code == 200
    names = sorted(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())
    assert names == [
        "Abbie_kzbYR2QbpncC/joy-_00001_.webp",
        "Abbie_kzbYR2QbpncC/neutral-_00001_.webp",
        "Cleo_CCCCCCCCCCCC/neutral-_00001_.webp",
    ]


def test_many_character_zip_skips_ids_with_no_expressions_folder(client):
    """Bella has no expressions folder at all -- she is silently left out
    rather than failing the whole export, the same "broken-not-skipped"
    posture the archive index takes elsewhere, applied to a request that asks
    for several characters at once and gets what exists."""
    import io
    import zipfile

    resp = client.get(
        "/api/v1/expressions/export.zip",
        params=[("id", "Abbie_0d162f5f.png"), ("id", "Bella_11112222.png")],
    )
    assert resp.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
    assert all(n.startswith("Abbie_kzbYR2QbpncC/") for n in names)


def test_many_character_zip_404s_when_nothing_has_expressions(client):
    resp = client.get("/api/v1/expressions/export.zip", params=[("id", "Bella_11112222.png")])
    assert resp.status_code == 404


def test_many_character_zip_requires_at_least_one_id(client):
    assert client.get("/api/v1/expressions/export.zip").status_code == 422
