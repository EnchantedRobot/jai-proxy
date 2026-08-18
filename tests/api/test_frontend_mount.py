"""How the React client under `/next` is served (proxy/server.py).

The mount is conditional on `frontend/dist` existing, so these tests skip in a
checkout that has not run `make frontend-build` -- and in CI, where the Python
job never builds it. What they pin down is the behaviour that is easy to break
and invisible until a browser hits it: the SPA fallback, and the fact that
`/next` is registered before the `web/` mount at "/" swallows everything.
"""

from __future__ import annotations

import pytest

from proxy.server import FRONTEND_DIST

pytestmark = pytest.mark.skipif(
    not FRONTEND_DIST.is_dir(),
    reason="frontend/dist is not built (make frontend-build)",
)


def test_serves_the_shell_at_the_mount_root(client):
    response = client.get("/next/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")


def test_client_side_routes_fall_back_to_the_shell(client):
    """A deep link is a real address, not a 404.

    This is the whole reason `/next` is a route rather than a StaticFiles mount:
    `/next/characters/<id>` exists only in the client's router, so the server
    has to answer it with the shell and let the client route from there. The
    old `web/` mount could not do this, which is why it has no deep links.
    """
    response = client.get("/next/characters/Aurora_1a2b3c4d")
    assert response.status_code == 200
    assert b"<div id=\"root\">" in response.content
    # The shell names this build's content-hashed assets, so a cached copy
    # would keep pointing at the previous build's JavaScript.
    assert "no-store" in response.headers["cache-control"]


def test_real_files_are_served_as_themselves(client):
    response = client.get("/next/favicon.svg")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/svg+xml"


def test_hashed_assets_are_cacheable_forever(client):
    asset = next((FRONTEND_DIST / "assets").glob("*.js"))
    response = client.get(f"/next/assets/{asset.name}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_the_api_still_wins_over_the_frontend(client):
    """Registration order is load-bearing and worth a test, not a comment.

    Both frontends are mounted with patterns broad enough to swallow the API --
    `web/`'s at "/" literally matches everything. If either is ever registered
    ahead of the routers, this is the test that says so.
    """
    assert client.get("/api/v1/stats").status_code == 200


def test_traversal_out_of_dist_is_refused(client):
    """`../` in the path must not reach outside the built output.

    It arrives from the URL unvalidated, and the handler joins it onto a
    directory. A traversal falls back to the shell rather than reading the file.

    Percent-encoded, and that is the whole point of the test: a literal
    `/next/../../pyproject.toml` is normalised to `/pyproject.toml` by the
    client before it is ever sent, so it never reaches this handler and would
    pass whether or not the guard existed. `%2e%2e` survives to the path
    parameter intact, which is what an attacker would send.
    """
    response = client.get("/next/%2e%2e/%2e%2e/pyproject.toml")
    assert b"[project]" not in response.content
    assert b"<div id=\"root\">" in response.content
