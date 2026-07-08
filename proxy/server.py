import logging
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

capture_store = CaptureStore()
mlx_client = MLXClient()
profile_parser = ProfileParser()
greeting_converter = GreetingConverter()
card_builder = CardBuilder()
png_writer = PngWriter()
avatar_fetcher = AvatarFetcher()


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


@app.post("/build")
async def build(req: BuildRequest) -> BuildResponse:
    profile = profile_parser.parse(req.profile_html or "")
    if not profile.name or profile.name == "Unknown":
        profile.name = req.character.name

    greetings = [greeting_converter.convert(html) for html in req.greetings_html]

    capture = capture_store.get(normalize(req.character.name))
    card, warnings = card_builder.build(profile, greetings, capture=capture, book=None)

    card.extensions = {
        "jai": {"source_url": req.character.url, "character_id": req.character.id}
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
