from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# The repo root, so `.env` is found no matter which directory the server or a
# script was launched from -- pydantic-settings would otherwise resolve a
# relative env_file against the current working directory.
ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Runtime configuration, read from (in precedence order) the process
    environment, then `.env` at the repo root, then these defaults. Every key is
    the field name upper-cased behind `JAI_PROXY_` -- see `.env.template`."""

    model_config = SettingsConfigDict(
        env_prefix="JAI_PROXY_",
        env_file=ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mlx_base_url: str = "http://127.0.0.1:8011/v1"
    mlx_model: str = "Llama-3.2-3B-Instruct-4bit"
    host: str = "127.0.0.1"
    port: int = 8000

    # Where built cards land. Pointing this at SillyTavern's characters folder
    # (data/default-user/characters) makes SillyTavern the archive itself: a
    # card edited or deleted there simply *is* the archive's new state, with no
    # sync step -- which is why the layout below defaults to flat.
    output_dir: Path = Path("./cards")

    # How cards are foldered under output_dir:
    #   flat   -- <name>_<id8>.png, everything in one directory. Required by
    #             SillyTavern, which does not recurse into subfolders.
    #   nested -- <creator>/<name>_<id8>.png, the original layout. The creator
    #             is kept on the card either way (extensions.jai.creatorName),
    #             so nothing is lost by going flat; filenames carry the card-id
    #             fragment, so they don't collide across creators.
    card_layout: Literal["flat", "nested"] = "flat"

    # Server-side working state, deliberately *not* under output_dir: that may
    # point at SillyTavern's characters folder, which is not ours to litter.
    captures_dir: Path = Path("./state/captures")
    # Speed cache of raw lorebook payloads keyed by (source, lorebook id). A
    # lorebook is reused across many characters, and fetching one is the slow
    # part of an export, so we stash it here on first sight and skip the fetch
    # every later time. Purely a cache -- wipe/refresh via POST /clear-lorebooks.
    lorebook_cache_dir: Path = Path("./state/lorecache")

    request_timeout: float = 120.0
    allowed_origins: list[str] = ["*"]
    user_names: list[str] = ["USER"]

    # Lossily quantize card avatars with pngquant before embedding the card.
    # Fails soft: if the binary is missing or can't shrink the image, the
    # uncompressed PNG is written instead. Default binary is the one vendored
    # next to this package; override with JAI_PROXY_PNGQUANT_BIN or PATH.
    compress: bool = True
    pngquant_bin: Path = Path(__file__).resolve().parent / "pngquant"

    # Outbound proxy for server-initiated calls to third-party APIs (currently
    # just proxy/datacat_api.py's original-avatar lookup). httpx's single
    # `proxy=` kwarg, so one URL covers http+https; None disables it.
    http_proxy: str | None = None

    # A datacat.run anonymous session token, so DatacatImageResolver reuses it
    # instead of hitting /api/liberator/identify on every run. Left unset the
    # first time; the resolver fetches one and writes it back here itself --
    # see proxy/datacat_api.py._persist_session_token.
    datacat_session_token: str | None = None


settings = Settings()
settings.output_dir.mkdir(parents=True, exist_ok=True)
settings.captures_dir.mkdir(parents=True, exist_ok=True)
settings.lorebook_cache_dir.mkdir(parents=True, exist_ok=True)
