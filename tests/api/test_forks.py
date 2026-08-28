"""Forks -- docs/FORKS_AND_EXTRAS_PLAN.md §3.

Two primitives: `POST /characters/{id}/fork` (born here, a full copy the
caller rewrites) and `POST /characters` with `fork_of=` (adopted, a file that
already is a rewrite). Both share one invariant worth testing hardest:
lineage is flattened, not chained -- forking a fork produces a sibling of the
existing fork, and `fork.of` always names the root original.
"""

from __future__ import annotations

from proxy.cards import pngtools
from tests.conftest import card_png


def read_card(raw: bytes) -> dict:
    envelope = pngtools.read_envelope(raw)
    assert envelope is not None
    return envelope[1]


def post_import(client, png: bytes, name: str = "upload.png", **data):
    return client.post(
        "/api/v1/characters",
        files={"file": (name, png, "image/png")},
        data=data,
    )


# --- born here: POST /characters/{id}/fork ----------------------------------


def test_forking_mints_a_fresh_fragment_and_shares_the_gallery(client, archive_dirs):
    resp = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["id"] != "Abbie_0d162f5f.png"
    assert body["fragment"] != "0d162f5f"
    assert body["gallery_id"] == "kzbYR2QbpncC"  # the parent's, forced
    assert body["is_fork"] is True
    assert body["forked_from"] == {"id": "Abbie_0d162f5f.png", "name": "Abbie"}

    on_disk = read_card((archive_dirs["characters"] / body["id"]).read_bytes())
    fork = on_disk["extensions"]["fork"]
    assert fork["of"] == "0d162f5f"
    assert fork["of_filename"] == "Abbie_0d162f5f.png"
    assert on_disk["extensions"]["jai"]["sourceKind"] == "fork"
    # Attribution clones from the parent -- only the id and sourceKind change.
    assert on_disk["extensions"]["jai"]["creatorName"] == "KornyPony"
    # A fork starts as a full copy of the parent's text.
    assert on_disk["description"] == "Abbie is a test character."


def test_forking_twice_does_not_collide(client):
    first = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()
    second = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()
    assert first["id"] != second["id"]
    assert first["fragment"] != second["fragment"]


def test_forking_a_fork_produces_a_sibling_not_a_grandchild(client):
    """The flattening decision: fork.of always names the root, never an
    intermediate fork -- so a rewrite of a rewrite is a sibling of the first
    fork, not one level deeper."""
    child = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()
    grandchild = client.post(f"/api/v1/characters/{child['id']}/fork").json()

    assert grandchild["forked_from"] == {"id": "Abbie_0d162f5f.png", "name": "Abbie"}
    assert grandchild["forked_from"] != {"id": child["id"], "name": child["name"]}

    listing = client.get("/api/v1/characters?fork_of=0d162f5f&limit=0").json()
    ids = {item["id"] for item in listing["items"]}
    assert ids == {child["id"], grandchild["id"]}


def test_a_fork_survives_its_parent_being_deleted(client):
    fork = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()
    resp = client.delete("/api/v1/characters/Abbie_0d162f5f.png")
    assert resp.status_code == 200, resp.text

    detail = client.get(f"/api/v1/characters/{fork['id']}").json()
    assert detail["forked_from"] is None  # dangling, not an error
    assert detail["card"]["extensions"]["fork"]["of"] == "0d162f5f"


# --- adopted: POST /characters?fork_of= -------------------------------------


def test_adopting_a_file_as_a_fork_forces_the_parent_gallery_and_stamps_fork(client, archive_dirs):
    png = card_png("Abbie Rewrite", creator="someone else")
    resp = post_import(client, png, fork_of="0d162f5f", note="expanded dialogue")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    on_disk = read_card((archive_dirs["characters"] / body["id"]).read_bytes())
    assert on_disk["extensions"]["gallery_id"] == "kzbYR2QbpncC"
    fork = on_disk["extensions"]["fork"]
    assert fork["of"] == "0d162f5f"
    assert fork["of_filename"] == "Abbie_0d162f5f.png"
    assert fork["note"] == "expanded dialogue"


def test_adopting_the_same_forked_file_twice_dedupes(client):
    png = card_png("Abbie Rewrite", creator="someone else")
    first = post_import(client, png, fork_of="0d162f5f").json()
    second = post_import(client, png, fork_of="0d162f5f").json()
    assert second["duplicate"] is True
    assert second["id"] == first["id"]


def test_adopting_a_fork_of_a_fork_flattens_to_the_root(client):
    child = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()
    png = card_png("Adopted Grandchild", creator="someone else")
    resp = post_import(client, png, fork_of=child["fragment"])
    assert resp.status_code == 200, resp.text

    detail = client.get(f"/api/v1/characters/{resp.json()['id']}").json()
    assert detail["card"]["extensions"]["fork"]["of"] == "0d162f5f"


def test_fork_of_a_bogus_fragment_is_422(client):
    resp = post_import(client, card_png("Nobody"), fork_of="deadbeef")
    assert resp.status_code == 422


# --- filtering and the gallery claimants fix --------------------------------


def test_is_fork_filter(client):
    fork = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()

    forks_only = client.get("/api/v1/characters?is_fork=true&limit=0").json()
    assert {item["id"] for item in forks_only["items"]} == {fork["id"]}

    originals_only = client.get("/api/v1/characters?is_fork=false&limit=0").json()
    assert fork["id"] not in {item["id"] for item in originals_only["items"]}
    assert "Abbie_0d162f5f.png" in {item["id"] for item in originals_only["items"]}


def test_galleries_route_reports_every_claimant(client):
    fork = client.post("/api/v1/characters/Abbie_0d162f5f.png/fork").json()

    folders = client.get("/api/v1/galleries").json()
    abbie_folder = next(f for f in folders if f["folder"] == "Abbie_kzbYR2QbpncC")
    assert set(abbie_folder["card_ids"]) == {"Abbie_0d162f5f.png", fork["id"]}
