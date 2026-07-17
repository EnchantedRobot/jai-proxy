import logging
from datetime import datetime, timezone
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from proxy import janitor_mapper
from proxy.avatar import AvatarFetcher
from proxy.capture_store import CaptureStore
from proxy.cardbuilder import CardBuilder, PngWriter
from proxy.config import settings
from proxy.lorebook import LorebookMapper
from proxy.mlx_client import MLXClient, MLXError
from proxy.models import BuildRequest, BuildResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("jai_proxy.server")

app = FastAPI(title="jai-proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
mlx_client = MLXClient()
card_builder = CardBuilder()
png_writer = PngWriter()
avatar_fetcher = AvatarFetcher()
lorebook_mapper = LorebookMapper()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _first_message_of_role(messages: list[dict[str, Any]], role: str) -> str:
    for message in messages:
        if message.get("role") == role:
            content = message.get("content", "")
            return content if isinstance(content, str) else str(content)
    return ""



@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "captures": capture_store.count, "model": settings.mlx_model}


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": settings.mlx_model, "object": "model"}],
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

    try:
        if body.get("stream"):
            return StreamingResponse(
                mlx_client.stream(body), media_type="text/event-stream"
            )
        completion = await mlx_client.complete(body)
        return JSONResponse(completion)
    except MLXError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/capture-status")
async def capture_status(name: str) -> dict[str, Any]:
    return {"name": name, **capture_store.status(name)}


@app.post("/clear-captures")
async def clear_captures() -> dict[str, Any]:
    removed = capture_store.clear()
    return {"ok": True, "removed": removed}


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

    card, warnings = card_builder.build(profile, greetings, capture=capture, book=book)
    warnings = lore_warnings + warnings

    # data.name is the real character name (chat_name); the JSON `name` field
    # is the card-title blurb (often a scenario hook, not an actual character
    # name -- see "She needs your help"), preserved as metadata instead. An
    # explicit output_name from the export prompt overrides the card name.
    page_name = (character.get("name") or "").strip()
    if req.output_name and req.output_name.strip():
        card.name = req.output_name.strip()

    card.character_version = req.character.url or "jai-proxy"
    card.extensions = {
        "jai": {
            "source_url": req.character.url,
            "id": req.character.id or character.get("id"),
            "sourceKind": "janitor_core",
            "creatorName": card.creator,
            "pageName": page_name,
            "linkedAt": _utc_now_iso(),
        }
    }

    avatar_url = req.avatar_url or janitor_mapper.avatar_url(character)
    avatar_bytes = await avatar_fetcher.fetch(avatar_url, req.avatar_b64)
    path = png_writer.write(card, avatar_bytes)

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

    return BuildResponse(ok=True, path=str(path), warnings=warnings, fields_present=fields_present)


def main() -> None:
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
