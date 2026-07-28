"""gallery_id generation and the read/ensure accessors -- the id
SillyTavern-CharacterLibrary keys a character's image gallery on.

The format is a contract with *their* code (12 chars from a 62-char alphanumeric
alphabet, in `data.extensions.gallery_id`), so it's pinned here. The other half
of the contract is that an existing id is never regenerated -- it's the link to a
gallery folder that may already hold images.
"""

import string

from proxy import gallery

# ---------------------------------------------------------------------------
# generate_id -- CharacterLibrary's generateGalleryId, in Python
# ---------------------------------------------------------------------------


def test_generated_id_is_twelve_alphanumeric_chars():
    allowed = set(string.ascii_letters + string.digits)
    for _ in range(200):
        gid = gallery.generate_id()
        assert len(gid) == 12
        assert set(gid) <= allowed


def test_generated_ids_are_distinct():
    # Not a randomness test -- just that we're not handing every card the same
    # id (which would collapse every same-named character into one gallery).
    assert len({gallery.generate_id() for _ in range(500)}) == 500


# ---------------------------------------------------------------------------
# read_id
# ---------------------------------------------------------------------------


def test_read_id_present_absent_and_empty():
    assert gallery.read_id({"extensions": {"gallery_id": "f1AMBFO5oPUr"}}) == "f1AMBFO5oPUr"
    assert gallery.read_id({"extensions": {"chub": {"id": 1}}}) is None
    assert gallery.read_id({}) is None
    assert gallery.read_id({"extensions": {"gallery_id": ""}}) is None
    assert gallery.read_id({"extensions": None}) is None


# ---------------------------------------------------------------------------
# ensure_id -- mutates in place, returns the assigned id (None == unchanged)
# ---------------------------------------------------------------------------


def test_ensure_id_stamps_a_fresh_id_and_returns_it():
    data = {"name": "Lyra", "extensions": {"jai": {"id": "abc"}}}
    gid = gallery.ensure_id(data)

    assert gid is not None and len(gid) == 12
    assert data["extensions"]["gallery_id"] == gid
    assert data["extensions"]["jai"] == {"id": "abc"}  # siblings untouched


def test_ensure_id_leaves_an_existing_id_alone():
    data = {"extensions": {"gallery_id": "ORIGINAL0000"}}
    assert gallery.ensure_id(data) is None
    assert gallery.ensure_id(data, preferred="NEWER0000000") is None
    assert data["extensions"]["gallery_id"] == "ORIGINAL0000"


def test_ensure_id_adopts_the_preferred_id_when_given():
    data = {"extensions": {}}
    assert gallery.ensure_id(data, preferred="CARRIEDOVER1") == "CARRIEDOVER1"
    assert data["extensions"]["gallery_id"] == "CARRIEDOVER1"


def test_ensure_id_falls_back_to_a_fresh_id_for_an_empty_preferred():
    data = {}
    gid = gallery.ensure_id(data, preferred="")
    assert gid is not None and len(gid) == 12
    assert data["extensions"]["gallery_id"] == gid


def test_ensure_id_creates_extensions_when_missing_or_not_a_dict():
    for data in ({}, {"extensions": None}, {"extensions": "junk"}):
        gid = gallery.ensure_id(data)
        assert data["extensions"]["gallery_id"] == gid
