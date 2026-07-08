import proxy
from proxy.config import settings
from proxy.models import CharacterCardV3


def test_package_imports():
    assert proxy is not None


def test_settings_defaults():
    assert settings.mlx_base_url == "http://127.0.0.1:8011/v1"
    assert settings.mlx_model == "Llama-3.2-3B-Instruct-4bit"
    assert settings.port == 8000


def test_character_card_v3_to_dict_shape():
    card = CharacterCardV3(name="Ada")
    d = card.to_dict()
    assert d["spec"] == "chara_card_v3"
    assert d["spec_version"] == "3.0"
    assert d["data"]["name"] == "Ada"
    assert d["name"] == "Ada"
