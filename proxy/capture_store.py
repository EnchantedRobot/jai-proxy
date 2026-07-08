import logging
from datetime import datetime, timezone
from pathlib import Path

from proxy.config import settings

logger = logging.getLogger("jai_proxy.capture_store")


class CaptureStore:
    """M1: log-only + raw persistence. Records the raw system prompt to the
    server log and to a numbered .txt file under `captures_dir`, so real
    captures from live JanitorAI chats can become parser fixtures. No parsing
    yet (that's M2's SystemPromptParser).
    """

    def __init__(self, captures_dir: Path | None = None) -> None:
        self._raw_prompts: list[str] = []
        self._captures_dir = captures_dir or settings.captures_dir
        self._captures_dir.mkdir(parents=True, exist_ok=True)

    def record(self, system_prompt: str) -> None:
        if not system_prompt:
            return
        self._raw_prompts.append(system_prompt)
        n = len(self._raw_prompts)
        logger.info(
            "captured system prompt (#%d, %d chars):\n%s",
            n,
            len(system_prompt),
            system_prompt,
        )
        path = self._write(n, system_prompt)
        logger.info("wrote capture to %s", path)

    def _write(self, n: int, system_prompt: str) -> Path:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self._captures_dir / f"system_prompt_{n:03d}_{timestamp}.txt"
        path.write_text(system_prompt, encoding="utf-8")
        return path

    @property
    def count(self) -> int:
        return len(self._raw_prompts)
