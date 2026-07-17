from __future__ import annotations

import re

from bs4 import BeautifulSoup, Comment
from bs4.element import NavigableString, PageElement, Tag

# ---------------------------------------------------------------------------
# Small text utilities (ported from janitorai-export.user.js)
# ---------------------------------------------------------------------------

_QUOTE_MAP = str.maketrans(
    {
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "″": '"',
        "‘": "'",
        "’": "'",
        "‛": "'",
        "′": "'",
    }
)


def normalize_quotes(s: str) -> str:
    return s.translate(_QUOTE_MAP)


def tidy_text(s: str) -> str:
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def clean_tag(t: str) -> str:
    """Strip a leading emoji / "#" / punctuation run from a tag chip's text
    so "\U0001f469‍\U0001f9b0 Female" -> "Female", "#ottergirl" -> "ottergirl".
    SillyTavern doesn't support emoji in tags, so the raw JanitorAI tag names
    (which are emoji-prefixed) must be cleaned before they land on a card."""
    t = re.sub(r"^[\s#]+", "", t)
    i = 0
    while i < len(t) and not t[i].isalnum():
        i += 1
    return t[i:].strip()


# ---------------------------------------------------------------------------
# Rich-text -> markdown serialization
#
# JanitorAI stores a creator's "About"/notes blurb as authored HTML (styled
# with inline colors + alignment we ignore -- we walk structure, not style).
# rich_to_md preserves full markdown (lists/headings/blockquote/links/images).
# This is the ONLY HTML->markdown path left after the JSON-API refactor: it
# converts a character's `description` blurb into creator_notes. The character
# definition itself (personality/scenario/example_dialogs) and the greetings
# arrive as authored markdown in the JSON and need no conversion.
# ---------------------------------------------------------------------------


def _children(node: PageElement) -> list[PageElement]:
    if isinstance(node, Tag):
        return list(node.children)
    return []


def rich_to_md(node: PageElement) -> str:
    if isinstance(node, Comment):
        return ""
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""

    tag = node.name.lower()

    def inner() -> str:
        return "".join(rich_to_md(child) for child in _children(node))

    if tag == "br":
        return "\n"
    if tag == "hr":
        return "\n\n---\n\n"
    if tag == "img":
        src = node.get("src") or ""
        alt = node.get("alt") or ""
        return f"\n\n![{alt}]({src})\n\n" if src else ""
    if tag in ("b", "strong"):
        t = inner()
        return f"**{t}**" if re.search(r"\S", t) else t
    if tag in ("i", "em"):
        t = inner()
        return f"*{t}*" if re.search(r"\S", t) else t
    if tag == "code":
        return "`" + inner() + "`"
    if re.fullmatch(r"h[1-6]", tag):
        n = int(tag[1])
        return f"\n\n{'#' * n} {inner().strip()}\n\n"
    if tag == "blockquote":
        body = inner().strip()
        quoted = "\n".join("> " + line for line in body.split("\n"))
        return f"\n\n{quoted}\n\n"
    if tag in ("ul", "ol"):
        return "\n" + inner() + "\n"
    if tag == "li":
        return "- " + inner().strip() + "\n"
    if tag == "a":
        href = node.get("href") or ""
        text = inner()
        return f"[{text}]({href})" if re.match(r"^https?://", href, re.IGNORECASE) else text
    if tag in ("p", "div"):
        content = inner()
        return f"\n\n{content}\n\n" if content.strip() else ""
    # span, font, and any unknown wrapper: keep contents only.
    return inner()


def serialize_md(root: PageElement) -> str:
    return tidy_text(normalize_quotes(rich_to_md(root)))


def html_to_md(html: str) -> str:
    """Convert an authored-HTML string (a character's `description` blurb from
    the JanitorAI JSON) into markdown. Returns "" for empty/blank input."""
    if not html or not html.strip():
        return ""
    return serialize_md(BeautifulSoup(html, "html.parser"))
