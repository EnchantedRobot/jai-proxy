# Phase 3C Step 0 fixtures

Captured 2026-08-11 against a live `uv run python -m proxy.server` (port 8000),
character `Cassandra_3731042.png` (gallery `Cassandra_VsYXtiQoMFco`, 0 local
files, 20 embedded `files.catbox.moe` URLs in its greetings/description) —
chosen because its gallery folder was empty, so "Download Media" was forced to
actually attempt every URL instead of short-circuiting on a filename match.

Confirms docs/PHASE_3C_PLAN.md §1 end to end:

- `cassandra_proxy_404s.log` — the browser's `GET /proxy/<url>` calls and their
  `404` responses (20 requests, 20 404s; the app has no such route).
- `cassandra_download_media_result.png` — the modal after the run: "20
  existed" / "✓ 20 already exist" even though nothing was ever fetched
  successfully.
- `cassandra_localstorage_poisoned.json` — the two contaminated blobs after
  the run:
  - `_cl_media_loc_completed.json` lists `Cassandra_3731042.png` as complete.
  - `_cl_media_dead_urls.json` records every URL with `"s":404,
    "e":"Proxy HTTP 404","p":1` (permanent) on attempt one.

Per §6/§9 these two blobs are discarded, not migrated, when 3C-1 lands.

Side finding, not part of §1: the URL keys in the dead-ledger JSON are
several catbox links concatenated into one string
(`files.catbox.moe/2og42i.jpg),(...`). That's the client's embedded-media
regex swallowing adjacent markdown image refs on this specific card's prose,
independent of the proxy bug — noted here in case it resurfaces once real
fetches start happening, not something 3C-1 needs to fix.
