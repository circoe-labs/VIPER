"""Typed runtime configuration read from `VIPER_*` environment variables and `backend/.env`."""

from functools import lru_cache
from typing import Annotated

from pydantic import Field, PositiveInt, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import make_url

LOCAL_DATABASE = "postgresql+psycopg://viper:viper@127.0.0.1:5442"
RoleName = Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")]


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

    # Read-only SQL console (ADR-0011): queries run as this login role, which may only SELECT the
    # explorer's exposed tables (`python -m app.cli provision-sql-reader`). The password default is
    # a local-development value like `viper`/`viper`; set `VIPER_SQL_READER_PASSWORD` elsewhere.
    sql_reader_role: RoleName = "viper_sql_reader"
    sql_reader_password: SecretStr = SecretStr("viper_sql_reader")
    sql_statement_timeout_ms: PositiveInt = 5000
    sql_max_rows: PositiveInt = 1000

    # Excel/CSV import bounds (ADR-0007): uploads above them are refused with a clear message.
    import_max_file_mb: PositiveInt = 10
    import_max_rows: PositiveInt = 5000
    import_max_columns: PositiveInt = 100

    # Prospection (Task 14): an employment verification older than this many days needs a re-check.
    # Unset by default — product has not chosen the age threshold (open question #9).
    verification_stale_days: PositiveInt | None = None

    # Home (Task 16): informative monthly targets — prospects newly contacted and appointments
    # obtained per month (source requirement "100 contacts / 10 rendez-vous").
    monthly_contact_target: PositiveInt = 100
    monthly_appointment_target: PositiveInt = 10

    @property
    def sql_reader_url(self) -> str:
        """The application database, reached as the SQL console's role."""
        url = make_url(self.database_url).set(
            username=self.sql_reader_role, password=self.sql_reader_password.get_secret_value()
        )
        return url.render_as_string(hide_password=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
