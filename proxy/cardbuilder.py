from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path

from PIL import Image, PngImagePlugin

from proxy.config import settings
from proxy.macros import MacroSanitizer
from proxy.models import CaptureRecord, CharacterBook, CharacterCardV3, ProfileFields

_UNSAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_\-]+")


def _safe_filename(name: str) -> str:
    slug = _UNSAFE_FILENAME_RE.sub("_", name.strip()).strip("_")
    return slug or "unnamed"


def _pick(visible: str, hidden: str) -> str:
    """Visible DOM value wins when non-empty; the captured hidden-definition
    value fills the gap. That's the whole point for hidden cards."""
    return visible if visible.strip() else hidden


class CardBuilder:
    """Assembles a CharacterCardV3 from a parsed profile (DOM), converted
    greetings, an optional hidden-definition capture, and an optional
    lorebook. Runs every text field through MacroSanitizer and collects the
    resulting warnings."""

    def __init__(self, sanitizer: MacroSanitizer | None = None) -> None:
        self._sanitizer = sanitizer or MacroSanitizer(user_names=settings.user_names)

    def build(
        self,
        profile: ProfileFields,
        greetings: list[str],
        capture: CaptureRecord | None,
        book: CharacterBook | None,
    ) -> tuple[CharacterCardV3, list[str]]:
        warnings: list[str] = []

        def sanitize(text: str) -> str:
            cleaned, unknown = self._sanitizer.sanitize(text)
            for macro_name in unknown:
                w = f"unresolved macro: {{{{{macro_name}}}}}"
                if w not in warnings:
                    warnings.append(w)
            return cleaned

        def desub(text: str) -> str:
            return self._sanitizer.reverse_names(text)

        description = sanitize(_pick(profile.description, desub(capture.personality) if capture else ""))
        scenario = sanitize(_pick(profile.scenario, desub(capture.scenario) if capture else ""))
        mes_example = sanitize(_pick(profile.mes_example, desub(capture.mes_example) if capture else ""))
        creator_notes = sanitize(profile.creator_notes)

        first_mes = sanitize(desub(greetings[0])) if greetings else ""
        alternate_greetings = [sanitize(desub(g)) for g in greetings[1:]]

        name = profile.name or (capture.name if capture else "") or "Unknown"

        if not description and not scenario and not mes_example:
            warnings.append("no description/scenario/example dialogs found")
        if not first_mes:
            warnings.append("no first_mes / greetings found")

        card = CharacterCardV3(
            name=name,
            description=description,
            personality="",
            scenario=scenario,
            mes_example=mes_example,
            first_mes=first_mes,
            alternate_greetings=alternate_greetings,
            creator=profile.creator,
            creator_notes=creator_notes,
            tags=profile.tags,
            character_book=book,
        )
        return card, warnings


class PngWriter:
    """Embeds a CharacterCardV3 as base64(JSON) into the `chara` (V2) and
    `ccv3` (V3) tEXt chunks of the avatar PNG, using Pillow's
    PngImagePlugin.PngInfo -- replaces the userscript's hand-rolled JS
    CRC32/canvas/base64 machinery entirely."""

    def __init__(self, output_dir: Path | None = None) -> None:
        self._output_dir = output_dir or settings.output_dir

    def write(self, card: CharacterCardV3, avatar_png: bytes, out_dir: Path | None = None) -> Path:
        out_dir = out_dir or self._output_dir
        out_dir.mkdir(parents=True, exist_ok=True)

        image = Image.open(io.BytesIO(avatar_png)).convert("RGBA")

        payload = base64.b64encode(json.dumps(card.to_dict()).encode("utf-8")).decode("ascii")
        info = PngImagePlugin.PngInfo()
        info.add_text("chara", payload)
        info.add_text("ccv3", payload)

        path = out_dir / f"{_safe_filename(card.name)}.png"
        image.save(path, "PNG", pnginfo=info)
        return path
