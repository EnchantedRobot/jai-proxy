"""Bring the avatar thumbnail cache in step with the archive.

The cache came across at cutover from SillyTavern's `thumbnails/avatar` and
already covers 99.6% of the archive, so this is a tidy-up pass, not a build:

  missing   -- an indexed card with no thumb. Rendered here so the first browse
               of a fresh archive is not also the thing that generates them.
               (The API generates on miss too, so this is an optimization of
               first-paint, never a prerequisite.)
  stale     -- a thumb whose card is gone: renamed by `make names`, or deleted.
               840 of these at cutover, the residue of the archive's whole life.
  miscased  -- a thumb whose name differs from its card's only by case. macOS
               resolves it anyway, so it looks fine here and would silently miss
               in a Linux container -- costing a needless regeneration. Renamed
               to match the card while we can still see the pair.

    uv run python scripts/sync_thumbs.py              # read-only report
    uv run python scripts/sync_thumbs.py --apply      # generate, prune, rename

Stale thumbs are retired to `<thumbs>/_stale/` rather than deleted, so a wrong
call is a `mv` away from being undone. Same filesystem, so it is free. The whole
cache is disposable regardless -- deleting it costs one regeneration pass and no
data -- which is why this script is allowed to be blunt.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from proxy import archive, thumbs
from proxy.config import settings


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--archive-dir", type=Path, default=settings.archive_dir)
    parser.add_argument("--thumbs-dir", type=Path, default=settings.thumbs_dir)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually generate, rename and retire; without it nothing is written",
    )
    parser.add_argument(
        "--delete-stale",
        action="store_true",
        help="delete stale thumbs outright instead of retiring them to _stale/",
    )
    parser.add_argument("--limit", type=int, default=20, help="max names to list per section (0 = all)")
    args = parser.parse_args()

    if not args.archive_dir.is_dir():
        parser.error(f"archive dir does not exist: {args.archive_dir}")

    index = archive.ArchiveIndex(args.archive_dir)
    index.refresh(force=True)
    store = thumbs.ThumbnailStore(args.thumbs_dir, args.archive_dir)
    filenames = [r.filename for r in index.all()]

    missing = store.missing(filenames)
    stale = store.stale(filenames)

    # Split the miscased out of `stale` before pruning: by exact name they look
    # orphaned, but they are a usable thumb for a card that is still here.
    by_fold = {name.casefold(): name for name in filenames}
    miscased: list[tuple[Path, str]] = []
    for path in list(stale):
        card = by_fold.get(path.name.casefold())
        if card is not None:
            miscased.append((path, card))
            stale.remove(path)
    # A miscased thumb is a hit, not a miss -- don't render one we already have.
    renamed_targets = {card for _, card in miscased}
    missing = [name for name in missing if name not in renamed_targets]

    print(f"archive: {len(filenames)} cards in {args.archive_dir}")
    print(f"thumbs:  {args.thumbs_dir / 'avatar'}")
    _report("missing (to generate)", missing, args.limit)
    _report("miscased (to rename)", [f"{p.name} -> {card}" for p, card in miscased], args.limit)
    _report("stale (to retire)", [p.name for p in stale], args.limit)

    if not args.apply:
        print("\nread-only; pass --apply to write")
        return 0

    for path, card in miscased:
        # Two-step through a temporary name: on a case-insensitive filesystem a
        # direct rename between names differing only in case is a no-op or an
        # error depending on the platform.
        interim = path.with_name(path.name + ".casefix")
        path.replace(interim)
        interim.replace(path.with_name(card))
    print(f"renamed  {len(miscased)}")

    generated = failed = 0
    for name in missing:
        if store.generate_avatar(name) is None:
            failed += 1
        else:
            generated += 1
    print(f"generated {generated}" + (f", failed {failed}" if failed else ""))

    if args.delete_stale:
        for path in stale:
            path.unlink(missing_ok=True)
        print(f"deleted  {len(stale)} stale")
    else:
        retired = args.thumbs_dir / "_stale"
        retired.mkdir(parents=True, exist_ok=True)
        for path in stale:
            shutil.move(str(path), str(retired / path.name))
        print(f"retired  {len(stale)} stale -> {retired}")
    return 0


def _report(label: str, names: list[str], limit: int) -> None:
    print(f"\n{label}: {len(names)}")
    shown = names if limit == 0 else names[:limit]
    for name in shown:
        print(f"  {name}")
    if len(names) > len(shown):
        print(f"  ... and {len(names) - len(shown)} more")


if __name__ == "__main__":
    raise SystemExit(main())
