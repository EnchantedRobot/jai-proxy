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
from proxy import gallery, pngtools
from proxy.cardbuilder import CardBuilder, PngWriter


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
        "extensions": {
            "chub": {"id": 4937471, "full_path": "SteakedGamer/tsuko", "pageName": "Tsuko"},
            "depth_prompt": {"prompt": "stay in character", "depth": 4},
            "fav": False,
        },
    }
    if gallery_id is not None:
        data["extensions"]["gallery_id"] = gallery_id
    return data


def _datacat_data(cid: str = "f901406d-c5bb-48d7-b37a-6815e94ee879") -> dict:
    return {
        "name": "Abigail",
        "creator": "toraval",
        "description": "The Queen of Dragons",
        "first_mes": "*Abigail enters.*",
        "creator_notes": "<p>a blurb</p>",
        "extensions": {"datacat": {"id": cid, "sourceKind": "janitor", "creatorName": "toraval", "pageName": "Abigail"}},
    }


def _jannyai_data(gallery_id: str | None = None) -> dict:
    data = {
        "name": "Abby",
        "creator": "@MathiDoos",
        "description": "A card about {{char}} meeting {{user}}.",
        "scenario": "{{user}} runs into {{char}}.",
        "first_mes": "Hey {{user}}, it's {{char}}.",
        "creator_notes": "<p>a blurb</p>",
        "tags": ["Female"],
        "extensions": {
            "jannyai": {
                "id": "c9630bdc-c851-4d90-a6e2-fc96a19b3e1a",
                "creatorUsername": "@MathiDoos",
                "slug": "character-abby",
                "pageName": "Abby",
                "tagline": "a blurb",
            }
        },
    }
    if gallery_id is not None:
        data["extensions"]["gallery_id"] = gallery_id
    return data


def _write_existing(cards_dir: Path, *, name: str, creator: str, cid: str, data: dict) -> Path:
    """Put a card on disk the way a prior (fuller) retrieval would -- through the
    real writer, so its filename and PNG structure match what an import looks
    for. compress=False keeps the pixel bytes deterministic for the diff check.

    The writer stamps a gallery_id on everything it writes, so when `data` itself
    carries none the stamped id is peeled back off: a card with no gallery_id is
    now by definition a *legacy* one (written before ids existed), and those are
    the only cards an import can still backfill into."""
    writer = PngWriter(output_dir=cards_dir, compress=False)
    source_had_id = gallery.read_id(data) is not None  # the write stamps one in place
    path = writer.write_payload(
        _envelope(data), _png_bytes((8, 8)), creator=creator, name=name, card_id=cid
    )
    if not source_had_id:
        raw = path.read_bytes()
        envelope, written = pngtools.read_envelope(raw)
        written["extensions"].pop("gallery_id", None)
        path.write_bytes(pngtools.embed_card(raw, envelope, written))
    return path


def _read_data(path: Path) -> dict:
    return pngtools.extract_embedded_card(path.read_bytes())


def _pixel_chunks(png: bytes):
    return [(t, d) for t, d in pngtools._iter_chunks(png) if t not in pngtools._TEXT_CHUNK_TYPES]


def _run_import(import_dir: Path, cards_dir: Path, monkeypatch, *extra: str) -> int:
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
            *extra,
        ],
    )
    return importer.main()


# The gallery_id accessor itself now lives in proxy/gallery.py (shared with the
# writer and the backfill script) -- see tests/test_gallery.py.


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
# _import_datacat -- optional original-avatar link via an image_resolver
# ---------------------------------------------------------------------------


class _FakeResolver:
    def __init__(self, url: str | None):
        self._url = url
        self.calls: list[str] = []

    def resolve(self, character_id: str) -> str | None:
        self.calls.append(character_id)
        return self._url


def test_import_datacat_leads_creator_notes_with_resolved_avatar(tmp_path):
    builder = CardBuilder()
    writer = PngWriter(output_dir=tmp_path, compress=False)
    resolver = _FakeResolver("https://ella.janitorai.com/bot-avatars/abc.webp")

    out, warnings = importer._import_datacat(
        builder, writer, _datacat_data(), _png_bytes(), "f901406d-c5bb-48d7-b37a-6815e94ee879", resolver
    )

    assert resolver.calls == ["f901406d-c5bb-48d7-b37a-6815e94ee879"]
    notes = _read_data(out)["creator_notes"]
    assert notes.startswith("![Abigail](https://ella.janitorai.com/bot-avatars/abc.webp)")
    assert not warnings


def test_import_datacat_notes_when_resolver_finds_nothing(tmp_path):
    builder = CardBuilder()
    writer = PngWriter(output_dir=tmp_path, compress=False)
    resolver = _FakeResolver(None)

    out, warnings = importer._import_datacat(
        builder, writer, _datacat_data(), _png_bytes(), "f901406d-c5bb-48d7-b37a-6815e94ee879", resolver
    )

    assert any("original avatar not recovered" in w for w in warnings)
    assert not _read_data(out)["creator_notes"].startswith("![")


def test_import_datacat_without_resolver_is_unchanged(tmp_path):
    builder = CardBuilder()
    writer = PngWriter(output_dir=tmp_path, compress=False)

    out, warnings = importer._import_datacat(
        builder, writer, _datacat_data(), _png_bytes(), "f901406d-c5bb-48d7-b37a-6815e94ee879"
    )

    assert not warnings
    assert not _read_data(out)["creator_notes"].startswith("![")


def test_main_fetch_datacat_images_flag_wires_resolver_and_closes_it(tmp_path, monkeypatch):
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()
    (imports / "abigail.png").write_bytes(_import_png(_datacat_data()))

    resolver = _FakeResolver("https://ella.janitorai.com/bot-avatars/xyz.webp")
    closed = []
    resolver.close = lambda: closed.append(True)
    monkeypatch.setattr(importer, "DatacatImageResolver", lambda: resolver)

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "import_cards.py",
            "--import-dir",
            str(imports),
            "--cards-dir",
            str(cards),
            "--no-compress",
            "--fetch-datacat-images",
        ],
    )
    assert importer.main() == 0

    written = sorted(cards.glob("**/*.png"))
    assert resolver.calls == ["f901406d-c5bb-48d7-b37a-6815e94ee879"]
    assert closed == [True]
    notes = _read_data(written[0])["creator_notes"]
    assert notes.startswith("![Abigail](https://ella.janitorai.com/bot-avatars/xyz.webp)")


def test_main_without_flag_never_constructs_resolver(tmp_path, monkeypatch):
    """Default run stays a pure offline batch -- DatacatImageResolver (which
    owns a live httpx.Client) must not even be instantiated."""
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()
    (imports / "abigail.png").write_bytes(_import_png(_datacat_data()))

    def _boom():
        raise AssertionError("DatacatImageResolver should not be constructed without the flag")

    monkeypatch.setattr(importer, "DatacatImageResolver", _boom)

    assert _run_import(imports, cards, monkeypatch) == 0


# ---------------------------------------------------------------------------
# _jannyai_extensions -- fresh JannyAI write keeps its block + a gallery_id
# ---------------------------------------------------------------------------


def test_jannyai_extensions_stamps_provenance_and_keeps_block():
    ext = importer._jannyai_extensions(_jannyai_data(gallery_id="GID7"), "MathiDoos")
    assert ext["jai"]["sourceKind"] == "jannyai_import"
    assert ext["jai"]["creatorName"] == "MathiDoos"
    assert ext["gallery_id"] == "GID7"
    # the "@handle", slug and tagline survive in the preserved block
    assert ext["jannyai"]["creatorUsername"] == "@MathiDoos"
    assert ext["jannyai"]["tagline"] == "a blurb"


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


def test_main_imports_jannyai_card(tmp_path, monkeypatch):
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    (imports / "Abby.png").write_bytes(_import_png(_jannyai_data(gallery_id="wdE3mtqqauvd")))

    assert _run_import(imports, cards, monkeypatch) == 0

    # Named from the character, suffixed with the id fragment.
    written = sorted(cards.glob("**/*.png"))
    assert written == [cards / "Abby_c9630bdc.png"]

    data = _read_data(written[0])
    assert data["name"] == "Abby"
    assert data.get("character_book") is None  # JannyAI carries no lorebook
    assert "{{char}}" in data["description"]  # macros preserved
    assert data["extensions"]["jai"]["sourceKind"] == "jannyai_import"
    assert data["extensions"]["gallery_id"] == "wdE3mtqqauvd"
    # creator_notes de-HTML'd on the way in
    assert "<p>" not in (data.get("creator_notes") or "")


def test_main_imports_chub_card(tmp_path, monkeypatch):
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    (imports / "tsuko.png").write_bytes(_import_png(_chub_data(gallery_id="f1AMBFO5oPUr")))

    assert _run_import(imports, cards, monkeypatch) == 0

    written = sorted(cards.glob("**/*.png"))
    assert written == [cards / "Tsuko_4937471.png"]

    data = _read_data(written[0])
    # A fresh extensions.jai provenance stamp, the same every other source gets.
    assert data["extensions"]["jai"] == {
        "source_url": "https://chub.ai/characters/SteakedGamer/tsuko",
        "id": "4937471",
        "sourceKind": "chub_import",
        "creatorName": "SteakedGamer",
        "pageName": "Tsuko",
        "linkedAt": data["extensions"]["jai"]["linkedAt"],
    }
    # Chub's own extensions block (id, gallery_id, depth_prompt, fav) survives.
    assert data["extensions"]["chub"]["id"] == 4937471
    assert data["extensions"]["gallery_id"] == "f1AMBFO5oPUr"
    assert data["extensions"]["depth_prompt"] == {"prompt": "stay in character", "depth": 4}
    assert data["extensions"]["fav"] is False


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


# ---------------------------------------------------------------------------
# --overwrite -- deliberate re-import over existing cards
# ---------------------------------------------------------------------------


def test_overwrite_replaces_an_existing_card(tmp_path, monkeypatch):
    """Without the flag an existing id is skipped; with it the card is rebuilt
    from the export. This is the path for re-dumping sources after a pipeline
    change (e.g. the creator-notes taming)."""
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    stale = _chub_data()
    stale["description"] = "stale text"
    _write_existing(cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=stale)

    fresh = _chub_data()
    fresh["description"] = "fresh text"
    (imports / "tsuko.png").write_bytes(_import_png(fresh))

    # default: left alone
    assert _run_import(imports, cards, monkeypatch) == 0
    assert _read_data(cards / "Tsuko_4937471.png")["description"] == "stale text"

    # --overwrite: rebuilt
    assert _run_import(imports, cards, monkeypatch, "--overwrite") == 0
    assert _read_data(cards / "Tsuko_4937471.png")["description"] == "fresh text"
    assert sorted(cards.glob("**/*.png")) == [cards / "Tsuko_4937471.png"]


def test_overwrite_keeps_the_on_disk_gallery_id(tmp_path, monkeypatch):
    """The gallery handle belongs to the archive, not the export -- an
    overwrite must not swap it for whatever the source happens to carry."""
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    _write_existing(
        cards,
        name="Tsuko",
        creator="SteakedGamer",
        cid="4937471",
        data=_chub_data(gallery_id="ONDISK00000a"),
    )
    (imports / "tsuko.png").write_bytes(_import_png(_chub_data(gallery_id="FROMEXPORT01")))

    assert _run_import(imports, cards, monkeypatch, "--overwrite") == 0
    assert _read_data(cards / "Tsuko_4937471.png")["extensions"]["gallery_id"] == "ONDISK00000a"


def test_overwrite_prunes_a_card_renamed_upstream(tmp_path, monkeypatch):
    """The filename is `<name>_<id8>.png`; only the id half is stable. A rename
    would otherwise leave the old file behind and fork the card in two."""
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    _write_existing(
        cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data()
    )

    renamed = _chub_data()
    renamed["name"] = "Tsuko Reborn"
    (imports / "tsuko.png").write_bytes(_import_png(renamed))

    assert _run_import(imports, cards, monkeypatch, "--overwrite") == 0
    assert sorted(cards.glob("**/*.png")) == [cards / "Tsuko_Reborn_4937471.png"]


def test_overwrite_leaves_unrelated_cards_alone(tmp_path, monkeypatch):
    """Pruning keys on the id fragment, so a different card must survive."""
    cards = tmp_path / "cards"
    imports = tmp_path / "import"
    imports.mkdir()

    other = _chub_data()
    other["name"] = "Someone Else"
    other["extensions"]["chub"]["id"] = 9999999
    neighbour = _write_existing(
        cards, name="Someone Else", creator="SteakedGamer", cid="9999999", data=other
    )
    _write_existing(
        cards, name="Tsuko", creator="SteakedGamer", cid="4937471", data=_chub_data()
    )
    (imports / "tsuko.png").write_bytes(_import_png(_chub_data()))

    assert _run_import(imports, cards, monkeypatch, "--overwrite") == 0
    assert neighbour.exists()
