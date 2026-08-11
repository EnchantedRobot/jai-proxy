# The archive server. Nothing here is architecture-specific -- both the base
# image and uv's are multi-arch -- so this builds natively on arm64 (a Mac) and
# amd64 (a NAS or a VPS) without a variant per host.

# --- builder: resolve the locked dependency set into a venv ------------------
FROM python:3.13-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Use the interpreter already in the image (the runtime stage has the same one
# at the same path) instead of letting uv fetch a second, standalone build.
ENV UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy

WORKDIR /app
COPY pyproject.toml uv.lock ./
# --no-install-project: the app is not imported as an installed package, it is
# run as `python -m proxy.server` from /app. Keeping the project out of the venv
# means this layer depends only on the lockfile, so editing proxy/ never
# re-resolves dependencies.
RUN uv sync --frozen --no-dev --no-install-project

# --- runtime -----------------------------------------------------------------
FROM python:3.13-slim-bookworm

# pngquant compresses card avatars before they are embedded. The vendored
# binary next to proxy/ is a macOS Mach-O one and is excluded by .dockerignore,
# so PngWriter's PATH fallback picks up this one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pngquant \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 app

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY proxy/ ./proxy/
COPY web/ ./web/
COPY pyproject.toml uv.lock README.md ./

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    # Bind all interfaces: 127.0.0.1 would only be reachable from inside the
    # container. This is the one variable the container actually needs -- every
    # writable path already defaults under /app/data, which is the mount.
    JAI_PROXY_HOST=0.0.0.0

# proxy/config.py creates its directories at import time; /app/data is normally
# a mount, but pre-creating it keeps a mountless `docker run` from failing.
RUN mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 8000

# urllib rather than curl -- it is already in the interpreter, and installing a
# HTTP client just to poll a local endpoint is a package to keep patched.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).read()"]

CMD ["python", "-m", "proxy.server"]
