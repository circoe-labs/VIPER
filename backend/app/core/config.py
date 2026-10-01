"""Typed runtime configuration read from `VIPER_*` environment variables and `backend/.env`."""

from functools import lru_cache
from typing import Annotated, Self
from urllib.parse import urlsplit

from pydantic import Field, PositiveInt, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import make_url

LOCAL_DATABASE = "postgresql+psycopg://viper:viper@127.0.0.1:5442"
RoleName = Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")]
OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1"


def _http_url(value: str) -> str:
    """An absolute http(s) URL without spaces (a scheme like `javascript:` is refused)."""
    value = value.strip()
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.netloc or any(c.isspace() for c in value):
        raise ValueError("must be an absolute http(s) URL")
    return value


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

    # Contact messages (S3): the sender pre-filled in a new message (`From`). Unset: the person
    # types it; a message cannot be validated without one. Never hard-coded (handoff Task 12).
    default_outbound_email: (
        Annotated[str, Field(max_length=320, pattern=r"^[^@\s]+@[^@\s]+$")] | None
    ) = None

    # AI drafting of Contact messages (S5, handoff Task 14). Key and model are both needed; unset,
    # « Générer avec l'IA » answers 503 `ai_not_configured` and nothing changes. No model id is
    # hard-coded (handoff docs/08 §4): the operator chooses it. The key is never logged or returned.
    openai_api_key: SecretStr | None = None
    openai_model: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    openai_base_url: str = OPENAI_OFFICIAL_BASE_URL
    # Per network operation (connect ≤ 10 s, then each read/write), not a total per attempt;
    # bounded retries on transient failures only (a timeout is not replayed).
    openai_timeout_ms: Annotated[int, Field(ge=1000, le=300_000)] = 60_000
    openai_max_retries: Annotated[int, Field(ge=0, le=5)] = 2
    # Honour the server's HTTPS_PROXY / NO_PROXY / SSL_CERT_FILE… for the OpenAI calls; off by
    # default (a direct connection, the environment cannot redirect the key elsewhere).
    openai_trust_env: bool = False
    # The booking link the AI may copy into a mail; unset = no link at all.
    contact_booking_url: Annotated[str, Field(max_length=2000)] | None = None

    @field_validator("openai_api_key", "openai_model", "contact_booking_url", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: object) -> object:
        # `VIPER_OPENAI_API_KEY=` in a .env means « not configured », not an empty key.
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator("openai_base_url")
    @classmethod
    def _base_url(cls, value: str) -> str:
        # `…/v1/` and `…/v1` name the same API root; requests append `/responses`.
        return _http_url(value).rstrip("/")

    @field_validator("contact_booking_url")
    @classmethod
    def _booking_url(cls, value: str | None) -> str | None:
        # Refused at startup rather than silently ignored (the reference dropped a bad value).
        return None if value is None else _http_url(value)

    @model_validator(mode="after")
    def _model_with_key(self) -> Self:
        if self.openai_api_key is not None and self.openai_model is None:
            raise ValueError("VIPER_OPENAI_MODEL is required when VIPER_OPENAI_API_KEY is set")
        return self

    @property
    def generation_available(self) -> bool:
        """The AI drafting is configured (key and model)."""
        return self.openai_api_key is not None and self.openai_model is not None

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
