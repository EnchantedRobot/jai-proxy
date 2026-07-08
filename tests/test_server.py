import base64
import io
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

import proxy.server as server_module
from proxy.config import settings

FIXTURES = Path(__file__).parent / "fixtures"


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


class FakeAvatarFetcher:
    def __init__(self, png_bytes: bytes | None = None):
        buf = io.BytesIO()
        Image.new("RGBA", (8, 8), (9, 9, 9, 255)).save(buf, "PNG")
        self._bytes = png_bytes or buf.getvalue()

    async def fetch(self, url, avatar_b64=None):
        return self._bytes


def make_client(fake: FakeMLXClient, tmp_path=None) -> TestClient:
    server_module.mlx_client = fake
    server_module.capture_store = server_module.CaptureStore(captures_dir=tmp_path)
    server_module.png_writer = server_module.PngWriter(output_dir=tmp_path)
    server_module.avatar_fetcher = FakeAvatarFetcher()
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


# ---------------------------------------------------------------------------
# /build -- public card export end-to-end (M3)
# ---------------------------------------------------------------------------


def test_build_exports_public_card_png(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    profile_html = (FIXTURES / "profile_akane_kujo.html").read_text(encoding="utf-8")

    resp = client.post(
        "/build",
        json={
            "character": {
                "name": "Akane Kujo",
                "id": "abc123",
                "url": "https://janitorai.com/characters/abc123",
            },
            "profile_html": profile_html,
            "greetings_html": [],
            "avatar_url": "https://ella.janitorai.com/bot-avatars/example.webp",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["description"] is True
    assert body["fields_present"]["scenario"] is True

    path = Path(body["path"])
    assert path.exists()
    assert path.parent == tmp_path

    reopened = Image.open(path)
    decoded = json.loads(base64.b64decode(reopened.text["ccv3"]))
    assert decoded["data"]["name"] == "Akane Kujo"
    assert decoded["data"]["creator"] == "dezea"
    assert decoded["data"]["extensions"]["jai"]["character_id"] == "abc123"
    assert decoded["data"]["extensions"]["jai"]["source_url"] == "https://janitorai.com/characters/abc123"


def test_build_falls_back_to_character_name_without_profile_html(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={"character": {"name": "No Profile Card"}},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "no first_mes / greetings found" in body["warnings"]

    path = Path(body["path"])
    reopened = Image.open(path)
    decoded = json.loads(base64.b64decode(reopened.text["chara"]))
    assert decoded["data"]["name"] == "No Profile Card"


# ---------------------------------------------------------------------------
# /build -- hidden-card merge end-to-end (M4)
# ---------------------------------------------------------------------------


def test_build_merges_captured_hidden_definition_when_profile_is_empty(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_prompt = (FIXTURES / "system_prompt_hidden_aubrey_evans.txt").read_text(encoding="utf-8")

    capture_resp = client.post(
        "/v1/chat/completions",
        json={
            "model": "x",
            "stream": False,
            "messages": [
                {"role": "system", "content": raw_prompt},
                {"role": "user", "content": "hi"},
            ],
        },
    )
    assert capture_resp.status_code == 200

    build_resp = client.post(
        "/build",
        json={"character": {"name": "Aubrey Evans"}},
    )

    assert build_resp.status_code == 200
    body = build_resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["description"] is True
    assert body["fields_present"]["scenario"] is True
    assert body["fields_present"]["mes_example"] is True

    decoded = json.loads(base64.b64decode(Image.open(Path(body["path"])).text["ccv3"]))
    assert decoded["data"]["name"] == "Aubrey Evans"
    assert "Her nickname is Ace" in decoded["data"]["description"]
    assert decoded["data"]["scenario"].startswith("setting: {The Regional Championship")
    assert decoded["data"]["mes_example"].startswith("USER: *As her coach")


def test_build_prefers_visible_dom_over_capture_when_both_present(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_prompt = (FIXTURES / "system_prompt_hidden_lyra.txt").read_text(encoding="utf-8")
    profile_html = (FIXTURES / "profile_akane_kujo.html").read_text(encoding="utf-8")

    client.post(
        "/v1/chat/completions",
        json={
            "model": "x",
            "stream": False,
            "messages": [
                {"role": "system", "content": raw_prompt},
                {"role": "user", "content": "hi"},
            ],
        },
    )

    build_resp = client.post(
        "/build",
        json={"character": {"name": "Lyra"}, "profile_html": profile_html},
    )

    body = build_resp.json()
    decoded = json.loads(base64.b64decode(Image.open(Path(body["path"])).text["ccv3"]))
    # profile_akane_kujo.html's own visible description wins even though the
    # request was for character "Lyra" (name mismatch is irrelevant here --
    # this only proves visible-DOM precedence, not name resolution).
    assert "Full Name: Lyra Amarok" not in decoded["data"]["description"]


# ---------------------------------------------------------------------------
# /build -- lorebook mapping + hidden-def lore merge wiring (M5)
# ---------------------------------------------------------------------------


def test_build_populates_character_book_from_lorebooks_payload(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_script = json.loads((FIXTURES / "hampter_script_kamii_university.json").read_text(encoding="utf-8"))

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Akane Kujo"},
            "lorebooks": [{"id": raw_script["id"], "raw": raw_script}],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["character_book"] is True

    decoded = json.loads(base64.b64decode(Image.open(Path(body["path"])).text["ccv3"]))
    book = decoded["data"]["character_book"]
    assert book["name"] == "Kamii University: A Living Campus"
    assert len(book["entries"]) == 20
    assert book["entries"][0]["content"].startswith("Kamii University: The Living Campus")


def test_build_with_no_lorebooks_has_no_character_book(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post("/build", json={"character": {"name": "No Lore"}})

    assert resp.status_code == 200
    body = resp.json()
    assert body["fields_present"]["character_book"] is False


def test_build_surfaces_lorebook_mapping_warnings(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Broken Script Owner"},
            "lorebooks": [
                {"id": "broken", "raw": {"type": "lorebook", "id": "broken", "title": "Broken", "script": "not json"}}
            ],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert any("Broken" in w for w in body["warnings"])
    assert body["fields_present"]["character_book"] is False


def test_build_maps_greetings_html_to_first_mes(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Greeter"},
            "greetings_html": ["<p>Hello <strong>there</strong></p>", "<p>Second</p>"],
        },
    )

    assert resp.status_code == 200
    path = Path(resp.json()["path"])
    decoded = json.loads(base64.b64decode(Image.open(path).text["ccv3"]))
    assert decoded["data"]["first_mes"] == "Hello **there**"
    assert decoded["data"]["alternate_greetings"] == ["Second"]
