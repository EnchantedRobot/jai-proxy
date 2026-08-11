"""Recovers a datacat-imported card's original avatar URL by calling datacat's
own (anonymous, no-login) API -- the same one SillyTavern-CharacterLibrary's
"Restore Original Avatars" tool uses. The datacat export this project imports
(see proxy/datacat_mapper.py) never carries the source image, only the
JanitorAI character id -- datacat's character-detail payload does, at full
resolution, inside its embedded v2 card.

Session: POST /api/liberator/identify with a throwaway device token returns an
anonymous session token, no credentials involved. Confirmed live 2026-07-30:
this and the character-detail GET both work from a plain server-side request,
no browser/cookies/CF challenge needed -- datacat's own auth gate is just this
handshake.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from proxy.config import ROOT, settings

logger = logging.getLogger(__name__)

DATACAT_API_BASE = "https://datacat.run"

_ENV_TOKEN_KEY = "JAI_PROXY_DATACAT_SESSION_TOKEN"
_ENV_TOKEN_LINE_RE = re.compile(rf"^{_ENV_TOKEN_KEY}=.*$", re.MULTILINE)
# A stored token that gets rejected outright (vs. e.g. the character simply
# not existing) is treated as stale, not a hard failure -- one retry with a
# freshly identified session before giving up on that lookup.
_AUTH_FAILURE_STATUS = {401, 403}

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": DATACAT_API_BASE,
    "Referer": f"{DATACAT_API_BASE}/",
}

_MAX_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 1.0
# Retried as transient; anything else (4xx, a parsed response) returns as-is.
_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}


def _request(client: httpx.Client, method: str, url: str, **kwargs: Any) -> httpx.Response | None:
    """The one place every outbound datacat call goes through: retries a
    transient failure (network error or 429/5xx) up to `_MAX_ATTEMPTS` times
    with linear backoff, then gives up and returns None -- callers treat that
    as "couldn't resolve this one" and move on, matching the rest of the
    import pipeline's one-bad-card-must-not-abort-the-batch contract. Never
    raises."""
    last_error: Exception | str | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            resp = client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            last_error = exc
        else:
            if resp.status_code not in _RETRY_STATUS_CODES:
                return resp
            last_error = f"HTTP {resp.status_code}"
        if attempt < _MAX_ATTEMPTS:
            time.sleep(_RETRY_BACKOFF_SECONDS * attempt)
    logger.warning("datacat request failed after %d attempts: %s %s (%s)", _MAX_ATTEMPTS, method, url, last_error)
    return None


def _persist_session_token(token: str, env_path: Path) -> None:
    """Write a freshly-fetched anonymous session token into `.env` so the next
    run reuses it instead of hitting /api/liberator/identify again. Replaces
    an existing JAI_PROXY_DATACAT_SESSION_TOKEN line if there is one,
    otherwise appends it; every other line is left untouched."""
    line = f"{_ENV_TOKEN_KEY}={token}"
    existing = env_path.read_text() if env_path.exists() else ""
    if _ENV_TOKEN_LINE_RE.search(existing):
        updated = _ENV_TOKEN_LINE_RE.sub(line, existing)
    else:
        sep = "" if not existing or existing.endswith("\n") else "\n"
        updated = f"{existing}{sep}{line}\n"
    env_path.write_text(updated)


def _original_avatar_url(character: dict[str, Any]) -> str | None:
    """The untouched source-CDN avatar URL (JanitorAI's ella.janitorai.com,
    or Saucepan's cdn.saucepan.ai for a saucepan-sourced character) out of a
    datacat character-detail payload. datacat's own `avatar`/
    `avatar_variant_urls` fields are its re-hosted, downscaled copies (a
    768px "hero" at best) -- never used here since the whole point is the
    untouched original the local import can no longer produce."""
    candidates: list[Any] = [
        ((character.get("chara_card_v2_json") or {}).get("data") or {}).get("avatar"),
    ]
    for variant in character.get("content_variants") or []:
        content = (variant or {}).get("content") or {}
        candidates.append(((content.get("chara_card_v2_json") or {}).get("data") or {}).get("avatar"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.startswith("http"):
            return candidate
    return None


class DatacatImageResolver:
    """Resolves a datacat character id to its original source-CDN avatar URL.

    A session token is expensive only in the sense that it's one extra round
    trip -- but hitting /api/liberator/identify on every run when the same
    anonymous token keeps working is needless load, so a token is loaded from
    `settings.datacat_session_token` (JAI_PROXY_DATACAT_SESSION_TOKEN in
    .env) up front if one's there, and a freshly-fetched one is written back
    to .env (`persist=True`, the default) so the next run picks it up too. If
    a stored token turns out to have been rejected, resolve() drops it and
    identifies a fresh one automatically -- no manual .env cleanup needed."""

    def __init__(
        self,
        client: httpx.Client | None = None,
        *,
        persist: bool = True,
        env_path: Path | None = None,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.Client(
            timeout=15.0, headers=_HEADERS, proxy=settings.http_proxy or None
        )
        self._session_token: str | None = settings.datacat_session_token or None
        self._persist = persist
        self._env_path = env_path or (ROOT / ".env")

    def _ensure_session(self) -> str | None:
        if self._session_token:
            return self._session_token
        resp = _request(
            self._client,
            "POST",
            f"{DATACAT_API_BASE}/api/liberator/identify",
            json={"deviceToken": str(uuid.uuid4())},
        )
        if resp is None or resp.status_code >= 400:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        if not data.get("success"):
            return None
        token = data.get("sessionToken")
        if not isinstance(token, str) or not token:
            return None
        self._session_token = token
        if self._persist:
            _persist_session_token(token, self._env_path)
            print(f"[datacat] fetched a new anonymous session token, saved to {self._env_path}")
        return self._session_token

    def _fetch_character(self, character_id: str, token: str) -> httpx.Response | None:
        return _request(
            self._client,
            "GET",
            f"{DATACAT_API_BASE}/api/characters/{character_id}",
            headers={"X-Session-Token": token},
        )

    def resolve(self, character_id: str) -> str | None:
        """The original avatar URL for a datacat character id, or None if it
        can't be recovered (no session, the character is gone from datacat's
        index, or its payload carries no original-CDN avatar)."""
        if not character_id:
            return None
        token = self._ensure_session()
        if not token:
            return None
        resp = self._fetch_character(character_id, token)
        if resp is not None and resp.status_code in _AUTH_FAILURE_STATUS:
            self._session_token = None
            token = self._ensure_session()
            if not token:
                return None
            resp = self._fetch_character(character_id, token)
        if resp is None or resp.status_code >= 400:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        if not data.get("success"):
            return None
        return _original_avatar_url(data.get("character") or {})

    def close(self) -> None:
        if self._owns_client:
            self._client.close()
