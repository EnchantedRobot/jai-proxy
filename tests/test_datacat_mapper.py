"""datacat import mapping, validated against two real datacat card exports
(tests/fixtures/datacat/*.json -- the base64-decoded embedded card objects):

  * abigail       -- single greeting, no alternates (toraval)
  * alt_greetings -- Aoi, a first_mes plus 5 alternates (AlissaOne)
"""

import base64
import io
import json
from pathlib import Path

from PIL import Image

from proxy import datacat_mapper as mapper
from proxy import pngtools
from proxy.cardbuilder import CardBuilder

FIXTURES = Path(__file__).parent / "fixtures" / "datacat"


def load_obj(name: str) -> dict:
    """The full embedded card object ({spec, spec_version, data, ...mirror})."""
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def load_data(name: str) -> dict:
    return load_obj(name)["data"]


def png_with_card(obj: dict) -> bytes:
    """A minimal PNG carrying `obj` as a base64(JSON) `ccv3`/`chara` card, the
    way a datacat export does -- for exercising extract_card end to end."""
    buf = io.BytesIO()
    Image.new("RGBA", (1, 1)).save(buf, "PNG")
    payload = base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")
    return pngtools.inject_text_chunks(buf.getvalue(), {"chara": payload, "ccv3": payload})


# ---------------------------------------------------------------------------
# extract_card -- pull the embedded card back out of PNG bytes
# ---------------------------------------------------------------------------


def test_extract_card_roundtrips_embedded_card():
    data = mapper.extract_card(png_with_card(load_obj("abigail")))
    assert data is not None
    assert data["name"] == "Abigail"
    assert mapper.datacat_block(data)["id"] == "f901406d-c5bb-48d7-b37a-6815e94ee879"


def test_extract_card_prefers_ccv3_over_chara():
    # ccv3 is authoritative; a divergent chara chunk must not win.
    buf = io.BytesIO()
    Image.new("RGBA", (1, 1)).save(buf, "PNG")
    v3 = base64.b64encode(json.dumps({"data": {"name": "V3"}}).encode()).decode()
    v2 = base64.b64encode(json.dumps({"data": {"name": "V2"}}).encode()).decode()
    png = pngtools.inject_text_chunks(buf.getvalue(), {"chara": v2, "ccv3": v3})
    assert mapper.extract_card(png)["name"] == "V3"


def test_extract_card_returns_none_for_non_png():
    assert mapper.extract_card(b"not a png") is None


def test_extract_card_returns_none_without_card_chunk():
    buf = io.BytesIO()
    Image.new("RGBA", (1, 1)).save(buf, "PNG")
    assert mapper.extract_card(buf.getvalue()) is None


# ---------------------------------------------------------------------------
# to_profile_fields -- datacat puts the whole definition in `description`
# ---------------------------------------------------------------------------


def test_profile_fields_map_definition():
    fields = mapper.to_profile_fields(load_data("abigail"))
    assert fields.name == "Abigail"
    assert fields.creator == "toraval"
    assert fields.description.startswith("Name= Abigail")
    assert "{{user}}" in fields.scenario  # macros are intact
    assert "Royalty" in fields.tags


def test_creator_notes_are_dehtmled():
    data = load_data("abigail")
    assert "<p>" in (data["creator_notes"])  # raw datacat HTML in the source
    fields = mapper.to_profile_fields(data)
    assert fields.creator_notes  # present
    assert "<p>" not in fields.creator_notes  # ...but converted to markdown


# ---------------------------------------------------------------------------
# greetings -- first_mes first, then alternates
# ---------------------------------------------------------------------------


def test_greetings_single_when_no_alternates():
    greetings = mapper.greetings(load_data("abigail"))
    assert len(greetings) == 1
    assert greetings[0] == load_data("abigail")["first_mes"]


def test_greetings_primary_then_alternates():
    data = load_data("alt_greetings")
    greetings = mapper.greetings(data)
    assert greetings[0] == data["first_mes"]
    assert len(greetings) == 1 + len(data["alternate_greetings"])


# ---------------------------------------------------------------------------
# provenance accessors
# ---------------------------------------------------------------------------


def test_provenance_accessors():
    data = load_data("abigail")
    assert mapper.card_id(data) == "f901406d-c5bb-48d7-b37a-6815e94ee879"
    assert mapper.creator(data) == "toraval"
    assert mapper.page_name(data) == "Abigail"
    assert mapper.source_url(data) == (
        "https://janitorai.com/characters/f901406d-c5bb-48d7-b37a-6815e94ee879"
    )
    assert mapper.is_datacat(data) is True


def test_is_datacat_false_without_block():
    assert mapper.is_datacat({"name": "x"}) is False


# ---------------------------------------------------------------------------
# integration -- the mapped fields build a clean card through CardBuilder
# ---------------------------------------------------------------------------


def test_builds_card_with_macros_intact_and_no_book():
    data = load_data("abigail")
    profile = mapper.to_profile_fields(data)
    card, warnings = CardBuilder().build(
        profile, mapper.greetings(data), capture=None, book=None
    )
    assert card.name == "Abigail"
    assert card.description
    assert card.first_mes
    assert card.character_book is None  # datacat carries no lorebook
    assert "{{user}}" in card.scenario  # sanitizer preserves real macros
    assert "no first_mes" not in " ".join(warnings)
