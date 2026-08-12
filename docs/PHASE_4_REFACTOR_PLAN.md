# Phase 4 — Python reorganization

**Status:** DONE, 2026-08-12. All six steps landed; 781 Python tests and 77 JS tests
green, the 47-operation route table byte-identical before and after, and the server
verified booting against the real 3,841-card archive.

## What this is

`proxy/` is a flat namespace of 36 modules where `macros.py`, `media_guard.py`,
`chub_mapper.py` and `server.py` are peers. The code grew from a set of scripts
into a FastAPI server and the layering that emerged was never written down in the
directory structure.

The layering itself is fine. The internal import graph is **acyclic and already
correctly ordered**: `config` at the bottom, then leaf utilities, then the source
mappers, then the card builders, then `server`/`api` on top. Nothing is tangled
and nothing imports upward. The only problem is that none of that is visible from
the file listing.

So this is a **relocation pass**. Files, classes and functions move into packages
that name the layer they belong to. Logic is not rewritten.

## Non-goals

Explicitly out of scope, so the diff stays reviewable as a move:

- **No deduplication.** The four identical `_s(value) -> str` coercers stay, one
  per mapper. The two pngquant-binary resolvers stay. The three UTC-timestamp
  formatters stay. The four `/build-*` endpoints keep assembling their own
  `extensions` dicts by hand.
- **No new abstractions.** No `SourceKind` enum, no shared extensions-block
  builder, no formalized mapper protocol — even though the mappers do share an
  implicit `to_profile_fields` / `greetings` / `avatar_url` / `page_name` /
  `creator_id` surface.
- **No behavior changes.** Every HTTP route path stays exactly as it is (the two
  userscripts and `web/` bind to them), and every on-disk format is untouched.
- **No compatibility shims.** Nothing outside this repo imports `proxy.*`, and
  nothing inside `proxy/` is imported by anything but `scripts/` and `tests/`.
  Verified: the only cross-boundary import of server internals anywhere is
  `from proxy.server import app` in `tests/conftest.py`.

Deferred to a later pass, recorded here so they are not rediscovered: the `_s`
duplication, the source-kind string literals scattered across four build sites
plus `archive.py` plus `datacat_mapper.normalized_source_kind` (there is
currently not a single `Enum` in the codebase), and the by-hand extensions block.

## Target layout

```
proxy/
  config.py                  unchanged, stays at root — everything imports it
  deps.py                    NEW: the singletons server.py builds at module scope
  server.py                  app assembly only: FastAPI(), middleware, lifespan,
                             router includes, static mount, main()

  api/
    schemas.py               ← api/models.py
    build_schemas.py         ← the wire half of models.py
    build.py                 ← the four /build-* routes from server.py
    capture.py               ← /capture-status, /clear-captures, /existing,
                               /lorebooks/existing, /clear-lorebooks
    chat.py                  ← /health, /v1/models, /v1/chat/completions
    datacat.py               unchanged
    v1/
      _shared.py             router, singletons, helpers used by 2+ route modules
      characters.py          list / get / put / delete / tags / png / thumb
      galleries.py           folders, files, uploads, thumb pruning
      media.py               status, manifest, download, jobs
      system.py              stats, facets, refresh, settings

  cards/
    models.py                ← the card half of models.py
    builder.py               ← cardbuilder.py
    edit.py                  ← cardwrite.py   (see deviations)
    pngtools.py              ← pngtools.py    (name kept, see deviations)
    naming.py                ← id_fragment + _safe_filename, out of cardbuilder.py
    gallery.py               ← gallery.py
    lorebook.py              ← lorebook.py
    avatar_fetch.py          ← avatar.py
    avatar_image.py          ← avatar_transform.py

  sources/
    janitor.py               ← janitor_mapper.py
    saucepan.py              ← saucepan_mapper.py
    saucepan_fragments.py    ← saucepan_fragments.py
    chub.py                  ← chub_mapper.py
    datacat.py               ← datacat_mapper.py
    datacat_client.py        ← datacat_api.py
    jannyai.py               ← jannyai_mapper.py
    prompts/
      janitor.py             ← prompt_parser.py
      saucepan.py            ← saucepan_prompt_parser.py

  text/
    macros.py  html_md.py  notes_html.py  name_repair.py

  media/
    writer.py  jobs.py  manifest.py  guard.py  names.py

  archive/
    catalog.py               ← archive.py
    thumbs.py                ← thumbs.py

  state/
    captures.py              ← capture_store.py
    lorebook_cache.py        ← lorebook_cache.py
    ui_settings.py           ← settings_store.py

  runtime/
    dashboard.py             ← dashboard.py (+ the DASHBOARD global and
                               _record_download, out of server.py)
    mock_responder.py        ← mock_responder.py
```

### Three naming decisions worth stating

- **`archive/catalog.py`, not `archive/index.py`.** The module defines a
  module-level function `index()` returning `ArchiveIndex`. A module named
  `index` inside a package named `archive` makes `from proxy.archive import
  index` ambiguous between the module and the function. `catalog` sidesteps it:
  callers read `catalog.index()`.
- **`state/ui_settings.py`, not `state/settings.py`.** `settings_store` holds the
  *browser UI's* settings; `config.settings` holds the *server's*. Two files
  named `settings.py` in one package tree is a trap.
- **`sources/datacat_client.py`, not `datacat_api.py`.** It is an outbound HTTP
  client for datacat.run. The current name reads like `proxy/api/datacat.py`,
  which is the unrelated inbound route module.

`cards/writer.py` and `media/writer.py` share a basename deliberately — they are
in different packages and every call site imports them explicitly
(`from proxy.media import writer as media_writer`).

## Scripts

`scripts/` stays exactly where it is. Per the standing call, those eleven files
are multi-repo-era band-aids scheduled for removal, and reorganizing code that
gets deleted is wasted work. They need import updates only.

One exception is forced: `scripts/fix_names.py` already imports the private
`_safe_filename` from `cardbuilder`. Moving it to `cards/naming.py` drops the
underscore, since the privacy marker is already not respected.

## The one hazard that matters

**`from X import y` freezes a binding; `import X` then `X.y` does not.**

Three process-wide singletons are monkeypatched by name in tests or reassigned at
runtime:

| Singleton | Patched/set by | Lands in |
|---|---|---|
| `v1.thumbnail_store` | `tests/conftest.py:archive_dirs` | `api/v1/_shared.py` |
| `archive._index` | `tests/conftest.py:archive_dirs` | `archive/catalog.py` |
| `v1.job_store` | `server.py` lifespan, `.bind(loop)` | `api/v1/_shared.py` |
| `server.DASHBOARD` | `server.main()` | `runtime/dashboard.py` |

If a split-out route module does `from proxy.api.v1._shared import
thumbnail_store`, the conftest monkeypatch will silently miss it and the test
suite will read the developer's real 3 GB archive and pass for the wrong reason —
which is exactly the failure `conftest.py` already documents having hit once.

**Rule for the whole pass:** every reference to those four names goes through the
module (`_shared.thumbnail_store`, `catalog._index`, `dashboard.DASHBOARD`),
never a from-import.

## Steps

Each step ends green on `make test` (781 Python tests) before the next begins.

### 1. Leaf packages — `text/`, `media/`, `state/`, `archive/`

Pure file moves plus import updates. These have the fewest dependents and no
shared mutable state except `archive._index`.

- `media_*.py` → `media/`, prefix dropped.
- `archive.py` → `archive/catalog.py`; audit every `archive._index` reference for
  the from-import rule above.
- Verify: `make test`, plus `uv run python -c "import proxy.server"`.

### 2. `cards/`

- Move the seven modules.
- Extract `id_fragment` and `_safe_filename` from `cardbuilder.py` into
  `cards/naming.py`; `safe_filename` loses its underscore.
- Split `models.py` at its existing section-comment boundaries. The file is
  already sectioned, so each class lands intact:
  - → `cards/models.py`: `LoreEntry`, `CharacterBook`, `ParsedDefinition`,
    `ProfileFields`, `CaptureRecord`, `CharacterCardV3`, `_utcnow`.
  - → `api/build_schemas.py`: `ChatCompletionRequest`, `BuildCharacter`,
    `BuildLorebook`, `BuildRequest`, `BuildResponse`, `SaucepanBuildRequest`,
    `ChubBuildRequest`, `DatacatBuildRequest`, `ExistingRequest/Response`,
    `LorebookExistingRequest/Response`.

### 3. `sources/`

Straight moves, `_mapper` suffix dropped, `prompt_parser` pair nested under
`sources/prompts/`. The two cross-file comments that cite modules by path
(`datacat_mapper.py:353` → `server._datacat_block`, `cardbuilder.py:211` →
`server._assemble_and_write`) get their references updated in step 6.

### 4. `api/` and `server.py` — the only step with real risk

Ordered sub-steps:

1. `api/models.py` → `api/schemas.py`.
2. Create `proxy/deps.py` and move the seven singletons `server.py` constructs at
   module scope, verbatim: `capture_store`, `responder`, `card_builder`,
   `png_writer`, `avatar_fetcher`, `lorebook_mapper`, `lorebook_cache`,
   `chub_sanitizer`.
3. Move `DASHBOARD` and `_record_download` into `runtime/dashboard.py`;
   `main()` sets `dashboard.DASHBOARD`. This also removes a cross-module global
   read, which is a side effect of the move, not a redesign.
4. Split `api/v1.py` (1202 lines) by resource. It has **no section-comment
   markers**, so unlike `models.py` this is a grouping judgment, not a cut along
   dotted lines. Helpers travel to `_shared.py` when used by more than one route
   module, and into the single route module otherwise:

   | Helper | Uses | Destination |
   |---|---|---|
   | `_index`, `_require` | 17, 11 — all four groups | `_shared.py` |
   | `_safe_child`, `_gallery_dir` | galleries + media | `_shared.py` |
   | `_gallery_dir_for_card` | characters + media | `_shared.py` |
   | `_serve_file`, `_THUMB_CACHE_CONTROL` | galleries + characters | `_shared.py` |
   | `_write_error`, `_check_precondition` | characters + galleries | `_shared.py` |
   | `thumbnail_store`, `job_store` | everywhere | `_shared.py` |
   | `_card_out`, `_gallery_out`, `_matches`, `_SORTS`, `_etag_of` | characters only | `characters.py` |
   | `_job_status_out` | media only | `media.py` |
   | `_settings_store` | system only | `system.py` |

5. Move the route functions verbatim out of `server.py` into `api/build.py`,
   `api/capture.py`, `api/chat.py`. Build helpers travel with their only callers:
   `_utc_now_iso`, `_datacat_block`, `_check_duplicate`, `build_card`,
   `fetch_avatar_and_write`, `_fields_present`, `_chub_fields_present`,
   `_assemble_and_write`, `_resolve_saucepan_lorebooks` → `api/build.py`;
   `_first_message_of_role` → `api/chat.py`.
6. `server.py` retains only: imports, `WEB_DIR`, `_lifespan`, `app` +
   middleware + `include_router` calls, `QuietAccessFilter`, the StaticFiles
   mount, `_stats_line`, `_serve`, `main()`. Target ≈120 lines.

Verify beyond `make test`: boot the server, confirm the OpenAPI route table is
identical to a pre-refactor capture (`GET /openapi.json`, diff the `paths` keys),
and confirm the StaticFiles mount is still registered **last** — Starlette
matches in registration order and a `/` mount swallows everything after it.

### 5. Tests mirror the layout

`tests/` → `tests/cards/`, `tests/sources/`, `tests/api/`, `tests/media/`,
`tests/text/`, `tests/archive/`, `tests/state/`. `conftest.py` stays at
`tests/` root.

This also fixes the current situation where one module's tests are split four
arbitrary ways (`test_api_v1.py`, `test_api_v1_media.py`, `test_api_writes.py`,
`test_api_galleries.py`) — they realign onto the four new route modules.

`tests/fixtures/` does not move; check for path assumptions relative to
`Path(__file__).parent` in the moved test modules.

### 6. Docs and comments

- README module paths.
- `docs/PHASE_3B_PLAN.md`, `3C`, `3D` references.
- The cross-file comments that name modules by path — notably the three places
  citing `chub_mapper`'s raw-dict-passthrough rule, and the two citing
  `server._datacat_block` / `server._assemble_and_write`.
- `.claude/` and memory notes that pin module paths.

## Untouched by design

`Dockerfile` (`COPY proxy/ ./proxy/` takes the package whole), `compose.yaml`,
`pyproject.toml` (`packages = ["proxy"]`, and the `jai-proxy = "proxy.server:main"`
entry point survives since `main()` stays in `server.py`), `Makefile`, `web/`,
`userscript/`, and every path under `data/`.


## What actually happened

Six steps, each green before the next. Four deviations from the plan above, all
made for call-site collisions rather than taste:

1. **`pngtools.py` kept its name** instead of becoming `cards/png.py`. 77 call
   sites use `pngtools.`, and `png` is the pervasive local name for raw bytes in
   exactly those files.
2. **`cardwrite.py` became `cards/edit.py`**, not `cards/writer.py`. `writer`
   would have sat beside `media_writer` in the same modules (ambiguous) and
   shadows the `writer = PngWriter(...)` locals in the import scripts.
3. **Logger names tracked their modules.** `jai_proxy.capture_store` is now
   `jai_proxy.state.captures`, `jai_proxy.cardwrite` is `jai_proxy.cards.edit`,
   and the build lines moved from `jai_proxy.server` to `jai_proxy.api.build`.
   Visible in the dashboard's log column, which shortens `jai_proxy.X` to `X`.
4. **`_shared.PREFIX`** — the card and gallery URLs in responses were built from
   `router.prefix`, which is empty once the routers are per-module. The prefix is
   now a named constant, applied once to the parent router and read by the URL
   builders. The suite caught this; see below.

Helpers that moved into `_shared` were made public (`_index` → `index`,
`_serve_file` → `serve_file`, and so on) rather than being reached across modules
through their underscores.

### What the verification actually caught

Three real regressions, all found by the suite rather than by reading:

- **The `router.prefix` break** — `thumb_url` and `png_url` silently lost their
  `/api/v1` prefix. Five tests, and it would have broken every image in the
  browse grid.
- **The `deps` singletons in `tests/api/test_acquisition.py`** — the harness
  repoints `responder`, `capture_store`, `png_writer` and friends by module
  attribute. This is exactly the hazard the plan called out, landing on the test
  side rather than the source side: 33 tests failed until they pointed at
  `proxy.deps` instead of `proxy.server`.
- **A mangled keyword argument** — the qualifier that rewrote `thumbnail_store`
  to `_shared.thumbnail_store` also hit two `thumbnail_store=` kwargs, which is a
  syntax error rather than a silent break.

Two pre-existing unused imports (`time` in `media/writer.py`, `json` in
`state/captures.py`) were left alone: both predate this pass, and removing them
is not a move.

### Verification performed

- 781 Python tests, 38 + 39 JS tests, all green.
- OpenAPI route table captured before the first move and diffed after every
  step: 47 operations, identical throughout.
- Every script under `scripts/` import-checked after each step.
- `StaticFiles` confirmed still the last-registered route.
- Live boot against the real archive: 3,841 cards indexed in 1.05s, `/health`,
  `/api/v1/stats`, `/api/v1/characters` and the frontend at `/` all answering.
