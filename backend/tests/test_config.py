import pytest

from app.core.config import Settings


def test_settings_are_read_from_prefixed_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "postgresql+psycopg://user:pass@db.example.test:5432/viper"
    monkeypatch.setenv("VIPER_DATABASE_URL", url)

    assert Settings().database_url == url
