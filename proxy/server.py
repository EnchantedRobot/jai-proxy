"""The application: what gets mounted, in what order, and how it is run.

No request handling happens here. The routes live in `proxy.api` -- the archive's
own contract under `/api/v1`, the `/build-*` acquisition endpoints the two
userscripts post to, and the OpenAI-shaped chat surface the sites are pointed at
as a custom provider. This module assembles them onto one app and starts it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from proxy import deps
from proxy.api import v1_router
from proxy.api.build import router as build_router
from proxy.api.capture import router as capture_router
from proxy.api.chat import router as chat_router
from proxy.api.datacat import router as datacat_router
from proxy.api.v1 import _shared as v1_shared
from proxy.config import REQUIRED_DIRS, ROOT, STARTUP_DIR_ERRORS, settings
from proxy.runtime import dashboard as dashboard_mod

logger = logging.getLogger("jai_proxy.server")

# The vendored Character Library frontend. In the repo, not in the archive:
# it is code, it ships with the server, and it is the same directory in a
# checkout and in the container image. See web/VENDORED.md.
WEB_DIR = ROOT / "web"


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Binds the media job runner to the loop uvicorn is actually running on
    # (docs/PHASE_3C_PLAN.md §7) -- module import happens before that loop
    # exists, so this can't be done at module scope.
    v1_shared.job_store.bind(asyncio.get_running_loop())
    yield


app = FastAPI(title="jai-proxy", lifespan=_lifespan)

# The archive's own contract: browse, download, export. Deliberately namespaced
# under /api/v1 and deliberately not shaped like SillyTavern's /api -- see
# proxy/api/__init__.py for why that distinction is the point.
app.include_router(v1_router)
# DataCat's session transport (Phase 3B S2). See proxy/api/datacat.py.
app.include_router(datacat_router)
# What the two userscripts talk to: the per-source build endpoints, the
# bookkeeping they call around a bulk run, and the custom-provider chat surface
# that is how a hidden definition gets captured at all.
app.include_router(build_router)
app.include_router(capture_router)
app.include_router(chat_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The browse UI loads the entire archive as one JSON document at boot -- 5.9 MB
# with extensions attached -- and 1.3 MB of vendored JavaScript alongside it.
# Both are overwhelmingly repeated text, so gzip takes the pair down by roughly
# a factor of five. The threshold keeps thumbnails and card PNGs out of it:
# those are already compressed, and re-compressing them costs CPU to add bytes.
app.add_middleware(GZipMiddleware, minimum_size=1024)


class QuietAccessFilter(logging.Filter):
    """Drop uvicorn access-log lines for successful (2xx) requests.

    Errors and redirects still print; only routine 200/204/etc noise is
    suppressed. record.args is (client_addr, method, path, http_version,
    status_code) per uvicorn's access logger call.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            status_code = record.args[-1]  # type: ignore[index]
            return not (200 <= int(status_code) < 300)
        except (TypeError, IndexError, ValueError):
            return True


logging.getLogger("uvicorn.access").addFilter(QuietAccessFilter())

# The browser, mounted last and mounted at the root.
#
# Last because Starlette matches routes in registration order and a mount at "/"
# matches everything: every API route above therefore wins, and the frontend
# picks up only what is left. Registering it earlier would swallow /api/v1 and
# the userscript endpoints whole.
#
# At the root rather than /library because the archive *is* this application
# now. There is no host page to be a subsection of.
#
# `html=True` serves index.html for "/" and for directory requests. It does
# NOT fall back to index.html for an arbitrary unknown path -- Starlette's
# StaticFiles only rewrites directory requests and looks for a 404.html,
# neither of which applies here -- so an unmatched path 404s (verified live).
# This app has no client-side deep-link routing that would need that fallback.
class NoCacheStaticFiles(StaticFiles):
    """Serve the frontend with browser caching switched off.

    StaticFiles sends ETag/Last-Modified but no Cache-Control, which leaves
    Chrome free to apply heuristic freshness. That bit us badly: a hard reload
    only bypasses the cache for the *navigation's* own subresources, so the
    modules under web/modules/ -- imported later, when the user opens the tag
    manager or switches to Online -- kept being served from cache. Stale code
    is indistinguishable from broken code, and we burned a session on it.

    This is a localhost archive serving a few hundred KB of its own assets.
    Always-fresh is worth more than the bytes.
    """

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


if WEB_DIR.is_dir():
    app.mount("/", NoCacheStaticFiles(directory=WEB_DIR, html=True), name="web")
else:  # pragma: no cover -- only in a checkout with the frontend removed
    logger.warning("web/ is missing at %s; the browser UI will not be served", WEB_DIR)


def _owner_of(path: Path) -> tuple[Path, int, int] | None:
    """Who owns the nearest *existing* ancestor of `path`, or None.

    The nearest existing one because a path we could not create is by
    definition absent -- what the operator needs to see is who owns the
    directory the creation was attempted in.
    """
    for candidate in (path, *path.parents):
        try:
            info = candidate.stat()
        except OSError:
            continue
        return candidate, info.st_uid, info.st_gid
    return None


def _preflight() -> list[str]:
    """Problems with the data mount, as lines to print. Empty means all good.

    This is the failure a remote deployment actually hits: `data/` is a bind
    mount, and on unraid its host directory is owned by `nobody:users` (99:100)
    while the image's default user is uid 1000. Without this the symptom is a
    PermissionError traceback from an import, which names neither the mount nor
    the uid -- see docs/DEPLOY.md.
    """
    problems: list[str] = []
    unwritable: list[Path] = []

    # Deduplicated by path: the same directory is attempted twice when a store
    # in proxy.deps re-ensures one config.py already tried (captures, lorecache).
    for path, exc in STARTUP_DIR_ERRORS:
        if path in unwritable:
            continue
        unwritable.append(path)
        problems.append(f"could not create {path}: {exc.strerror or exc}")

    for path in REQUIRED_DIRS:
        if path in unwritable or not path.is_dir():
            continue
        # An actual write, not os.access: access() answers from the permission
        # bits alone and reports success on a read-only mount.
        probe = path / ".jai-proxy-write-test"
        try:
            probe.touch()
            probe.unlink()
        except OSError as exc:
            problems.append(f"cannot write to {path}: {exc.strerror or exc}")
            unwritable.append(path)

    if problems:
        # Deduplicated by owner: these directories are normally all inside one
        # bind mount, so without this every failure repeats the same
        # "owned by uid=99 gid=100" and buries the one fact that matters.
        owners: dict[tuple[int, int], Path] = {}
        for path in unwritable:
            if found := _owner_of(path):
                owner_path, uid, gid = found
                owners.setdefault((uid, gid), owner_path)
        problems.append(
            f"the server runs as uid={os.getuid()} gid={os.getgid()}; "
            + "; ".join(
                f"{owner_path} is owned by uid={uid} gid={gid}"
                for (uid, gid), owner_path in owners.items()
            )
        )
        problems.append(
            "in a container, chown the host directory behind the /app/data mount "
            "to that uid/gid, or set PUID/PGID to the directory's owner"
        )
    return problems


def _stats_line() -> str:
    return (
        f"{deps.capture_store.count} captures · "
        f"{deps.lorebook_cache.count} lorebooks cached · "
        f"model {deps.responder.model}"
    )


def _serve() -> None:
    # log_config=None keeps uvicorn from installing its own stdout handlers, so
    # its records propagate to the root logger we configured instead.
    uvicorn.run(app, host=settings.host, port=settings.port, log_config=None)


def main() -> None:
    # Before anything else, and before the dashboard takes over the terminal:
    # an unusable data mount is fatal, and the message has to be readable.
    if problems := _preflight():
        print("jai-proxy cannot start -- the data directory is not usable:", file=sys.stderr)
        for line in problems:
            print(f"  {line}", file=sys.stderr)
        raise SystemExit(1)

    # The handle lives on the dashboard module rather than being a global here,
    # so the route module that reports into it (proxy/api/build.py) can read it
    # without importing this one -- see the note beside its definition.
    if not (settings.dashboard and sys.stdout.isatty()):
        logging.basicConfig(level=logging.INFO)
        _serve()
        return

    dashboard_mod.DASHBOARD = dashboard_mod.Dashboard(
        title="jai-proxy",
        address=f"http://{settings.host}:{settings.port}",
        stats=_stats_line,
    )
    dashboard_mod.install_logging(dashboard_mod.DASHBOARD)
    sink = dashboard_mod.StdoutSink(dashboard_mod.DASHBOARD.log)
    try:
        with dashboard_mod.live(dashboard_mod.DASHBOARD), contextlib.redirect_stdout(sink):
            _serve()
    except KeyboardInterrupt:  # pragma: no cover -- Ctrl-C is a clean exit
        pass
    finally:
        dashboard_mod.replay_problems(dashboard_mod.DASHBOARD, sys.stderr)
        dashboard_mod.DASHBOARD = None


if __name__ == "__main__":
    main()
