"""The Playwright data loader never writes synthetic rows outside an `*_e2e` database."""

import pytest

from tests import e2e_data


def test_refuses_a_database_not_named_e2e(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("VIPER_DATABASE_URL", "postgresql+psycopg://viper:viper@127.0.0.1:1/viper")

    assert e2e_data.main() == 1
    assert "must end with '_e2e'" in capsys.readouterr().out
