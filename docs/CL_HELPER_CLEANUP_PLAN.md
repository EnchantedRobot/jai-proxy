# cl-helper legacy cleanup plan

Authority for this cleanup. Written 2026-08-12 from a full-repo audit (see memory
`jai_proxy_cl_helper_audit.md` for the raw findings this plan is based on).

## Context

jai-proxy's web frontend was originally vendored from SillyTavern-CharacterLibrary,
which called out to `cl-helper`, a closed-source SillyTavern server plugin, for
media/gallery features. SillyTavern and cl-helper are both gone from this
architecture (see `web/VENDORED.md`, `docs/PHASE_3B_PLAN.md`). Most of what
cl-helper did has already been ported into jai-proxy itself (DataCat routes,
gallery thumbnails). This plan finishes the job: nothing in the running app
should still say "cl-helper" or silently depend on a server that no longer
exists.

**Verify-before-delete rule for the whole plan:** every "dead code" claim below
was confirmed by grep at audit time. Before deleting anything, re-run the grep
yourself — don't trust the line numbers blindly, the file may have moved since.

## Step 1 — Delete provenance comments (no behavior change)

Remove comments that only explain "this was ported from cl-helper's source."
No functional change, just prose cleanup.

- `proxy/server.py:56`
- `proxy/archive/thumbs.py:265`
- `proxy/sources/datacat_client.py:205,207,217,227,248,311`
- `proxy/api/datacat.py:5,18,20`
- `proxy/api/v1/galleries.py:210`
- `scripts/sync_thumbs.py:26`
- `tests/api/test_media.py:271`
- `web/modules/gallery-viewer.js:595`
- `web/modules/providers/datacat/datacat-provider.js` (comments at ~224,227,523)
- `web/modules/providers/datacat/datacat-browse.js` (comments at ~2590,4006,4038)
- `web/modules/providers/provider-interface.js:75-76` — the `minClHelperVersion`
  getter itself is dead (grep the repo for `minClHelperVersion`; if nothing
  reads it, delete the whole getter, not just the comment)

## Step 2 — Rename `CL_HELPER_PLUGIN_BASE` and the gallery-thumb naming

This is functionality that's already fully self-hosted by jai-proxy — only the
*name* is legacy. Do not change behavior, only names.

- `web/modules/providers/provider-utils.js:14-20` — rename
  `CL_HELPER_PLUGIN_BASE` to something accurate (e.g. `DATACAT_API_BASE`).
  Update the comment to drop the cl-helper history now that step 1 already
  covers the "why" elsewhere, or trim it to one line.
- Propagate the rename through every consumer: `web/modules/providers/datacat/datacat-api.js`
  (~15 uses) and `web/modules/providers/saucepan/saucepan-api.js` (~15 uses,
  including the `checkClHelperAvailable()` function name and
  `SAUCEPAN_CDN_PROXY_BASE`).
- The gallery-thumb route naming: `web/archive-api.js:426-447` (the route match
  string `/api/plugins/cl-helper/gallery-thumb/` itself can likely stay as the
  *wire format*, since the userscript/other code may still request that exact
  path — check `web/library-sections/14-virtual-scrolling-system-renders-only-visible-card.js:805`,
  which builds that URL — but every internal name that isn't the literal wire
  path should be renamed: `web/index.html:1991-1994` ids
  (`settingsGridThumbClHelperFields`, `settingsGridThumbClHelperRow`,
  `settingsGridThumbClHelper`), the `gridThumbnailsClHelper` setting key
  (defaults in `05-settings-persistence-system-uses-sillytavern-s-ext.js:130`,
  usage in `23-utility-functions.js:113`), and the matching JS variable/function
  names throughout `06-settings-migrations.js` (search `ClHelper` case-sensitive
  in that file — ~15 sites: `gridThumbClHelperCheckbox`, `gridThumbClHelperRow`,
  `applyGridThumbsDisabledStates`, etc). Suggested new name: something like
  `gridThumbnailsHiRes` / `HI_RES_THUMB` reflecting what the toggle actually
  controls (high-resolution gallery thumbnails), not the plugin that used to
  serve them.
- If renaming a persisted setting key (`gridThumbnailsClHelper`), keep reading
  the old key as a fallback for one release so existing users' saved settings
  aren't silently reset — check how `06-settings-migrations.js` handles other
  historical setting renames and follow the same pattern.

## Step 3 — Delete the four broken gallery extractors

These are live-registered (`web/modules/module-loader.js:180-189`) but call the
untranslated `/plugins/cl-helper/...` path, which nothing serves standalone —
broken today, not worth porting.

1. Delete `web/modules/gallery-extractors/civitai.js` entirely.
2. Delete `web/modules/gallery-extractors/pixiv.js` entirely.
3. Delete `web/modules/gallery-extractors/dropbox.js` entirely.
4. `web/modules/gallery-extractors/imgchest.js` — **partial**: only the
   password-protected-post path needs cl-helper (`CL_HELPER_BASE` at line 25,
   the health-check + unlock calls around lines 74-79). Public-post extraction
   in the same file works without it. Trim the file to keep public-post
   extraction, drop the password path and its cl-helper calls, update the
   result/error messaging accordingly.
5. Remove the corresponding `import(...)` lines for civitai/pixiv/dropbox from
   `web/modules/module-loader.js:180-189`.
6. Delete the matching help/settings copy in `web/index.html`: lines 1514,
   1517, 1523 (extractor help text mentioning Imgchest/Pixiv/Civitai +
   cl-helper), 2322 (Civitai API key setting description), 2351 (Pixiv cookie
   setting description). Re-check line numbers before editing — earlier edits
   in this same pass will shift them.
7. Delete the Civitai/Pixiv settings UI wiring in
   `web/library-sections/06-settings-migrations.js` — search for
   `civitai-set-key`, `civitai-validate`, `civitai-clear-key`,
   `pixiv-set-cookie`, `pixiv-validate`, `pixiv-logout` and remove the
   surrounding handler blocks (roughly lines 2183-2328, but grep to confirm
   current extent) plus the DOM lookups feeding them and any now-orphaned
   settings keys (e.g. `civitaiApiKey`) in the settings defaults file if
   nothing else reads them.
8. Run `web/tests/*` (`cd web && node --test`) after this step — the extractor
   registry and archive-api tests may reference these modules.

## Step 4 — Delete the orphaned Botbooru login block

Confirmed dead two independent ways: `botbooru` is not a registered provider
(only `chub`/`datacat` are, per `module-loader.js:209-210`), and every DOM id
it queries is absent from `web/index.html` (checked: `botbooruLoginState`,
`botbooruUsernameInput`, `botbooruPasswordInput`, `validateBotbooruBtn`,
`toggleBotbooruPasswordBtn`, `botbooruFavTagsPills`, `botbooruFavTagsInput`,
`botbooruWeightedModeCheckbox`, `botbooruTagWeightsList`,
`botbooruTrackDownloadsCheckbox`, `botbooruShowNsflCheckbox`,
`botbooruTagWeightsInput`, `botbooruTagWeightsAddBtn` — zero matches). Every
guard on these lookups is a permanent no-op.

1. In `web/library-sections/06-settings-migrations.js`, delete every block
   referencing `botbooru`/`Botbooru` (grep case-insensitive in this file —
   scattered from roughly line 835 to 1924; confirm current extent, it is not
   one contiguous block).
2. Delete the associated setting defaults in
   `web/library-sections/05-settings-persistence-system-uses-sillytavern-s-ext.js:40-48`:
   `botbooruToken`, `botbooruUsername`, `botbooruPassword`,
   `botbooruTrackDownloads`, `botbooruMinTokens`, `botbooruNsfw`,
   `botbooruShowNsfl`, `botbooruNsfwAccountSynced`, `botbooruUseTagWeights` —
   confirmed via repo-wide grep that nothing outside this dead block reads
   them.
3. **Do not touch** unrelated `botbooru` references — these are the real
   card-provider-link field, unconnected to the login plugin:
   `web/index.html:1218-1219` (`botbooru:yes`/`bb:no` filter syntax),
   `web/library-sections/23-utility-functions.js:5` (`PROVIDER_EXT_KEYS`),
   `web/library-sections/20-advanced-filter.js:620`,
   `web/library-sections/35-character-duplicate-detection-system.js:957`,
   `web/library-sections/25-provider-link-feature.js:334`. These stay exactly
   as they are.

## Step 5 — Delete dead CSS

`web/library.css` lines 8163-8262 (16 rules), zero references anywhere in JS
or HTML — confirmed by repo-wide grep at audit time, re-confirm before
deleting:

```
.cl-helper-banner
.cl-helper-banner > i
.cl-helper-banner strong
.cl-helper-banner code
.cl-helper-banner.cl-helper-update
.cl-helper-banner-row
.cl-helper-banner.cl-helper-update .cl-helper-banner-row > i
.cl-helper-banner .cl-helper-update-actions
.cl-helper-status-check
.cl-helper-update-summary
.cl-helper-update-summary .cl-update-label
.cl-helper-update-summary code
.cl-helper-update-summary ul
.cl-helper-update-summary .cl-update-note
.cl-helper-fields-disabled
```

Delete the whole `/* cl-helper plugin dependency banner */` ... `/* Grey out
settings fields when plugin unavailable */` region (the comment right after
`.cl-helper-fields-disabled` belongs to the *next* CSS block, `.provider-order-list`
— don't delete past `.cl-helper-fields-disabled`'s closing brace).

## Step 6 — Stale UI copy

Covered by step 3.6 above (the help/settings text goes away with the
extractors it describes). No separate action needed — just confirm after step
3 that `grep -rn "cl-helper" web/index.html` only still shows the step-2
renamed-not-removed gallery-thumb ids (which step 2 will also clear).

## Verification

After all steps:

```
grep -ril "cl-helper\|cl_helper\|clhelper" . --exclude-dir=.git
```

should return **nothing** except this plan doc and the memory note referenced
above (both are historical records, fine to keep mentioning the old name).

Also run:
- `cd web && node --test` (JS test suite)
- Python test suite (`pytest` / whatever `make test` runs) — some Python
  comments touched in step 1 live near test files
- Manually load the app and open Settings → Media: confirm no Civitai/Pixiv/
  Botbooru UI remnants render, and the (renamed) high-res gallery thumbnail
  toggle still works.
