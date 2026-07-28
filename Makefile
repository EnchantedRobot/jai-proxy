.PHONY: compile test run import gallery-ids export

# Where `make export` drops the cards. Override on the command line if needed,
# e.g. `make export DEST=/tmp/characters`.
DEST ?= $(HOME)/workspaces/SillyTavern/data/default-user/characters

# Concatenate userscript/src_jai/*.js   -> userscript/jai-proxy-bridge.user.js
# and userscript/src_saucepan/*.js       -> userscript/saucepan-proxy-bridge.user.js
compile:
	uv run python scripts/compile_userscript_jai.py
	uv run python scripts/compile_userscript_saucepan.py

# Run the Python test suite
test:
	uv run python -m pytest -q

run:
	uv run python -m proxy.server

# Bulk-import card PNGs from ./import into ./cards -- datacat and Chub.ai
# exports are auto-detected (see scripts/import_cards.py). Cards already on disk
# are skipped, never overwritten. Extra flags pass through via ARGS, e.g.
# `make import ARGS=--no-compress`.
import:
	uv run python scripts/import_cards.py $(ARGS)

# Backfill `extensions.gallery_id` (SillyTavern-CharacterLibrary's per-character
# gallery handle) into any card in ./cards missing one. Read-only report by
# default; `make gallery-ids ARGS=--apply` writes them in place.
gallery-ids:
	uv run python scripts/backfill_gallery_ids.py $(ARGS)

# Flat-copy every card PNG in ./cards (which is nested per creator) into $(DEST),
# SillyTavern's characters folder. Filenames are unique across creators, so the
# flattening is lossless. Existing files are overwritten.
export:
	@mkdir -p "$(DEST)"
	@find cards -type f -name '*.png' | while read -r f; do \
		cp "$$f" "$(DEST)/"; \
	done; \
	n=$$(find cards -type f -name '*.png' | wc -l | tr -d ' '); \
	echo "Copied $$n cards to $(DEST)"
