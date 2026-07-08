import base64
import io
import json
from pathlib import Path

from bs4 import BeautifulSoup
from PIL import Image

from proxy.cardbuilder import CardBuilder, PngWriter, _safe_filename
from proxy.html_parser import GreetingConverter, ProfileParser
from proxy.models import CaptureRecord, CharacterBook, LoreEntry, ProfileFields

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (16, 16), (5, 5, 5, 255)).save(buf, "PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# CardBuilder -- real Akane Kujo profile fixture (public card: visible DOM
# values should win outright since there's no capture).
# ---------------------------------------------------------------------------


def test_build_public_card_from_real_profile_fixture():
    profile = ProfileParser().parse(_load("profile_akane_kujo.html"))
    card, warnings = CardBuilder().build(profile, greetings=[], capture=None, book=None)

    assert card.name == "Akane Kujo"
    assert card.creator == "dezea"
    assert card.description.startswith("> Character Information:")
    assert "Pronoun Awareness" in card.scenario
    assert card.personality == ""
    assert "no first_mes / greetings found" in warnings


def test_build_maps_greetings_to_first_mes_and_alternates():
    # CardBuilder consumes already-converted greeting markdown (the server
    # route runs GreetingConverter first); it only sanitizes macros here.
    profile = ProfileFields(name="Test", description="d", scenario="s")
    card, _ = CardBuilder().build(
        profile, greetings=["Hello **there**", "Second greeting"], capture=None, book=None
    )
    assert card.first_mes == "Hello **there**"
    assert card.alternate_greetings == ["Second greeting"]


# ---------------------------------------------------------------------------
# Hidden-card precedence: empty DOM def + capture -> capture fills the gap.
# ---------------------------------------------------------------------------


def test_hidden_capture_fills_gap_when_dom_definition_empty():
    profile = ProfileFields(name="Lyra", description="", scenario="", mes_example="")
    capture = CaptureRecord(
        name="Lyra",
        personality="hidden personality text",
        scenario="hidden scenario text",
        mes_example="hidden mes example text",
        raw_system_prompt="<Lyra's Persona>hidden personality text</Lyra's Persona>",
    )
    card, warnings = CardBuilder().build(profile, greetings=[], capture=capture, book=None)

    assert card.description == "hidden personality text"
    assert card.scenario == "hidden scenario text"
    assert card.mes_example == "hidden mes example text"
    assert "no description/scenario/example dialogs found" not in warnings


def test_visible_dom_value_wins_over_capture_when_both_present():
    profile = ProfileFields(name="Lyra", description="visible wins")
    capture = CaptureRecord(name="Lyra", personality="hidden loses")
    card, _ = CardBuilder().build(profile, greetings=[], capture=capture, book=None)
    assert card.description == "visible wins"


def test_capture_name_used_when_profile_name_missing():
    profile = ProfileFields(name="")
    capture = CaptureRecord(name="Captured Name")
    card, _ = CardBuilder().build(profile, greetings=[], capture=capture, book=None)
    assert card.name == "Captured Name"


# ---------------------------------------------------------------------------
# Macro sanitization + warnings
# ---------------------------------------------------------------------------


def test_unresolved_macro_surfaces_as_warning():
    profile = ProfileFields(name="X", description="hello {{waifu}} friend", scenario="s")
    card, warnings = CardBuilder().build(profile, greetings=[], capture=None, book=None)
    assert card.description == "hello {{waifu}} friend"
    assert "unresolved macro: {{waifu}}" in warnings


def test_known_pronoun_macro_folds_without_warning():
    profile = ProfileFields(name="X", description="hi {obj}, love {{poss}}", scenario="s")
    card, warnings = CardBuilder().build(profile, greetings=[], capture=None, book=None)
    assert card.description == "hi {{user}}, love {{user}}"
    assert not any("unresolved macro" in w for w in warnings)


# ---------------------------------------------------------------------------
# character_book passthrough
# ---------------------------------------------------------------------------


def test_character_book_attached_when_provided():
    profile = ProfileFields(name="X", description="d", scenario="s")
    book = CharacterBook(name="lore", entries=[LoreEntry(keys=["k"], content="c")])
    card, _ = CardBuilder().build(profile, greetings=[], capture=None, book=book)
    assert card.character_book is book


# ---------------------------------------------------------------------------
# _safe_filename
# ---------------------------------------------------------------------------


def test_safe_filename_strips_unsafe_characters():
    assert _safe_filename("Rival Mafia Heiress - Vivienne Laurent") == "Rival_Mafia_Heiress_-_Vivienne_Laurent"
    assert _safe_filename("   ") == "unnamed"
    assert _safe_filename("Akane Kujo") == "Akane_Kujo"


# ---------------------------------------------------------------------------
# PngWriter -- round trip: write -> reopen -> read chunks back -> JSON equal.
# ---------------------------------------------------------------------------


def test_png_writer_round_trips_card_json(tmp_path):
    profile = ProfileParser().parse(_load("profile_akane_kujo.html"))
    greeting_html = str(
        BeautifulSoup(_load("profile_akane_kujo.html"), "html.parser")
        .find(id="panel-info-2")
        .select_one(".characterInfoMarkdownContainer")
    )
    greeting = GreetingConverter().convert(greeting_html)
    card, _ = CardBuilder().build(profile, greetings=[greeting], capture=None, book=None)

    writer = PngWriter(output_dir=tmp_path)
    path = writer.write(card, _png_bytes())

    assert path.parent == tmp_path
    assert path.name == "Akane_Kujo.png"
    assert path.exists()

    reopened = Image.open(path)
    assert reopened.text["chara"] == reopened.text["ccv3"]
    decoded = json.loads(base64.b64decode(reopened.text["ccv3"]))
    assert decoded == card.to_dict()
    assert decoded["data"]["name"] == "Akane Kujo"
    assert decoded["data"]["first_mes"].startswith("**Scenario: Welcome to Kamii University!**")


def test_png_writer_converts_non_png_avatar_source(tmp_path):
    # Simulate a webp avatar (JanitorAI avatars are typically .webp) --
    # PngWriter must still write a valid PNG with the chunks readable.
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 100, 50)).save(buf, "WEBP")
    webp_bytes = buf.getvalue()

    profile = ProfileFields(name="Webp Test", description="d")
    card, _ = CardBuilder().build(profile, greetings=[], capture=None, book=None)

    path = PngWriter(output_dir=tmp_path).write(card, webp_bytes)
    reopened = Image.open(path)
    assert reopened.format == "PNG"
    assert json.loads(base64.b64decode(reopened.text["chara"]))["data"]["name"] == "Webp Test"


def test_png_writer_creates_output_dir_if_missing(tmp_path):
    out_dir = tmp_path / "nested" / "cards"
    profile = ProfileFields(name="Nested")
    card, _ = CardBuilder().build(profile, greetings=[], capture=None, book=None)

    path = PngWriter(output_dir=out_dir).write(card, _png_bytes())
    assert path.exists()
    assert path.parent == out_dir
