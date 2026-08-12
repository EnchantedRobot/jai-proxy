# Phase 5 — Tag consolidation: one intake rule, one curated merge

> Status: **PLANNED (2026-08-12).** Nothing in this document is built. Phases 3B/3C/3D
> and the Phase 4 Python reorg are closed; this is the next piece of work.
>
> "Phase 4" belongs to the finished Python reorganization (`docs/PHASE_4_REFACTOR_PLAN.md`).
> The tag work is **Phase 5**. `name_repair` is explicitly *not* in it and gets its own
> phase later.

Phase 5 has two halves that are deliberately kept apart:

- **(a) Intake** — every `/build-*` route puts its tags through **one shared syntactic
  normalizer**. No dictionary, no judgement, no deletions. This is the half that stops
  the archive from taking on new mess.
- **(b) Merge** — a **curated, previewed, user-driven** pass that collapses the existing
  vocabulary using the dictionary from `~/workspaces/SillyTavern-Character-Tools`. This
  is a tool the user drives from `web/`, not something that happens to cards behind
  their back.

Keeping them apart is a decision, not an accident. See §4.

---

## 1. The measured corpus — don't re-derive these

Measured 2026-08-12 against the live archive (`proxy.archive.catalog`, all cards):

| | |
|---|---|
| cards | **3,841** |
| distinct tags | **520** |
| tag applications | **28,811** |
| distinct keys after case/`#`/whitespace folding | **511** |
| case-collision groups | **8** |
| cards touching a collision group | **100** |
| cards with an intra-card duplicate tag (case-insensitive) | **0** |
| tags carrying emoji, a leading `#`, or stray whitespace | **0** |

The 8 collision groups, in full:

```
femdom          Femdom(80)         | femdom(1)
hatefuck        hatefuck(1)        | HateFuck(1)
anypov          AnyPOV(1)          | anypov(1)
downbadforu     DownBadForU(1)     | DownBADforU(1)
multipleintros  MultipleIntros(5)  | multipleintros(1)
wifeherup       wifeherup(1)       | WifeHerUP(2)      | WifeHerUp(2)
crackher        CrackHER(1)        | CrackHer(1)
wifeheralready  WifeherALREADY(1)  | WifeHerALREADY(1)
```

**What the shipped dictionary would do to this corpus.** The dictionary
(`~/workspaces/SillyTavern-Character-Tools/tag-dictionary.json`: 19 categories,
**426 canonicals**, **2,576 aliases**, **924 removedTags**) was run against the real
corpus through its own `buildBuckets` / `buildApplyPayload`:

| outcome | tags | applications |
|---|---|---|
| claimed by a canonical | 486 | 28,639 |
| claimed by `removedTags` | 32 | 38 |
| **unassigned** | **2** | 134 |

Resolved plan: **78 renames, 32 removals, 81 cards changed, vocabulary 520 → 416.**
The only two unassigned tags are `Monster Girl` (133) and `Deadbeat` (1).

Read those numbers honestly before scoping the UI: **coverage is ~99.6% because the
dictionary was curated against this same library** when it lived in SillyTavern. The
merge is real but small, and there is almost nothing left to *curate*. The tag manager's
value is the preview and the ongoing surface, not a big first-run payoff.

---

## 2. The intake defect

`clean_tag` (`proxy/text/html_md.py:37` — strips a leading `#`/emoji/punctuation run)
is called by **two of five** sources:

| source | `clean_tag` | `clean_creator_notes` | MacroSanitizer |
|---|---|---|---|
| janitor | yes | yes | yes |
| chub | yes | yes | yes |
| datacat | **no** | yes | yes |
| jannyai | **no** | yes | yes |
| saucepan | **no** | **no** | yes |

This is not hypothetical. `tests/fixtures/datacat/raw_api_character_abbie.json` and
`tests/fixtures/great_n_datacat.json` both carry `#`-prefixed tags
(`#wildwest`, `#outlaw`, `#bully`, `#rockstar`, `#hiddenfeelings`, `#reunion`).
`proxy/sources/datacat.py:173 resolve_tag_names` strips a leading **emoji** but not a
leading `#`, so those land on the card as written. The corpus shows zero `#` tags today
only because those particular cards predate the DataCat browser-import path.

**Two choke points cover all five sources**, which is what makes half (a) cheap:

- `CardBuilder` (`proxy/cards/builder.py:119`, `tags=profile.tags`) covers **janitor,
  datacat, saucepan, jannyai** — all four construct a `ProfileFields`
  (`proxy/cards/models.py:83`).
- `chub` never goes through pydantic (deliberately — see the card-import memo: a
  round-trip through `LoreEntry` drops `priority`/`probability`/`selectiveLogic`), so
  `proxy/sources/chub.py:190` gets the same call by hand.

---

## 3. What the intake normalizer does

Syntactic only. Every rule below is reversible-by-inspection and loses no information a
human would want back:

1. Strip a leading run of `#`, whitespace, emoji and punctuation (today's `clean_tag`).
2. Trim, and collapse internal whitespace runs to one space.
3. Drop tags that are empty after 1–2.
4. Deduplicate **within a card**, case-insensitively, keeping the first occurrence's
   casing and the original order.

That is the whole list.

**It does NOT split on commas.** `Can Be Wholesome, Can Be Sexy` is a genuine single
JanitorAI tag on **515 cards**, and it is a canonical in the shipped dictionary under
*Content Rating*. Earlier scoping notes filed it as a comma-joined mistake; that was
wrong. Splitting it would damage 515 cards.

**It does not touch casing.** `Femdom` vs `femdom` is a merge decision, and merges live
in half (b) where they can be previewed.

Applied to today's corpus this is a **no-op on every card** (0 emoji, 0 `#`, 0 stray
whitespace, 0 intra-card dupes). That is the correct expectation: half (a) is prevention,
and its test is the fixtures, not the archive.

---

## 4. Decisions settled (2026-08-12)

**Intake is syntactic only.** It never consults the dictionary, never renames, never
deletes. The cost is accepted knowingly: new imports will keep introducing casing
variants, so the merge in half (b) is a recurring tool, not a one-shot migration. The
reason is that a dictionary mistake applied at intake destroys a tag with no record that
it ever existed, and the archive's delete contract everywhere else is "move it, don't
unlink it."

**The merge is a real tag-manager UI in `web/`**, not a script and not a CLI. Rationale:
the maintenance scripts (`make import/check/names/thumbs/gallery-ids`) are recorded
band-aids scheduled for removal, and `web/VENDORED.md` already names **"bulk tag
cleanup"** as one of the archive's five jobs. This is that job.

**The matching semantics stay in JavaScript, vendored — not ported to Python.** Because
intake no longer consults the dictionary, the server needs *no* tag-matching logic at
all. `tag-analysis.js` is pure (no DOM, no SillyTavern globals), already unit-tested
upstream, and already designed around exactly this split:

> "ALL tag-matching semantics live here — `norm()`, alias lookup, canonical casing,
> mapping-beats-removal. The server holds none of it: it receives the resolved
> `{rename, remove}` plan and applies it by literal string equality."

That contract is reusable verbatim. Porting it would create a second implementation to
keep in sync for no gain.

**No new Enum work.** The source-kind string literals scattered across the four build
sites, `archive.py` and `datacat_mapper.normalized_source_kind` are a real deferral on
record in `PHASE_4_REFACTOR_PLAN.md`'s non-goals. They stay deferred. Phase 5 does not
touch them.

---

## 5. Architecture

### Python (small)

- **`proxy/text/tags.py`** — new. `normalize_tags(tags: Iterable[str]) -> list[str]`
  implementing §3, plus `normalize_tag(t: str) -> str`. `clean_tag` moves here from
  `proxy/text/html_md.py` (it is tag logic, not HTML→markdown) and becomes an internal
  step; keep a re-export in `html_md` only if a caller genuinely needs it, otherwise
  update the two import sites and the test.
- **`proxy/cards/builder.py`** — `tags=normalize_tags(profile.tags)`.
- **`proxy/sources/chub.py`** — swap the hand-rolled `clean_tag` comprehension for
  `normalize_tags`.
- **`proxy/api/v1/characters.py`** — new `POST /api/v1/tags/apply` taking a literal plan:

  ```json
  { "rename": { "<exact card tag>": "<exact canonical>" }, "remove": ["<exact card tag>"] }
  ```

  Applied corpus-wide by **literal string equality**, making no decisions of its own.
  Per-card: drop `remove` hits, map `rename` hits, dedupe case-insensitively preserving
  order, write only if the list actually changed, then one `catalog.index().refresh()`.
  Same partial-success contract as the existing bulk route — report `{changed, unchanged,
  failed}`, never roll back; there is no transaction across 3,000 PNG rewrites.

  The existing `POST /api/v1/characters/tags` (add/remove over a **selection**, used by
  `web/modules/batch-tagging.js:252`) stays exactly as it is. Different job, different
  shape; do not overload it.

- **`proxy/state/ui_settings.py`** — the dictionary delta persists here, in
  `data/settings.json`, under one key. No new store, no new file format.

### JavaScript (the bulk of the work)

Vendor from `~/workspaces/SillyTavern-Character-Tools` into `web/vendor/tag-tools/`:

- **`tag-analysis.js`** (381 lines) — `norm`, `buildBuckets`, `buildApplyPayload`,
  `pickCanonical`, the glob-pattern tier (`*monster*` contains / `monster*` prefix /
  `*monster` suffix, sorted most-specific-first, consulted only when no literal alias
  matches, mapping patterns tried before removal patterns).
- **`tag-delta.js`** (118 lines) — `diffDictionary` / `applyDelta`. Keep it. It is what
  lets the vendored base dictionary be re-synced from upstream later without freezing the
  user's edits, and it keeps the persisted blob small. Its `isPattern` guards are
  load-bearing: glob rules are core-dictionary-only and must never enter or leave the
  delta.
- **`tag-dictionary.json`** (4,348 lines) — the base.

Then, new in `web/modules/tag-manager.js` (+ `.css`), a sibling of `batch-tagging.js`:

- The three-bucket editor ported from upstream `ui-editor.js` (675 lines): canonical
  groups + their variants / unassigned / removed. Clicking a chip moves it; every edit
  saves the delta.
- Adapt it off SillyTavern's `characters` global to the archive's card list, and off
  SillyTavern's extension-settings store to `data/settings.json`.
- Preview before apply: `buildApplyPayload` runs client-side against the real card list,
  the resolved `{rename, remove}` plan is shown with per-tag counts, and only then does
  it `POST /api/v1/tags/apply`.
- Wire it into the panel the same way `batch-tagging` is wired.

**`buildBuckets` is the single decision point** — the editor and the apply payload come
from the same call, which is what makes "what you previewed is what lands on disk"
structurally true rather than a promise. Do not add a second matching path.

---

## 6. Sequencing

Each step is one commit and leaves the tree green.

1. **`proxy/text/tags.py`** + tests. Unit-test §3's four rules directly, including the
   comma tag surviving intact and the emoji/`#` fixtures from DataCat.
2. **Wire the two choke points** (`builder.py`, `chub.py`) and update the `clean_tag`
   import sites. Assert the existing build tests are unchanged — a no-op on today's data
   is the expected result.
3. **Regression test per source**: feed each of the five build paths a tag list carrying
   `#`, emoji, whitespace and a case-dupe, and assert normalized output. This is the test
   that would have caught the DataCat gap.
4. **`POST /api/v1/tags/apply`** + tests, including partial success, the no-op path, and
   dedupe-after-rename (two tags renaming onto the same canonical must collapse to one).
5. **Vendor the three JS files** into `web/vendor/tag-tools/`, record them in
   `web/VENDORED.md`, and port upstream's tag tests into `web/tests/` under the existing
   `node:test` harness (`make test-js`).
6. **`web/modules/tag-manager.js`** — buckets + preview, read-only. No apply button yet.
   Verify the preview reproduces §1's numbers against the live archive: 78 renames,
   32 removals, 81 cards, 520 → 416.
7. **Enable apply.** Dry-run against a copied corpus first.
8. **Run it for real**, then re-measure and record the actual post-merge vocabulary.

---

## 7. Traps

- **The comma tag.** `Can Be Wholesome, Can Be Sexy`, 515 cards, genuine. Never split.
- **`removedTags` deletes.** 32 observed tags / 38 applications, including `Cute`,
  `Coffee`, `Big Butt` and `Multiple Greetings`. Small, but these are unrecoverable once
  written. The preview must show removals separately from renames, and the count must be
  read before applying.
- **The dictionary was curated against this same library.** ~99.6% coverage is not
  evidence that the dictionary generalizes; it is evidence of shared provenance. New
  imports from a new creator will land in `unassigned` and that is working as intended.
- **`declared` vs discovered variants.** `buildBuckets` marks a variant `declared: true`
  only when it is a literal string in the dictionary. Anything that matched by `norm()`
  or a glob is discovered. **Persisting discovered variants back into the dictionary
  would silently re-declare every incidental casing your cards happen to use as an
  intentional alias.** Upstream documents this; honour it.
- **Glob rules are not chips.** They are rules. They must never be rendered or counted as
  tags, and `isPattern` must keep them out of the delta.
- **`web/` bridge ReferenceErrors truncate silently** (recorded from Phase 3D scoping): a
  throw inside a bridge file cuts everything after it with no visible error. After wiring
  the module, click every settings/help surface and capture `console.warn`.
- **Thumb cache and index refresh.** A tag rewrite changes the card JSON, not the pixels,
  so the avatar thumb cache does *not* need invalidating — but the archive index does.
  One `refresh(force=True)` after the batch, not per card.

---

## 8. Acceptance criteria

1. All five `/build-*` routes produce tags through one function; a tag carrying `#`,
   emoji, stray whitespace or a case-dupe comes out clean from every one of them, proven
   by test.
2. `clean_tag` has exactly one home and no source calls its own variant.
3. Running intake over today's corpus changes **zero** cards.
4. `POST /api/v1/tags/apply` applies a literal plan corpus-wide, reports partial success,
   and is idempotent — re-posting the same plan reports 0 changed.
5. The tag manager's preview and its posted payload come from the same `buildBuckets`
   call, and the preview reproduces §1's plan against the live archive.
6. The merge runs for real; post-merge vocabulary is measured and recorded, and the 8
   case-collision groups are gone.
7. `make test` and `make test-js` green; the Playwright smoke gate exits 0 with zero
   console errors.

---

## 9. Non-goals

- `name_repair` / `make names` — its own phase.
- Source-kind `Enum`s and the by-hand extensions block — still deferred from Phase 4.
- Porting tag matching to Python.
- Any change to `POST /api/v1/characters/tags` or `web/modules/batch-tagging.js`.
- Automatic dictionary application at intake (§4, decided against).
