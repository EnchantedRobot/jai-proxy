from __future__ import annotations

import re

from bs4 import BeautifulSoup, Comment
from bs4.element import NavigableString, PageElement, Tag

from proxy.models import ProfileFields

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
    so "\U0001f469‍\U0001f9b0 Female" -> "Female", "#ottergirl" -> "ottergirl"."""
    t = re.sub(r"^[\s#]+", "", t)
    i = 0
    while i < len(t) and not t[i].isalnum():
        i += 1
    return t[i:].strip()


# ---------------------------------------------------------------------------
# Rich-text -> markdown serialization
#
# JanitorAI renders authored Markdown to HTML (styled with rotating Emotion
# "css-*" classes + inline colors, which we ignore -- we walk structure, not
# style). Two serializers:
#
#   rich_to_md      -- FULL markdown (lists/headings/blockquote/links/images
#                       preserved). Used for creator_notes and the definition
#                       fields (description/scenario/mes_example).
#
#   greeting_runs   -- NAIVE markdown for first_mes/alternate_greetings. ST's
#                       chat-message renderer reliably handles only *italic*,
#                       **bold**, and plain "quotes"; it mis-renders nesting.
#                       So we flatten to runs with <=1 emphasis level and keep
#                       embedded images as ![](url).
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


# --- greeting (naive) serializer --------------------------------------------


class _Run:
    __slots__ = ("text", "emph")

    def __init__(self, text: str, emph: str) -> None:
        self.text = text
        self.emph = emph


_BLOCK_TAGS = {"p", "div", "li", "blockquote", "hr", "ul", "ol"}


def _md_runs(node: PageElement, emph: str, out: list[_Run]) -> None:
    if isinstance(node, Comment):
        return
    if isinstance(node, NavigableString):
        if str(node):
            out.append(_Run(str(node), emph))
        return
    if not isinstance(node, Tag):
        return

    tag = node.name.lower()
    if tag == "br":
        out.append(_Run("\n", ""))
        return
    if tag == "img":
        src = node.get("src") or ""
        if src:
            out.append(_Run(f"\n\n![]({src})\n\n", ""))
        return

    e = emph
    if tag in ("strong", "b"):
        e = emph or "**"  # outer wins
    elif tag in ("em", "i"):
        e = emph or "*"
    for child in _children(node):
        _md_runs(child, e, out)

    if tag in _BLOCK_TAGS or re.fullmatch(r"h[1-6]", tag):
        out.append(_Run("\n\n", ""))


_EMPHASIZE_RE = re.compile(r"^(\s*)([\s\S]*?)(\s*)$")


def _emphasize(marker: str, text: str) -> str:
    if not re.search(r"\w", text):
        return text
    m = _EMPHASIZE_RE.match(text)
    if m and m.group(2):
        return m.group(1) + marker + m.group(2) + marker + m.group(3)
    return text


def _runs_to_markdown(runs: list[_Run]) -> str:
    out = []
    i = 0
    while i < len(runs):
        e = runs[i].emph
        text_parts = []
        while i < len(runs) and runs[i].emph == e:
            text_parts.append(runs[i].text)
            i += 1
        text = "".join(text_parts)
        out.append(_emphasize(e, text) if e else text)
    return "".join(out)


# Pull double-quoted dialogue OUT of surrounding bold/italic markers. ST's
# naive renderer mis-renders `**"line"**` / `*"line"*` -- a quote must never
# sit inside emphasis. JanitorAI authors keep dialogue in its own emphasis
# span, so stripping any emphasis run that hugs a single quoted span is exact.
# Runs to a fixpoint so `***"x"***` etc. fully unwrap.
_UNWRAP_QUOTED_EMPHASIS_RE = re.compile(r'(\*{1,3}|_{1,3})(["“][^"“”\n]*["”])\1')


def unwrap_quoted_emphasis(md: str) -> str:
    prev = None
    while prev != md:
        prev = md
        md = _UNWRAP_QUOTED_EMPHASIS_RE.sub(r"\2", md)
    return md


def rich_to_greeting(root: PageElement) -> str:
    runs: list[_Run] = []
    _md_runs(root, "", runs)
    return tidy_text(unwrap_quoted_emphasis(normalize_quotes(_runs_to_markdown(runs))))


# ---------------------------------------------------------------------------
# Title / name / creator / tags
# Title format on JanitorAI is "Bot Title | Character Name" -- the character
# name is the LAST "|" segment.
# ---------------------------------------------------------------------------


def get_full_title(soup: BeautifulSoup) -> str:
    meta = soup.select_one('meta[name="twitter:title"]')
    from_meta = (meta.get("content") or "").strip() if meta else ""
    if from_meta:
        return from_meta
    h2 = soup.select_one(".character-card-box h2")
    if h2 and h2.get_text(strip=True):
        return h2.get_text(strip=True)
    if soup.title and soup.title.string:
        return soup.title.string.strip()
    return ""


def get_name(soup: BeautifulSoup) -> str:
    parts = get_full_title(soup).split("|")
    t = parts[-1].strip()
    return t or "Unknown"


_HANDLE_RE = re.compile(r"^@[\w.\-]+$")
_PROFILE_OF_RE = re.compile(r"profile-of-([\w.\-]+)")


def get_creator(soup: BeautifulSoup) -> str:
    box = soup.select_one(".character-card-creator-box")
    scope = box or soup
    handle = None
    for el in scope.select("a,span"):
        text = el.get_text(strip=True)
        if _HANDLE_RE.match(text):
            handle = text
            break
    if handle:
        return handle.lstrip("@")
    a = scope.select_one('a[href*="profile-of-"]')
    if a:
        m = _PROFILE_OF_RE.search(a.get("href") or "")
        if m:
            return m.group(1)
    return "janitorai.com"


def get_tags(soup: BeautifulSoup) -> list[str]:
    nodes = soup.select(".pp-cc-tags-item")
    if not nodes:
        nodes = soup.select('a[href*="custom_tags="], a[href*="tag_id="]')
    seen: list[str] = []
    for n in nodes:
        cleaned = clean_tag(n.get_text(strip=True))
        if cleaned and cleaned not in seen:
            seen.append(cleaned)
    return seen


# ---------------------------------------------------------------------------
# Character definition accordion (Scenario / Personality / Example Dialogs)
#
# Each accordion item has a button whose title text is e.g. "Scenario (341
# tokens)" and an aria-controls pointing at its panel. Panels render markdown
# into ".characterInfoMarkdownContainer" eagerly (present in the DOM even
# while visually collapsed), so no clicking is needed for these three.
# ---------------------------------------------------------------------------


def _accordion_panel_by_title(soup: BeautifulSoup, title_prefix: str) -> Tag | None:
    want = title_prefix.lower()
    btn = None
    for b in soup.select("button[aria-controls^='panel-info-']"):
        if b.get_text(strip=True).lower().startswith(want):
            btn = b
            break
    if not btn:
        return None
    panel_id = btn.get("aria-controls")
    return soup.find(id=panel_id) if panel_id else None


def definition_section(soup: BeautifulSoup, title_prefix: str) -> str:
    panel = _accordion_panel_by_title(soup, title_prefix)
    if not panel:
        return ""
    md = panel.select_one(".characterInfoMarkdownContainer")
    root = md or panel
    return serialize_md(root)


# ---------------------------------------------------------------------------
# Creator notes
#
# The creator's authored blurb lives INSIDE ".character-card-creator-box" (in
# a nested div whose classes rotate so we can't anchor on them). Locate the
# markdown root by:
#   1. an element whose DIRECT children include an <hr> (a creator's section
#      divider) -- most authored notes have these; or
#   2. the longest-prose non-noise block with >=2 direct <p> children.
# Selection is by TEXT LENGTH, not document order: a naive "first div with
# >=2 <p>" grabs the stats ribbon (likes/chats) or the Created/Updated row,
# which precede the blurb in the DOM.
# ---------------------------------------------------------------------------

_NOISE_SELECTOR = ".characterInfoMarkdownContainer, [aria-label='Next message'], [data-tab-id]"
_MIN_PROSE = 40  # longer than any stats ribbon / "Created ..." date row


def _is_noise(el: Tag) -> bool:
    return el.select_one(_NOISE_SELECTOR) is not None


def _prose_len(el: Tag) -> int:
    return len(re.sub(r"\s+", " ", el.get_text()).strip())


def get_creator_notes_root(soup: BeautifulSoup) -> Tag | None:
    creator_box = soup.select_one(".character-card-creator-box")
    boxes: list[Tag] = ([creator_box] if creator_box else []) + soup.select(".character-card-box")

    # 1. Element with an <hr> as a direct child (markdown divider).
    for box in boxes:
        for el in box.find_all(("div", "section")):
            if _is_noise(el):
                continue
            if any(isinstance(c, Tag) and c.name == "hr" for c in el.find_all(recursive=False)):
                return el

    # 2. Longest-prose non-noise block with >=2 direct <p> children.
    for box in boxes:
        best: Tag | None = None
        best_len = 0
        for el in box.find_all(("div", "section")):
            if _is_noise(el):
                continue
            direct_p = [c for c in el.find_all(recursive=False) if isinstance(c, Tag) and c.name == "p"]
            if len(direct_p) < 2:
                continue
            length = _prose_len(el)
            if length > best_len:
                best, best_len = el, length
        if best is not None and best_len >= _MIN_PROSE:
            return best
    return None


def get_creator_notes(soup: BeautifulSoup) -> str:
    root = get_creator_notes_root(soup)
    if not root:
        return ""
    md = serialize_md(root)
    return md or root.get_text(" ", strip=True)


# ---------------------------------------------------------------------------
# Public parsers
# ---------------------------------------------------------------------------


class ProfileParser:
    """Parses a JanitorAI profile page's outerHTML into ProfileFields. Ported
    from the DOM logic in ~/workspaces/saucepan/janitorai-export.user.js
    (the live janitorai-export Tampermonkey userscript)."""

    def parse(self, html: str) -> ProfileFields:
        soup = BeautifulSoup(html or "", "html.parser")
        return ProfileFields(
            name=get_name(soup),
            creator=get_creator(soup),
            tags=get_tags(soup),
            description=definition_section(soup, "personality"),
            scenario=definition_section(soup, "scenario"),
            mes_example=definition_section(soup, "example dialogs"),
            creator_notes=get_creator_notes(soup),
        )


class GreetingConverter:
    """Converts a single rendered greeting's HTML (first_mes or one
    alternate_greeting) into SillyTavern-friendly naive markdown. Ported from
    janitorai-export.user.js's richToGreeting."""

    def convert(self, html: str) -> str:
        soup = BeautifulSoup(html or "", "html.parser")
        return rich_to_greeting(soup)
