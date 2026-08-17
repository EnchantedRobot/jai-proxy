# Phase 5C — Name editor: bring `make names` into the UI

> Status: **PROPOSED (2026-08-15).** Nothing in this document is built.
>
> Sibling of `docs/PHASE_5B_TAG_EDITOR_PLAN.md`: same shape (a modal opened from the
> more-options dropdown, a survey of the whole archive, a plan the human edits, one bulk
> apply). The decision engine already exists and is *not* being changed —
> `proxy/text/name_repair.py` (846 lines, 80% top-1 accuracy) stays exactly as it is. This
> phase is a surface for it plus a write path.

---

## 0. What exists today

| piece | where | role |
|---|---|---|
| `diagnose(card) -> Diagnosis` | `proxy/text/name_repair.py:711` | verdict (`ok`/`junk`/`generic`/`title`), best suggestion, ranked candidates from the body, kept/dropped segments, `ensemble` flag |
| `roster(...)`, `Candidate` | same file | the ranking engine and its per-candidate features |
| terminal driver | `scripts/fix_names.py` (794 lines), `make names` | scan → print → `--interactive` prompt → apply → append `logs/name_repair.jsonl` |
| the apply | `fix_names.py:169 _apply` | rewrite `data.name`, re-embed via `pngtools.embed_card`, assert pixel chunks unchanged, rename the file to `<slug>_<id8>.png` |
| the guard | `fix_names.py:204 _implausible` | rejects `yy` / `u` style slips before they reach a card |
| the tuning loop | `--rejudge` / `--stats` over the jsonl | the only way a rule change is measured |

**Nothing in the web app touches names beyond the normal card editor.** `PUT
/api/v1/characters/{id}` renames the character but deliberately leaves the file alone
(`characters.py:363` docstring).

---

## 1. Measured ground truth (run 2026-08-15 against `data/` — 3,860 cards)

```
read + parse   1.04 s
diagnose       9.79 s
verdicts       ok 3833 · title 22 · junk 5 · generic 0
of the 27 flagged: 24 are ensemble-flagged, 21 have no confident suggestion
```

The full flagged list is short enough to read in one screen, and it is *hard* residue —
`The Bet`, `Spoils of War`, `The Alley Cat Tavern`, `Only Boy at a Demihuman Sleepover`:
multi-character scenario cards where leaving the name alone is usually the right answer.
The genuinely fixable ones are three: `Misandrist Goth Stuck in the Sauna with You |
Pandora Ortiz` → `Pandora Ortiz`, `Vespera - Neo-Gomorrah's cheapest doctor` → `Vespera`,
`Milf Sex Satisfaction Service ~ MSSS` → `MSSS`. Two proposals are outright wrong
(`Castella Royalties - Revenge, Roses, Ruin` → `Revenge, Roses, Ruin`; `The Bride` →
`Harvest Festival`).

**This is the single most important input to the design.** The archive has already been
swept by `make names`, so a modal scoped to "what `diagnose` flags today" opens on ~27 rows,
most of which should be dismissed rather than renamed. Two consequences:

1. The feature's steady-state value is **intake** — new Chub/DataCat imports get reviewed
   here instead of in a terminal — plus **dismissal memory**, so those 24 ensemble cards
   stop being re-presented every time.
2. If the intent is "there are a variety of characters which could use renames" beyond the
   27, the modal needs a **review-any-card mode** (search the archive, diagnose on demand,
   including cards currently rated `ok`), not just the findings list. That is an explicit
   open question in §6.

---

## 2. Server

### 2.1 `GET /api/v1/names/scan`

Query: `verdict=junk,title,generic` (default: all non-ok), `include_ensemble=false`,
`include_ok=false`, `include_dismissed=false`, `q=` (name substring, forces `include_ok`).

Row shape — everything the row UI and the decision log need, so the client never re-derives:

```json
{
  "filename": "Vespera_1a2b3c4d.png", "etag": "\"…\"", "card_id": "jai:…",
  "name": "Vespera - Neo-Gomorrah's cheapest doctor",
  "verdict": "junk", "reason": "name carries a tagline/descriptor alongside the real name",
  "ensemble": true, "suggestion": "Vespera",
  "kept": ["Vespera"], "dropped": ["Neo-Gomorrah's cheapest doctor"],
  "candidates": [{"display": "Ves", "score": 8.4, "count": 31, "lowercase": 0,
                  "possessive": 4, "first_pos": 0.02, "surname": null}],
  "excerpt": "…300 chars of definition…",
  "dismissed": false
}
```

**Cost and caching.** 11 s cold for the whole archive. The tag manager already scans
everything on open behind a spinner, so a spinner is acceptable — but memoize
`diagnose` per `(filename, mtime_ns, size)` in a module-level dict (same key the catalog
refresh already computes, `catalog.py:376`), so a re-open is instant and only new or edited
cards pay. No background job, no progress endpoint, no persisted index. If a cold 11 s
proves annoying in practice, the cache can be warmed on first index build later — do not
build that up front.

### 2.2 `POST /api/v1/names/apply`

```json
{"renames": [{"filename": "…png", "name": "Vespera", "etag": "\"…\""}],
 "dismiss":  ["Other_9f8e.png"],
 "move_file": false, "move_gallery": false}
```

Per-row result `{filename, new_filename, ok, error}`. Rules:

- Reuses `edit.read_card` + `edit.patch_card` — atomic write, pixels untouched, preserved
  extensions. **No new write primitive for the name-only path.**
- Per-row `If-Match` semantics using the etag from the scan (`characters.py:160 _etag_of`).
  A card edited elsewhere since the scan fails *that row* and reports it; it does not
  clobber and it does not abort the batch.
- Runs the `_implausible` guard server-side (see §3). A row that trips it is rejected with
  the reason; the client re-submits with `"force": true` after the human confirms.
- Appends one decision-log record per row (§3), with `"source": "ui"`.
- Calls `catalog.index().refresh(force=True)` once at the end, not per row.

### 2.3 The two optional on-disk moves — recommend **not** shipping them in step 1

**Renaming the PNG (`move_file`) fights the archive's identity contract.** `filename` *is*
the id (`catalog.CardSummary` docstring, `catalog.py:83`) — it is what every URL, the DOM,
the bundle export and the thumbnail cache key on. `put_character` refuses to move it for
exactly this reason. Renaming from a bulk operation additionally:

- orphans the avatar thumb (`thumbs.avatar_path` is keyed on the exact filename, and both
  `avatar/` and `avatar_<size>/` variants exist) — the smoke gate's zero-orphan check trips;
- strands per-character media state, which keys on `character.avatar`, i.e. the filename
  (`31-unified-media-download-pipeline.js:112`);
- 404s any detail view or URL the human has open on that card.

If it ships, it must be one server-side operation that renames the PNG *and* moves every
thumb variant alongside it, returns `new_filename`, and forces a client list refresh — plus
the existing collision/`samefile` handling from `fix_names.py:169` (case-only renames on
APFS are the trap). Default the checkbox off. The honest alternative is to never move the
file: it already diverges from the name for every card with punctuation in it, so it is a
label, not a fact.

**Renaming the gallery folder (`move_gallery`) is unnecessary and actively harmful.** A
rename does *not* orphan a gallery today: `gallery.resolve_folder` finds the folder by its
`_<gallery_id>` tail regardless of the name half (`proxy/cards/gallery.py:145`), which is
why the Phase 3 write path documents "a rename moves NOTHING". Renaming the folder buys
cosmetics and costs: every gallery thumb is cached under the *folder name*
(`thumbs.gallery_path`), so the whole folder's thumbs orphan; and APFS case/NFD-insensitivity
is the exact hazard that made live galleries look orphaned in `repair_galleries.py`. If
folder cosmetics are wanted, they belong in `scripts/repair_galleries.py` as a tidy pass,
not in an interactive apply.

So the three-step apply in the original sketch collapses to **step 1 by default**, with 2
and 3 behind one "also tidy files on disk" checkbox that is a separate, later step.

---

## 3. Shared decision log — `proxy/text/name_log.py` (new)

`logs/name_repair.jsonl` is not a debug artifact; it is the corpus `--rejudge` scores rule
changes against, and it is how `--stats` reports accuracy. **A UI that renames without
writing it silently kills the tuning loop.** So before any of the above:

Extract from `scripts/fix_names.py`, unchanged in behaviour — `_candidate_row`, `_rank_of`,
`_log`, `_describe`, `_implausible`, `_card_id`, `_fragment`, `_new_path` — into
`proxy/text/name_log.py`, and have `fix_names.py` import them. Add one field, `"source":
"cli" | "ui"`. Existing tests (`tests/scripts/test_fix_names.py`) must stay green with no
edits beyond import paths; that is the acceptance check for this step.

Dismissals ("name is fine") are read back from the same log: the newest record per
`card_id` with `action == "fine"` marks a card dismissed, which is what keeps the 24
ensemble cards from reappearing on every open. No second store.

---

## 4. Frontend — `web/modules/name-manager.js` + `name-manager.css`

Modelled on `tag-manager.js` throughout: lazy registration in
`web/modules/module-loader.js:304`-style block, `window.registerOverlay?.({ id:
'nameManagerModal', tier: 7, … })`, `CoreAPI` for fetches, a footer Apply.

Entry point: a `#nameManagerBtn` dropdown item in `web/index.html:173`'s
`#moreOptionsMenu`, directly under **Tag Consolidation** — `<i class="fa-solid
fa-signature"></i> Name Repair`.

**Layout**

- Header: scanned count, per-verdict counts, and how many are hidden as ensemble/dismissed
  — mirroring the CLI's summary block, which is genuinely useful context.
- Filter row: verdict chips (JUNK / TITLE / GENERIC), toggles for *show ensemble*, *show
  dismissed*, *show all cards*, and a search box.
- Rows, one per card:
  - avatar thumb + current name (struck through once the row is dirty);
  - **an editable text input**, prefilled with `suggestion` (empty when there is none — 21
    of 27 today, so an empty input must look normal, not broken);
  - verdict chip + `reason`;
  - `dropped` segments shown as removed chips (that is the whole story for a JUNK row);
  - **candidate chips from the body** — click to fill the input; hover shows the features
    (`count`, `lowercase`, `possessive`, first-mention position) that ranked it, which is
    what the CLI prints and what makes a wrong top-1 obvious;
  - a collapsed definition excerpt;
  - two buttons: **Dismiss** ("name is fine") and **Open card**.
- Footer: `Apply N renames` + `Revert` (Phase 6's Apply/Revert language, no diff view).

**Rows are opt-in, never pre-checked.** Top-1 is 80% overall and 74% on TITLE — measured,
not guessed — and two of today's five suggestions are wrong. A row counts toward the apply
only once its input has been touched or a candidate chip clicked. There is no "accept all".

**Testing**: `web/tests/name-manager-plan.test.mjs` (node:test, the tag-manager pattern) over
the pure row→payload builder, kept in its own exported function so it is testable without a
DOM. Python: route tests for scan/apply including the etag-conflict and implausible-name
paths, plus a `tmp_path` archive fixture — note the PngWriter-frozen-`archive_dir` hazard
from the card-intake work.

---

## 5. Steps

1. `proxy/text/name_log.py` extraction; `fix_names.py` imports it. No behaviour change.
2. `GET /api/v1/names/scan` + the mtime-keyed diagnose cache. Verify against the CLI: same
   27 rows, same verdicts.
3. `POST /api/v1/names/apply` — name-only, etag-guarded, logs decisions.
4. `name-manager.js` + CSS + dropdown button + module-loader registration.
5. Dismissal filtering and the search / review-any-card mode (§6 answer decides how far).
6. *Optional, separate:* `move_file` with thumb migration. `move_gallery` — recommend
   dropping entirely.

Steps 1–4 are the feature. 5 is what makes it pleasant to re-open. 6 is cosmetics with
teeth.

---

## 6. Open questions

1. **Scope of the scan.** 27 flagged cards is the honest finding. Is the goal (a) a clean
   surface for reviewing *new imports* going forward, or (b) a way to hunt bad names among
   the 3,833 cards `diagnose` currently rates OK? (b) is a different feature — it needs
   search + on-demand diagnose and possibly a loosened verdict threshold, and it is worth
   deciding before the modal is laid out.
2. **File renaming.** Accept the recommendation (name-only, filename stays), or is a tidy
   filename worth the thumb-migration work?
3. **Ensemble default.** The CLI hides ensemble GENERIC rows by default but shows ensemble
   JUNK/TITLE. 24 of today's 27 are ensemble-flagged, so mirroring the CLI exactly means the
   modal opens nearly full of cards that should be left alone. Hide all ensembles behind the
   toggle instead?
