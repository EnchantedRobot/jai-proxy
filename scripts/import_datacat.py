"""Bulk-import datacat character-card PNGs into the cards archive.

datacat exports embed a full JanitorAI character card (chara_card_v3) in the
PNG's `ccv3`/`chara` tEXt chunks. Grabbing a bucket of those is faster than the
send-a-chat-then-capture flow, so this re-homes each one into
`cards/<creator>/<name>_<id8>.png` -- the exact layout and naming the native
retriever produces -- running the same MacroSanitizer, creator-notes de-HTML,
avatar normalize, and pngquant compression. Once landed, a card shows as
acquired on the next JanitorAI scan (the scan keys off the `_<id8>` fragment).

A card whose id already lives in `cards/` is skipped, never overwritten: the
one on disk may be a full retrieval that includes the lorebook datacat doesn't
capture. To replace one, delete the existing file and re-run.

Offline batch -- it does not need the proxy server running.

    make import
    uv run python scripts/import_datacat.py --import-dir import --cards-dir cards
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from proxy import datacat_mapper
from proxy.cardbuilder import CardBuilder, PngWriter
from proxy.config import settings


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _build_extensions(data: dict, creator: str) -> dict:
    """Provenance mirroring the native /build extensions, but flagged
    `datacat_import` and carrying datacat's own block so it's always clear a
    card came in via import (and may therefore lack a lorebook)."""
    return {
        "jai": {
            "source_url": datacat_mapper.source_url(data),
            "id": datacat_mapper.card_id(data) or None,
            "sourceKind": "datacat_import",
            "creatorName": creator,
            "pageName": datacat_mapper.page_name(data),
            "linkedAt": _utc_now_iso(),
        },
        "datacat": datacat_mapper.datacat_block(data),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-dir", type=Path, default=Path("import"))
    parser.add_argument("--cards-dir", type=Path, default=settings.output_dir)
    parser.add_argument(
        "--no-compress",
        action="store_true",
        help="skip pngquant avatar compression (on by default, matching the server)",
    )
    args = parser.parse_args()

    if not args.import_dir.is_dir():
        print(f"import dir not found: {args.import_dir}")
        return 1

    builder = CardBuilder()
    writer = PngWriter(output_dir=args.cards_dir, compress=not args.no_compress)

    # First pass: read + parse every PNG (keeping the bytes for reuse as the
    # avatar), so a single existing() scan can pre-compute which ids are already
    # on disk before we write anything.
    pngs = sorted(p for p in args.import_dir.glob("*.png"))
    records: list[tuple[Path, bytes, dict, str]] = []
    skipped_unparsable = 0
    for path in pngs:
        raw = path.read_bytes()
        data = datacat_mapper.extract_card(raw)
        if data is None or not datacat_mapper.is_datacat(data):
            print(f"  skip  {path.name}: not a datacat card")
            skipped_unparsable += 1
            continue
        records.append((path, raw, data, datacat_mapper.card_id(data)))

    already = writer.existing([cid for _, _, _, cid in records if cid])

    written = skipped_existing = errored = 0
    seen_ids: set[str] = set()
    for path, raw, data, cid in records:
        if cid and (cid in already or cid in seen_ids):
            print(f"  skip  {path.name}: already in cards/ (id {cid[:8]})")
            skipped_existing += 1
            continue
        try:
            profile = datacat_mapper.to_profile_fields(data)
            greetings = datacat_mapper.greetings(data)
            card, warnings = builder.build(profile, greetings, capture=None, book=None)
            card.character_version = datacat_mapper.source_url(data) or "jai-proxy"
            card.extensions = _build_extensions(data, profile.creator)
            out = writer.write(card, raw, card_id=cid or None)
        except Exception as exc:  # one bad PNG must not abort the batch
            print(f"  ERROR {path.name}: {exc}")
            errored += 1
            continue
        if cid:
            seen_ids.add(cid)
        suffix = f"  ({'; '.join(warnings)})" if warnings else ""
        print(f"  write {path.name} -> {out.relative_to(args.cards_dir)}{suffix}")
        written += 1

    print(
        f"\nimported {written}, skipped {skipped_existing} existing, "
        f"{skipped_unparsable} non-datacat, {errored} errored "
        f"(of {len(pngs)} PNGs in {args.import_dir})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
