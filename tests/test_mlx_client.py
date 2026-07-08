import json

import httpx
import pytest

from proxy.config import settings
from proxy.mlx_client import MLXClient, MLXError


def _client(handler) -> MLXClient:
    transport = httpx.MockTransport(handler)
    return MLXClient(client=httpx.AsyncClient(transport=transport))


@pytest.mark.asyncio
async def test_complete_overrides_model_and_hits_chat_completions_url():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "model": settings.mlx_model,
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "hi there"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = _client(handler)
    result = await client.complete({"model": "gpt-4-whatever", "messages": []})

    assert seen["url"] == f"{settings.mlx_base_url}/chat/completions"
    assert seen["body"]["model"] == settings.mlx_model
    assert result["choices"][0]["message"]["content"] == "hi there"


@pytest.mark.asyncio
async def test_complete_raises_mlx_error_on_upstream_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = _client(handler)
    with pytest.raises(MLXError):
        await client.complete({"messages": []})


@pytest.mark.asyncio
async def test_stream_yields_single_sse_chunk_then_done():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "model": settings.mlx_model,
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "hi there"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = _client(handler)
    chunks = [c async for c in client.stream({"messages": []})]

    assert len(chunks) == 2
    assert chunks[0].startswith(b"data: ")
    payload = json.loads(chunks[0][len(b"data: ") :])
    assert payload["choices"][0]["delta"]["content"] == "hi there"
    assert payload["object"] == "chat.completion.chunk"
    assert chunks[1] == b"data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_stream_forces_non_streaming_request_to_mlx():
    """Regression: forwarding the caller's stream:true straight to MLX makes
    MLX itself return SSE text, which broke resp.json() in complete()."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "model": settings.mlx_model,
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "hi there"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = _client(handler)
    [c async for c in client.stream({"messages": [], "stream": True})]

    assert seen["body"]["stream"] is False
