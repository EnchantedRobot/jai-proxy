"""`/api/v1` -- browse, download and edit over the card archive.

Every endpoint here is a plain `def`, not `async def`, on purpose: they all touch
the filesystem, and FastAPI runs sync handlers in a threadpool where blocking is
harmless. Declaring them `async` would block the event loop for the duration of a
stat sweep or a 1.2 MB read, which is precisely the workload this API is made of.

This is the archive's own contract, deliberately not SillyTavern's. Teaching it
to answer `/characters/edit-attribute` would relocate the compatibility burden
rather than end it; the translation lives in `web/archive-api.js`, on the client,
in one deletable file.

The routes are grouped by resource across `characters`, `galleries`, `media` and
`system`; anything two of them need lives in `_shared`. They are assembled onto
one router here, in the order they were registered when this was a single module.
"""

from fastapi import APIRouter

from proxy.api.v1 import _shared  # noqa: F401  -- re-exported for tests and the server's startup hook
from proxy.api.v1 import characters, galleries, media, system

router = APIRouter(prefix=_shared.PREFIX, tags=["archive"])
router.include_router(characters.router)
router.include_router(system.router)
router.include_router(galleries.router)
router.include_router(media.router)
