"""Typed runtime configuration read from `VIPER_*` environment variables and `backend/.env`."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

LOCAL_DATABASE = "postgresql+psycopg://viper:viper@127.0.0.1:5442"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VIPER_", env_file=".env", extra="ignore")

    database_url: str = f"{LOCAL_DATABASE}/viper"
    test_database_url: str = f"{LOCAL_DATABASE}/viper_test"


@lru_cache
def get_settings() -> Settings:
    return Settings()
