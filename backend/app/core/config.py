"""Typed runtime configuration read from `VIPER_*` environment variables and `backend/.env`."""

from functools import lru_cache

from pydantic import PositiveInt
from pydantic_settings import BaseSettings, SettingsConfigDict

LOCAL_DATABASE = "postgresql+psycopg://viper:viper@127.0.0.1:5442"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VIPER_", env_file=".env", extra="ignore")

    database_url: str = f"{LOCAL_DATABASE}/viper"
    test_database_url: str = f"{LOCAL_DATABASE}/viper_test"

    # Authentication (ADR-0004). Browsers accept `Secure` cookies from http://localhost, so the flag
    # stays on by default; turn it off only to reach a dev server over plain HTTP by another name.
    session_cookie_secure: bool = True
    # A session ends after this long without any authenticated request…
    session_idle_timeout_minutes: PositiveInt = 120
    # …and in any case this long after sign-in.
    session_absolute_timeout_hours: PositiveInt = 12

    # Excel/CSV import bounds (ADR-0007): uploads above them are refused with a clear message.
    import_max_file_mb: PositiveInt = 10
    import_max_rows: PositiveInt = 5000
    import_max_columns: PositiveInt = 100


@lru_cache
def get_settings() -> Settings:
    return Settings()
