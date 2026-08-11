"""`/api/v1` -- the archive's own contract.

These tests assert the contract's *shape*, not just its status codes, because the
frontend's `core-api.js` is written against it and a silently renamed field is a
broken browse grid.
"""

from __future__ import annotations

from tests.conftest import card_png, jai_extensions


def _names(payload) -> list[str]:
    return [item["name"] for item in payload["items"]]


# --- list -------------------------------------------------------------------


def test_lists_every_card_sorted_by_name(client):
    payload = client.get("/api/v1/characters").json()
    assert payload["total"] == 3
    assert _names(payload) == ["Abbie", "Bella", "Cleo"]


def test_card_shape_is_the_contract(client):
    item = client.get("/api/v1/characters?q=abbie").json()["items"][0]
    assert item == {
        "id": "Abbie_0d162f5f.png",
        "name": "Abbie",
        "creator": "KornyPony",
        "page_name": "A Test Page | Test",
        "tags": ["Female", "Vampire"],
        "source_kind": "janitor_core",
        "source_url": "https://janitorai.com/characters/0d162f5f-86ab-4fdd-a2c2-3912adf24960",
        "card_id": "0d162f5f-86ab-4fdd-a2c2-3912adf24960",
        "fragment": "0d162f5f",
        "gallery_id": "kzbYR2QbpncC",
        "character_version": "1",
        "greetings": 1,
        "lore_entries": 2,
        "description_chars": len("Abbie is a test character."),
        "has_creator_notes": False,
        "has_example_dialogue": False,
        "size": item["size"],
        "modified": item["modified"],
        "thumb_url": "/api/v1/characters/Abbie_0d162f5f.png/thumb",
        "png_url": "/api/v1/characters/Abbie_0d162f5f.png/png",
        "error": None,
    }


def test_urls_on_the_card_are_usable_as_given(client):
    """The client must never have to build a path by encoding an id itself."""
    item = client.get("/api/v1/characters?q=abbie").json()["items"][0]
    assert client.get(item["png_url"]).status_code == 200
    assert client.get(item["thumb_url"]).status_code == 200


def test_search_ands_its_terms(client):
    """A second word narrows. "korny abbie" is the one card, not every card by
    either."""
    assert _names(client.get("/api/v1/characters?q=korny+abbie").json()) == ["Abbie"]
    assert _names(client.get("/api/v1/characters?q=korny").json()) == ["Abbie", "Cleo"]
    assert client.get("/api/v1/characters?q=korny+nonexistent").json()["total"] == 0


def test_search_is_case_insensitive_and_covers_the_page_title(client):
    assert _names(client.get("/api/v1/characters?q=BELLA+THE+SECOND").json()) == ["Bella"]


def test_search_does_not_reach_into_prose(client):
    """Descriptions are not indexed -- 40 MB resident for a feature nobody asked
    for. Documented behaviour, so it is asserted."""
    assert client.get("/api/v1/characters?q=test+character").json()["total"] == 0


def test_tag_filter_requires_every_tag(client):
    assert _names(client.get("/api/v1/characters?tag=Female").json()) == ["Abbie", "Cleo"]
    assert _names(client.get("/api/v1/characters?tag=Female&tag=Vampire").json()) == ["Abbie"]
    assert client.get("/api/v1/characters?tag=Female&tag=Male").json()["total"] == 0


def test_tag_filter_is_case_insensitive(client):
    assert _names(client.get("/api/v1/characters?tag=female").json()) == ["Abbie", "Cleo"]


def test_creator_and_source_filters(client):
    assert _names(client.get("/api/v1/characters?creator=kornypony").json()) == ["Abbie", "Cleo"]
    assert _names(client.get("/api/v1/characters?source=chub_import").json()) == ["Bella"]


def test_has_lorebook_filter(client):
    assert _names(client.get("/api/v1/characters?has_lorebook=true").json()) == ["Abbie"]
    assert _names(client.get("/api/v1/characters?has_lorebook=false").json()) == ["Bella", "Cleo"]


def test_sort_and_reverse(client):
    assert _names(client.get("/api/v1/characters?sort=-name").json()) == ["Cleo", "Bella", "Abbie"]
    assert _names(client.get("/api/v1/characters?sort=-greetings").json())[0] == "Bella"
    assert _names(client.get("/api/v1/characters?sort=-lore").json())[0] == "Abbie"


def test_unknown_sort_is_a_422_that_says_what_is_allowed(client):
    response = client.get("/api/v1/characters?sort=drop+table")
    assert response.status_code == 422
    assert "greetings" in response.json()["detail"]


def test_pagination_reports_the_filtered_total(client):
    payload = client.get("/api/v1/characters?limit=2&offset=1").json()
    assert payload["total"] == 3, "total is the filtered set, not the page"
    assert _names(payload) == ["Bella", "Cleo"]
    assert (payload["limit"], payload["offset"]) == (2, 1)


def test_limit_zero_means_everything(client):
    payload = client.get("/api/v1/characters?limit=0").json()
    assert len(payload["items"]) == 3


def test_offset_past_the_end_is_an_empty_page_not_an_error(client):
    payload = client.get("/api/v1/characters?offset=999").json()
    assert payload["items"] == []
    assert payload["total"] == 3


def test_health_filter_surfaces_broken_cards(client, populated_archive):
    (populated_archive["characters"] / "Broken_1.png").write_bytes(b"not a png")
    client.post("/api/v1/refresh")

    assert client.get("/api/v1/characters").json()["total"] == 3, "broken cards are out by default"

    broken = client.get("/api/v1/characters?health=broken").json()
    assert broken["total"] == 1
    item = broken["items"][0]
    assert item["id"] == "Broken_1.png"
    assert item["error"] == "not a PNG stream"
    assert item["name"] == ""

    assert client.get("/api/v1/characters?health=all").json()["total"] == 4


# --- facets, stats, refresh -------------------------------------------------


def test_facets_count_over_the_whole_archive(client):
    facets = client.get("/api/v1/facets").json()
    assert facets["tags"] == [
        {"value": "Female", "count": 2},
        {"value": "Male", "count": 1},
        {"value": "Vampire", "count": 1},
    ]
    assert facets["creators"][0] == {"value": "KornyPony", "count": 2}
    assert {f["value"] for f in facets["sources"]} == {"janitor_core", "chub_import"}


def test_facets_can_be_capped(client):
    facets = client.get("/api/v1/facets?limit=1").json()
    assert facets["tags"] == [{"value": "Female", "count": 2}]


def test_stats(client):
    stats = client.get("/api/v1/stats").json()
    assert stats["cards"] == 3
    assert stats["unreadable"] == 0
    assert stats["creators"] == 2
    assert stats["tags"] == 3
    assert stats["galleries"] == 1, "only Abbie's gallery folder exists on disk"
    assert stats["bytes"] > 0
    assert stats["thumbs"] == {"cached": 0, "missing": 3, "stale": 0}


def test_stats_tracks_thumb_coverage_as_it_is_generated(client):
    client.get("/api/v1/characters/Abbie_0d162f5f.png/thumb")
    assert client.get("/api/v1/stats").json()["thumbs"]["cached"] == 1


def test_refresh_reads_back_a_write_immediately(client, populated_archive):
    """The debounce must never make a client unable to see its own write."""
    client.get("/api/v1/characters")  # build the index, so `parsed` means the new card
    (populated_archive["characters"] / "Dana_55556666.png").write_bytes(card_png("Dana"))
    stats = client.post("/api/v1/refresh").json()
    assert stats["parsed"] == 1
    assert "Dana" in _names(client.get("/api/v1/characters").json())


# --- detail -----------------------------------------------------------------


def test_detail_returns_the_whole_embedded_card(client):
    payload = client.get("/api/v1/characters/Abbie_0d162f5f.png").json()
    assert payload["spec"] == "chara_card_v3"
    assert payload["spec_version"] == "3.0"
    assert payload["name"] == "Abbie"
    # Verbatim, straight off the PNG -- prose the list omits, and every extension
    # block, unrewritten.
    assert payload["card"]["description"] == "Abbie is a test character."
    assert payload["card"]["first_mes"] == "Hello, I am Abbie."
    assert payload["card"]["extensions"]["jai"]["sourceKind"] == "janitor_core"
    assert len(payload["card"]["character_book"]["entries"]) == 2


def test_detail_measures_the_gallery_on_disk(client):
    payload = client.get("/api/v1/characters/Abbie_0d162f5f.png").json()
    assert payload["gallery"] == {
        "gallery_id": "kzbYR2QbpncC",
        "folder": "Abbie_kzbYR2QbpncC",
        "exists": True,
        "images": 2,
        "bytes": 306,
    }


def test_gallery_folder_missing_is_reported_not_invented(client):
    """The common real case: a card carries a gallery_id but its images were never
    downloaded. `exists: false` with the folder name still filled in."""
    payload = client.get("/api/v1/characters/Cleo_33334444.png").json()
    assert payload["gallery"]["folder"] == "Cleo_CCCCCCCCCCCC"
    assert payload["gallery"]["exists"] is False
    assert payload["gallery"]["images"] == 0


def test_detail_of_a_broken_card_is_a_422_with_a_reason(client, populated_archive):
    (populated_archive["characters"] / "Broken_1.png").write_bytes(b"not a png")
    client.post("/api/v1/refresh")
    response = client.get("/api/v1/characters/Broken_1.png")
    assert response.status_code == 422
    assert "not a PNG" in response.json()["detail"]


def test_unknown_card_is_a_404_naming_it(client):
    response = client.get("/api/v1/characters/Nope.png")
    assert response.status_code == 404
    assert "Nope.png" in response.json()["detail"]


def test_traversal_cannot_name_a_file(client):
    """The path is resolved through the index, so `..` matches no card."""
    for attempt in ("..%2F..%2Fetc%2Fpasswd", "....%2F%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd"):
        assert client.get(f"/api/v1/characters/{attempt}").status_code == 404


# --- bytes out --------------------------------------------------------------


def test_png_is_the_card_byte_for_byte(client, populated_archive):
    """No re-encoding anywhere in the path -- re-encoding is what strips the V3
    tEXt chunks, which is the whole reason the export works at all."""
    on_disk = (populated_archive["characters"] / "Abbie_0d162f5f.png").read_bytes()
    response = client.get("/api/v1/characters/Abbie_0d162f5f.png/png")
    assert response.status_code == 200
    assert response.content == on_disk
    assert response.headers["content-type"] == "image/png"


def test_png_is_offered_as_a_download_under_its_own_name(client):
    disposition = client.get("/api/v1/characters/Abbie_0d162f5f.png/png").headers[
        "content-disposition"
    ]
    assert disposition.startswith("attachment;")
    assert 'filename="Abbie_0d162f5f.png"' in disposition
    assert "filename*=UTF-8''Abbie_0d162f5f.png" in disposition


def test_download_name_survives_non_ascii(client, populated_archive):
    (populated_archive["characters"] / "Amélie_1.png").write_bytes(card_png("Amélie"))
    client.post("/api/v1/refresh")
    disposition = client.get("/api/v1/characters/Amélie_1.png/png").headers["content-disposition"]
    # An ASCII fallback for old clients, and the real name in the RFC 6266 form.
    assert 'filename="Am?lie_1.png"' in disposition
    assert "filename*=UTF-8''Am%C3%A9lie_1.png" in disposition


def test_thumb_is_generated_and_served_as_jpeg(client, populated_archive):
    response = client.get("/api/v1/characters/Abbie_0d162f5f.png/thumb")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "public, max-age=86400"
    card_bytes = (populated_archive["characters"] / "Abbie_0d162f5f.png").stat().st_size
    assert len(response.content) < card_bytes


def test_thumb_falls_back_to_the_full_png_when_it_cannot_be_rendered(client, populated_archive):
    """A card too broken to thumbnail still has to appear in the grid -- being
    visible is how it gets noticed and fixed."""
    (populated_archive["characters"] / "Broken_1.png").write_bytes(b"not a png")
    client.post("/api/v1/refresh")
    response = client.get("/api/v1/characters/Broken_1.png/thumb")
    assert response.status_code == 200
    assert response.content == b"not a png"


def test_conditional_get_answers_304_with_no_body(client):
    """A grid re-asks for hundreds of thumbs on every navigation."""
    first = client.get("/api/v1/characters/Abbie_0d162f5f.png/thumb")
    etag = first.headers["etag"]
    again = client.get(
        "/api/v1/characters/Abbie_0d162f5f.png/thumb", headers={"If-None-Match": etag}
    )
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["etag"] == etag


def test_etag_changes_when_the_card_changes(client, populated_archive):
    """Invalidation keys on (mtime_ns, size) -- the same pair the index uses, so a
    card and its thumb can never disagree about whether they changed."""
    before = client.get("/api/v1/characters/Cleo_33334444.png/png").headers["etag"]
    (populated_archive["characters"] / "Cleo_33334444.png").write_bytes(
        card_png("Cleo Rewritten Much Longer Name", extensions=jai_extensions("33334444"))
    )
    after = client.get("/api/v1/characters/Cleo_33334444.png/png").headers["etag"]
    assert before != after


def test_a_card_deleted_out_from_under_the_index_is_a_404(client, populated_archive):
    (populated_archive["characters"] / "Abbie_0d162f5f.png").unlink()
    client.post("/api/v1/refresh")
    assert client.get("/api/v1/characters/Abbie_0d162f5f.png/png").status_code == 404


def test_the_old_endpoints_still_work(client):
    """`/api/v1` is additive: the capture-and-build protocol the userscripts speak
    is untouched by it."""
    assert client.get("/health").json()["ok"] is True
