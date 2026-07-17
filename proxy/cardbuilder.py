from __future__ import annotations

import base64
import io
import json
import re
import shutil
from pathlib import Path

from PIL import Image

from proxy import pngtools
from proxy.config import settings
from proxy.macros import MacroSanitizer
from proxy.models import CaptureRecord, CharacterBook, CharacterCardV3, ProfileFields

_UNSAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9_\-]+")


def _safe_filename(name: str) -> str:
    slug = _UNSAFE_FILENAME_RE.sub("_", name.strip()).strip("_")
    return slug or "unnamed"


def _id_fragment(card_id: str | None) -> str:
    """A short, filename-safe slice of the card id used to disambiguate cards
    that share a creator and name. For a JanitorAI UUID this is the first
    segment (8 hex chars) -- collision-safe within a single creator's folder.
    Returns "" when there's no usable id, so the filename degrades to just the
    name."""
    token = _UNSAFE_FILENAME_RE.sub("", (card_id or "").strip())
    return token[:8]


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
    `ccv3` (V3) tEXt chunks of the avatar PNG -- replacing the userscript's
    hand-rolled JS CRC32/canvas/base64 machinery entirely.

    The avatar is first normalized to PNG and (when enabled) lossily quantized
    with pngquant to keep card files small, then the card chunks are injected
    into the compressed bytes. See proxy/pngtools.py for the mechanics."""

    def __init__(
        self,
        output_dir: Path | None = None,
        compress: bool | None = None,
        pngquant_bin: Path | None = None,
    ) -> None:
        self._output_dir = output_dir or settings.output_dir
        self._compress = settings.compress if compress is None else compress
        self._pngquant_bin = self._resolve_pngquant(pngquant_bin or settings.pngquant_bin)

    @staticmethod
    def _resolve_pngquant(configured: Path) -> Path | None:
        """The vendored binary if present, else one on PATH, else None (which
        disables compression -- writing falls back to the unquantized PNG)."""
        if configured.exists():
            return configured
        found = shutil.which("pngquant")
        return Path(found) if found else None

    def write(
        self,
        card: CharacterCardV3,
        avatar_png: bytes,
        out_dir: Path | None = None,
        card_id: str | None = None,
    ) -> Path:
        # Cards are foldered by creator and suffixed with a card-id fragment --
        # <creator>/<name>_<id8>.png -- so a bulk export can't collide two cards
        # that share a name (different creators land in different folders; same
        # creator + same name is disambiguated by the id). Re-exporting the same
        # card yields the same path and overwrites, which is intended.
        out_dir = out_dir or self._output_dir
        creator_dir = _safe_filename(card.creator) if card.creator.strip() else "unknown_creator"
        target_dir = out_dir / creator_dir
        target_dir.mkdir(parents=True, exist_ok=True)

        # Normalize whatever the avatar is (webp/jpg/png) to PNG bytes, then
        # optionally quantize. pngquant strips text chunks, so the card is
        # injected last -- directly into the (compressed) byte stream.
        image = Image.open(io.BytesIO(avatar_png)).convert("RGBA")
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        image_bytes = buffer.getvalue()

        if self._compress and self._pngquant_bin is not None:
            quantized = pngtools.quantize(image_bytes, self._pngquant_bin)
            if quantized is not None:
                image_bytes = quantized

        payload = base64.b64encode(json.dumps(card.to_dict()).encode("utf-8")).decode("ascii")
        image_bytes = pngtools.inject_text_chunks(image_bytes, {"chara": payload, "ccv3": payload})

        fragment = _id_fragment(card_id)
        stem = _safe_filename(card.name)
        filename = f"{stem}_{fragment}.png" if fragment else f"{stem}.png"
        path = target_dir / filename
        path.write_bytes(image_bytes)
        return path
