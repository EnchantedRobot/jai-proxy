"""`GET|POST /proxy/{url}` -- the passthrough the vendored frontend has been
calling into a 404 ever since the pivot.

WHY THIS EXISTS
CharacterLibrary was written as a SillyTavern extension, and SillyTavern shipped
a CORS-proxy middleware at exactly this path. Sixteen call sites still reach for
it: `fetchWithProxy` in `web/modules/providers/provider-utils.js`, all seven
gallery extractors, three Chub modules and the media-localization section. Every
one of them tries the provider directly first and falls back here when the
browser's CORS policy (or a provider that simply doesn't send the header) makes
the direct leg impossible. With no route answering, that fallback returned a 404
HTML page -- which the media pipeline then classified as a permanently dead URL,
marking characters "media complete" having never fetched a byte.

So this is a bug fix that predates the proxy feature, and it is also where the
configured outbound proxy earns most of its keep: browsing Chub and running the
gallery extractors is the traffic a person actually wants routed.

WHAT IT WILL AND WON'T FETCH
`proxy.media.guard` gates every request -- the same guard the server-side media
downloader uses, scheme + literal-host checks plus a DNS preflight. That is what
keeps this from being an SSRF hole pointed at the LAN it runs inside, and it is
also what stops the route being aimed back at this server's own origin.

There is no enable/disable toggle. The route is useless to an attacker who can
already reach a machine on your LAN (the guard refuses every private and
loopback target, so it cannot be used to pivot inwards), and the frontend has no
working path without it. `gatherEnvInfo`'s probe reads any non-404 as "enabled",
so the guard's 400 on a self-referential URL reports correctly.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response

from proxy.media import guard as media_guard
from proxy.runtime import net

logger = logging.getLogger("jai_proxy.api.cors_proxy")

router = APIRouter(tags=["proxy"])

# Headers that describe *this* hop and must not be replayed to the upstream.
# `host` would name our own server; `cookie` would forward the archive's own
# session material to a third party; `origin`/`referer` announce a localhost
# origin that some providers reject outright; `accept-encoding` and
# `content-length` are httpx's to set, since it re-encodes and re-frames the
# body. The rest are RFC 9110 hop-by-hop headers.
_DROP_REQUEST_HEADERS = frozenset(
    {
        "host",
        "cookie",
        "origin",
        "referer",
        "accept-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

# Dropped on the way back for the same framing reason: httpx has already decoded
# the body, so a `content-encoding: gzip` we copied would describe bytes that are
# no longer gzipped and the browser would fail to parse them.
_DROP_RESPONSE_HEADERS = frozenset(
    {
        "content-encoding",
        "content-length",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

# The exact body SillyTavern's middleware answered when its own server-side fetch
# failed, and which `provider-utils.js:247` still special-cases to tell "your
# server couldn't reach the provider" apart from "the provider returned a 500".
# Keeping the string verbatim is what keeps that error message accurate.
UPSTREAM_UNREACHABLE_BODY = "Internal Server Error"


def _forwarded_request_headers(request: Request) -> dict[str, str]:
    return {k: v for k, v in request.headers.items() if k.lower() not in _DROP_REQUEST_HEADERS}


def _forwarded_response_headers(response: httpx.Response) -> dict[str, str]:
    return {
        k: v for k, v in response.headers.items() if k.lower() not in _DROP_RESPONSE_HEADERS
    }


# Two routes rather than one `api_route(methods=["GET", "POST"])`, and the
# reason is downstream: FastAPI writes a *single* operation id per function, so
# a two-method route emits the same id under both `get:` and `post:` in the
# OpenAPI document. That is not cosmetic -- openapi-typescript turns each into
# a TypeScript declaration of the same name and the frontend's `tsc -b` fails
# on the duplicate (see `make api-schema`). One function per method is what
# keeps the generated client compilable; both delegate to `_forward` below, so
# there is still one implementation.
@router.get("/proxy/{url:path}")
async def cors_proxy(url: str, request: Request) -> Response:
    """Fetch `url` server-side and hand the response back verbatim.

    The URL arrives percent-encoded as a single path segment (`proxyEncode` in
    provider-utils.js escapes `/` and `?` along with everything else), so
    Starlette's own path decoding hands it back whole, query string included.
    """
    return await _forward(url, request)


@router.post("/proxy/{url:path}")
async def cors_proxy_post(url: str, request: Request) -> Response:
    """`cors_proxy`, for the one caller that posts.

    `mega.js` sends a JSON command batch through the fallback; every other site
    is a GET.
    """
    return await _forward(url, request)


async def _forward(url: str, request: Request) -> Response:
    target = url.strip()
    if not target:
        return PlainTextResponse("no URL given", status_code=400)

    safety = media_guard.is_url_safe_for_download(target)
    if not safety.ok:
        # 400, not 403: `gatherEnvInfo` probes this route with our own origin to
        # find out whether it exists at all, and reads anything that isn't a 404
        # as "enabled". A refusal is a correct answer, not a missing route.
        return PlainTextResponse(f"refused: {safety.reason}", status_code=400)

    # getaddrinfo blocks; off the event loop, exactly as the media writer does it.
    dns_reason = await asyncio.to_thread(media_guard.preflight_dns, target)
    if dns_reason:
        return PlainTextResponse(f"refused: {dns_reason}", status_code=400)

    body = await request.body() if request.method == "POST" else None

    try:
        async with net.async_client(timeout=30.0, follow_redirects=True) as client:
            async with client.stream(
                request.method,
                target,
                headers=_forwarded_request_headers(request),
                content=body,
            ) as upstream:
                try:
                    payload = await media_guard.read_body_with_cap(upstream)
                except media_guard.MediaTooLargeError as exc:
                    return PlainTextResponse(f"refused: {exc}", status_code=502)
                return Response(
                    content=payload,
                    status_code=upstream.status_code,
                    headers=_forwarded_response_headers(upstream),
                )
    except httpx.HTTPError as exc:
        # The body has to be exactly this string -- see UPSTREAM_UNREACHABLE_BODY.
        logger.warning("cors proxy could not reach %s: %s", target, exc)
        return PlainTextResponse(UPSTREAM_UNREACHABLE_BODY, status_code=500)
