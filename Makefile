.PHONY: compile test run import

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
