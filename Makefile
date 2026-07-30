.PHONY: compile test test-js run import gallery-ids check

# Every target reads .env (see .env.template) via proxy/config.py -- most
# importantly JAI_PROXY_OUTPUT_DIR, the cards folder they all read and write.

# Concatenate userscript/src_jai/*.js   -> userscript/jai-proxy-bridge.user.js
# and userscript/src_saucepan/*.js       -> userscript/saucepan-proxy-bridge.user.js
compile:
	uv run python scripts/compile_userscript_jai.py
	uv run python scripts/compile_userscript_saucepan.py

# Run the Python test suite
test:
	uv run python -m pytest -q

# Run the userscript unit tests (node:test, no deps -- see userscript/tests/)
test-js:
	cd userscript && node --test

run:
	uv run python -m proxy.server

# Bulk-import card PNGs from ./import into the cards folder -- datacat, JannyAI
# and Chub.ai exports are auto-detected (see scripts/import_cards.py). Cards
# already on disk are skipped, never overwritten. Extra flags pass through via
# ARGS, e.g. `make import ARGS=--no-compress`.
import:
	uv run python scripts/import_cards.py $(ARGS)

# Backfill `extensions.gallery_id` (SillyTavern-CharacterLibrary's per-character
# gallery handle) into any card missing one. Read-only report by default;
# `make gallery-ids ARGS=--apply` writes them in place.
gallery-ids:
	uv run python scripts/backfill_gallery_ids.py $(ARGS)

datacat-ids:
	uv run python scripts/backfill_datacat_ids.py $(ARGS)

# Re-audit built cards against the current macro/formatting rules. Read-only;
# `make check ARGS=--repair` rewrites the cards that would change.
check:
	uv run python scripts/check_cards.py $(ARGS)
