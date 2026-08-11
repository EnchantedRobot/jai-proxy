# web/tests

- **`archive-api.test.js`** — unit tests for the fetch adapter. Run with
  `cd web && node --test`, or `make test-js`. These do **not** cover vendored code.
- **`smoke.py`** — Playwright boot-and-browse check against a running server.
  Loads the app, opens a card, its gallery, **every settings section** and
  **every Help section**, and fails on any console error/warning or failed request.

      JAI_PROXY_PORT=8002 uv run python -m proxy.server &
      ~/.pyenv/versions/3.13.11/bin/python web/tests/smoke.py http://127.0.0.1:8002

  Playwright lives under pyenv 3.13.11, not the uv venv.

  It clicks through every panel on purpose: panels only execute when opened, so a
  handler broken by an edit stays silent until someone opens that section. It
  captures `console.warn` as well as errors for the same reason — `multi-select.js`
  degrades to a warning and simply never injects its toolbar button.
