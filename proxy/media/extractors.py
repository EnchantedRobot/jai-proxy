"""External gallery extractors -- resolve a gallery *source* into direct image
URLs (or, for MEGA, into a reference the download step knows how to fetch and
decrypt itself).

docs/UI_REWRITE_PLAN.md §3.4 dropped all seven of `web/`'s extractors up front,
"to be reconsidered server-side later, on evidence of a real card that needs it".
Stage 6B is that reconsideration, and the evidence is a scan of all 3,868 cards:

    chub gallery    318 cards, 5,247 files already downloaded under the old
                              UI (`data/galleries/*/chubgallery_*`) -- see
                              `resolve_chub_gallery` below
    mega             61 cards
    catbox album     23 cards
    imgchest         19 cards
    imgbb album      15 cards
    postimg          11 cards
    gdrive            2 cards      dropped: negligible, and the one most
                                   dependent on browser session cookies
    imgbox            0 cards      dropped: not needed at all. Every card that
                                   mentions imgbox links direct
                                   `images2.imgbox.com/...` files, which the
                                   ordinary `embedded` phase already handles.

These are emphatically *not* the media pipeline -- they are one optional phase
of it. A card's own embedded and lorebook URLs never needed an extractor, which
is why localizing kept working after §3.4 dropped these.

**Two kinds of source, one name.** `chub` and `mega` don't fit the
URL-pattern-in-card-text model the other four use -- a Chub gallery is
triggered by the card's own `extensions.chub.id`, not a link anyone wrote, and
a MEGA folder needs its content decrypted (AES ECB/CBC/CTR via `proxy.media.mega`),
not just fetched. They're still extractors in the sense that matters: each one
turns "this card has a gallery source" into a list of images the ordinary
download pipeline can save. `resolve_chub_gallery` is called directly by
`_discovered_items` (keyed on the card's Chub link, not `find_gallery_urls`);
`mega` is registered here like the other four, via `Extractor.fetch` instead of
`Extractor.parse`, since listing a MEGA folder means calling MEGA's API rather
than scraping an HTML page.
"""

from __future__ import annotations

import html as html_module
import json
import logging
import re
from dataclasses import dataclass
from typing import Callable, Iterable

import httpx

from proxy.config import settings
from proxy.media import mega as media_mega
from proxy.state import ui_settings

logger = logging.getLogger("jai_proxy.media.extractors")

# Album pages only. A direct file URL (files.catbox.moe/x.png,
# i.postimg.cc/h/x.png, cdn.imgchest.com/files/x.webp, i.ibb.co/h/x.png) is
# already an image and belongs to the embedded phase -- matching it here would
# fetch the same bytes twice under a different prefix.
_URL_IN_TEXT = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)


@dataclass(frozen=True)
class GalleryImage:
    url: str
    filename: str | None = None


# Parsing is pure (HTML in, images out) and fetching is the caller's job, so
# every extractor is testable against a fixture with no transport at all.
Parser = Callable[[str], list["GalleryImage"]]


@dataclass(frozen=True)
class Extractor:
    id: str
    pattern: re.Pattern[str]
    # Exactly one of the two is set: `parse` for the album-page extractors
    # (text already fetched by `resolve_gallery_urls`), `fetch` for a source
    # that has to talk to its own API instead of scraping HTML (mega).
    parse: Parser | None = None
    fetch: Callable[[httpx.Client, str], list["GalleryImage"]] | None = None


def _get_text(client: httpx.Client, url: str) -> str:
    response = client.get(url, follow_redirects=True)
    response.raise_for_status()
    return response.text


def _basename(url: str) -> str | None:
    tail = url.rsplit("/", 1)[-1].split("?")[0]
    return tail or None


def _dedupe(images: Iterable[GalleryImage]) -> list[GalleryImage]:
    seen: set[str] = set()
    out: list[GalleryImage] = []
    for image in images:
        if image.url not in seen:
            seen.add(image.url)
            out.append(image)
    return out


# ---- catbox ----------------------------------------------------------------

_CATBOX_FILE = re.compile(r">https://files\.catbox\.moe/([^<]+)<")


def _parse_catbox(text: str) -> list[GalleryImage]:
    """Album pages list their files as bare text links between tags."""
    return _dedupe(
        GalleryImage(f"https://files.catbox.moe/{name.strip()}", name.strip())
        for name in _CATBOX_FILE.findall(text)
    )


# ---- postimg ---------------------------------------------------------------

_POSTIMG_CARD = re.compile(
    r'data-hotlink="([^"]+)"\s+data-name="([^"]+)"\s+data-ext="([^"]+)"'
)


def _parse_postimg(text: str) -> list[GalleryImage]:
    images = []
    for hotlink, name, ext in _POSTIMG_CARD.findall(text):
        filename = f"{name}.{ext}"
        images.append(
            GalleryImage(f"https://i.postimg.cc/{hotlink}/{filename}", filename)
        )
    return _dedupe(images)


# ---- imgchest --------------------------------------------------------------

_IMGCHEST_DATA_PAGE = re.compile(r'data-page="([^"]+)"')
_IMGCHEST_CDN = re.compile(
    r"https?://cdn\.imgchest\.com/files/[^\s\"'<>]+?\.(?:png|jpe?g|gif|webp)",
    re.IGNORECASE,
)


def _parse_imgchest(text: str) -> list[GalleryImage]:
    """Prefer the embedded JSON blob; fall back to scraping CDN URLs.

    Both paths are kept because the legacy extractor kept both: the blob is
    complete and ordered, but its shape follows imgchest's frontend and has
    changed before, and the regex still finds the images when it does.
    """
    if "PostPassword" in text:
        # Password-gated post: nothing to resolve, and not an error worth
        # retrying either.
        return []

    match = _IMGCHEST_DATA_PAGE.search(text)
    if match:
        try:
            data = json.loads(html_module.unescape(match.group(1)))
            files = data.get("props", {}).get("post", {}).get("files") or []
            images = [
                GalleryImage(f["link"], _basename(f["link"]))
                for f in files
                if isinstance(f, dict) and isinstance(f.get("link"), str)
            ]
            if images:
                return _dedupe(images)
        except (ValueError, AttributeError, TypeError):
            pass

    return _dedupe(
        GalleryImage(found, _basename(found)) for found in _IMGCHEST_CDN.findall(text)
    )


# ---- imgbb -----------------------------------------------------------------

_IMGBB_DATA_OBJECT = re.compile(r"data-object='([^']+)'")
_IMGBB_OG_IMAGE = re.compile(r'<meta property="og:image" content="([^"]+)"')


def _parse_imgbb_objects(text: str) -> list[GalleryImage]:
    from urllib.parse import unquote

    images: list[GalleryImage] = []
    for raw in _IMGBB_DATA_OBJECT.findall(text):
        try:
            decoded = unquote(html_module.unescape(raw))
            obj = json.loads(decoded)
        except ValueError:
            continue
        image_url = (obj.get("image") or {}).get("url")
        if isinstance(image_url, str) and image_url:
            images.append(GalleryImage(image_url, _basename(image_url)))
    return images


def _parse_imgbb(text: str) -> list[GalleryImage]:
    """Album pages carry one `data-object` per image; a single-image page only
    has the og:image meta tag.

    The legacy extractor also walked imgbb's paginated JSON endpoint with a
    scraped auth token. That is not ported: it needs a token lifted out of an
    inline script, and page one already covers the album sizes these cards
    actually link.
    """
    images = _parse_imgbb_objects(text)
    if images:
        return _dedupe(images)

    match = _IMGBB_OG_IMAGE.search(text)
    if match and "//i.ibb.co/" in match.group(1):
        return [GalleryImage(match.group(1), _basename(match.group(1)))]
    return []


# ---- mega -------------------------------------------------------------------


def _fetch_mega(client: httpx.Client, url: str) -> list[GalleryImage]:
    return [GalleryImage(image.url, image.filename) for image in media_mega.extract_images(client, url)]


# ---- chub (first-party gallery, not a page link) -----------------------------

_CHUB_GALLERY_API = "https://gateway.chub.ai/api/gallery/project/{id}?limit=100&count=false"
_CHUB_ORIGIN = "https://chub.ai"
_CHUB_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": _CHUB_ORIGIN,
    "Referer": f"{_CHUB_ORIGIN}/",
}


def _chub_token() -> str | None:
    """The user's Chub bearer token from `data/settings.json`'s root
    `chubToken` key -- the same flat key the browser writes (Settings ->
    Providers -> Chub API token), read the same narrow, defensive way
    `runtime.net` reads `httpProxyUrl`. Most galleries don't need it; a
    private or NSFW-gated one does."""
    try:
        blob = ui_settings.SettingsStore(settings.settings_file).read()
    except ui_settings.SettingsError:
        return None
    token = blob.get("chubToken")
    return token.strip() if isinstance(token, str) and token.strip() else None


def resolve_chub_gallery(client: httpx.Client, project_id: str) -> list[GalleryImage]:
    """A Chub-sourced card's own first-party gallery -- Chub's hosted image
    feature for that character (`gateway.chub.ai/api/gallery/project/{id}`),
    not a link anyone wrote into the card's text. Triggered by
    `extensions.chub.id`, so unlike the other extractors it is called
    directly by `_discovered_items` rather than through
    `find_gallery_urls`/`resolve_gallery_urls`."""
    if not project_id:
        return []
    headers = dict(_CHUB_HEADERS)
    token = _chub_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = client.get(_CHUB_GALLERY_API.format(id=project_id), headers=headers)
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("chub gallery fetch failed for project %s: %s", project_id, exc)
        return []

    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list):
        return []
    images = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        image_url = node.get("primary_image_path")
        if isinstance(image_url, str) and image_url:
            images.append(GalleryImage(image_url, _basename(image_url)))
    return _dedupe(images)


EXTRACTORS: tuple[Extractor, ...] = (
    Extractor("catbox", re.compile(r"catbox\.moe/c/[a-zA-Z0-9]+"), parse=_parse_catbox),
    Extractor("postimg", re.compile(r"post(?:img|images)\.(?:cc|org)/gallery/[a-zA-Z0-9]+"), parse=_parse_postimg),
    Extractor("imgchest", re.compile(r"imgchest\.com/p/[a-zA-Z0-9]+"), parse=_parse_imgchest),
    Extractor("imgbb", re.compile(r"//(?:www\.)?ibb\.co(?:\.com)?/album/[a-zA-Z0-9]+"), parse=_parse_imgbb),
    Extractor("mega", re.compile(r"mega\.(?:nz|co\.nz)/folder/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+"), fetch=_fetch_mega),
    Extractor("mega", re.compile(r"mega\.(?:nz|co\.nz)/#F![A-Za-z0-9_-]+![A-Za-z0-9_-]+"), fetch=_fetch_mega),
)


def extractor_for(url: str) -> Extractor | None:
    for extractor in EXTRACTORS:
        if extractor.pattern.search(url):
            return extractor
    return None


def find_gallery_urls(text: str) -> list[str]:
    """Album page URLs in a block of card text, deduplicated, order preserved."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for match in _URL_IN_TEXT.finditer(text):
        # Markdown and prose leave punctuation glued to the end of a URL.
        url = match.group(0).rstrip(".,;:!?)}]")
        if url in seen or extractor_for(url) is None:
            continue
        seen.add(url)
        found.append(url)
    return found


def resolve_gallery_urls(client: httpx.Client, urls: Iterable[str]) -> list[GalleryImage]:
    """Fetch each album page and resolve it to its images.

    Synchronous on purpose: the only callers are the media job's planner, which
    runs on a worker thread (`asyncio.to_thread`), and the submit route, which
    is a sync `def` on FastAPI's threadpool. Blocking there is correct; doing
    this on the event loop would stall every other request for the length of a
    whole-archive run.

    One failing album must not sink a card's media run -- these are third-party
    pages that go away, rate-limit, and change markup -- so a page that raises
    is logged and skipped.
    """
    out: list[GalleryImage] = []
    for url in urls:
        extractor = extractor_for(url)
        if extractor is None:
            continue
        try:
            if extractor.fetch is not None:
                out.extend(extractor.fetch(client, url))
            else:
                out.extend(extractor.parse(_get_text(client, url)))
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("gallery extractor %s failed on %s: %s", extractor.id, url, exc)
    return _dedupe(out)
