"""`proxy/media/status.py` -- the one definition of "this card's media is
complete", shared by `GET /media/status`, the `needs_media` browse chip, and
bulk localize's skip list (docs/UI_REWRITE_PLAN.md Stage 6B).

The sweep is read-only, which is the property most worth pinning: it runs over
every card in the archive, so anything it writes it writes 3,868 times.
"""

from __future__ import annotations

from proxy.archive import catalog
from proxy.config import settings
from proxy.media import manifest as media_manifest, status as media_status


def _index():
    idx = catalog.ArchiveIndex(settings.archive_dir)
    idx.refresh()
    return idx


def _manifest(gallery_dir, *, errors: int = 0, dead: int = 0) -> None:
    manifest = media_manifest.empty_manifest()
    media_manifest.record_saved(manifest, "https://cdn.example.com/ok.png", "localized_media_0_ok.webp", "abc")
    for n in range(dead):
        media_manifest.record_dead(manifest, f"https://cdn.example.com/gone{n}.png", "404")
    media_manifest.append_run(
        manifest, {"at": media_manifest.now_iso(), "saved": 1, "skipped": 0, "errors": errors}
    )
    media_manifest.save_manifest(gallery_dir, manifest)


def test_card_with_no_manifest_is_absent_not_incomplete(populated_archive):
    # "Never had a media run" is not the same as "has no media", and the map
    # must not pretend to answer the second question.
    assert media_status.card_status_map(_index()) == {}


def test_a_clean_run_reads_as_complete(populated_archive):
    _manifest(populated_archive["galleries"] / "Abbie_kzbYR2QbpncC")

    entry = media_status.card_status_map(_index())["Abbie_0d162f5f.png"]

    assert entry.complete is True
    assert entry.files == 1
    assert entry.dead == 0
    assert entry.last_run is not None


def test_a_run_with_errors_reads_as_incomplete(populated_archive):
    _manifest(populated_archive["galleries"] / "Abbie_kzbYR2QbpncC", errors=2)

    assert media_status.card_status_map(_index())["Abbie_0d162f5f.png"].complete is False


def test_dead_urls_are_counted_without_making_the_run_incomplete(populated_archive):
    # A permanently-gone URL is a finished answer, not an unfinished run.
    _manifest(populated_archive["galleries"] / "Abbie_kzbYR2QbpncC", dead=3)

    entry = media_status.card_status_map(_index())["Abbie_0d162f5f.png"]

    assert entry.dead == 3
    assert entry.complete is True


def test_the_sweep_creates_nothing(populated_archive):
    """The property that matters at 3,868 cards: no gallery folder is minted
    for a card that does not have one, and no card gets rewritten."""
    galleries = populated_archive["galleries"]
    before_dirs = {p.name for p in galleries.iterdir()}
    characters = populated_archive["characters"]
    before_bytes = {p.name: p.read_bytes() for p in characters.glob("*.png")}

    media_status.card_status_map(_index())

    assert {p.name for p in galleries.iterdir()} == before_dirs
    assert {p.name: p.read_bytes() for p in characters.glob("*.png")} == before_bytes


def test_gallery_dir_if_present_returns_none_rather_than_creating(populated_archive):
    idx = _index()
    cleo = next(r for r in idx.cards() if r.name == "Cleo")

    # Cleo carries a gallery_id but has no folder on disk -- the common real
    # case, and the one where a "resolve" that creates would do damage.
    assert media_status.gallery_dir_if_present(cleo) is None
    assert not (populated_archive["galleries"] / "Cleo_CCCCCCCCCCCC").exists()
