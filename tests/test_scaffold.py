from pathlib import Path

import proxy
from proxy.config import Settings
from proxy.models import CharacterCardV3


def test_package_imports():
    assert proxy is not None


def test_settings_defaults():
    # Built without the repo's .env, so this asserts the shipped defaults rather
    # than whatever this machine happens to be configured to.
    defaults = Settings(_env_file=None)
    assert defaults.mock_model == "jai-proxy-mock"
    assert defaults.port == 8000
    assert defaults.output_dir == Path("./cards")
    assert defaults.card_layout == "flat"
    # Working state stays out of the cards folder -- that may be SillyTavern's.
    assert defaults.captures_dir == Path("./state/captures")
    assert defaults.lorebook_cache_dir == Path("./state/lorecache")


def test_settings_read_env_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "JAI_PROXY_OUTPUT_DIR=/tmp/characters\nJAI_PROXY_CARD_LAYOUT=nested\n",
        encoding="utf-8",
    )
    configured = Settings(_env_file=env)
    assert configured.output_dir == Path("/tmp/characters")
    assert configured.card_layout == "nested"


def test_character_card_v3_to_dict_shape():
    card = CharacterCardV3(name="Ada")
    d = card.to_dict()
    assert d["spec"] == "chara_card_v3"
    assert d["spec_version"] == "3.0"
    assert d["data"]["name"] == "Ada"
    assert d["name"] == "Ada"
