import logging
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from proxy.capture_store import CaptureStore
from proxy.config import settings
from proxy.mlx_client import MLXClient, MLXError

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


def main() -> None:
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
