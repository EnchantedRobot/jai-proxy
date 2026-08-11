.PHONY: compile test test-js run docker-build docker-up import gallery-ids check names thumbs settings-import

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

# Run the JavaScript unit tests (node:test, no deps). Two trees, run separately
# because each resolves its fixtures relative to its own directory: the
# userscripts (userscript/tests/) and the browser's archive adapter
# (web/tests/).
test-js:
	cd userscript && node --test
	cd web && node --test

run:
	uv run python -m proxy.server

# The same server in a container: one image, one mount (./data), one port.
# The targets below still run on the host, against that same ./data.
docker-build:
	docker compose build

docker-up:
	docker compose up -d

# Bulk-import card PNGs from ./import into the cards folder -- datacat, JannyAI
# and Chub.ai exports are auto-detected (see scripts/import_cards.py). Cards
# already on disk are skipped, never overwritten. The same run also sweeps the
# cards folder for orphans (cards dropped in by hand, with no extensions.jai
# stamp), imports them in place and retires the originals to state/orphans.
# Extra flags pass through via ARGS, e.g. `make import ARGS=--no-compress`.
import:
	uv run python scripts/import_cards.py $(ARGS) --fetch-datacat-images

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

# Find card names that aren't names -- a tagline welded on (`Mia, your desperate
# roommate`) or a generic placeholder hiding the real character (`Narrator`).
# SillyTavern feeds data.name to the model as "You are <name>", so both wreck
# the roleplay. Read-only report by default; `make names ARGS=--interactive`
# walks the findings and applies the renames you confirm. Nothing is ever
# renamed automatically -- the suggestions are ~87% right, not 100%.
# Interactive decisions are appended to logs/name_repair.jsonl (diagnosis +
# what you actually chose), which is the ground truth for improving the rules:
# `make names ARGS=--stats` scores them against it.
names:
	uv run python scripts/fix_names.py $(ARGS)

# Tidy the browse grid's thumbnail cache (data/cache/thumbs/avatar): render the
# cards that have no thumb, retire the thumbs whose card is gone, and fix the
# ones whose name differs from their card's only by case -- macOS resolves those
# anyway, so they look fine here and would silently miss in a Linux container.
# The API also generates on miss, so this only ever moves work off first paint.
# Read-only report by default; `make thumbs ARGS=--apply` writes.
thumbs:
	uv run python scripts/sync_thumbs.py $(ARGS)

# Seed data/settings.json from an existing SillyTavern install: lifts the
# Character Library blob (provider tokens, followed creators, display prefs)
# out of its settings.json so the standalone browser stops depending on
# origin-keyed browser storage -- which silently held a copy left behind by
# SillyTavern itself, since its stock port is also 8000.
# Read-only report by default; `make settings-import ARGS=--apply` writes.
settings-import:
	uv run python scripts/import_st_settings.py $(ARGS)
