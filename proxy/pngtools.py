"""Low-level PNG helpers: lossy quantization via the bundled `pngquant` binary
and raw tEXt-chunk (re)injection.

The two are a pair. `pngquant` shrinks a card's avatar dramatically (a 1.8 MB
JanitorAI PNG drops to ~700 KB) but *strips every ancillary chunk*, including
the `chara`/`ccv3` tEXt chunks that carry the character card. So the pipeline is:
normalize the avatar to PNG -> quantize the pixels -> re-inject the card text
chunks into the compressed bytes. Injection rewrites the raw chunk stream rather
than re-encoding through Pillow, so it preserves pngquant's optimized IDAT
exactly (re-saving via Pillow would inflate it back). Mirrors the approach in
../SillyTavern-Character-Tools-Server/src/transforms.ts.
"""

from __future__ import annotations

import struct
import subprocess
import zlib
from pathlib import Path

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Every flavour of textual chunk. We strip all of them before re-injecting so a
# quantized-then-injected file never carries stale duplicates.
_TEXT_CHUNK_TYPES = frozenset({b"tEXt", b"zTXt", b"iTXt"})


def _iter_chunks(data: bytes):
    """Yield (type, data) for each PNG chunk after the 8-byte signature. CRCs are
    dropped (recomputed on write); malformed trailing bytes are ignored."""
    pos = 8
    while pos + 12 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        cdata = data[pos + 8 : pos + 8 + length]
        yield ctype, cdata
        pos += 12 + length


def _encode_chunk(ctype: bytes, cdata: bytes) -> bytes:
    body = ctype + cdata
    return struct.pack(">I", len(cdata)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _text_chunk(keyword: str, text: str) -> bytes:
    # tEXt is Latin-1; keyword + NUL + text. Card payloads are base64 (ASCII), a
    # strict subset, so this never lossily encodes.
    payload = keyword.encode("latin-1") + b"\x00" + text.encode("latin-1")
    return _encode_chunk(b"tEXt", payload)


def inject_text_chunks(png: bytes, texts: dict[str, str]) -> bytes:
    """Return `png` with `texts` written as tEXt chunks immediately after IHDR,
    stripping any pre-existing text chunks first. Placement before IDAT means
    Pillow (and SillyTavern/JanitorAI importers) surface them on open without a
    full decode."""
    if png[:8] != _PNG_SIGNATURE:
        raise ValueError("not a PNG stream")

    out = [_PNG_SIGNATURE]
    injected = False
    for ctype, cdata in _iter_chunks(png):
        if ctype in _TEXT_CHUNK_TYPES:
            continue  # drop stale text; the caller's chunks are authoritative
        out.append(_encode_chunk(ctype, cdata))
        if ctype == b"IHDR" and not injected:
            out.extend(_text_chunk(k, v) for k, v in texts.items())
            injected = True
    return b"".join(out)


def quantize(png: bytes, pngquant_bin: Path, *, timeout: float = 60.0) -> bytes | None:
    """Lossily quantize `png` with pngquant, reading stdin and writing stdout.
    Returns the smaller PNG, or None when quantization was skipped or unavailable
    so the caller keeps the original:

      * exit 98  -- `--skip-if-larger`: the palette version wasn't smaller
      * exit 99  -- quality floor not met (only if a --quality is passed)
      * binary missing / not executable / timeout / any other non-zero exit
    """
    try:
        proc = subprocess.run(
            [str(pngquant_bin), "--skip-if-larger", "--strip", "-"],
            input=png,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None

    if proc.returncode == 0 and proc.stdout[:8] == _PNG_SIGNATURE:
        return proc.stdout
    return None
