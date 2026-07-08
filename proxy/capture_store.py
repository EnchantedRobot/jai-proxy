import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from proxy.config import settings
from proxy.models import CaptureRecord
from proxy.prompt_parser import SystemPromptParser

logger = logging.getLogger("jai_proxy.capture_store")

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def normalize(name: str) -> str:
    """Lookup key for CaptureStore: lowercase, trimmed."""
    return (name or "").strip().lower()


def _slug(key: str) -> str:
    slug = _SLUG_RE.sub("_", key).strip("_")
    return slug or "unnamed"


class CaptureStore:
    """Archives every raw hidden-definition system prompt as a numbered
    .txt file (unconditional format-drift safety net -- see PLAN.md §4,
    always kept even if parsing fails) AND parses each prompt via
    SystemPromptParser into a CaptureRecord upserted by normalize(name),
    persisted as `{captures_dir}/{slug}.json` and held in memory so
    CardBuilder can merge the hidden definition into a `/build` (get()).
    """

    def __init__(
        self,
        captures_dir: Path | None = None,
        parser: SystemPromptParser | None = None,
    ) -> None:
        self._raw_prompts: list[str] = []
        self._captures_dir = captures_dir or settings.captures_dir
        self._captures_dir.mkdir(parents=True, exist_ok=True)
        self._parser = parser or SystemPromptParser()
        self._records: dict[str, CaptureRecord] = {}
        self._load_existing_records()

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
        path = self._write_raw(n, system_prompt)
        logger.info("wrote capture to %s", path)

        parsed = self._parser.parse(system_prompt)
        key = normalize(parsed.name)
        if not key:
            logger.warning(
                "capture #%d: parser found no character name; raw prompt archived "
                "but no CaptureRecord upserted",
                n,
            )
            return

        existing = self._records.get(key)
        record = CaptureRecord(
            name=parsed.name,
            personality=parsed.personality,
            scenario=parsed.scenario,
            mes_example=parsed.mes_example,
            raw_system_prompt=system_prompt,
            lore_entries=existing.lore_entries if existing else [],
        )
        self._records[key] = record
        self._persist(key, record)

    def get(self, name: str) -> CaptureRecord | None:
        return self._records.get(normalize(name))

    def _write_raw(self, n: int, system_prompt: str) -> Path:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self._captures_dir / f"system_prompt_{n:03d}_{timestamp}.txt"
        path.write_text(system_prompt, encoding="utf-8")
        return path

    def _persist(self, key: str, record: CaptureRecord) -> None:
        path = self._captures_dir / f"{_slug(key)}.json"
        path.write_text(record.model_dump_json(indent=2), encoding="utf-8")

    def _load_existing_records(self) -> None:
        for path in sorted(self._captures_dir.glob("*.json")):
            try:
                record = CaptureRecord.model_validate_json(path.read_text(encoding="utf-8"))
            except Exception:
                logger.exception("failed to load capture record from %s", path)
                continue
            self._records[normalize(record.name)] = record

    @property
    def count(self) -> int:
        return len(self._raw_prompts)
