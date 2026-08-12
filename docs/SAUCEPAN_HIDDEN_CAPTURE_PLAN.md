# Saucepan Hidden-Definition Capture — Implementation Plan

> Status: **designed + validated, not yet implemented.** Probe session 2026-07-18 confirmed
> viability with byte-exact ground-truth diffs. This doc is self-contained — a fresh session
> (targeting Claude Sonnet) should be able to implement from here without re-probing.

## 1. Context — the problem this solves

Hidden saucepan companions (`companion.companion.open_definition === false`) can't be fully
exported today. Their `/api/v1/companion/definition` returns a decoy `{"error": ...}`, so
`POST /build-saucepan` falls back to public v2 fields only (name / creator / tags / blurb /
greetings / avatar) plus a "definition is not open" warning — `description` / `scenario` /
`mes_example` come back empty. See `proxy/sources/saucepan.py` hidden fallback (`is_open` +
`to_profile_fields` description fallback to `full_description_fragments`).

saucepan recently shipped a **Custom API Provider** (Settings → External Model API Providers →
Add Custom, tagged LABS). It lets you point chat at any OpenAI-compatible `/chat/completions`
endpoint. Bots either allow custom providers or don't — the toggle is binary ("Allow custom
providers"), enabled on your own companions automatically and on others only if the creator
opted in. When chat runs through a custom provider, saucepan's backend sends the **full
character definition in the `system` message, in plaintext** — because a model must be able to
read it, saucepan's usual fragment-obfuscation cannot apply here. Pointing that provider at our
proxy lets us capture the hidden definition the same way the JanitorAI hidden flow already does.

## 2. What the probe validated (2026-07-18)

Full findings in memory `jai_proxy_saucepan_custom_provider.md`. Key facts:

- **Server-origin.** saucepan rejects internal-address provider URLs (SSRF guard) and calls
  from its own backend IPs with **no browser User-Agent**. → the proxy MUST sit behind a
  **public URL** (a named Cloudflare tunnel). localhost is impossible.
- **Wire shape is standard OpenAI**, identical layout to JanitorAI hidden:
  `messages = [system(full definition), assistant(primary greeting), user(the message)]`,
  plus `stream: true`, `temperature`, arbitrary `model`. "Test Connection" sends a throwaway
  `{"messages":[{"role":"user","content":"ping"}], "max_tokens":1, "stream":false}` — it has
  no `system` message so it self-ignores.
- **The parse mapping is byte-exact.** Validated with a Rosetta-stone trick: exported the OPEN
  card "Finley Brite" by Theodrax normally (ground truth in the card PNG), then captured ITS
  chat system prompt via the custom provider and diffed. After `{{user}}` reversal, all fields
  matched to the byte (see §4). The captured chat request is saved as the fixture
  `tests/fixtures/saucepan/saucepan_chat_finley_60bdd321.json`; the ground-truth card is at
  `cards/Theodrax/Finley_60bdd321.png` (open export).

## 3. Architecture (mirrors the JanitorAI hidden flow)

```
saucepan backend ──POST──> [public URL / CF tunnel] ──> proxy  /saucepan/v1/chat/completions
                                                          │  1. parse system msg (SaucepanPromptParser)
                                                          │  2. reverse {{user}} using handle from prompt
                                                          │  3. CaptureStore.record(...) keyed by char name
                                                          └─ forward to MLX so chat still answers
userscript export of hidden card ──POST──> proxy  /build-saucepan
                                                  │  is_open == false AND capture exists?
                                                  │   → description ← capture, scenario ← capture
                                                  │   → greetings/tags/name/avatar from public v2 API
                                                  └─ assemble + write PNG
```

Reference template already in the repo: the JanitorAI path — `server.py` `/v1/chat/completions`
capture block (L94-116) + `/build-jai` hidden merge (L179-246), `proxy/sources/prompts/janitor.py`
`SystemPromptParser`, `proxy/state/captures.py`, `proxy/text/macros.py` `MacroSanitizer.reverse_names`.

## 4. The validated parse mapping

saucepan's chat `system` prompt is: a scaffolding **preamble**, then labeled sections of the
form `[ Label ]` on their own line, then the user persona. Line-anchored split on
`^\[ <Label> \]$`. Everything before the first header is the preamble.

| Prompt part | → card field | Finley diff |
|---|---|---|
| `[ Background ]`  (≡ API "Companion Core") | `description` | **EXACT** 4491 chars |
| `[ Critical Instructions ]` (≡ API "Advanced Prompt") | `scenario` | **EXACT** 120 chars |
| `assistant` message | `first_mes` / greeting | **EXACT** 1873 chars (but see note) |
| preamble (before first header) | **DROP** — saucepan scaffolding | — |
| `[ User Description ]` | **DROP** — the user's own persona | — |

- **No `[ Example Dialogue ]` section exists** in the chat prompt — confirmed absent in BOTH a
  single-character (Finley) and a multi-character (Kara) capture. So `mes_example` is NOT
  recoverable via this path; leave it empty. That's fine — creators rarely author example
  dialogs (see memory `jai_proxy_settled_findings.md`), and the open API can't get it for hidden
  cards either.
- **Mapping is section-level, not semantic.** For Finley the author put scenario-text in
  Advanced Prompt (→ `[ Critical Instructions ]`); for Kara they put behavior guidelines there
  and the scenario inside Companion Core (→ `[ Background ]`). Either way `[ Background ]`→
  description and `[ Critical Instructions ]`→scenario reproduce exactly what the *open* export
  would have produced. Do NOT try to be smarter than the section labels.
- **`{{user}}` reversal is self-contained.** The card stores `{{user}}`; the captured prompt has
  the account handle substituted in throughout (e.g. `{{user}}` → `EnchantedRobot`). The handle
  is extractable from the preamble: `The user is roleplaying (.+?)\.`. Word-boundary-substitute
  that handle back to `{{user}}`. No config and no userscript cooperation needed.
- **Greeting note:** the captured `assistant` message equals `first_mes`, but for saucepan we do
  NOT need it — the public v2 API returns ALL greetings (`starting_scenarios_fragments`) with
  macros intact even for hidden cards, and `/build-saucepan` already uses them via
  `sources.saucepan.greetings(raw)`. So the capture only needs to supply **description + scenario**.

## 5. Design decisions (locked)

1. **Distinct capture path: `POST /saucepan/v1/chat/completions`.** We control the provider URL
   (saucepan sends it verbatim, only requiring it end in `/chat/completions`), so route saucepan
   to its own path instead of content-sniffing the format on the shared `/v1/chat/completions`.
   Same handler body as the JanitorAI capture, but parses with `SaucepanPromptParser` and reverses
   the dynamic handle. Keeps JanitorAI untouched and avoids a format heuristic.
2. **Reverse `{{user}}` at capture time**, inside/after the saucepan parse, so the stored
   `CaptureRecord` already contains `{{user}}`. Downstream (`CardBuilder`) then stays uniform —
   its existing `reverse_names(user_names=["USER"])` is a harmless no-op on already-reversed
   saucepan text.
3. **Key the capture by the primary character name** parsed from the preamble
   (`You are roleplaying <NAMES> and any side characters…` → take the first name before a comma).
   `/build-saucepan` looks the capture up by `companion.name`. These must normalize-match
   (`capture_store.normalize` lowercases+strips). For Finley both are "Finley" ✓. This mirrors
   the JanitorAI name-join gotcha; `clear-captures` is the mitigation for stale/colliding names.
4. **Capture only supplies description + scenario.** Greetings/tags/name/creator/avatar/lorebooks
   keep coming from the public v2 API path already in `/build-saucepan`.

## 6. Implementation phases

### Phase 1 — `proxy/sources/prompts/saucepan.py` + tests (start here, pure/offline)
- New `SaucepanPromptParser` (peer of `SystemPromptParser`). `parse(system: str) -> ParsedDefinition`
  (`proxy/cards/models.py` L72: `name, personality, scenario, mes_example, first_mes, raw`). Map:
  `personality ← [ Background ]`, `scenario ← [ Critical Instructions ]`, `mes_example ← ""`,
  `name ←` primary name from preamble. Extract handle from preamble and reverse it to `{{user}}`
  in `personality`/`scenario` before returning (use `macros.reverse_persona_names(text, [handle])`).
  Return the raw prompt on `.raw`. Never raise; unknown/missing sections → "".
- Detection helper `is_saucepan_prompt(system) -> bool` (e.g. contains `[ User Description ]` or the
  "and any side characters" preamble) — used later for safety, though routing is path-based.
- Tests `tests/test_saucepan_prompt_parser.py`, driven by
  `tests/fixtures/saucepan/saucepan_chat_finley_60bdd321.json`: load the `system` message, assert
  `personality`/`scenario` equal the known Finley description/scenario **with `{{user}}` restored**
  (cross-check strings are in the fixture's sibling ground truth; assert the two `{{user}}` spots
  in description are reversed, preamble + `[ User Description ]` dropped, `name == "Finley"`).
  Follow the fixture-loading pattern in `tests/test_saucepan_mapper.py`.

### Phase 2 — capture endpoint wiring
- `proxy/state/captures.py`: allow a per-call parser. Minimal change — add an optional
  `parser: SystemPromptParser | None = None` to `record()` (L47) defaulting to `self._parser`;
  or add `record_with(parser, system, primary_greeting=)`. Everything else (keying by
  `parsed.name`, greeting-merge, persistence) is reused as-is.
- `proxy/api/chat.py`: add `POST /saucepan/v1/chat/completions` mirroring the existing
  `/v1/chat/completions` (L94), but calling `capture_store.record(system, primary_greeting=...,
  parser=saucepan_parser)`. Forward to MLX identically (stream + non-stream). The `assistant`
  greeting can still be recorded (harmless; unused for saucepan).

### Phase 3 — `/build-saucepan` hidden-fill merge (`proxy/api/build.py`)
- After mapping `profile = sources.saucepan.to_profile_fields(raw)`, if `not is_open(raw)`:
  `capture = capture_store.get(profile.name)`. If a capture with definition exists
  (`capture.personality or capture.scenario`), override `profile.description ← capture.personality`
  and `profile.scenario ← capture.scenario`, and DROP the "definition is not open" warning
  (replace with an info note like "hidden definition filled from capture"). If no capture, keep
  today's fallback + warning.
- **Read `proxy/cards/builder.py` `build()` first** to confirm how `capture=` vs `profile` merge for
  hidden cards (the `_pick` logic). Simplest robust approach: fill the fields directly on `profile`
  as above and continue to pass `capture=None` (or pass the capture and ensure it wins). Mirror
  whatever the JanitorAI `/build-jai` hidden path does at L190-215 for consistency.

### Phase 4 — public host + auth gate
- **Named Cloudflare tunnel** on Matt's domain (he owns a CF domain+account) → stable hostname,
  because saucepan locks the Provider URL after saving (a `trycloudflare.com` quick-tunnel URL
  changes each run). Document the `cloudflared` named-tunnel setup in the README.
- **API-key gate**: the proxy has NO auth today (`server.py` only has permissive CORS). Add a
  check on the saucepan capture path (and ideally all write paths) that validates the
  `Authorization: Bearer <key>` saucepan sends (the key the user typed into the provider form)
  against a configured secret (`settings`, env `JAI_PROXY_*`). Fail closed on the public path so
  the exposed URL isn't an open relay/model.

### Phase 5 — userscript (`userscript/src_saucepan/`)
Mirror the JanitorAI bridge's capture affordances (currently absent in the saucepan bridge —
confirmed):
- `client-server.js`: add `captureStatus(name)` (`GET /capture-status?name=`) and `clearCaptures()`
  (`POST /clear-captures`) — copy from `src_jai/client-server.js`.
- `scheduler.js`: in the hidden branch of `tick()`, query capture-status and flip the pill from
  `🟢 saucepan · hidden ✗` to `hidden ✓` when the definition is captured (mirror
  `src_jai/scheduler.js`). Allow export once ✓.
- `overlay.js`: add the inline **CLEAR** affordance (mirror `src_jai/overlay.js`).
- Recompile via `scripts/compile_userscript_saucepan.py` / `make compile`; `node --check`.
- Docs: how to add the Custom Provider (Provider URL = `<tunnel>/saucepan/v1/chat/completions`,
  any key/model), send one chat message, then export.

### Phase 6 — live verify
- Re-establish the named tunnel + run the proxy with MLX. Point a fresh saucepan Custom Provider
  at `<tunnel>/saucepan/v1/chat/completions`. On a genuinely **hidden** card (or your own hidden
  companion): send a chat message → pill flips `hidden ✓` → export → decode the PNG and confirm
  description/scenario are the real hidden definition with `{{user}}` intact. Cross-check against
  an open equivalent if available (the Finley method).

## 7. Files

- **New:** `proxy/sources/prompts/saucepan.py`, `tests/test_saucepan_prompt_parser.py`.
- **Edit:** `proxy/state/captures.py` (per-call parser), `proxy/api/chat.py` (new capture route +
  `/build-saucepan` merge + auth gate), `proxy/config.py` (auth secret), `proxy/sources/saucepan.py`
  (only if the hidden fallback needs to yield to the capture), `userscript/src_saucepan/*`,
  `README.md`.
- **Reuse (do not rewrite):** `proxy/text/macros.py` (`reverse_persona_names`), `proxy/cards/builder.py`,
  `proxy/cards/lorebook.py`, `proxy/cards/avatar_fetch.py`, `proxy/cards/models.py`, the `/build-saucepan` assemble tail
  `_assemble_and_write`.
- **Fixture:** `tests/fixtures/saucepan/saucepan_chat_finley_60bdd321.json` (the captured request);
  ground truth `cards/Theodrax/Finley_60bdd321.png`.

## 8. Gotchas

- **Name-key mismatch** (design decision #3): primary preamble name vs `companion.name`. Verify
  on the live test; `clear-captures` mitigates stale/colliding captures.
- **Multi-character cards**: `[ Background ]` holds `[[Scenario:]]` + per-character `[[ [Name:…] ]]`
  sheets — still all → description, which is correct. Don't split it.
- **MLX must be running** for the saucepan chat to actually answer (same as JanitorAI); the capture
  happens regardless, but the user needs a real reply to keep chatting.
- **Test Connection ping** has no `system` message → naturally not recorded. Don't special-case it.
- **Keep JanitorAI untouched** — the distinct path guarantees it.

## 9. Test / verify commands

- `pytest` — full suite green (currently ~194 tests) including the new parser tests.
- `make compile` + `node --check` on `saucepan-proxy-bridge.user.js`.
- Live: `/verify`-style end-to-end per Phase 6.
