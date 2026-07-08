from pathlib import Path

import pytest

from proxy.prompt_parser import SystemPromptParser

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture
def parser() -> SystemPromptParser:
    return SystemPromptParser()


# ---------------------------------------------------------------------------
# Real captures -- public-definition cards
# ---------------------------------------------------------------------------


def test_kira_public_card(parser):
    raw = _load("system_prompt_open_kira.txt")
    parsed = parser.parse(raw)

    assert parsed.name == "Kira"
    assert parsed.personality.startswith("## Kira description")
    assert "Tags/archetypes: edgy" in parsed.personality
    # No <Scenario> tag and no trailing content in this capture.
    assert parsed.scenario == ""
    assert parsed.mes_example.startswith("Kira knocked on USER's door")
    assert parsed.raw == raw


def test_sabrina_hill_public_card(parser):
    raw = _load("system_prompt_open_sabrina_hill.txt")
    parsed = parser.parse(raw)

    # Tag-derived name is best-effort -- "Sabrina's Persona" strips to
    # "Sabrina", not the full "Sabrina Hill" from inside the body. The DOM
    # (ProfileParser) is the source of truth for the full name; visible DOM
    # wins over the capture at merge time (cardbuilder, M3+).
    assert parsed.name == "Sabrina"
    assert parsed.personality.startswith("> Basic Information:")
    assert "Name: Sabrina Hill" in parsed.personality
    # No <example_dialogs> tag in this capture.
    assert parsed.mes_example == ""
    # <Scenario> content plus genuine trailing creator content (not inside
    # any tag) both fold into scenario.
    assert "It is a genuinely comfortable space" in parsed.scenario
    assert "Sex and Intimacy" in parsed.scenario
    assert parsed.raw == raw


def test_akane_kujo_public_card(parser):
    raw = _load("system_prompt_open_akane_kujo.txt")
    parsed = parser.parse(raw)

    assert parsed.name == "Akane Kujo"
    assert parsed.personality.startswith(">Character Information:")
    assert "Name: Akane Kujo" in parsed.personality
    # No <example_dialogs> tag in this capture (matches the DOM's "Example
    # Dialogs (0 tokens)" accordion for this same character).
    assert parsed.mes_example == ""
    assert "Pronoun Awareness" in parsed.scenario
    # Trailing creator-authored world-info block after </Scenario>.
    assert "Kamii University" in parsed.scenario
    assert parsed.raw == raw


# ---------------------------------------------------------------------------
# Real captures -- hidden-definition cards
# ---------------------------------------------------------------------------


def test_lyra_hidden_card(parser):
    raw = _load("system_prompt_hidden_lyra.txt")
    parsed = parser.parse(raw)

    assert parsed.name == "Lyra"
    assert "Full Name: Lyra Amarok" in parsed.personality
    assert parsed.scenario.startswith("Important settings for Roleplay")
    assert "NEVER, under ANY circumstances" in parsed.scenario
    assert parsed.mes_example == ""
    assert parsed.raw == raw


def test_lyra_and_lyra_2_agree_on_meaningful_fields(parser):
    # lyra vs lyra_2 differ only by one trailing whitespace character on a
    # line INSIDE the persona block -- a whitespace-tolerance edge case, not
    # a meaningful diff. That one character legitimately persists in the
    # extracted `personality` text (we only strip block boundaries, not
    # collapse internal whitespace), so compare whitespace-collapsed.
    lyra = parser.parse(_load("system_prompt_hidden_lyra.txt"))
    lyra_2 = parser.parse(_load("system_prompt_hidden_lyra_2.txt"))

    def collapse(s: str) -> str:
        return " ".join(s.split())

    assert lyra.name == lyra_2.name
    assert collapse(lyra.personality) == collapse(lyra_2.personality)
    assert collapse(lyra.scenario) == collapse(lyra_2.scenario)
    assert lyra.mes_example == lyra_2.mes_example
    assert lyra.raw != lyra_2.raw


def test_ari_hidden_card(parser):
    raw = _load("system_prompt_hidden_ari.txt")
    parsed = parser.parse(raw)

    assert parsed.name == "Ari"
    assert parsed.personality.startswith("Location: USA")
    assert "About Ari:" in parsed.personality
    # <Scenario> content plus the trailing "Ravenwood Academy" world-info
    # block (outside any tag) both fold into scenario.
    assert "final-year high school student" in parsed.scenario
    assert "Ravenwood Academy" in parsed.scenario
    assert parsed.mes_example.startswith("*Ari glanced down at her phone")
    assert parsed.raw == raw


def test_aubrey_evans_hidden_card(parser):
    raw = _load("system_prompt_hidden_aubrey_evans.txt")
    parsed = parser.parse(raw)

    assert parsed.name == "Aubrey Evans"
    assert parsed.personality.startswith("Aubrey Evans")
    assert "Her nickname is Ace" in parsed.personality
    assert parsed.scenario.startswith("setting: {The Regional Championship")
    assert parsed.mes_example.startswith("USER: *As her coach")
    assert parsed.raw == raw


# ---------------------------------------------------------------------------
# Graceful degradation on malformed / format-drifted input -- never throws,
# missing fields are just "". No real capture exhibits total tag loss, so
# these are synthetic worst-case fixtures.
# ---------------------------------------------------------------------------


def test_empty_prompt_never_throws(parser):
    parsed = parser.parse("")
    assert parsed.name == ""
    assert parsed.personality == ""
    assert parsed.scenario == ""
    assert parsed.mes_example == ""
    assert parsed.raw == ""


def test_none_prompt_never_throws(parser):
    parsed = parser.parse(None)
    assert parsed.name == ""
    assert parsed.raw == ""


def test_prompt_with_no_recognized_tags_is_untagged_prose(parser):
    raw = "Just some plain prose with no tags at all, JanitorAI format has drifted."
    parsed = parser.parse(raw)

    assert parsed.name == ""
    assert parsed.personality == ""
    assert parsed.scenario == ""
    assert parsed.mes_example == ""
    assert parsed.raw == raw


def test_unclosed_character_tag_takes_content_through_end(parser):
    raw = "<Foo's Persona>bar that never closes, format drifted mid-capture"
    parsed = parser.parse(raw)

    assert parsed.name == "Foo"
    assert parsed.personality == "bar that never closes, format drifted mid-capture"


def test_scenario_nested_inside_persona_is_not_duplicated(parser):
    raw = (
        "<X's Persona>before <Scenario>nested scenario text</Scenario> "
        "after</X's Persona>"
    )
    parsed = parser.parse(raw)

    assert parsed.name == "X"
    assert "nested scenario text" in parsed.personality
    # Not pulled out as a second, top-level scenario block.
    assert parsed.scenario == ""


def test_literal_backslash_n_is_converted_to_real_newlines(parser):
    raw = "<Y's Persona>line one\\nline two</Y's Persona>"
    parsed = parser.parse(raw)

    assert parsed.personality == "line one\nline two"
