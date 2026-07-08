from fastapi.testclient import TestClient

import proxy.server as server_module
from proxy.config import settings


class FakeMLXClient:
    def __init__(self):
        self.last_request = None

    async def complete(self, req):
        self.last_request = req
        return {
            "id": "chatcmpl-fake",
            "model": settings.mlx_model,
            "choices": [
                {
                    "message": {"role": "assistant", "content": "fake reply"},
                    "finish_reason": "stop",
                }
            ],
        }

    async def stream(self, req):
        self.last_request = req
        yield b'data: {"choices":[{"delta":{"content":"fake reply"}}]}\n\n'
        yield b"data: [DONE]\n\n"


def make_client(fake: FakeMLXClient, tmp_path=None) -> TestClient:
    server_module.mlx_client = fake
    server_module.capture_store = server_module.CaptureStore(captures_dir=tmp_path)
    return TestClient(server_module.app)


def test_health(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["captures"] == 0
    assert body["model"] == settings.mlx_model


def test_list_models(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    assert resp.json() == {
        "object": "list",
        "data": [{"id": settings.mlx_model, "object": "model"}],
    }


def test_chat_completions_captures_system_prompt_and_forwards(tmp_path):
    fake = FakeMLXClient()
    client = make_client(fake, tmp_path)

    resp = client.post(
        "/v1/chat/completions",
        json={
            "model": "whatever-janitorai-sends",
            "stream": False,
            "messages": [
                {"role": "system", "content": "<system>hidden def here</system>"},
                {"role": "user", "content": "hi"},
            ],
        },
    )

    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "fake reply"
    assert fake.last_request["messages"][0]["content"] == "<system>hidden def here</system>"

    health = client.get("/health").json()
    assert health["captures"] == 1

    written = list(tmp_path.glob("system_prompt_*.txt"))
    assert len(written) == 1
    assert written[0].read_text() == "<system>hidden def here</system>"


def test_chat_completions_streaming_returns_sse(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/v1/chat/completions",
        json={"model": "x", "stream": True, "messages": [{"role": "user", "content": "hi"}]},
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert "data: [DONE]" in resp.text


def test_chat_completions_capture_error_does_not_block_forward(monkeypatch, tmp_path):
    fake = FakeMLXClient()
    client = make_client(fake, tmp_path)
    monkeypatch.setattr(
        server_module.capture_store,
        "record",
        lambda *_: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    resp = client.post(
        "/v1/chat/completions",
        json={
            "model": "x",
            "stream": False,
            "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}],
        },
    )

    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "fake reply"
