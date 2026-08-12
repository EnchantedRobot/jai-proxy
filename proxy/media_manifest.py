"""State for server-side media downloads (Phase 3C-1) -- docs/PHASE_3C_PLAN.md §3.

Two stores, deliberately separate:

**The per-gallery manifest** (`<gallery>/.media.json`) is what makes a
character's media state travel with its folder and survive a rename --
folders resolve by gallery id (`gallery.resolve_folder`), so the manifest
does too. A dotfile, so it is already excluded from every listing and scan
(`v1.py:list_gallery_files`, `gallery.py:_scan`). It records which source URL
became which local file (`files`), which URLs are permanently gone for *this*
gallery specifically (`dead`), and a short history of runs.

**The global dead-URL ledger** (`data/state/dead_urls.json`) is the
cross-character win: the same broken catbox link appears on dozens of cards,
so a URL confirmed dead once should never be re-fetched from any of them.
Ported from `web/modules/media-dedup.js`'s ledger half (`_ledger`,
`recordFailure`, `recordSuccess`, `isDead`, `deadReason`, the eviction rule)
-- same entry shape, same thresholds, same "delete on success" behaviour.
Unlike the JS version this one is never poisoned by our own missing `/proxy`
route (docs/PHASE_3C_PLAN.md §1): the writer that fills it in only ever sees
real fetch outcomes. Per §6/§9 the two old localStorage blobs are discarded,
not migrated, when this lands.

Both stores are written atomically via `cardwrite.write_atomic` -- a reader
mid-write (the browser polling `GET .../media` while a run is in flight)
must never see a truncated JSON file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from proxy import cardwrite
from proxy.config import settings

MANIFEST_NAME = ".media.json"
_MANIFEST_VERSION = 1

# Verbatim MAX_TRANSIENT_ATTEMPTS / MAX_LEDGER_ENTRIES (media-dedup.js:42,46).
MAX_TRANSIENT_ATTEMPTS = 4
MAX_LEDGER_ENTRIES = 5000
_LEDGER_VERSION = 1


# --------------------------------------------------------------------------
# Per-gallery manifest
# --------------------------------------------------------------------------


def manifest_path(gallery_dir: Path) -> Path:
    return gallery_dir / MANIFEST_NAME


def load_manifest(gallery_dir: Path) -> dict[str, Any]:
    """The manifest for one gallery folder, or a fresh skeleton if there is
    none yet or it can't be parsed -- a corrupt manifest must not block new
    downloads, only lose its own history."""
    path = manifest_path(gallery_dir)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return _empty_manifest()
    try:
        data = json.loads(raw)
    except ValueError:
        return _empty_manifest()
    if not isinstance(data, dict):
        return _empty_manifest()
    data.setdefault("version", _MANIFEST_VERSION)
    data.setdefault("files", {})
    data.setdefault("dead", {})
    data.setdefault("runs", [])
    if not isinstance(data["files"], dict):
        data["files"] = {}
    if not isinstance(data["dead"], dict):
        data["dead"] = {}
    if not isinstance(data["runs"], list):
        data["runs"] = []
    return data


def empty_manifest() -> dict[str, Any]:
    """A fresh, unsaved manifest -- for a card that has no gallery folder yet
    (never had media downloaded) rather than one whose `.media.json` is
    merely missing or corrupt."""
    return _empty_manifest()


def _empty_manifest() -> dict[str, Any]:
    return {"version": _MANIFEST_VERSION, "updated": None, "files": {}, "dead": {}, "runs": []}


def save_manifest(gallery_dir: Path, manifest: dict[str, Any]) -> None:
    manifest["updated"] = _now_iso()
    payload = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
    cardwrite.write_atomic(manifest_path(gallery_dir), payload)


def record_saved(
    manifest: dict[str, Any], url: str, file_name: str, sha256: str, *, size: int | None = None
) -> None:
    entry: dict[str, Any] = {"file": file_name, "sha256": sha256, "at": _now_iso()}
    if size is not None:
        entry["size"] = size
    manifest["files"][url] = entry
    manifest["dead"].pop(url, None)


def record_dead(manifest: dict[str, Any], url: str, reason: str, *, attempts: int = 1) -> None:
    manifest["dead"][url] = {"reason": reason, "attempts": attempts, "at": _now_iso()}


def append_run(manifest: dict[str, Any], run: dict[str, Any]) -> None:
    manifest["runs"].append(run)
    # Bounded the same way the ledger is -- a long-lived gallery shouldn't grow
    # its manifest without limit; only the recent history is ever read.
    if len(manifest["runs"]) > 200:
        manifest["runs"] = manifest["runs"][-200:]


# --------------------------------------------------------------------------
# Global dead-URL ledger
# --------------------------------------------------------------------------


def load_dead_ledger() -> dict[str, Any]:
    """`{url: {n, f, l, p, s, e}}`, same short-key entry shape as the JS
    ledger it replaces (media-dedup.js "Entry shape" comment): attempt count,
    first-seen, last-attempt, permanent flag, last HTTP status, last error
    text."""
    try:
        raw = settings.dead_urls_file.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict) or data.get("version") != _LEDGER_VERSION:
        return {}
    urls = data.get("urls")
    return urls if isinstance(urls, dict) else {}


def save_dead_ledger(ledger: dict[str, Any]) -> None:
    _evict_if_needed(ledger)
    payload = json.dumps({"version": _LEDGER_VERSION, "urls": ledger}, ensure_ascii=False).encode("utf-8")
    cardwrite.write_atomic(settings.dead_urls_file, payload)


def _evict_if_needed(ledger: dict[str, Any]) -> None:
    """Port of `evictIfNeeded` (media-dedup.js:374-379): drop the
    least-recently-touched entries once the ledger grows past the cap."""
    if len(ledger) <= MAX_LEDGER_ENTRIES:
        return
    ordered = sorted(ledger.items(), key=lambda kv: kv[1].get("l", 0))
    drop = len(ledger) - MAX_LEDGER_ENTRIES
    for url, _ in ordered[:drop]:
        del ledger[url]


def is_dead(ledger: dict[str, Any], url: str) -> bool:
    """Port of `isDead` (media-dedup.js:413-417)."""
    entry = ledger.get(url)
    if not entry:
        return False
    return bool(entry.get("p") == 1 or entry.get("n", 0) >= MAX_TRANSIENT_ATTEMPTS)


def dead_reason(ledger: dict[str, Any], url: str) -> str:
    """Port of `deadReason` (media-dedup.js:420-425)."""
    entry = ledger.get(url)
    if not entry:
        return ""
    if entry.get("p") == 1:
        status = entry.get("s")
        return f"HTTP {status}" if status else (entry.get("e") or "permanently unavailable")
    return f"failed {entry.get('n', 0)} times ({entry.get('e') or 'unknown'})"


def record_failure(
    ledger: dict[str, Any], url: str, *, permanent: bool, status: int | None, message: str
) -> dict[str, Any]:
    """Port of `recordFailure` (media-dedup.js:433-448). Returns
    `{dead, permanent, attempts}` -- `dead` is what the caller checks to
    decide whether this run's classification of the URL just became final."""
    now = time.time()
    entry = ledger.get(url) or {"n": 0, "f": now}
    entry["n"] = entry.get("n", 0) + 1
    entry["l"] = now
    entry["s"] = status
    entry["e"] = str(message or "")[:200]
    if permanent:
        entry["p"] = 1
    ledger[url] = entry

    is_permanent = entry.get("p") == 1
    return {
        "dead": is_permanent or entry["n"] >= MAX_TRANSIENT_ATTEMPTS,
        "permanent": is_permanent,
        "attempts": entry["n"],
    }


def record_success(ledger: dict[str, Any], url: str) -> None:
    """Port of `recordSuccess` (media-dedup.js:451-454): a URL that works
    again drops out of the ledger rather than accumulating a clean history."""
    ledger.pop(url, None)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# Kept as an alias for the module's own internal callers written before this
# was made public.
_now_iso = now_iso
