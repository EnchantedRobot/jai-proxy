import contextlib
import logging
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from proxy import chub_mapper, dashboard as dashboard_mod, datacat_mapper
from proxy import janitor_mapper, saucepan_mapper
from proxy.api import v1_router
from proxy.api.datacat import router as datacat_router
from proxy.avatar import AvatarFetcher
from proxy.capture_store import CaptureStore
from proxy.cardbuilder import CardBuilder, PngWriter
from proxy.config import ROOT, settings
from proxy.lorebook import LorebookMapper
from proxy.lorebook_cache import LorebookCache
from proxy.macros import MacroSanitizer
from proxy.mock_responder import MockResponder
from proxy.models import (
    BuildRequest,
    BuildResponse,
    CaptureRecord,
    ChubBuildRequest,
    CharacterBook,
    CharacterCardV3,
    DatacatBuildRequest,
    ExistingRequest,
    ExistingResponse,
    LorebookExistingRequest,
    LorebookExistingResponse,
    ProfileFields,
    SaucepanBuildRequest,
)
from proxy.saucepan_mapper import SAUCEPAN_ORIGIN

# Chub.ai's own avatar CDN convention; mirrors CHUB_AVATAR_BASE in
# web/modules/providers/chub/chub-api.js -- keep the two in sync.
CHUB_AVATAR_BASE = "https://avatars.charhub.io/avatars/"

logger = logging.getLogger("jai_proxy.server")

# The vendored Character Library frontend. In the repo, not in the archive:
# it is code, it ships with the server, and it is the same directory in a
# checkout and in the container image. See web/VENDORED.md.
WEB_DIR = ROOT / "web"

# Set by main() when the live dashboard is drawing; None means plain logging,
# and every call site below is a no-op then (see _record_download).
DASHBOARD: dashboard_mod.Dashboard | None = None

app = FastAPI(title="jai-proxy")

# The archive's own contract: browse, download, export. Deliberately namespaced
# under /api/v1 and deliberately not shaped like SillyTavern's /api -- see
# proxy/api/__init__.py for why that distinction is the point.
app.include_router(v1_router)
# DataCat's session transport (Phase 3B S2) -- the archive's replacement for
# the cl-helper plugin's DataCat surface. See proxy/api/datacat.py.
app.include_router(datacat_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The browse UI loads the entire archive as one JSON document at boot -- 5.9 MB
# with extensions attached -- and 1.3 MB of vendored JavaScript alongside it.
# Both are overwhelmingly repeated text, so gzip takes the pair down by roughly
# a factor of five. The threshold keeps thumbnails and card PNGs out of it:
# those are already compressed, and re-compressing them costs CPU to add bytes.
app.add_middleware(GZipMiddleware, minimum_size=1024)

class QuietAccessFilter(logging.Filter):
    """Drop uvicorn access-log lines for successful (2xx) requests.

    Errors and redirects still print; only routine 200/204/etc noise is
    suppressed. record.args is (client_addr, method, path, http_version,
    status_code) per uvicorn's access logger call.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            status_code = record.args[-1]  # type: ignore[index]
            return not (200 <= int(status_code) < 300)
        except (TypeError, IndexError, ValueError):
            return True


logging.getLogger("uvicorn.access").addFilter(QuietAccessFilter())

capture_store = CaptureStore()
responder = MockResponder()
card_builder = CardBuilder()
png_writer = PngWriter()
avatar_fetcher = AvatarFetcher()
lorebook_mapper = LorebookMapper()
lorebook_cache = LorebookCache()
# Chub bypasses CardBuilder (raw-dict passthrough, see chub_mapper), so it
# needs its own sanitizer instance -- same construction as CardBuilder's.
chub_sanitizer = MacroSanitizer(user_names=settings.user_names)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _datacat_block(
    *,
    card_id: str | None,
    source_kind: str,
    creator_id: str,
    creator_name: str,
    page_name: str,
    linked_at: str,
) -> dict[str, Any]:
    """extensions.datacat provenance -- the shape SillyTavern-CharacterLibrary's
    datacat provider reads and writes natively (modules/providers/datacat/
    datacat-provider.js), built from the same source fields as extensions.jai
    so a freshly downloaded card is already linkable there without a separate
    datacat lookup. `source_kind` is datacat's own vocabulary ("janitor" /
    "saucepan"), distinct from extensions.jai's sourceKind values."""
    return {
        "id": card_id,
        "sourceKind": source_kind,
        "creatorId": creator_id or None,
        "creatorName": creator_name,
        "pageName": page_name,
        "linkedAt": linked_at,
    }


def _first_message_of_role(messages: list[dict[str, Any]], role: str) -> str:
    for message in messages:
        if message.get("role") == role:
            content = message.get("content", "")
            return content if isinstance(content, str) else str(content)
    return ""


def _record_download(
    *,
    source: str,
    name: str,
    creator: str,
    ok: bool = True,
    detail: str = "",
    duplicate: bool = False,
    filename: str = "",
) -> None:
    """Announce a card build on the dashboard's downloads column, and log the
    same line so the plain-logging path (no TTY) still says what was written.

    `duplicate` means the card was already on disk, so nothing was written at
    all -- reported rather than silently dropped, since from the browser the
    click looks identical to a real export."""
    if ok:
        logger.info(
            "%s %s card: %s by %s%s",
            "already have" if duplicate else "saved",
            source,
            name,
            creator or "unknown",
            f" ({filename})" if filename else "",
        )
    else:
        logger.warning("%s card not saved: %s — %s", source, name, detail)
    if DASHBOARD is not None:
        DASHBOARD.feed.record(
            source=source,
            name=name,
            creator=creator,
            ok=ok,
            detail=detail,
            duplicate=duplicate,
            filename=filename,
        )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "captures": capture_store.count,
        "lorebooks": lorebook_cache.count,
        "model": responder.model,
    }


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": responder.model, "object": "model"}],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    body = await request.json()

    try:
        messages = body.get("messages", [])
        capture_store.record(
            _first_message_of_role(messages, "system"),
            primary_greeting=_first_message_of_role(messages, "assistant"),
        )
    except Exception:
        logger.exception("capture failed; continuing to forward")

    # The reply is generated locally (proxy/mock_responder.py) and has no
    # upstream to fail, so there is no error branch left here -- the capture
    # above is the part that matters, and it already swallows its own failures.
    if body.get("stream"):
        return StreamingResponse(
            responder.stream(body), media_type="text/event-stream"
        )
    return JSONResponse(await responder.complete(body))


@app.get("/capture-status")
async def capture_status(name: str) -> dict[str, Any]:
    return {"name": name, **capture_store.status(name)}


@app.post("/clear-captures")
async def clear_captures() -> dict[str, Any]:
    removed = capture_store.clear()
    return {"ok": True, "removed": removed}


@app.post("/lorebooks/existing")
async def lorebooks_existing(req: LorebookExistingRequest) -> LorebookExistingResponse:
    """Split the requested lorebook ids into the ones already cached (skip the
    fetch, reference by id in the build) and the ones missing (fetch, then send
    up -- the build endpoint caches them write-through)."""
    cached, missing = lorebook_cache.split(req.source, req.ids)
    return LorebookExistingResponse(cached=cached, missing=missing)


@app.post("/clear-lorebooks")
async def clear_lorebooks() -> dict[str, Any]:
    removed = lorebook_cache.clear()
    return {"ok": True, "removed": removed}


@app.post("/existing")
async def existing(req: ExistingRequest) -> ExistingResponse:
    """Report which of the given card ids are already saved on disk, so a bulk
    export can skip them before the slow one-at-a-time classify/build loop."""
    return ExistingResponse(existing=sorted(png_writer.existing(req.ids)))


def _check_duplicate(
    card_id: str | None, *, source: str, name: str, creator: str
) -> BuildResponse | None:
    """A card whose id is already on disk is left alone: the caller stops here,
    before the avatar fetch, and reports the file found. Re-acquiring one means
    deleting it first -- the same rule `make import` and the bulk sweep follow,
    so a card edited in SillyTavern is never silently replaced. Returns None
    when there's no on-disk match (the caller should proceed to build/write)."""
    already = png_writer.find_by_id(card_id)
    if not already:
        return None
    _record_download(
        source=source, name=name, creator=creator, duplicate=True, filename=already[0].name
    )
    return BuildResponse(ok=True, path=str(already[0]), duplicate=True)


def build_card(
    *,
    profile: ProfileFields,
    greetings: list[str],
    book: CharacterBook | None,
    avatar_url: str | None,
    character_version: str,
    extensions: dict[str, Any],
    capture: CaptureRecord | None = None,
    warnings: list[str] | None = None,
) -> tuple[CharacterCardV3, list[str]]:
    """Source-specific half of the shared build/write tail: run the neutral
    fields through CardBuilder and stamp provenance. /build-jai (JanitorAI) and
    /build-saucepan differ only in how they produce these inputs -- everything
    from here down (and in fetch_avatar_and_write) is identical. Chub bypasses
    this entirely (see chub_mapper's raw-dict-passthrough rule) and goes
    straight to fetch_avatar_and_write with its own payload."""
    card, build_warnings = card_builder.build(
        profile, greetings, capture=capture, book=book, avatar_url=avatar_url
    )
    all_warnings = (warnings or []) + build_warnings

    card.character_version = character_version or "jai-proxy"
    card.extensions = extensions
    return card, all_warnings


async def fetch_avatar_and_write(
    *,
    write_fn: Callable[[bytes], Path],
    avatar_url: str | None,
    avatar_b64: str | None,
    source: str,
    name: str,
    creator: str,
    warnings: list[str],
    fields_present: dict[str, bool],
) -> BuildResponse:
    """The tail shared by every write path regardless of how the card payload
    was produced: fetch the avatar, write the PNG via `write_fn` (closes over
    either png_writer.write for a CharacterCardV3 or png_writer.write_payload
    for a raw dict), and announce the result on the dashboard."""
    avatar_bytes = await avatar_fetcher.fetch(avatar_url, avatar_b64)
    path = write_fn(avatar_bytes)
    _record_download(source=source, name=name, creator=creator, filename=path.name)
    return BuildResponse(ok=True, path=str(path), warnings=warnings, fields_present=fields_present)


def _fields_present(card: CharacterCardV3) -> dict[str, bool]:
    return {
        "description": bool(card.description),
        "scenario": bool(card.scenario),
        "mes_example": bool(card.mes_example),
        "first_mes": bool(card.first_mes),
        "alternate_greetings": bool(card.alternate_greetings),
        "creator_notes": bool(card.creator_notes),
        "tags": bool(card.tags),
        "character_book": card.character_book is not None,
    }


async def _assemble_and_write(
    *,
    profile: ProfileFields,
    greetings: list[str],
    book: CharacterBook | None,
    avatar_url: str | None,
    avatar_b64: str | None,
    card_id: str | None,
    character_version: str,
    extensions: dict[str, Any],
    source: str,
    capture: CaptureRecord | None = None,
    warnings: list[str] | None = None,
) -> BuildResponse:
    """The CardBuilder path: dedupe-check, build_card, fetch_avatar_and_write.
    Used as-is by /build-jai and /build-saucepan; /build-chub uses the two
    halves directly since it never goes through CardBuilder."""
    duplicate = _check_duplicate(
        card_id, source=source, name=profile.name, creator=profile.creator or ""
    )
    if duplicate is not None:
        return duplicate

    card, all_warnings = build_card(
        profile=profile,
        greetings=greetings,
        book=book,
        avatar_url=avatar_url,
        character_version=character_version,
        extensions=extensions,
        capture=capture,
        warnings=warnings,
    )

    return await fetch_avatar_and_write(
        write_fn=lambda avatar_bytes: png_writer.write(card, avatar_bytes, card_id=card_id),
        avatar_url=avatar_url,
        avatar_b64=avatar_b64,
        source=source,
        name=card.name,
        creator=card.creator or "",
        warnings=all_warnings,
        fields_present=_fields_present(card),
    )


@app.post("/build-jai")
async def build_jai(req: BuildRequest) -> BuildResponse:
    character = req.character_json or {}
    profile = janitor_mapper.to_profile_fields(character)
    if not profile.name:
        profile.name = req.character.name

    hidden = janitor_mapper.is_hidden(character)
    capture = capture_store.get(profile.name)
    json_greetings = janitor_mapper.greetings(character)

    if hidden:
        # A hidden card's definition and its primary greeting both ride in on
        # the chat relay capture; the JSON supplies only the alternates.
        captured = capture.greetings if capture else []
        has_system = capture is not None and bool(
            capture.personality or capture.scenario or capture.mes_example
        )
        has_primary = bool(captured)
        if not (has_system and has_primary):
            _record_download(
                source="janitor",
                name=profile.name,
                creator=profile.creator,
                ok=False,
                detail="hidden — no chat capture yet",
            )
            return BuildResponse(
                ok=False,
                warnings=[
                    "hidden card not exportable — send a chat message in this "
                    "character's chat first so the proxy can capture its hidden "
                    "definition and primary greeting"
                ],
            )
        primary = captured[0]
        greetings = [primary] + [g for g in json_greetings if g != primary]
    else:
        greetings = json_greetings

    raw_scripts = [lb.raw for lb in req.lorebooks]
    book, lore_warnings = lorebook_mapper.map(raw_scripts, character_name=profile.name)
    if capture is not None:
        book = lorebook_mapper.merge(book, capture.lore_entries)

    avatar_url = req.avatar_url or janitor_mapper.avatar_url(character)

    # data.name is the real character name (chat_name); the JSON `name` field
    # is the card-title blurb (often a scenario hook, not an actual character
    # name -- see "She needs your help"), preserved as metadata instead.
    page_name = (character.get("name") or "").strip()
    card_id = req.character.id or character.get("id")
    linked_at = _utc_now_iso()
    extensions = {
        "jai": {
            "source_url": req.character.url,
            "id": card_id,
            "sourceKind": "janitor_core",
            "creatorName": profile.creator,
            "pageName": page_name,
            "linkedAt": linked_at,
        },
        "datacat": _datacat_block(
            card_id=card_id,
            source_kind="janitor",
            creator_id=janitor_mapper.creator_id(character),
            creator_name=profile.creator,
            page_name=page_name,
            linked_at=linked_at,
        ),
    }

    return await _assemble_and_write(
        profile=profile,
        greetings=greetings,
        book=book,
        avatar_url=avatar_url,
        avatar_b64=req.avatar_b64,
        card_id=card_id,
        character_version=req.character.url or "jai-proxy",
        extensions=extensions,
        source="janitor",
        capture=capture,
        warnings=lore_warnings,
    )


def _resolve_saucepan_lorebooks(raw: dict[str, Any]) -> None:
    """Reconcile the export's lorebooks with the on-disk cache, in place.

    The cache-aware userscript sends only the lorebooks it had to fetch (the
    cache misses) in `lorebooks`, plus `cached_lorebook_ids` for the rest. We
    write the fresh ones through to the cache and load the cached ids back in, so
    saucepan_mapper sees every attached lorebook exactly as if all had been
    fetched. An older userscript that sends every lorebook inline (and no
    cached_lorebook_ids) still works -- it just also warms the cache."""
    fetched = [b for b in (raw.get("lorebooks") or []) if isinstance(b, dict)]
    present: set[str] = set()
    for book in fetched:
        lid = (book.get("id") or "").strip()
        if lid:
            lorebook_cache.put("saucepan", lid, book)
            present.add(lid)

    combined = list(fetched)
    for raw_id in raw.get("cached_lorebook_ids") or []:
        lid = (raw_id or "").strip()
        if not lid or lid in present:
            continue
        blob = lorebook_cache.get("saucepan", lid)
        if blob is not None:
            combined.append(blob)
            present.add(lid)
    raw["lorebooks"] = combined


@app.post("/build-saucepan")
async def build_saucepan(req: SaucepanBuildRequest) -> BuildResponse:
    """saucepan peer of /build-jai. The userscript posts the raw
    {id, definition, companion, lorebooks} it fetched; the server deobfuscates
    and maps it (saucepan_mapper), then reuses the shared assemble/write tail.
    saucepan definitions carry macros intact, so there's no hidden-capture /
    name-reversal step -- it's a straight open-card build."""
    raw = req.character or {}
    _resolve_saucepan_lorebooks(raw)
    profile = saucepan_mapper.to_profile_fields(raw)
    greetings = saucepan_mapper.greetings(raw)
    book = saucepan_mapper.character_book(raw, character_name=profile.name)
    avatar_url = req.avatar_url or saucepan_mapper.avatar_url(raw)
    card_id = saucepan_mapper.companion_id(raw)

    warnings: list[str] = []
    if not saucepan_mapper.is_open(raw):
        warnings.append(
            "saucepan definition is not open — only public fields were available; "
            "description/scenario/example may be incomplete"
        )

    source_url = f"{SAUCEPAN_ORIGIN}/companion/{card_id}" if card_id else None
    page_name = saucepan_mapper.page_name(raw)
    linked_at = _utc_now_iso()
    extensions = {
        "jai": {
            "source_url": source_url,
            "id": card_id or None,
            "sourceKind": "saucepan_core",
            "creatorName": profile.creator,
            "pageName": page_name,
            "linkedAt": linked_at,
        },
        "datacat": _datacat_block(
            card_id=card_id or None,
            source_kind="saucepan",
            creator_id=saucepan_mapper.creator_id(raw),
            creator_name=profile.creator,
            page_name=page_name,
            linked_at=linked_at,
        ),
    }

    return await _assemble_and_write(
        profile=profile,
        greetings=greetings,
        book=book,
        avatar_url=avatar_url,
        avatar_b64=req.avatar_b64,
        card_id=card_id or None,
        character_version=source_url or "jai-proxy",
        extensions=extensions,
        source="saucepan",
        warnings=warnings,
    )


def _chub_fields_present(data: dict[str, Any]) -> dict[str, bool]:
    return {
        "description": bool(data.get("description")),
        "scenario": bool(data.get("scenario")),
        "mes_example": bool(data.get("mes_example")),
        "first_mes": bool(data.get("first_mes")),
        "alternate_greetings": bool(data.get("alternate_greetings")),
        "creator_notes": bool(data.get("creator_notes")),
        "tags": bool(data.get("tags")),
        "character_book": data.get("character_book") is not None,
    }


@app.post("/build-chub")
async def build_chub(req: ChubBuildRequest) -> BuildResponse:
    """Chub peer of /build-saucepan (see ChubBuildRequest for the request
    shape). The browser is a pure capture layer here too: it fetches the raw
    Chub node and linked lorebook (both CORS-open, no proxy needed) and posts
    them; the server builds and cleans (chub_mapper) and writes straight
    through write_payload -- never through CardBuilder/pydantic, per
    chub_mapper's raw-dict-passthrough rule (a Chub character_book carries
    priority/probability/selectiveLogic and an int-or-string position that a
    pydantic LoreEntry round-trip would drop or coerce)."""
    node = req.node or {}
    raw_data = chub_mapper.build_v2_from_chub(node, req.linked_lorebook)
    cleaned, warnings = chub_mapper.clean_card(raw_data, chub_sanitizer)

    card_id = chub_mapper.card_id(cleaned) or None
    name = chub_mapper.name(cleaned)
    creator = chub_mapper.creator(cleaned)

    duplicate = _check_duplicate(card_id, source="chub", name=name, creator=creator)
    if duplicate is not None:
        return duplicate

    page_name = chub_mapper.page_name(cleaned)
    cleaned["extensions"] = {
        **(cleaned.get("extensions") or {}),
        "jai": {
            "source_url": chub_mapper.source_url(cleaned),
            "id": card_id,
            "sourceKind": "chub_core",
            "creatorName": creator,
            "pageName": page_name,
            "linkedAt": _utc_now_iso(),
        },
    }
    if req.gallery_id:
        cleaned["extensions"]["gallery_id"] = req.gallery_id

    payload = chub_mapper.to_payload(cleaned)
    full_path = node.get("fullPath") or ""
    avatar_url = (
        req.avatar_url
        or node.get("max_res_url")
        or node.get("avatar_url")
        or (f"{CHUB_AVATAR_BASE}{full_path}/avatar.webp" if full_path else None)
    )

    response = await fetch_avatar_and_write(
        write_fn=lambda avatar_bytes: png_writer.write_payload(
            payload, avatar_bytes, creator=creator, name=name, card_id=card_id
        ),
        avatar_url=avatar_url,
        avatar_b64=req.avatar_b64,
        source="chub",
        name=name,
        creator=creator,
        warnings=warnings,
        fields_present=_chub_fields_present(cleaned),
    )
    if response.ok and not response.duplicate:
        # write_payload stamps extensions.gallery_id (and gallery.py's other
        # bookkeeping) into `payload` in place before this returns, so it's
        # already current by the time we hand it back.
        response.filename = Path(response.path).name if response.path else None
        response.card = payload
    return response


@app.post("/build-datacat")
async def build_datacat(req: DatacatBuildRequest) -> BuildResponse:
    """DataCat peer of /build-chub (see DatacatBuildRequest for the request
    shape). Unlike Chub, a datacat character carries nothing pydantic's
    LoreEntry round-trip would drop, so this goes through CardBuilder like
    /build and /build-saucepan -- build_card + fetch_avatar_and_write directly
    (not _assemble_and_write) so the built card is available afterward to
    populate the filename/card response fields the browser needs (see
    BuildResponse's docstring).

    /download often fills in fields the detail payload leaves empty for a
    repaired Saucepan card, so it wins when present; datacat_mapper.
    build_v2_from_character is the fallback (and the only source when the
    browser didn't fetch /download at all, e.g. for a plain JanitorAI row)."""
    character = req.character or {}
    v2 = datacat_mapper.build_v2_from_download(req.download, character) if req.download else None
    if v2 is None:
        v2 = datacat_mapper.build_v2_from_character(character)
    if v2 is None:
        return BuildResponse(ok=False, warnings=["datacat: no usable character data"])

    data = v2["data"]
    profile = datacat_mapper.to_profile_fields(data)
    greetings = datacat_mapper.greetings(data)
    book_dict = data.get("character_book")
    book = CharacterBook.model_validate(book_dict) if book_dict else None

    raw_card_id = character.get("character_id") or character.get("characterId")
    card_id = str(raw_card_id) if raw_card_id else None

    duplicate = _check_duplicate(card_id, source="datacat", name=profile.name, creator=profile.creator)
    if duplicate is not None:
        return duplicate

    source_kind = datacat_mapper.normalized_source_kind(character)
    if source_kind == "saucepan":
        source_url = f"{SAUCEPAN_ORIGIN}/companion/{card_id}" if card_id else None
    else:
        source_url = f"https://janitorai.com/characters/{card_id}" if card_id else None

    page_name = datacat_mapper.page_name(data)
    creator_id = datacat_mapper.creator_id(data)
    linked_at = _utc_now_iso()
    extensions: dict[str, Any] = {
        "jai": {
            "source_url": source_url,
            "id": card_id,
            "sourceKind": "datacat_core",
            "creatorName": profile.creator,
            "pageName": page_name,
            "linkedAt": linked_at,
        },
        "datacat": _datacat_block(
            card_id=card_id,
            source_kind=source_kind,
            creator_id=creator_id,
            creator_name=profile.creator,
            page_name=page_name,
            linked_at=linked_at,
        ),
    }
    if req.gallery_id:
        extensions["gallery_id"] = req.gallery_id

    avatar_url = req.avatar_url or datacat_mapper.resolve_avatar_url(character)

    card, all_warnings = build_card(
        profile=profile,
        greetings=greetings,
        book=book,
        avatar_url=avatar_url,
        character_version=source_url or "jai-proxy",
        extensions=extensions,
    )

    response = await fetch_avatar_and_write(
        write_fn=lambda avatar_bytes: png_writer.write(card, avatar_bytes, card_id=card_id),
        avatar_url=avatar_url,
        avatar_b64=req.avatar_b64,
        source="datacat",
        name=card.name,
        creator=card.creator or "",
        warnings=all_warnings,
        fields_present=_fields_present(card),
    )
    if response.ok and not response.duplicate:
        response.filename = Path(response.path).name if response.path else None
        response.card = card.to_dict()
    return response


# The browser, mounted last and mounted at the root.
#
# Last because Starlette matches routes in registration order and a mount at "/"
# matches everything: every API route above therefore wins, and the frontend
# picks up only what is left. Registering it earlier would swallow /api/v1 and
# the userscript endpoints whole.
#
# At the root rather than /library because the archive *is* this application
# now. There is no host page to be a subsection of.
#
# `html=True` serves index.html for "/" and for directory requests. It does
# NOT fall back to index.html for an arbitrary unknown path -- Starlette's
# StaticFiles only rewrites directory requests and looks for a 404.html,
# neither of which applies here -- so an unmatched path 404s (verified live).
# This app has no client-side deep-link routing that would need that fallback.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:  # pragma: no cover -- only in a checkout with the frontend removed
    logger.warning("web/ is missing at %s; the browser UI will not be served", WEB_DIR)


def _stats_line() -> str:
    return (
        f"{capture_store.count} captures · "
        f"{lorebook_cache.count} lorebooks cached · "
        f"model {responder.model}"
    )


def _serve() -> None:
    # log_config=None keeps uvicorn from installing its own stdout handlers, so
    # its records propagate to the root logger we configured instead.
    uvicorn.run(app, host=settings.host, port=settings.port, log_config=None)


def main() -> None:
    global DASHBOARD

    if not (settings.dashboard and sys.stdout.isatty()):
        logging.basicConfig(level=logging.INFO)
        _serve()
        return

    DASHBOARD = dashboard_mod.Dashboard(
        title="jai-proxy",
        address=f"http://{settings.host}:{settings.port}",
        stats=_stats_line,
    )
    dashboard_mod.install_logging(DASHBOARD)
    sink = dashboard_mod.StdoutSink(DASHBOARD.log)
    try:
        with dashboard_mod.live(DASHBOARD), contextlib.redirect_stdout(sink):
            _serve()
    except KeyboardInterrupt:  # pragma: no cover -- Ctrl-C is a clean exit
        pass
    finally:
        dashboard_mod.replay_problems(DASHBOARD, sys.stderr)
        DASHBOARD = None


if __name__ == "__main__":
    main()
