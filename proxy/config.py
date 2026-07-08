from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="JAI_PROXY_")

    mlx_base_url: str = "http://127.0.0.1:8011/v1"
    mlx_model: str = "Llama-3.2-3B-Instruct-4bit"
    host: str = "127.0.0.1"
    port: int = 8000
    output_dir: Path = Path("./cards")
    captures_dir: Path = Path("./cards/.captures")
    request_timeout: float = 120.0
    allowed_origins: list[str] = ["*"]
    user_names: list[str] = ["USER"]


settings = Settings()
settings.output_dir.mkdir(parents=True, exist_ok=True)
settings.captures_dir.mkdir(parents=True, exist_ok=True)
