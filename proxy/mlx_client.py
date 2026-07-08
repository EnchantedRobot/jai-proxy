import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from proxy.config import settings


class MLXError(Exception):
    """Raised when the MLX upstream fails or returns a non-2xx response."""


class MLXClient:
    """Thin async wrapper around MLX's OpenAI-compatible /chat/completions."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(timeout=settings.request_timeout)

    async def complete(self, req: dict[str, Any]) -> dict[str, Any]:
        body = {**req, "model": settings.mlx_model}
        url = f"{settings.mlx_base_url}/chat/completions"
        try:
            resp = await self._client.post(url, json=body)
        except httpx.HTTPError as exc:
            raise MLXError(f"MLX request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise MLXError(f"MLX returned {resp.status_code}: {resp.text}")
        return resp.json()

    async def stream(self, req: dict[str, Any]) -> AsyncIterator[bytes]:
        """v1: request non-streaming from MLX, then yield the full reply as a
        single OpenAI SSE `data:` chunk followed by a terminal [DONE]."""
        completion = await self.complete({**req, "stream": False})
        message = completion.get("choices", [{}])[0].get("message", {})
        chunk = {
            "id": completion.get("id", "chatcmpl-jai-proxy"),
            "object": "chat.completion.chunk",
            "model": completion.get("model", settings.mlx_model),
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "role": message.get("role", "assistant"),
                        "content": message.get("content", ""),
                    },
                    "finish_reason": completion.get("choices", [{}])[0].get(
                        "finish_reason", "stop"
                    ),
                }
            ],
        }
        yield f"data: {json.dumps(chunk)}\n\n".encode()
        yield b"data: [DONE]\n\n"

    async def aclose(self) -> None:
        await self._client.aclose()
