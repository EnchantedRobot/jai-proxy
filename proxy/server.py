import contextlib
import logging
import sys
from datetime import datetime, timezone
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from proxy import dashboard as dashboard_mod
from proxy import janitor_mapper, saucepan_mapper
from proxy.api import v1_router
from proxy.avatar import AvatarFetcher
from proxy.capture_store import CaptureStore
from proxy.cardbuilder import CardBuilder, PngWriter
from proxy.config import ROOT, settings
from proxy.lorebook import LorebookMapper
from proxy.lorebook_cache import LorebookCache
from proxy.mock_responder import MockResponder
from proxy.models import (
    BuildRequest,
    BuildResponse,
    CaptureRecord,
    CharacterBook,
    ExistingRequest,
    ExistingResponse,
    LorebookExistingRequest,
    LorebookExistingResponse,
    ProfileFields,
    SaucepanBuildRequest,
)
from proxy.saucepan_mapper import SAUCEPAN_ORIGIN

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
    """The shared tail every source path funnels through: build the card from
    neutral fields, stamp provenance, fetch the avatar, and write the PNG. Both
    /build (JanitorAI) and /build-saucepan differ only in how they produce the
    inputs (profile, greetings, book, avatar_url, extensions) -- everything from
    here down is identical.

    A card whose id is already on disk is left alone: the export stops here,
    before the avatar fetch, and reports the file it found. Re-acquiring one
    means deleting it first -- the same rule `make import` and the bulk sweep
    follow, so a card edited in SillyTavern is never silently replaced."""
    already = png_writer.find_by_id(card_id)
    if already:
        _record_download(
            source=source,
            name=profile.name,
            creator=profile.creator or "",
            duplicate=True,
            filename=already[0].name,
        )
        return BuildResponse(ok=True, path=str(already[0]), duplicate=True)

    card, build_warnings = card_builder.build(
        profile, greetings, capture=capture, book=book, avatar_url=avatar_url
    )
    all_warnings = (warnings or []) + build_warnings

    card.character_version = character_version or "jai-proxy"
    card.extensions = extensions

    avatar_bytes = await avatar_fetcher.fetch(avatar_url, avatar_b64)
    path = png_writer.write(card, avatar_bytes, card_id=card_id)
    _record_download(
        source=source, name=card.name, creator=card.creator or "", filename=path.name
    )

    fields_present = {
        "description": bool(card.description),
        "scenario": bool(card.scenario),
        "mes_example": bool(card.mes_example),
        "first_mes": bool(card.first_mes),
        "alternate_greetings": bool(card.alternate_greetings),
        "creator_notes": bool(card.creator_notes),
        "tags": bool(card.tags),
        "character_book": card.character_book is not None,
    }

    return BuildResponse(ok=True, path=str(path), warnings=all_warnings, fields_present=fields_present)


@app.post("/build")
async def build(req: BuildRequest) -> BuildResponse:
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
    """saucepan peer of /build. The userscript posts the raw
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
# `html=True` serves index.html for "/" and, importantly, returns index.html
# rather than 404 for unknown paths, which is what a client-side router needs.
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
