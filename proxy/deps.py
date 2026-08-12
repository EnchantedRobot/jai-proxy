"""The process-wide singletons the route modules share.

These were built at `proxy.server` module scope, where the route functions closed
over them directly. Splitting the routes across `proxy.api.*` left them with no
common owner, so they live here -- constructed once at import, exactly as before.

Import the *module*, not the names:

    from proxy import deps
    deps.png_writer.write(...)

A `from proxy.deps import png_writer` freezes the binding at import time, which
is how a test that repoints one of these ends up not repointing it at all. Same
rule as `proxy.api.v1._shared`'s stores -- see the hazard note in
docs/PHASE_4_REFACTOR_PLAN.md.
"""

from __future__ import annotations

from proxy.cards.avatar_fetch import AvatarFetcher
from proxy.cards.builder import CardBuilder, PngWriter
from proxy.cards.lorebook import LorebookMapper
from proxy.config import settings
from proxy.runtime.mock_responder import MockResponder
from proxy.state.captures import CaptureStore
from proxy.state.lorebook_cache import LorebookCache
from proxy.text.macros import MacroSanitizer

capture_store = CaptureStore()
responder = MockResponder()
card_builder = CardBuilder()
png_writer = PngWriter()
avatar_fetcher = AvatarFetcher()
lorebook_mapper = LorebookMapper()
lorebook_cache = LorebookCache()
# Chub bypasses CardBuilder (raw-dict passthrough, see proxy.sources.chub), so it
# needs its own sanitizer instance -- same construction as CardBuilder's.
chub_sanitizer = MacroSanitizer(user_names=settings.user_names)
