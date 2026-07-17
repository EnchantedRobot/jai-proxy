import base64
import io
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

import proxy.server as server_module
from proxy.config import settings

FIXTURES = Path(__file__).parent / "fixtures"


def _character(name: str) -> dict:
    return json.loads((FIXTURES / "hampter" / f"{name}.json").read_text(encoding="utf-8"))


def _saucepan(id_fragment: str) -> dict:
    path = next((FIXTURES / "saucepan").glob(f"saucepan_{id_fragment}*.json"))
    return json.loads(path.read_text(encoding="utf-8"))


def _prompt(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


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


def _decode(path) -> dict:
    return json.loads(base64.b64decode(Image.open(Path(path)).text["ccv3"]))["data"]


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


# ---------------------------------------------------------------------------
# /v1/chat/completions -- forwards to MLX and captures the hidden definition
# (system message) + primary greeting (first assistant message).
# ---------------------------------------------------------------------------


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

    assert client.get("/health").json()["captures"] == 1

    written = list(tmp_path.glob("system_prompt_*.txt"))
    assert len(written) == 1
    assert written[0].read_text() == "<system>hidden def here</system>"


def test_chat_completions_captures_assistant_message_as_primary_greeting(tmp_path):
    # Real captured JanitorAI chat request: [system(hidden def), user ".",
    # assistant(rendered primary greeting), user "USER: hello"]. One relay
    # captures both halves a hidden card needs.
    client = make_client(FakeMLXClient(), tmp_path)
    real_request = json.loads((FIXTURES / "chat_request_hidden_ari.json").read_text(encoding="utf-8"))

    client.post("/v1/chat/completions", json=real_request)

    status = client.get("/capture-status", params={"name": "Ari"}).json()
    assert status == {"name": "Ari", "system": True, "greetings": True}

    # Stored as the assistant message (index 2), stripped.
    record = server_module.capture_store.get("Ari")
    assert record.greetings == [real_request["messages"][2]["content"].strip()]


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
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
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
# /build -- open card export end-to-end (JSON API path).
# ---------------------------------------------------------------------------


def test_build_exports_open_card_png(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    akane = _character("open_akane_kujo")

    resp = client.post(
        "/build",
        json={
            "character": {
                "name": "Akane Kujo",
                "id": "abc123",
                "url": "https://janitorai.com/characters/abc123",
            },
            "character_json": akane,
            "avatar_url": "https://ella.janitorai.com/bot-avatars/example.webp",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["description"] is True
    assert body["fields_present"]["scenario"] is True
    assert body["fields_present"]["first_mes"] is True
    assert body["fields_present"]["alternate_greetings"] is True

    path = Path(body["path"])
    # Foldered by creator, name suffixed with the card-id fragment.
    assert path.exists()
    assert path.parent == tmp_path / "dezea"
    assert path.name == "Akane_Kujo_abc123.png"

    data = _decode(path)
    assert data["name"] == "Akane Kujo"
    assert data["creator"] == "dezea"
    assert data["tags"] == [
        "Female", "Multiple", "AnyPOV", "Angst", "Demi-Human",
        "Fluff", "Horror", "kitsune", "yandere", "TheValentine",
    ]
    assert data["first_mes"].startswith("**Scenario: Welcome to Kamii University!**")
    assert data["character_version"] == "https://janitorai.com/characters/abc123"

    jai = data["extensions"]["jai"]
    assert jai["id"] == "abc123"
    assert jai["source_url"] == "https://janitorai.com/characters/abc123"
    assert jai["sourceKind"] == "janitor_core"
    assert jai["creatorName"] == "dezea"
    # The JSON `name` field (the card-title blurb) is kept as metadata, not
    # embedded as data.name.
    assert jai["pageName"] == "The Girl in Every Yearbook | Akane Kujo"
    assert "linkedAt" in jai


# ---------------------------------------------------------------------------
# /build-saucepan -- open card export end-to-end (saucepan JSON API path). Same
# assemble/write tail as /build; differs only in the source mapper.
# ---------------------------------------------------------------------------


def test_build_saucepan_exports_open_card_png(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    eve = _saucepan("04a0c1ac")

    resp = client.post("/build-saucepan", json={"character": eve})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["description"] is True
    assert body["fields_present"]["scenario"] is True
    assert body["fields_present"]["first_mes"] is True
    assert body["fields_present"]["alternate_greetings"] is True
    assert body["fields_present"]["character_book"] is True

    path = Path(body["path"])
    # Foldered by creator handle, name suffixed with the companion-id fragment.
    assert path.parent == tmp_path / "desslok"
    assert path.name == "Eve_04a0c1ac.png"

    data = _decode(path)
    assert data["name"] == "Eve"
    assert data["creator"] == "desslok"
    assert data["first_mes"].startswith("Throughout her first week at Crestfall High")
    assert len(data["alternate_greetings"]) == 3  # 5 scenarios, one blank dropped
    # Advanced Prompt leads scenario, raw.
    assert data["scenario"].startswith("{{char}} is an android")
    assert len(data["character_book"]["entries"]) == 19  # two lorebooks merged
    assert (
        data["character_version"]
        == "https://saucepan.ai/companion/04a0c1ac-187b-4aa0-8f5b-885533be748d"
    )

    jai = data["extensions"]["jai"]
    assert jai["sourceKind"] == "saucepan_core"
    assert jai["id"] == "04a0c1ac-187b-4aa0-8f5b-885533be748d"
    assert jai["source_url"] == "https://saucepan.ai/companion/04a0c1ac-187b-4aa0-8f5b-885533be748d"
    assert jai["creatorName"] == "desslok"
    assert jai["pageName"] == "Eve | I Did Nothing Wrong"


def test_build_saucepan_response_formatting_lands_in_scenario(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post("/build-saucepan", json={"character": _saucepan("1155a61e")})

    data = _decode(resp.json()["path"])
    assert data["name"] == "Taryn"
    # No Advanced Prompt; Response Formatting appended under a label instead.
    assert data["scenario"].startswith("--- Response Formatting Instructions ---")


def test_build_saucepan_hidden_card_warns_but_exports_public_fields(tmp_path):
    # A hidden companion (open_definition:false) can't yield its definition, so
    # the build warns and falls back to the public fields rather than failing.
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post("/build-saucepan", json={"character": _saucepan("closed_83831943")})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert any("not open" in w for w in body["warnings"])
    # Public fields (name, blurb, greetings) survive; the hidden definition
    # (scenario / example dialogue) does not.
    assert body["fields_present"]["description"] is True
    assert body["fields_present"]["first_mes"] is True
    assert body["fields_present"]["scenario"] is False
    assert body["fields_present"]["mes_example"] is False

    data = _decode(Path(body["path"]))
    assert data["name"] == "Maddie, Alice, Laila, Veronica, Sadie"
    assert data["creator"] == "GreatN"
    assert data["extensions"]["jai"]["sourceKind"] == "saucepan_core"
    assert data["mes_example"] == ""


# ---------------------------------------------------------------------------
# /existing -- "which of these ids are already on disk?" for bulk skip.
# ---------------------------------------------------------------------------


def test_existing_reports_only_ids_already_on_disk(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    akane = _character("open_akane_kujo")

    # Save one card, then ask about its id plus one we never built.
    client.post(
        "/build",
        json={
            "character": {"name": "Akane Kujo", "id": "abc123"},
            "character_json": akane,
        },
    )

    resp = client.post("/existing", json={"ids": ["abc123", "never-built-999"]})

    assert resp.status_code == 200
    assert resp.json() == {"existing": ["abc123"]}


def test_existing_matches_on_id_fragment_regardless_of_name(tmp_path):
    # The saved filename keys on the first 8 id chars, so a full UUID whose
    # fragment matches an on-disk card is reported even though the caller has
    # no idea what name it was saved under.
    client = make_client(FakeMLXClient(), tmp_path)
    client.post(
        "/build",
        json={
            "character": {"name": "Whoever", "id": "deadbeef-1111-2222-3333-444455556666"},
            "character_json": {"chat_name": "Whoever", "creator_name": "acreator"},
        },
    )

    resp = client.post(
        "/existing", json={"ids": ["deadbeef-1111-2222-3333-444455556666"]}
    )

    assert resp.json()["existing"] == ["deadbeef-1111-2222-3333-444455556666"]


def test_existing_empty_request_returns_empty(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    resp = client.post("/existing", json={"ids": []})
    assert resp.status_code == 200
    assert resp.json() == {"existing": []}


def test_build_falls_back_to_character_name_without_character_json(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post("/build", json={"character": {"name": "No Profile Card"}})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "no first_mes / greetings found" in body["warnings"]

    data = _decode(body["path"])
    assert data["name"] == "No Profile Card"
    assert data["character_version"] == "jai-proxy"


def test_build_names_card_from_chat_name_not_title_blurb(tmp_path):
    # The userscript sends no name anymore -- the server names the card (and its
    # file) from chat_name (the real character name), never from the JSON `name`
    # field (the card-title blurb), which is preserved only as metadata.
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"id": "deadbeef-1234-5678-9abc-def012345678"},
            "character_json": {
                "chat_name": "Chatname",
                "name": "Scenario Hook Blurb",
                "creator_name": "somecreator",
            },
        },
    )

    assert resp.status_code == 200
    path = Path(resp.json()["path"])
    # chat_name drives the filename stem; creator folders it; id suffixes it.
    assert path.parent.name == "somecreator"
    assert path.name == "Chatname_deadbeef.png"

    data = _decode(path)
    assert data["name"] == "Chatname"
    # The title blurb is preserved as metadata, not embedded as data.name.
    assert data["extensions"]["jai"]["pageName"] == "Scenario Hook Blurb"


# ---------------------------------------------------------------------------
# /build -- hidden-card merge: definition + primary greeting from the chat
# capture, everything else from the JSON.
# ---------------------------------------------------------------------------


# Full-length alternate greetings (real greetings clear the 100-char floor).
_ALT_1 = "*The morning bell rang across the empty courtyard as " + ("she waited by the gate, " * 4)
_ALT_2 = "*Rain streaked the classroom windows while " + ("the lesson droned on, " * 5)


def _hidden_ari_json() -> dict:
    return {
        "chat_name": "Ari",
        "name": "A Mysterious Transfer Student",
        "creator_name": "somecreator",
        "showdefinition": False,
        "custom_tags": ["mystery"],
        "tags": [{"name": "👤 AnyPOV"}],
        # first_messages[0] (primary) nulled by the server for hidden cards; a
        # "." placeholder plus two real alternates -- the placeholder is
        # dropped by the greeting floor.
        "first_messages": [None, _ALT_1, _ALT_2, "."],
        "description": "<p>The creator's authored note.</p>",
        "avatar": "ari.webp",
        "id": "ari-id-123",
    }


def _capture_ari(client, greeting: str | None) -> None:
    messages = [{"role": "system", "content": _prompt("system_prompt_hidden_ari.txt")}]
    if greeting is not None:
        messages += [{"role": "user", "content": "."}, {"role": "assistant", "content": greeting}]
    client.post("/v1/chat/completions", json={"model": "x", "stream": False, "messages": messages})


def test_build_hidden_card_with_no_capture_fails(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "character_json": _hidden_ari_json()},
    )

    body = resp.json()
    assert body["ok"] is False
    assert "hidden card not exportable" in body["warnings"][0]


def test_build_hidden_card_with_definition_but_no_greeting_fails(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    _capture_ari(client, greeting=None)  # system captured, no assistant greeting

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "character_json": _hidden_ari_json()},
    )

    body = resp.json()
    assert body["ok"] is False
    assert "hidden card not exportable" in body["warnings"][0]


def test_build_hidden_card_merges_capture_and_json(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    _capture_ari(client, greeting="Hello there, USER")

    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "character_json": _hidden_ari_json()},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True

    data = _decode(body["path"])
    # Definition body comes from the chat capture.
    assert data["name"] == "Ari"
    assert "Location: USA" in data["description"]
    # Primary greeting from the capture (persona name reversed to {{user}});
    # alternates from the JSON (the "." placeholder dropped by the floor).
    assert data["first_mes"] == "Hello there, {{user}}"
    assert data["alternate_greetings"] == [_ALT_1, _ALT_2]
    # Metadata from the JSON.
    assert data["creator"] == "somecreator"
    assert data["tags"] == ["AnyPOV", "mystery"]
    # creator_notes leads with a markdown reference to the original avatar.
    assert data["creator_notes"] == (
        "![Ari](https://ella.janitorai.com/bot-avatars/ari.webp)\n\n"
        "The creator's authored note."
    )
    assert data["extensions"]["jai"]["pageName"] == "A Mysterious Transfer Student"


# ---------------------------------------------------------------------------
# /build -- lorebook mapping from the lorebooks payload.
# ---------------------------------------------------------------------------


def test_build_populates_character_book_from_lorebooks_payload(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)
    raw_script = json.loads((FIXTURES / "hampter_script_kamii_university.json").read_text(encoding="utf-8"))

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Akane Kujo"},
            "character_json": {"chat_name": "Akane Kujo", "first_messages": ["hi"]},
            "lorebooks": [{"id": raw_script["id"], "raw": raw_script}],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["fields_present"]["character_book"] is True

    book = _decode(body["path"])["character_book"]
    assert book["name"] == "Kamii University: A Living Campus"
    assert len(book["entries"]) == 20
    assert book["entries"][0]["content"].startswith("Kamii University: The Living Campus")


def test_build_with_no_lorebooks_has_no_character_book(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={"character": {"name": "No Lore"}, "character_json": {"chat_name": "No Lore"}},
    )

    assert resp.json()["fields_present"]["character_book"] is False


def test_build_surfaces_lorebook_mapping_warnings(tmp_path):
    client = make_client(FakeMLXClient(), tmp_path)

    resp = client.post(
        "/build",
        json={
            "character": {"name": "Broken Script Owner"},
            "character_json": {"chat_name": "Broken Script Owner"},
            "lorebooks": [
                {"id": "broken", "raw": {"type": "lorebook", "id": "broken", "title": "Broken", "script": "not json"}}
            ],
        },
    )

    body = resp.json()
    assert any("Broken" in w for w in body["warnings"])
    assert body["fields_present"]["character_book"] is False


# ---------------------------------------------------------------------------
# /capture-status + /clear-captures
# ---------------------------------------------------------------------------


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

    _capture_ari(client, greeting="Hi USER")
    resp = client.post(
        "/build",
        json={"character": {"name": "Ari"}, "character_json": _hidden_ari_json()},
    )
    assert resp.json()["ok"] is True
    assert any(output_dir.rglob("*.png"))

    body = client.post("/clear-captures").json()
    assert body["ok"] is True
    assert body["removed"] > 0

    status = client.get("/capture-status", params={"name": "Ari"}).json()
    assert status == {"name": "Ari", "system": False, "greetings": False}
    assert any(output_dir.rglob("*.png"))
