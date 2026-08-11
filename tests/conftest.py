"""Shared fixtures for the archive tests.

The archive under test is a real directory of real card PNGs -- built here rather
than mocked, because every bug this code has had came from the *bytes*: a JPEG
behind a `.png` name, a tEXt chunk stripped by a re-encode, a filename that
differs from its thumb only in case. A fake filesystem would have hidden all
three.
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from proxy import archive as archive_mod
from proxy import pngtools, thumbs
from proxy.api import v1
from proxy.config import settings


def card_png(
    name: str = "Test",
    *,
    size: tuple[int, int] = (64, 96),
    colour: tuple[int, int, int, int] = (120, 80, 200, 255),
    **fields: Any,
) -> bytes:
    """A V3 card PNG: real pixels, real tEXt chunks, both spec keys.

    `fields` go straight into the card's `data`, so a test says what it is about
    (`tags=[...]`, `extensions={...}`) and inherits a valid card around it.
    """
    data: dict[str, Any] = {
        "name": name,
        "description": f"{name} is a test character.",
        "personality": "",
        "scenario": "",
        "first_mes": f"Hello, I am {name}.",
        "mes_example": "",
        "creator": "tester",
        "creator_notes": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "alternate_greetings": [],
        "tags": [],
        "character_version": "1",
        "extensions": {},
    }
    data.update(fields)
    envelope = {"spec": "chara_card_v3", "spec_version": "3.0", "data": data, **data}

    buffer = io.BytesIO()
    Image.new("RGBA", size, colour).save(buffer, "PNG")
    payload = base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("ascii")
    return pngtools.inject_text_chunks(buffer.getvalue(), {"chara": payload, "ccv3": payload})


def jai_extensions(
    card_id: str = "0d162f5f-86ab-4fdd-a2c2-3912adf24960",
    *,
    gallery_id: str = "kzbYR2QbpncC",
    source_kind: str = "janitor_core",
    creator_name: str = "tester",
    page_name: str = "A Test Page | Test",
) -> dict[str, Any]:
    """The `extensions` block CardBuilder stamps on every card, which is where
    the index reads provenance from."""
    return {
        "gallery_id": gallery_id,
        "jai": {
            "id": card_id,
            "source_url": f"https://janitorai.com/characters/{card_id}",
            "sourceKind": source_kind,
            "creatorName": creator_name,
            "pageName": page_name,
            "linkedAt": "2026-07-21T17:31:47.257Z",
        },
    }


@pytest.fixture
def archive_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """An empty archive laid out exactly like `data/`, with settings pointed at
    it and the process-wide index reset so it is rebuilt against the temp dir."""
    dirs = {
        "characters": tmp_path / "characters",
        "galleries": tmp_path / "galleries",
        "thumbs": tmp_path / "cache" / "thumbs",
    }
    for path in dirs.values():
        path.mkdir(parents=True)
    monkeypatch.setattr(settings, "archive_dir", dirs["characters"])
    monkeypatch.setattr(settings, "galleries_dir", dirs["galleries"])
    monkeypatch.setattr(settings, "thumbs_dir", dirs["thumbs"])
    # The index and the thumbnail store are process-wide singletons bound at
    # import time; both have to be re-pointed or a test reads the real 3 GB
    # archive on the developer's machine and passes for the wrong reason.
    monkeypatch.setattr(archive_mod, "_index", None)
    monkeypatch.setattr(v1, "thumbnail_store", thumbs.ThumbnailStore(dirs["thumbs"], dirs["characters"]))
    return dirs


@pytest.fixture
def populated_archive(archive_dirs: dict[str, Path]) -> dict[str, Path]:
    """Three cards worth telling apart, and one gallery folder.

    Abbie has a gallery on disk and a lorebook; Bella has two alternate
    greetings and shares no tags; Cleo has no gallery folder despite carrying a
    gallery_id, which is the common real case (images never downloaded).
    """
    characters = archive_dirs["characters"]
    (characters / "Abbie_0d162f5f.png").write_bytes(
        card_png(
            "Abbie",
            tags=["Female", "Vampire"],
            creator="KornyPony",
            extensions=jai_extensions(creator_name="KornyPony"),
            character_book={"entries": [{"keys": ["a"], "content": "x"}, {"keys": ["b"], "content": "y"}]},
        )
    )
    (characters / "Bella_11112222.png").write_bytes(
        card_png(
            "Bella",
            tags=["Male"],
            creator="Someone Else",
            alternate_greetings=["hi", "hey"],
            creator_notes="notes here",
            mes_example="<START>\n{{user}}: hi",
            extensions=jai_extensions(
                "11112222-0000-0000-0000-000000000000",
                gallery_id="BBBBBBBBBBBB",
                source_kind="chub_import",
                creator_name="Someone Else",
                page_name="Bella the Second",
            ),
        )
    )
    (characters / "Cleo_33334444.png").write_bytes(
        card_png(
            "Cleo",
            tags=["Female"],
            creator="KornyPony",
            extensions=jai_extensions(
                "33334444-0000-0000-0000-000000000000",
                gallery_id="CCCCCCCCCCCC",
                creator_name="KornyPony",
            ),
        )
    )
    gallery = archive_dirs["galleries"] / "Abbie_kzbYR2QbpncC"
    gallery.mkdir()
    (gallery / "one.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 100)
    (gallery / "two.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 200)
    return archive_dirs


@pytest.fixture
def client(populated_archive: dict[str, Path]):
    """A TestClient over the real app, with the archive pointed at temp dirs.

    Imported inside the fixture so collecting a test module that does not use it
    never pays for importing the server (and never triggers its startup work).
    """
    from fastapi.testclient import TestClient

    from proxy.server import app

    with TestClient(app) as test_client:
        yield test_client
