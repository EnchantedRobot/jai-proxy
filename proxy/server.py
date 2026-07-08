import logging
from datetime import datetime, timezone
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from proxy.avatar import AvatarFetcher
from proxy.capture_store import CaptureStore, normalize
from proxy.cardbuilder import CardBuilder, PngWriter
from proxy.config import settings
from proxy.html_parser import GreetingConverter, ProfileParser
from proxy.lorebook import LorebookMapper
from proxy.mlx_client import MLXClient, MLXError
from proxy.models import BuildRequest, BuildResponse, CaptureGreetingsRequest

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
profile_parser = ProfileParser()
greeting_converter = GreetingConverter()
card_builder = CardBuilder()
png_writer = PngWriter()
avatar_fetcher = AvatarFetcher()
lorebook_mapper = LorebookMapper()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _first_system_message(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") == "system":
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
        capture_store.record(_first_system_message(body.get("messages", [])))
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


@app.post("/capture-greetings")
async def capture_greetings(req: CaptureGreetingsRequest) -> dict[str, Any]:
    count = capture_store.record_greetings(req.name, req.greetings_html)
    return {"ok": True, "name": req.name, "count": count}


@app.get("/capture-status")
async def capture_status(name: str) -> dict[str, Any]:
    return {"name": name, **capture_store.status(name)}


@app.post("/clear-captures")
async def clear_captures() -> dict[str, Any]:
    removed = capture_store.clear()
    return {"ok": True, "removed": removed}


@app.post("/build")
async def build(req: BuildRequest) -> BuildResponse:
    profile = profile_parser.parse(req.profile_html or "")
    if not profile.name or profile.name == "Unknown":
        profile.name = req.character.name

    capture = capture_store.get(normalize(req.character.name))

    greetings_html = req.greetings_html or (capture.greetings if capture else [])
    greetings = [greeting_converter.convert(html) for html in greetings_html]

    hidden = "Character Definition is hidden" in (req.profile_html or "")
    has_system = capture is not None and bool(
        capture.personality or capture.scenario or capture.mes_example
    )
    has_greetings = bool(greetings_html)
    if hidden and not (has_system and has_greetings):
        missing = []
        if not has_system:
            missing.append("system definition (send a chat message)")
        if not has_greetings:
            missing.append("greetings (click Export greetings in the chat)")
        return BuildResponse(
            ok=False,
            warnings=[f"hidden card not exportable — missing: {', '.join(missing)}"],
        )

    raw_scripts = [lb.raw for lb in req.lorebooks]
    book, lore_warnings = lorebook_mapper.map(raw_scripts, character_name=req.character.name)
    if capture is not None:
        book = lorebook_mapper.merge(book, capture.lore_entries)

    card, warnings = card_builder.build(profile, greetings, capture=capture, book=book)
    warnings = lore_warnings + warnings

    # The name typed into the export prompt becomes the card's real name;
    # the page-scraped name (often a scenario blurb, not an actual
    # character name -- see "She needs your help") is preserved as
    # metadata instead of being embedded as `data.name`.
    page_name = profile.name
    if req.output_name and req.output_name.strip():
        card.name = req.output_name.strip()

    card.character_version = req.character.url or "jai-proxy"
    card.extensions = {
        "jai": {
            "source_url": req.character.url,
            "id": req.character.id,
            "sourceKind": "janitor_core",
            "creatorName": card.creator,
            "pageName": page_name,
            "linkedAt": _utc_now_iso(),
        }
    }

    avatar_bytes = await avatar_fetcher.fetch(req.avatar_url, req.avatar_b64)
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
