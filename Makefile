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

# Bulk-import datacat card PNGs from ./import into ./cards (see
# scripts/import_datacat.py). Cards already on disk are skipped, never
# overwritten. Extra flags pass through via ARGS, e.g. `make import ARGS=--no-compress`.
import:
	uv run python scripts/import_datacat.py $(ARGS)
