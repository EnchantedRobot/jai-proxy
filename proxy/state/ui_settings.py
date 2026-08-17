"""The archive's own settings blob, persisted at `data/settings.json`.

WHY THIS EXISTS
The vendored frontend was written as a SillyTavern extension, so it persisted
its settings -- provider credentials, followed creators, display preferences --
into SillyTavern's `settings.json` via the host page, with `localStorage` as a
backup. Standalone there is no host page, so only the backup ran, and the
archive's settings quietly lived in browser storage keyed to the *origin*
`http://127.0.0.1:8000`.

That was worse than it looked. SillyTavern's own stock port is 8000, so the
bucket the archive read was one SillyTavern itself had filled while running
there years earlier -- the archive appeared to "remember" a Chub token and 19
followed creators that no code in this repo had ever stored. It also meant the
settings would evaporate the moment the port, host or browser changed, which is
exactly what containerizing does.

So: one JSON file on disk, beside the cards, inside the volume that already gets
mounted and backed up.

WHAT THIS MODULE KNOWS
Nothing about the frontend's schema. The blob is an opaque JSON object; the
mapping onto SillyTavern's `extension_settings` shape belongs to the client-side
adapter (`web/archive-api.js`), the same seam every other ST-ism lives behind.
Keeping the server ignorant is what stops `settings.json` from re-growing a
SillyTavern shape the archive would then have to honour forever.

THE ONE EXCEPTION
`proxy.runtime.net` reads exactly one key out of this blob -- `httpProxyUrl`,
the outbound proxy every server-initiated fetch routes through. It is read
defensively (a missing key, a wrong type, a damaged file all degrade to "no
proxy") and never written back from the server side. The alternative was a
second configuration surface with its own file, endpoint and settings panel for
a single string, which costs more than the coupling does.

That is the whole exception. Nothing else in the server may read this file: one
key is a documented seam, two is the beginning of a schema.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger("jai_proxy.state.ui_settings")

# A ceiling on what will be accepted or read back. The real blob is ~4 KB (117
# keys); the one field with unbounded growth is `customCSS`. This is not a
# security boundary -- the server is local -- it is a guard against a runaway
# client turning the settings file into something that no longer loads.
MAX_BYTES = 2 * 1024 * 1024


class SettingsError(Exception):
    """The stored settings could not be read, or the given blob is unusable."""


class SettingsStore:
    """Read/write access to one JSON object on disk.

    Reads are not cached. The file is a few KB and is read on page load rather
    than per request, so a cache would buy nothing and would have to be
    invalidated against out-of-band edits -- and hand-editing this file is an
    entirely reasonable thing to do.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def read(self) -> dict[str, Any]:
        """The stored blob, or `{}` when nothing has been stored yet.

        A *missing* file is normal -- a fresh archive has no settings, and the
        frontend fills in its own defaults. A file that exists but does not
        parse is not normal, and raises rather than being silently replaced with
        defaults: the difference between "no settings" and "your settings are
        damaged" is the difference between a first run and losing a Chub token,
        and a caller that quietly returned {} would hand the frontend defaults
        which it would then save straight over the top of the damaged file.
        """
        if not self.path.is_file():
            return {}
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise SettingsError(f"could not read {self.path}: {exc}") from exc
        if len(raw) > MAX_BYTES:
            raise SettingsError(
                f"{self.path} is {len(raw)} bytes, over the {MAX_BYTES}-byte ceiling"
            )
        try:
            blob = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SettingsError(f"{self.path} is not valid JSON: {exc}") from exc
        if not isinstance(blob, dict):
            raise SettingsError(
                f"{self.path} holds a {type(blob).__name__}, expected a JSON object"
            )
        return blob

    def write(self, blob: dict[str, Any]) -> dict[str, Any]:
        """Replace the stored blob, atomically. Returns what was stored.

        Atomic because this file holds credentials that exist nowhere else once
        the browser-storage copy is gone: a torn write during a crash would lose
        the Chub and DataCat tokens with no second copy to recover from. The
        temp file is created in the destination directory so `os.replace` is a
        same-filesystem rename, which is the part that is actually atomic.
        """
        if not isinstance(blob, dict):
            raise SettingsError(f"expected a JSON object, got {type(blob).__name__}")
        try:
            text = json.dumps(blob, indent=2, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise SettingsError(f"settings are not JSON-serialisable: {exc}") from exc
        encoded = text.encode("utf-8")
        if len(encoded) > MAX_BYTES:
            raise SettingsError(
                f"settings are {len(encoded)} bytes, over the {MAX_BYTES}-byte ceiling"
            )

        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=self.path.parent, prefix=".settings-", suffix=".tmp"
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(tmp_fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                # fsync before the rename: the rename being atomic only means we
                # never see a half-written *name*, not that the bytes reached the
                # disk before the metadata did.
                os.fsync(handle.fileno())
            os.replace(tmp_path, self.path)
        except OSError as exc:
            tmp_path.unlink(missing_ok=True)
            raise SettingsError(f"could not write {self.path}: {exc}") from exc
        logger.debug("settings written to %s (%d bytes)", self.path, len(encoded))
        return blob
