import json
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

from proxy.html_md import clean_tag, html_to_md, normalize_quotes, serialize_md, tidy_text

FIXTURES = Path(__file__).parent / "fixtures"


def _load_character(name: str) -> dict:
    return json.loads((FIXTURES / "hampter" / f"{name}.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# clean_tag -- real emoji-prefixed tag chips (SillyTavern can't render emoji
# in tags, so the JanitorAI tag names must be stripped down to plain words).
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
# Small text utilities.
# ---------------------------------------------------------------------------


def test_normalize_quotes_folds_typographic_quotes():
    assert normalize_quotes("“hi” ‘there’") == '"hi" \'there\''


def test_tidy_text_collapses_blank_runs_and_trailing_space():
    assert tidy_text("a  \n\n\n\nb   \n") == "a\n\nb"


# ---------------------------------------------------------------------------
# rich_to_md / serialize_md -- markdown serialization of authored HTML.
# Synthetic cases cover the structural branches (headings/code/hr/links);
# the real end-to-end path is exercised by html_to_md below.
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# html_to_md -- the one HTML->markdown path left after the JSON refactor:
# a character's `description` blurb -> creator_notes.
# ---------------------------------------------------------------------------


def test_html_to_md_empty_and_blank_is_empty():
    assert html_to_md("") == ""
    assert html_to_md("   ") == ""


def test_html_to_md_converts_real_description_blurb():
    akane = _load_character("open_akane_kujo")
    md = html_to_md(akane["description"])

    assert md.startswith("You're not dating yet.")
    assert "fox girl" in md
    # Real markdown out, no raw block-level HTML tags leaking through.
    for tag in ("<p>", "<div>", "<h1>", "<strong>", "<img"):
        assert tag not in md
    # The blurb's embedded images survive as markdown image syntax.
    assert "![" in md
