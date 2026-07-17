.PHONY: compile test run

# Concatenate userscript/src/*.js -> userscript/jai-proxy-bridge.user.js
compile:
	uv run python scripts/compile_userscript_jai.py
	uv run python scripts/compile_userscript_saucepan.py

# Run the Python test suite
test:
	uv run python -m pytest -q

run:
	uv run python -m proxy.server
