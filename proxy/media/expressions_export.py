"""Zipping a character's `data/expressions/` folder for export.

Two shapes (docs/FORKS_AND_EXTRAS_PLAN.md §2), and they are genuinely
different archives, not the same one with a different root:

* `zip_one` -- one character, flattened to basenames at the zip root. ST's
  importer (`getImageBuffers` behind the *Import Expressions Pack* button)
  keeps only `path.parse(entry.fileName).base`, so a flat zip is the shape
  that button expects; nesting would still load, since it flattens anyway.
* `zip_many` -- several characters, each under its own on-disk folder name
  (`<Name>_<gallery_id>`, exactly the string `resolve_folder` matches on). Not
  loadable through `upload-zip`, which targets one folder and would collapse
  every character into it -- this is for dropping straight back into
  `data/expressions/`.

Plain `zipfile` into an in-memory buffer; both shapes are asked for by hand,
not on a hot path, and a character's expressions run tens of megabytes, not
the hundreds that would make buffering the wrong call.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path


def _files(directory: Path) -> list[Path]:
    return sorted(
        p for p in directory.iterdir() if p.is_file() and not p.name.startswith(".")
    )


def zip_one(directory: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in _files(directory):
            zf.write(entry, arcname=entry.name)
    return buffer.getvalue()


def zip_many(folders: list[tuple[str, Path]]) -> bytes:
    """`folders` is `(folder name on disk, directory)` pairs -- the caller has
    already resolved each character's expressions folder."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder_name, directory in folders:
            for entry in _files(directory):
                zf.write(entry, arcname=f"{folder_name}/{entry.name}")
    return buffer.getvalue()
