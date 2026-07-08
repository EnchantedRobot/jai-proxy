# jai-proxy

Archives JanitorAI character cards as SillyTavern-compatible Character Card V3
PNGs, for personal use. See `docs/PLAN.md` for the design and `docs/IMPLEMENTATION.md`
for the execution spec.

## Setup (macOS)

```bash
uv sync
uv run python -m proxy.server        # serves http://127.0.0.1:8000
```

MLX must already be running separately with an OpenAI-compatible endpoint at
`http://127.0.0.1:8011/v1` with `Llama-3.2-3B-Instruct-4bit` loaded.

Install `userscript/janitorai-export.user.js` in Tampermonkey. In JanitorAI's
proxy/config settings, set the endpoint to
`http://127.0.0.1:8000/v1/chat/completions` (any model name — the server
overrides it). A pill in the bottom-right corner shows 🟢/🔴 for server
reachability.

## Tests

```bash
uv run pytest
```

## Status

- **M0 — Scaffold:** done.
- **M1 — Gate:** done. Verified on the live site: pill 🟢, JanitorAI's
  request to a hidden card reaches the server directly (no `FetchHook`
  interception was even required — JanitorAI calls the configured proxy URL
  straight from the browser), MLX's reply renders in JanitorAI with no
  crash, and the server logged the full hidden system prompt. Captured
  prompt saved as `tests/fixtures/system_prompt_hidden_lyra.txt` for the M2
  parser.
