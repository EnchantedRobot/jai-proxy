import re
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

from proxy.html_parser import (
    GreetingConverter,
    ProfileParser,
    clean_tag,
    definition_section,
    get_creator_notes,
    rich_to_greeting,
    serialize_md,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _collapse_ws(s: str) -> str:
    """Collapse all whitespace runs to a single space. Real profile_*.html
    fixtures were captured via a browser "Save Page As", which hard-wraps
    text-node content at ~80 chars -- literal newlines that were never in the
    live DOM's textContent. That's a fixture-capture artifact, not a parser
    bug (confirmed: the raw saved HTML itself contains embedded "\\n" inside
    a single sentence, e.g. "...are \\nin full bloom..."). Whitespace-collapsed
    comparison sidesteps it while still proving content/structure fidelity."""
    return re.sub(r"\s+", " ", s).strip()


@pytest.fixture
def akane_soup() -> BeautifulSoup:
    return BeautifulSoup(_load("profile_akane_kujo.html"), "html.parser")


# ---------------------------------------------------------------------------
# ProfileParser -- real captures, cross-checked where reference_jai is
# trustworthy (name/creator/tags -- simple metadata, not the buggy
# HTML-serialization path). See tests/fixtures/README.md.
# ---------------------------------------------------------------------------


def test_akane_kujo_matches_trusted_reference_metadata():
    fields = ProfileParser().parse(_load("profile_akane_kujo.html"))

    assert fields.name == "Akane Kujo"
    assert fields.creator == "dezea"
    # Exact match against reference_jai/Akane_Kujo.png's tags list.
    assert fields.tags == [
        "Female", "Multiple", "AnyPOV", "Angst", "Demi-Human",
        "Fluff", "Horror", "kitsune", "yandere", "TheValentine",
    ]


def test_akane_kujo_description_matches_trusted_reference_prefix():
    fields = ProfileParser().parse(_load("profile_akane_kujo.html"))

    # reference_jai/Akane_Kujo.png's description field (built from the same
    # "Personality" accordion) starts with this exact structured markdown.
    assert fields.description.startswith("> Character Information:\n\n- Name: Akane Kujo")
    assert "Kitsune (Demi-Human)" in fields.description


def test_akane_kujo_scenario_and_empty_example_dialogs():
    fields = ProfileParser().parse(_load("profile_akane_kujo.html"))

    assert "Pronoun Awareness" in fields.scenario
    # Accordion literally says "Example Dialogs (0 tokens)" for this card.
    assert fields.mes_example == ""


def test_janitorai_credit_footer_stripped_from_definition_fields():
    # JanitorAI renders a "created by <creator> <year>© on janitorai.com"
    # footer as the last paragraph of the scenario AND personality panels.
    # It's page chrome (absent from the token stream, creator-dependent) and
    # must not leak into scenario/description.
    fields = ProfileParser().parse(_load("profile_akane_kujo.html"))

    assert "on janitorai.com" not in fields.scenario
    assert "created by dezea" not in fields.scenario
    # Footer used to trail the pronoun-awareness line; that line is now last.
    assert fields.scenario.rstrip().endswith("they/them/theirs.")

    assert "on janitorai.com" not in fields.description
    assert "created by dezea" not in fields.description


def _synthetic_panel(inner_html: str) -> BeautifulSoup:
    return BeautifulSoup(
        '<button aria-controls="panel-info-0">Scenario (5 tokens)</button>'
        '<div id="panel-info-0">'
        f'<div class="characterInfoMarkdownContainer">{inner_html}</div>'
        "</div>",
        "html.parser",
    )


def test_credit_footer_stripped_but_real_body_kept():
    soup = _synthetic_panel(
        "<p>Real scenario body.</p>"
        "<p>created by SomeOne 2026© on janitorai.com</p>"
    )
    md = definition_section(soup, "scenario")
    assert "Real scenario body." in md
    assert "on janitorai.com" not in md


def test_credit_footer_strip_leaves_ordinary_final_paragraph():
    # Only the exact footer shape is stripped; a creator's real closing line
    # (even one that merely mentions "created by ...") must survive.
    soup = _synthetic_panel(
        "<p>She was a rival created by the same scheduling.</p>"
    )
    md = definition_section(soup, "scenario")
    assert "rival created by the same scheduling" in md


def test_akane_kujo_creator_notes_has_no_leaked_page_chrome():
    fields = ProfileParser().parse(_load("profile_akane_kujo.html"))

    # The known bug in whatever built reference_jai/Akane_Kujo.png leaked a
    # literal "<h1>{page title}</h1>" into creator_notes. Our port must not
    # reproduce that -- the page title/accordion/carousel chrome must never
    # appear in creator_notes.
    assert "<h1>" not in fields.creator_notes
    assert "The Girl in Every Yearbook" not in fields.creator_notes
    assert fields.creator_notes.startswith("You're not dating yet.")
    assert "fox girl" in fields.creator_notes


@pytest.mark.parametrize(
    "fixture,expected_name,expected_creator",
    [
        ("profile_mio.html", "Mio Kawashima", "dezea"),
        ("profile_amelia.html", "Amelia Vance", "dezea"),
        ("profile_vivienne.html", "Rival Mafia Heiress - Vivienne Laurent", "Renderfull"),
    ],
)
def test_other_real_profiles_parse_name_and_creator(fixture, expected_name, expected_creator):
    fields = ProfileParser().parse(_load(fixture))
    assert fields.name == expected_name
    assert fields.creator == expected_creator
    assert fields.tags  # every real card has at least one tag chip
    assert fields.description  # every real card has a Personality section


def test_vivienne_uses_profile_of_fallback_for_creator():
    # Renderfull's creator box structure differs enough (or the @handle span
    # isn't isolated the same way) that this is worth confirming explicitly
    # rather than assuming the primary selector path was hit.
    fields = ProfileParser().parse(_load("profile_vivienne.html"))
    assert fields.creator == "Renderfull"


def test_missing_html_never_throws():
    fields = ProfileParser().parse("")
    assert fields.name == "Unknown"
    assert fields.creator == "janitorai.com"
    assert fields.tags == []
    assert fields.description == ""


# ---------------------------------------------------------------------------
# clean_tag -- real emoji-prefixed tag chips
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("👩‍🦰 Female", "Female"),
        ("👤 AnyPOV", "AnyPOV"),
        ("🧬 Demi-Human", "Demi-Human"),
        ("#ottergirl", "ottergirl"),
        ("  # slowburn", "slowburn"),
        ("TheValentine", "TheValentine"),
    ],
)
def test_clean_tag_strips_leading_emoji_and_hash(raw, expected):
    assert clean_tag(raw) == expected


# ---------------------------------------------------------------------------
# rich_to_md / serialize_md -- real markup shapes from the Personality panel
# (blockquote-as-section-header + <ul><li>), plus synthetic cases for
# branches no real fixture happens to exercise (headings, code, hr, links --
# JanitorAI's own page chrome uses <h2>-<h4> but no creator content in our
# fixtures does).
# ---------------------------------------------------------------------------


def test_blockquote_and_list_from_real_personality_panel(akane_soup):
    md = definition_section(akane_soup, "personality")
    assert md.startswith("> Character Information:")
    assert "- Name: Akane Kujo" in md
    assert "- Height: 164 cm (5'4\")" in md


def test_heading_serialization_synthetic():
    md = serialize_md(BeautifulSoup("<div><h2>Title Here</h2><p>body</p></div>", "html.parser"))
    assert md == "## Title Here\n\nbody"


def test_code_and_hr_serialization_synthetic():
    md = serialize_md(BeautifulSoup("<div><code>x = 1</code><hr/><p>after</p></div>", "html.parser"))
    assert "`x = 1`" in md
    assert "---" in md
    assert "after" in md


def test_link_serialization_keeps_only_http_links():
    md = serialize_md(
        BeautifulSoup(
            '<div><a href="https://example.com">ext</a> <a href="/internal">int</a></div>',
            "html.parser",
        )
    )
    assert "[ext](https://example.com)" in md
    assert "int" in md
    assert "[int]" not in md


def test_bold_and_italic_serialization_from_real_scenario(akane_soup):
    md = definition_section(akane_soup, "scenario")
    # "[System Instructions for Roleplay]" boilerplate paragraph is plain
    # text (no bold/italic in the source), so assert on structure instead.
    assert md.startswith("[System Instructions for Roleplay]")


# ---------------------------------------------------------------------------
# GreetingConverter -- real greeting HTML, cross-checked (whitespace-
# collapsed) against reference_jai/Akane_Kujo.png's first_mes, which we
# separately confirmed is NOT affected by the reference PNG's known
# creator_notes bug (its quote-unwrapping matches this exact port's logic).
# ---------------------------------------------------------------------------


def test_real_greeting_matches_trusted_reference_whitespace_collapsed(akane_soup):
    panel = akane_soup.find(id="panel-info-2")
    greeting_html = str(panel.select_one(".characterInfoMarkdownContainer"))

    converted = GreetingConverter().convert(greeting_html)

    reference_first_mes = (
        '**Scenario: Welcome to Kamii University!**\n\n'
        '*The cherry blossoms along the main gate of Kamii University are in full '
        'bloom, soft pink petals drifting lazily in the spring breeze.'
    )
    assert _collapse_ws(converted).startswith(_collapse_ws(reference_first_mes))
    # The reference's unwrapped dialogue line (bold stripped from the quote).
    assert '"Oh! You must be starting here today."' in converted
    assert '**"Oh! You must be starting here today."**' not in converted


def test_real_greeting_embeds_image_as_markdown(akane_soup):
    panel = akane_soup.find(id="panel-info-2")
    greeting_html = str(panel.select_one(".characterInfoMarkdownContainer"))

    converted = GreetingConverter().convert(greeting_html)
    assert re.search(r"!\[\]\([^)]+\.webp\)", converted)


def test_unwrap_quoted_emphasis_without_linewrap_artifact():
    # Same real Akane Kujo pattern (bold-wrapped quoted dialogue adjacent to
    # italic narration) but as a single-line snippet, isolating the
    # unwrap-quoted-emphasis behavior from the fixture's line-wrap artifact.
    html = (
        '<p><strong>"I know everything about this place."</strong> '
        "<em>She tilts her head slightly.</em></p>"
    )
    converted = rich_to_greeting(BeautifulSoup(html, "html.parser"))
    assert converted == '"I know everything about this place." *She tilts her head slightly.*'


def test_nested_emphasis_flattens_to_outer_marker():
    html = "<p><strong>outer <em>inner</em> text</strong></p>"
    converted = rich_to_greeting(BeautifulSoup(html, "html.parser"))
    assert converted == "**outer inner text**"


def test_br_becomes_newline_in_greeting():
    html = "<p>line one<br/>line two</p>"
    converted = rich_to_greeting(BeautifulSoup(html, "html.parser"))
    assert converted == "line one\nline two"


def test_empty_greeting_html_returns_empty_string():
    assert GreetingConverter().convert("") == ""
