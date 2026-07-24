"""Import-pipeline behaviour that isn't a mapper concern: the gallery_id
backfill. A legacy export (datacat/Chub) is never allowed to overwrite an
already-on-disk card, but if it carries an `extensions.gallery_id` the on-disk
card lacks, that one field is patched into the existing card in place -- pixels
and every other field untouched -- instead of the import simply being dropped.

Exercised end to end through `main()` (a real import dir + cards dir) plus unit
coverage of the pieces (_gallery_id, PngWriter.find, _backfill_gallery_id).
"""

import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

import scripts.import_cards as importer
from proxy import pngtools
from proxy.cardbuilder import PngWriter


def _envelope(data: dict) -> dict:
    """The chara_card_v3 envelope a writer emits: spec header + V2 mirror."""
    env = {"spec": "chara_card_v3", "spec_version": "3.0", "data": data}
    env.update(data)
    return env


def _png_bytes(size: tuple[int, int] = (4, 4)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (10, 20, 30, 255)).save(buf, "PNG")
    return buf.getvalue()


def _import_png(data: dict) -> bytes:
    """A legacy-export PNG: a small avatar carrying `data` as a ccv3/chara card."""
    payload = base64.b64encode(json.dumps(_envelope(data)).encode()).decode("ascii")
    return pngtools.inject_text_chunks(_png_bytes(), {"chara": payload, "ccv3": payload})


def _chub_data(gallery_id: str | None = None) -> dict:
    data = {
        "name": "Tsuko",
        "creator": "SteakedGamer",
        "description": "hello",
        "extensions": {"chub": {"id": 4937471}},
    }
    if gallery_id is not None:
        data["extensions"]["gallery_id"] = gallery_id
    return data


def _write_existing(cards_dir: Path, *, name: str, creator: str, cid: str, data: dict) -> Path:
    """Put a card on disk the way a prior (fuller) retrieval would -- through the
    real writer, so its filename and PNG structure match what an import looks
    for. compress=False keeps the pixel bytes deterministic for the diff check."""
    writer = PngWriter(output_dir=cards_dir, compress=False)
    return writer.write_payload(
        _envelope(data), _png_bytes((8, 8)), creator=creator, name=name, card_id=cid
    )


def _read_data(path: Path) -> dict:
    return pngtools.extract_embedded_card(path.read_bytes())


def _pixel_chunks(png: bytes):
    return [(t, d) for t, d in pngtools._iter_chunks(png) if t not in pngtools._TEXT_CHUNK_TYPES]


def _run_import(import_dir: Path, cards_dir: Path, monkeypatch) -> int:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "import_cards.py",
            "--import-dir",
            str(import_dir),
            "--cards-dir",
            str(cards_dir),
            "--no-compress",
        ],
    )
    return importer.main()


# ---------------------------------------------------------------------------
# _gallery_id accessor
# ---------------------------------------------------------------------------


def test_gallery_id_present_absent_and_empty():
    assert importer._gallery_id({"extensions": {"gallery_id": "f1AMBFO5oPUr"}}) == "f1AMBFO5oPUr"
    assert importer._gallery_id({"extensions": {"chub": {"id": 1}}}) is None
    assert importer._gallery_id({}) is None
    assert importer._gallery_id({"extensions": {"gallery_id": ""}}) is None
    assert importer._gallery_id({"extensions": None}) is None


# ---------------------------------------------------------------------------
# PngWriter.find -- locate the card an import would skip
# ---------------------------------------------------------------------------


def test_find_matches_name_and_id(tmp_path):
    cards = tmp_path / "cards"
    path = _write_existing(cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data())
    writer = PngWriter(output_dir=cards, compress=False)
    assert writer.find("Tsuko", "4937471") == [path]


def test_find_wont_match_different_name(tmp_path):
    cards = tmp_path / "cards"
    _write_existing(cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data())
    writer = PngWriter(output_dir=cards, compress=False)
    # Same id fragment, different name -> no match (safer than patching a neighbour).
    assert writer.find("Someone Else", "4937471") == []
    assert writer.find("Tsuko", "") == []  # no usable id fragment


# ---------------------------------------------------------------------------
# _backfill_gallery_id -- the in-place patch
# ---------------------------------------------------------------------------


def test_backfill_adds_field_and_preserves_pixels(tmp_path):
    cards = tmp_path / "cards"
    path = _write_existing(cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data())
    before = path.read_bytes()

    assert importer._backfill_gallery_id(path, "GID999") == "added"

    after = _read_data(path)
    assert after["extensions"]["gallery_id"] == "GID999"
    assert after["name"] == "Tsuko"  # everything else intact
    assert after["description"] == "hello"
    # Only the tEXt chunks changed; the avatar pixels are byte-identical.
    assert _pixel_chunks(path.read_bytes()) == _pixel_chunks(before)


def test_backfill_leaves_existing_gallery_id_untouched(tmp_path):
    cards = tmp_path / "cards"
    data = _chub_data(gallery_id="ORIGINAL")
    path = _write_existing(cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=data)

    assert importer._backfill_gallery_id(path, "NEWER") == "present"
    assert _read_data(path)["extensions"]["gallery_id"] == "ORIGINAL"


def test_backfill_reports_unreadable(tmp_path):
    plain = tmp_path / "plain.png"
    plain.write_bytes(_png_bytes())  # a PNG with no embedded card
    assert importer._backfill_gallery_id(plain, "GID") == "unreadable"


# ---------------------------------------------------------------------------
# _datacat_extensions -- fresh datacat write keeps a source gallery_id
# ---------------------------------------------------------------------------


def test_datacat_extensions_preserves_gallery_id():
    data = {"extensions": {"datacat": {"id": "abc"}, "gallery_id": "GID42"}}
    ext = importer._datacat_extensions(data, "creator")
    assert ext["gallery_id"] == "GID42"
    assert ext["jai"]["sourceKind"] == "datacat_import"


def test_datacat_extensions_omits_absent_gallery_id():
    ext = importer._datacat_extensions({"extensions": {"datacat": {"id": "abc"}}}, "creator")
    assert "gallery_id" not in ext


# ---------------------------------------------------------------------------
# main() -- the whole flow
# ---------------------------------------------------------------------------


def test_main_backfills_gallery_id_into_existing_card(tmp_path, monkeypatch):
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    # An existing (fuller) card with no gallery_id...
    existing = _write_existing(
        cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data()
    )
    before = existing.read_bytes()

    # ...and a legacy Chub export of the same character that carries one.
    (imports / "tsuko.png").write_bytes(_import_png(_chub_data(gallery_id="f1AMBFO5oPUr")))

    assert _run_import(imports, cards, monkeypatch) == 0

    # No new card was written; the existing one gained the gallery_id in place.
    assert sorted(cards.glob("**/*.png")) == [existing]
    patched = _read_data(existing)
    assert patched["extensions"]["gallery_id"] == "f1AMBFO5oPUr"
    assert _pixel_chunks(existing.read_bytes()) == _pixel_chunks(before)


def test_main_skips_when_import_has_no_gallery_id(tmp_path, monkeypatch):
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    existing = _write_existing(
        cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data()
    )
    (imports / "tsuko.png").write_bytes(_import_png(_chub_data()))  # no gallery_id

    assert _run_import(imports, cards, monkeypatch) == 0
    assert "gallery_id" not in _read_data(existing).get("extensions", {})
