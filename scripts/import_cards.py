"""Bulk-import character-card PNGs into the cards archive.

Two kinds of already-embedded PNG export are recognised when dropped into
`./import`, both re-homed into the configured cards folder as
`<name>_<id>.png` -- the exact layout and naming the native retriever produces
(see JAI_PROXY_OUTPUT_DIR / JAI_PROXY_CARD_LAYOUT in .env.template) -- so a
landed card shows as acquired on the next scan (which keys off the `_<id>`
filename fragment):

  * datacat  -- a JanitorAI card pulled by the closed-source datacat retriever.
    It carries no lorebook, so it's rebuilt through the CardBuilder (macro
    sanitize, creator-notes cleanup) with a fresh datacat_import provenance
    block. See proxy/datacat_mapper.py.
  * JannyAI  -- a jannyai.com card export, structurally a twin of datacat
    (definition-only, no lorebook, macros intact), rebuilt the same way with a
    fresh jannyai_import provenance block. See proxy/jannyai_mapper.py.
  * Chub.ai  -- an already-complete chara_card_v3 (its own lorebook + rich
    extensions). It's passed through near-verbatim: macros sanitized,
    creator_notes tamed (layout kept, stylesheet dropped -- see
    proxy/notes_html.py), tags cleaned, everything else (the whole
    character_book, Chub's own extensions block) preserved as is -- plus a
    fresh `extensions.jai` provenance stamp layered on top, the same one every
    other source gets. See proxy/chub_mapper.py.

Both share the same tail: avatar normalize + pngquant compression, and a card
whose id already lives in the cards folder is skipped, never overwritten (the
one on disk may be a fuller retrieval -- e.g. a datacat import lacks the lorebook
a native pull would have). `--overwrite` reverses that for a deliberate re-import
-- after a pipeline change that alters how cards are built, re-dump the source
exports and re-run with it. The on-disk gallery_id still wins, and a card renamed
upstream has its old `<name>_<id8>.png` pruned so the overwrite can't fork.

`--fetch-datacat-images` (datacat only) turns on one extra, opt-in network
step: for each datacat card, ask datacat.run's own API (see
proxy/datacat_api.py) for the untouched original JanitorAI avatar URL, and
lead creator_notes with it -- mirroring what the native retriever already
does for its own avatar_url, so SillyTavern-CharacterLibrary's creator-notes
media scan picks up the full-resolution original as a gallery image even
though the embedded avatar here is cropped/compressed. Off by default so this
stays a pure offline batch otherwise; a card whose original can't be
recovered (gone from datacat's index, etc.) just imports without the link.

One field is the exception to never-touch: `extensions.gallery_id`, the handle a
card carries to its stored image gallery (see proxy/gallery.py). A legacy export
often has one an older on-disk card lacks, so when an import matches an existing
card (same name + id) the gallery_id is *backfilled* into that card in place --
pixels and every other field untouched -- rather than the import simply being
dropped. This lets galleries be assigned to characters without re-downloading
their avatars. An id already on the on-disk card always wins, so the backfill
only reaches cards written before the writer started stamping ids (or scanned by
scripts/backfill_gallery_ids.py). To adopt a legacy export's id over one of ours,
delete the on-disk card and re-run.

Offline batch -- it does not need the proxy server running.

    make import
    uv run python scripts/import_cards.py --import-dir import --cards-dir /some/where
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from proxy import chub_mapper, datacat_mapper, gallery, jannyai_mapper, pngtools
from proxy.cardbuilder import CardBuilder, PngWriter, id_fragment
from proxy.config import settings
from proxy.datacat_api import DatacatImageResolver
from proxy.macros import MacroSanitizer


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _datacat_extensions(data: dict, creator: str) -> dict:
    """Provenance mirroring the native /build extensions, but flagged
    `datacat_import` and carrying datacat's own block so it's always clear a
    card came in via import (and may therefore lack a lorebook). A source
    `gallery_id` is carried over so a fresh import keeps it (Chub passes its
    whole extensions block through, so it keeps gallery_id for free)."""
    extensions = {
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
    gid = gallery.read_id(data)
    if gid is not None:
        extensions["gallery_id"] = gid
    return extensions


def _import_datacat(
    builder: CardBuilder,
    writer: PngWriter,
    data: dict,
    raw: bytes,
    cid: str,
    image_resolver: DatacatImageResolver | None = None,
) -> tuple[Path, list[str]]:
    profile = datacat_mapper.to_profile_fields(data)
    greetings = datacat_mapper.greetings(data)
    avatar_url = image_resolver.resolve(cid) if image_resolver and cid else None
    card, warnings = builder.build(profile, greetings, capture=None, book=None, avatar_url=avatar_url)
    if image_resolver and cid and not avatar_url:
        warnings.append("datacat: original avatar not recovered (no link added)")
    card.character_version = datacat_mapper.source_url(data) or "jai-proxy"
    card.extensions = _datacat_extensions(data, profile.creator)
    out = writer.write(card, raw, card_id=cid or None)
    return out, warnings


def _jannyai_extensions(data: dict, creator: str) -> dict:
    """Provenance mirroring _datacat_extensions but flagged `jannyai_import` and
    carrying JannyAI's own block (so the "@handle", slug and tagline survive).
    A source `gallery_id` is carried over so a fresh import keeps it."""
    extensions = {
        "jai": {
            "source_url": jannyai_mapper.source_url(data),
            "id": jannyai_mapper.card_id(data) or None,
            "sourceKind": "jannyai_import",
            "creatorName": creator,
            "pageName": jannyai_mapper.page_name(data),
            "linkedAt": _utc_now_iso(),
        },
        "jannyai": jannyai_mapper.jannyai_block(data),
    }
    gid = gallery.read_id(data)
    if gid is not None:
        extensions["gallery_id"] = gid
    return extensions


def _import_jannyai(
    builder: CardBuilder, writer: PngWriter, data: dict, raw: bytes, cid: str
) -> tuple[Path, list[str]]:
    profile = jannyai_mapper.to_profile_fields(data)
    greetings = jannyai_mapper.greetings(data)
    card, warnings = builder.build(profile, greetings, capture=None, book=None)
    card.character_version = jannyai_mapper.source_url(data) or "jai-proxy"
    card.extensions = _jannyai_extensions(data, profile.creator)
    out = writer.write(card, raw, card_id=cid or None)
    return out, warnings


def _chub_extensions(data: dict) -> dict:
    """Chub's own extensions block (chub/depth_prompt/fav/gallery_id, ...)
    passed through untouched, plus a fresh `extensions.jai` provenance block
    layered on top -- the same stamp every other source gets (see
    _datacat_extensions/_jannyai_extensions), flagged `chub_import` so a
    Chub-imported card is linkable in SillyTavern-CharacterLibrary without a
    separate lookup."""
    extensions = dict(data.get("extensions") or {})
    extensions["jai"] = {
        "source_url": chub_mapper.source_url(data),
        "id": chub_mapper.card_id(data) or None,
        "sourceKind": "chub_import",
        "creatorName": chub_mapper.creator(data),
        "pageName": chub_mapper.page_name(data),
        "linkedAt": _utc_now_iso(),
    }
    return extensions


def _import_chub(
    writer: PngWriter, sanitizer: MacroSanitizer, data: dict, raw: bytes, cid: str
) -> tuple[Path, list[str]]:
    # A Chub card is already a full chara_card_v3 -- clean the text fields and
    # pass the rest (extensions, lorebook) straight through, then embed the raw
    # payload so nothing our card models don't carry gets dropped. An
    # extensions.jai stamp is layered on top of Chub's own extensions block.
    cleaned, warnings = chub_mapper.clean_card(data, sanitizer)
    cleaned["extensions"] = _chub_extensions(cleaned)
    out = writer.write_payload(
        chub_mapper.to_payload(cleaned),
        raw,
        creator=chub_mapper.creator(cleaned),
        name=chub_mapper.name(cleaned),
        card_id=cid or None,
    )
    return out, warnings


def _backfill_gallery_id(path: Path, gallery_id: Any) -> str:
    """Add `gallery_id` to the extensions of the card at `path`, rewriting the
    PNG in place (pixels preserved). Returns a status:
      'added'      -- the card carried no gallery_id; it now has this one
      'present'    -- it already had one; left untouched
      'unreadable' -- the PNG had no readable card; left untouched
    """
    raw = path.read_bytes()
    parsed = pngtools.read_envelope(raw)
    if parsed is None:
        return "unreadable"
    envelope, data = parsed
    if gallery.ensure_id(data, preferred=gallery_id) is None:
        return "present"
    path.write_bytes(pngtools.embed_card(raw, envelope, data))
    return "added"


def _source_name(source: str, data: dict) -> str:
    """The character name an import matches the on-disk filename on."""
    return chub_mapper.name(data) if source == "chub" else datacat_mapper.name(data)


def _adopt_on_disk_gallery_id(data: dict, card_id: str, cards_dir: Path) -> Any | None:
    """Pin an --overwrite re-import to the gallery_id already in the archive.

    Normal precedence is payload > on-disk (see cardbuilder._stamp_gallery_id),
    which is right for a first import. It is wrong for an overwrite: the gallery
    folder in SillyTavern-CharacterLibrary is keyed by the id the on-disk card
    carries, so adopting a re-dumped export's id instead would orphan every
    image already filed under the old one."""
    fragment = id_fragment(card_id)
    if not fragment:
        return None
    for path in sorted(cards_dir.glob(f"**/*_{fragment}.png")):
        card = pngtools.extract_embedded_card(path.read_bytes())
        gid = gallery.read_id(card) if card else None
        if gid is not None:
            data.setdefault("extensions", {})["gallery_id"] = gid
            return gid
    return None


def _stale_siblings(card_id: str, written: Path, cards_dir: Path) -> list[Path]:
    """Cards carrying this id fragment at some *other* path -- what an
    --overwrite re-import leaves behind when the character has been renamed
    upstream, since the filename is `<name>_<id8>.png` and only the id half is
    stable. Without this the "overwrite" would quietly fork into two cards."""
    fragment = id_fragment(card_id)
    if not fragment:
        return []
    return [p for p in cards_dir.glob(f"**/*_{fragment}.png") if p != written]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-dir", type=Path, default=Path("import"))
    parser.add_argument("--cards-dir", type=Path, default=settings.output_dir)
    parser.add_argument(
        "--no-compress",
        action="store_true",
        help="skip pngquant avatar compression (on by default, matching the server)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help=(
            "re-import cards whose id is already in the cards folder, replacing "
            "them (default: skip). Use after a pipeline change that alters how "
            "cards are built -- e.g. re-dumping Chub exports to pick up the "
            "creator-notes taming. The on-disk gallery_id is preserved"
        ),
    )
    parser.add_argument(
        "--fetch-datacat-images",
        action="store_true",
        help=(
            "for datacat imports, call datacat.run to recover the original avatar "
            "URL and lead creator_notes with it (off by default; the only network "
            "call this script makes -- see proxy/datacat_api.py)"
        ),
    )
    args = parser.parse_args()

    if not args.import_dir.is_dir():
        print(f"import dir not found: {args.import_dir}")
        return 1

    builder = CardBuilder()
    writer = PngWriter(output_dir=args.cards_dir, compress=not args.no_compress)
    sanitizer = MacroSanitizer(user_names=settings.user_names)
    image_resolver = DatacatImageResolver() if args.fetch_datacat_images else None

    # First pass: read + parse + classify every PNG (keeping the bytes for reuse
    # as the avatar), so a single existing() scan can pre-compute which ids are
    # already on disk before we write anything.
    pngs = sorted(p for p in args.import_dir.glob("*.png"))
    records: list[tuple[Path, bytes, str, dict, str]] = []
    skipped_unparsable = 0
    for path in pngs:
        raw = path.read_bytes()
        data = pngtools.extract_embedded_card(raw)
        if data is None:
            print(f"  skip  {path.name}: no embedded character card")
            skipped_unparsable += 1
            continue
        if chub_mapper.is_chub(data):
            records.append((path, raw, "chub", data, chub_mapper.card_id(data)))
        elif datacat_mapper.is_datacat(data):
            records.append((path, raw, "datacat", data, datacat_mapper.card_id(data)))
        elif jannyai_mapper.is_jannyai(data):
            records.append((path, raw, "jannyai", data, jannyai_mapper.card_id(data)))
        else:
            print(f"  skip  {path.name}: unrecognized card (not datacat, JannyAI or Chub)")
            skipped_unparsable += 1

    already = writer.existing([cid for *_, cid in records if cid])

    written = skipped_existing = errored = backfilled = pruned = 0
    seen_ids: set[str] = set()
    for path, raw, source, data, cid in records:
        if cid and cid in seen_ids:
            print(f"  skip  {path.name}: duplicate in this batch (id {cid})")
            skipped_existing += 1
            continue
        if cid and cid in already and not args.overwrite:
            # Never overwrite an existing (possibly fuller) card -- but a legacy
            # export may carry a gallery_id the on-disk card lacks. Backfill just
            # that one field into the matching card(s), everything else untouched.
            gid = gallery.read_id(data)
            targets = writer.find(_source_name(source, data), cid, args.cards_dir) if gid else []
            added = 0
            for target in targets:
                if _backfill_gallery_id(target, gid) == "added":
                    added += 1
                    print(
                        f"  patch {path.name}: +gallery_id {gid} -> "
                        f"{target.relative_to(args.cards_dir)}"
                    )
            if added:
                backfilled += added
            else:
                detail = "gallery_id already set" if gid and targets else "already in the cards folder"
                print(f"  skip  {path.name}: {detail} (id {cid})")
            skipped_existing += 1
            continue
        if args.overwrite and cid and cid in already:
            _adopt_on_disk_gallery_id(data, cid, args.cards_dir)
        try:
            if source == "chub":
                out, warnings = _import_chub(writer, sanitizer, data, raw, cid)
            elif source == "jannyai":
                out, warnings = _import_jannyai(builder, writer, data, raw, cid)
            else:
                out, warnings = _import_datacat(builder, writer, data, raw, cid, image_resolver)
        except Exception as exc:  # one bad PNG must not abort the batch
            print(f"  ERROR {path.name}: {exc}")
            errored += 1
            continue
        if cid:
            seen_ids.add(cid)
        suffix = f"  ({'; '.join(warnings)})" if warnings else ""
        print(f"  write {path.name} [{source}] -> {out.relative_to(args.cards_dir)}{suffix}")
        written += 1
        if args.overwrite and cid:
            for stale in _stale_siblings(cid, out, args.cards_dir):
                stale.unlink()
                print(f"  prune {stale.relative_to(args.cards_dir)} (renamed since last import)")
                pruned += 1

    if image_resolver:
        image_resolver.close()

    print(
        f"\nimported {written}, skipped {skipped_existing} existing "
        f"({backfilled} gallery_id backfilled), {skipped_unparsable} unrecognized, "
        f"{errored} errored (of {len(pngs)} PNGs in {args.import_dir})"
        + (f", pruned {pruned} renamed" if pruned else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
