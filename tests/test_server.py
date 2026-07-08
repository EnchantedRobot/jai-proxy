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
    assert decoded["data"]["character_version"] == "https://janitorai.com/characters/abc123"
    jai_ext = decoded["data"]["extensions"]["jai"]
    assert jai_ext["id"] == "abc123"
    assert jai_ext["source_url"] == "https://janitorai.com/characters/abc123"
    assert jai_ext["sourceKind"] == "janitor_core"
    assert jai_ext["creatorName"] == "dezea"
    assert jai_ext["pageName"] == "Akane Kujo"
    assert "linkedAt" in jai_ext


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
    assert decoded["data"]["character_version"] == "jai-proxy"


def test_build_uses_output_name_override_as_card_name_and_filename(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Original Card Name"},
            "output_name": "My Custom Save Name",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True

    path = Path(body["path"])
    assert path.name == "My_Custom_Save_Name.png"

    reopened = Image.open(path)
    decoded = json.loads(base64.b64decode(reopened.text["chara"]))
    assert decoded["data"]["name"] == "My Custom Save Name"
    # The page-scraped name is preserved as metadata, not embedded as data.name.
    assert decoded["data"]["extensions"]["jai"]["pageName"] == "Original Card Name"


def test_build_blank_output_name_falls_back_to_page_name(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Blank Override Card"},
            "output_name": "   ",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    path = Path(body["path"])
    assert path.name == "Blank_Override_Card.png"

    reopened = Image.open(path)
    decoded = json.loads(base64.b64decode(reopened.text["chara"]))
    assert decoded["data"]["name"] == "Blank Override Card"


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
    assert decoded["data"]["mes_example"].startswith("{{user}}: *As her coach")


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


# ---------------------------------------------------------------------------
# /capture-greetings + /capture-status + hidden-card export gate (M7)
# ---------------------------------------------------------------------------


def test_capture_greetings_then_status_reflects_it(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/capture-greetings",
        json={"name": "Ari", "greetings_html": ["<p>Hi there</p>", "<p>Second</p>"]},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "name": "Ari", "count": 2}

    status = client.get("/capture-status", params={"name": "Ari"}).json()
    assert status == {"name": "Ari", "system": False, "greetings": True}


def test_capture_status_unknown_name_is_all_false(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    status = client.get("/capture-status", params={"name": "Nobody"}).json()
    assert status == {"name": "Nobody", "system": False, "greetings": False}


def test_clear_captures_wipes_state_but_leaves_pngs(tmp_path):
    captures_dir = tmp_path / "captures"
    output_dir = tmp_path / "cards"
    server_module.capture_store = server_module.CaptureStore(captures_dir=captures_dir)
    server_module.png_writer = server_module.PngWriter(output_dir=output_dir)
    server_module.mlx_client = FakeMLXClient()
    server_module.avatar_fetcher = FakeAvatarFetcher()
    client = TestClient(server_module.app)

    client.post(
        "/capture-greetings",
        json={"name": "Ari", "greetings_html": ["<p>Hi there</p>"]},
    )
    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "avatar_url": "http://example.com/a.png"},
    )
    assert resp.json()["ok"] is True
    assert any(output_dir.glob("*.png"))

    clear_resp = client.post("/clear-captures")
    assert clear_resp.status_code == 200
    body = clear_resp.json()
    assert body["ok"] is True
    assert body["removed"] > 0

    status = client.get("/capture-status", params={"name": "Ari"}).json()
    assert status == {"name": "Ari", "system": False, "greetings": False}
    assert any(output_dir.glob("*.png"))


_HIDDEN_PROFILE_HTML = "<div>Character Definition is hidden, Total 4486 tokens</div>"


def test_build_on_hidden_profile_with_no_capture_fails_with_warning(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "profile_html": _HIDDEN_PROFILE_HTML},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "system definition" in body["warnings"][0]
    assert "greetings" in body["warnings"][0]


def test_build_on_hidden_profile_with_partial_capture_fails_with_warning(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_prompt = (FIXTURES / "system_prompt_hidden_ari.txt").read_text(encoding="utf-8")

    client.post(
        "/v1/chat/completions",
        json={
            "model": "x",
            "stream": False,
            "messages": [{"role": "system", "content": raw_prompt}, {"role": "user", "content": "hi"}],
        },
    )

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "profile_html": _HIDDEN_PROFILE_HTML},
    )

    body = resp.json()
    assert body["ok"] is False
    assert "greetings" in body["warnings"][0]
    assert "system definition" not in body["warnings"][0]


def test_build_on_hidden_profile_with_both_captures_succeeds(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_prompt = (FIXTURES / "system_prompt_hidden_ari.txt").read_text(encoding="utf-8")

    client.post(
        "/v1/chat/completions",
        json={
            "model": "x",
            "stream": False,
            "messages": [{"role": "system", "content": raw_prompt}, {"role": "user", "content": "hi"}],
        },
    )
    client.post(
        "/capture-greetings",
        json={"name": "Ari", "greetings_html": ["<p>Hello there, USER</p>"]},
    )

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "profile_html": _HIDDEN_PROFILE_HTML},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    path = Path(body["path"])
    assert path.exists()

    decoded = json.loads(base64.b64decode(Image.open(path).text["ccv3"]))
    assert decoded["data"]["first_mes"] == "Hello there, {{user}}"


def test_build_on_open_card_profile_still_exports_with_no_capture(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    profile_html = (FIXTURES / "profile_akane_kujo.html").read_text(encoding="utf-8")

    resp = client.post(
        "/build",
        json={"character": {"name": "Akane Kujo"}, "profile_html": profile_html},
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True


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
