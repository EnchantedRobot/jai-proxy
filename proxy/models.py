from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# /v1/chat/completions
# ---------------------------------------------------------------------------


class ChatCompletionRequest(BaseModel):
    """Passthrough shape of whatever JanitorAI sends. Extra fields are kept
    verbatim so nothing is lost on the way to MLX."""

    model_config = {"extra": "allow"}

    model: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    stream: bool = False


# ---------------------------------------------------------------------------
# Lorebook / character_book
# ---------------------------------------------------------------------------


class LoreEntry(BaseModel):
    keys: list[str] = Field(default_factory=list)
    content: str = ""
    extensions: dict[str, Any] = Field(default_factory=dict)


class CharacterBook(BaseModel):
    name: str = ""
    entries: list[LoreEntry] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Parsed hidden-definition (from the chat system prompt)
# ---------------------------------------------------------------------------


class ParsedDefinition(BaseModel):
    name: str = ""
    personality: str = ""
    scenario: str = ""
    mes_example: str = ""
    first_mes: str = ""
    raw: str = ""


# ---------------------------------------------------------------------------
# Parsed visible profile (from DOM HTML)
# ---------------------------------------------------------------------------


class ProfileFields(BaseModel):
    name: str = ""
    creator: str = ""
    tags: list[str] = Field(default_factory=list)
    description: str = ""
    scenario: str = ""
    mes_example: str = ""
    creator_notes: str = ""


# ---------------------------------------------------------------------------
# CaptureStore record
# ---------------------------------------------------------------------------


class CaptureRecord(BaseModel):
    name: str = ""
    personality: str = ""
    scenario: str = ""
    mes_example: str = ""
    raw_system_prompt: str = ""
    lore_entries: list[LoreEntry] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=_utcnow)


# ---------------------------------------------------------------------------
# /build
# ---------------------------------------------------------------------------


class BuildCharacter(BaseModel):
    name: str
    id: str | None = None
    url: str | None = None


class BuildLorebook(BaseModel):
    id: str
    raw: dict[str, Any] = Field(default_factory=dict)


class BuildRequest(BaseModel):
    character: BuildCharacter
    profile_html: str | None = None
    greetings_html: list[str] = Field(default_factory=list)
    avatar_url: str | None = None
    avatar_b64: str | None = None
    lorebooks: list[BuildLorebook] = Field(default_factory=list)


class BuildResponse(BaseModel):
    ok: bool
    path: str | None = None
    warnings: list[str] = Field(default_factory=list)
    fields_present: dict[str, bool] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Character Card V3
# ---------------------------------------------------------------------------


class CharacterCardV3(BaseModel):
    name: str = ""
    description: str = ""
    personality: str = ""
    scenario: str = ""
    mes_example: str = ""
    first_mes: str = ""
    alternate_greetings: list[str] = Field(default_factory=list)
    creator: str = ""
    creator_notes: str = ""
    tags: list[str] = Field(default_factory=list)
    character_book: CharacterBook | None = None
    system_prompt: str = ""
    post_history_instructions: str = ""
    character_version: str = "jai-proxy"
    extensions: dict[str, Any] = Field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = self.model_dump(mode="json", exclude_none=True)
        card = {
            "spec": "chara_card_v3",
            "spec_version": "3.0",
            "data": data,
        }
        # V2-compat top-level mirror for tools that don't understand V3.
        card.update(data)
        return card
