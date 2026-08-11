"""`extensions.gallery_id` -- the per-character handle SillyTavern's
CharacterLibrary keys an image gallery on.

CharacterLibrary gives each character its own gallery folder named from the
character name *plus* a `gallery_id`, so two characters sharing a name don't
share (and overwrite) one gallery. It mints that id itself when a character
lacks one -- a random 12-character alphanumeric string stored in
`data.extensions.gallery_id`:

    const chars = 'ABC...XYZabc...xyz0123456789';   // 62
    for (let i = 0; i < 12; i++) result += chars.charAt(...)

We stamp the same thing at write time so our cards work there out of the box.
Deliberately the *same naive scheme*, not a stronger one (a content hash would
be the obvious upgrade): an id CharacterLibrary didn't mint has to be
indistinguishable from one it did, and since the id is only ever used alongside
the character name, a bare 62^12 collision isn't the real risk anyway.

An id already on a card is never regenerated -- it is the link to an existing
gallery folder. So an import keeps whatever id its source carried, and
re-exporting a character keeps the id the card already on disk carries.
"""

from __future__ import annotations

import secrets
import string
from typing import Any

# CharacterLibrary's alphabet and length, verbatim.
_ALPHABET = string.ascii_uppercase + string.ascii_lowercase + string.digits
_LENGTH = 12


def generate_id() -> str:
    """A fresh 12-character alphanumeric gallery id, e.g. 'aB3xY9kLmN2p'."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def read_id(data: dict[str, Any]) -> Any | None:
    """The `extensions.gallery_id` a card's `data` object carries, or None when
    it has none -- absent, empty, or an `extensions` that isn't an object. Reads
    the same from any source's card, since gallery_id is a plain sibling of the
    per-source blocks (jai/chub/datacat)."""
    extensions = data.get("extensions")
    if not isinstance(extensions, dict):
        return None
    gid = extensions.get("gallery_id")
    return gid if gid not in (None, "") else None


def ensure_id(data: dict[str, Any], preferred: Any | None = None) -> Any | None:
    """Give a card's `data` object a gallery_id if it lacks one, creating the
    `extensions` block if needed. `preferred` -- an id recovered from elsewhere,
    e.g. off the card already on disk at the write target -- is adopted instead
    of a fresh one when given, so an existing gallery link survives.

    Returns the id assigned, or None if the card already carried one (nothing
    changed), which is also the "did this mutate `data`?" signal callers use."""
    if read_id(data) is not None:
        return None
    extensions = data.get("extensions")
    if not isinstance(extensions, dict):
        extensions = {}
        data["extensions"] = extensions
    gid = generate_id() if preferred in (None, "") else preferred
    extensions["gallery_id"] = gid
    return gid
