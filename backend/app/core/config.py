"""Typed runtime configuration read from `VIPER_*` environment variables and `backend/.env`.

The integration settings (OpenAI, sender, CIRCOE Toolbox, scheduled sending) may also be set from
Paramètres > Connexions (Contact port S8): `app.services.runtime_settings` stores those values in
a private file and validates the merge with this very class, so the startup rules below are the
only rules. The environment then only gives the defaults.
"""

import re
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Self
from urllib.parse import urlsplit

from pydantic import Field, PositiveInt, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import make_url

LOCAL_DATABASE = "postgresql+psycopg://viper:viper@127.0.0.1:5442"
RoleName = Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")]
OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1"
# The CIRCOE Toolbox MCP server (the OAuth resource it announces): « Se connecter à CIRCOE
# Toolbox » works out of the box (S8). Tests and E2E always point elsewhere (a local fake).
CIRCOE_TOOLBOX_MCP_URL = "https://circoetoolbox-server-production.up.railway.app/mcp"


def _http_url(value: str) -> str:
    """An absolute http(s) URL without spaces (a scheme like `javascript:` is refused)."""
    value = value.strip()
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.netloc or any(c.isspace() for c in value):
        raise ValueError("must be an absolute http(s) URL")
    return value


LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]", "::1"})
# backend/app/core/config.py → the checkout root (the Toolbox token file may not live inside).
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TOOLBOX_TOKEN_STORE = Path.home() / ".viper" / "toolbox-oauth.json"
DEFAULT_RUNTIME_SETTINGS = Path.home() / ".viper" / "runtime-settings.json"
_ALLOWLIST_ADDRESS = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
_ALLOWLIST_DOMAIN = re.compile(r"^@[^@\s,;]+\.[^@\s,;]+$")


def toolbox_url(value: str) -> str:
    """HTTPS, or plain HTTP on the loopback only (the Toolbox's own rule for redirect URIs)."""
    value = value.strip()
    url = urlsplit(value)
    if any(c.isspace() for c in value) or not url.netloc:
        raise ValueError("must be an absolute https URL (http only on localhost)")
    if url.scheme == "https" or (url.scheme == "http" and url.hostname in LOOPBACK_HOSTS):
        return value
    raise ValueError("must be an absolute https URL (http only on localhost)")


def outside_checkout(value: Path, holds: str) -> Path:
    """The resolved path, refused inside the repository checkout (it would be committed or copied
    with the code)."""
    path = value.expanduser().resolve()
    if path.is_relative_to(REPOSITORY_ROOT):
        raise ValueError(f"must be outside the repository checkout (it holds {holds})")
    return path


def parse_allowlist(value: str) -> tuple[str, ...]:
    """`a@x.fr, @y.fr` → `("a@x.fr", "@y.fr")` (lowercase); a malformed entry is refused."""
    entries = tuple(entry.lower() for entry in re.split(r"[\s,;]+", value.strip()) if entry)
    for entry in entries:
        if not (_ALLOWLIST_ADDRESS.match(entry) or _ALLOWLIST_DOMAIN.match(entry)):
            raise ValueError("entries must be e-mail addresses or @domain rules")
    return entries


def allowlist_permits(allowlist: tuple[str, ...] | None, addresses: list[str]) -> bool:
    """Every address matches an exact entry or an `@domain` rule (None = no restriction)."""
    if allowlist is None:
        return True
    return all(
        address.lower() in allowlist
        or any(rule.startswith("@") and address.lower().endswith(rule) for rule in allowlist)
        for address in addresses
    )


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

    # Prospect score (prospect-contact-ux S1, decision D-UX2): the base added to the manual
    # contributions (notes with a `score_delta`), the sum clamped to 0..100. The band is red below
    # `prospect_score_red_below`, yellow below `prospect_score_green_from`, green from it on.
    # Values proposed by the orchestrator, to be confirmed by the product (open point).
    prospect_score_base: Annotated[int, Field(ge=0, le=100)] = 50
    prospect_score_red_below: Annotated[int, Field(ge=1, le=100)] = 40
    prospect_score_green_from: Annotated[int, Field(ge=1, le=100)] = 70

    # AI mail drafting context (prospect-contact-ux S5): how many of the prospect's notes (newest
    # first) and how many score contributions (largest |delta| first) reach the prompt.
    contact_mail_max_notes: Annotated[int, Field(ge=1, le=100)] = 20
    contact_mail_max_score_contributions: Annotated[int, Field(ge=1, le=20)] = 5

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

    # CIRCOE Toolbox (S6, handoff Task 15): Infomaniak drafts of validated messages through the
    # Toolbox MCP server (OAuth 2.1 + PKCE). Off by default: everything stays local. « Se connecter
    # à CIRCOE Toolbox » (Paramètres > Connexions, S8) turns it on and supplies the redirect URI.
    toolbox_mail_enabled: bool = False
    # The exact MCP URL (the OAuth resource the Toolbox announces): HTTPS, or http on loopback.
    toolbox_mcp_url: str | None = CIRCOE_TOOLBOX_MCP_URL
    # Where the Toolbox sends the browser back: the SPA page `/settings/connections` as the
    # browser sees it (e.g. http://localhost:5173/settings/connections in development). Unset,
    # the page sends its own address when the person connects (S8).
    toolbox_oauth_redirect_uri: str | None = None
    # The OAuth token file: outside the database (never in a backup, the explorer or a response)
    # and outside the repository checkout; owner-only permissions. Default `~/.viper/…`.
    toolbox_token_store_path: Path | None = None
    # Total bound of one Toolbox operation (initialize + tool call).
    toolbox_timeout_ms: Annotated[int, Field(ge=1000, le=120_000)] = 20_000
    # Period of the obsolete-draft cleanup worker in the API process; 0 = no worker (the CLI
    # `python -m app.cli toolbox-cleanup --once` still runs one pass).
    toolbox_cleanup_interval_ms: Annotated[int, Field(ge=0, le=86_400_000)] = 60_000
    # Optional VIPER-side allowlist of recipients for the scheduled send (S7): comma-separated
    # addresses or `@domain` rules. Unset = no VIPER-side restriction (the Toolbox keeps its own).
    infomaniak_send_allowlist: str | None = None
    # Scheduled sending (S7, decision 25: VIPER schedules, the Toolbox's `send_draft` executes):
    # the dispatcher worker of the API process runs a pass every interval while the Toolbox is
    # enabled, configured and connected. On by default (S9, supersedes the S8 « Désactivé par
    # défaut »: a message scheduled while nothing could send it never left): the switch
    # « Envoi automatique des mails programmés » of Paramètres > Connexions turns it off. Off, or an
    # interval of 0 = no worker (the CLI `python -m app.cli contact-dispatch --once` still runs one
    # pass). The interval is the « Délai maximal avant envoi » of « Paramètres avancés ».
    contact_dispatch_enabled: bool = True
    contact_dispatch_interval_ms: Annotated[int, Field(ge=0, le=3_600_000)] = 30_000
    # A message more late than this does not leave: it goes back to Validé (`dispatch_overdue`).
    contact_dispatch_max_lateness_ms: Annotated[int, Field(ge=60_000, le=7 * 86_400_000)] = (
        6 * 3_600_000
    )
    # Age after which a send claim nobody finished is reconciled (`dispatch_claim_ttl`: never less
    # than twice the Toolbox timeout).
    contact_dispatch_claim_ttl_ms: Annotated[int, Field(ge=1000, le=86_400_000)] = 600_000
    # Send attempts (certain transient failures included) before going back to Validé.
    contact_dispatch_max_attempts: Annotated[int, Field(ge=1, le=20)] = 5
    # Base of the exponential backoff between two attempts (base x 2^(n-1), at most 1 h).
    contact_dispatch_retry_base_ms: Annotated[int, Field(ge=1000, le=3_600_000)] = 60_000

    # The integration settings set from Paramètres > Connexions (S8): a private JSON file outside
    # the database and outside the checkout, like the Toolbox token. Default `~/.viper/…`.
    runtime_settings_path: Path | None = None

    @field_validator(
        "openai_api_key",
        "openai_model",
        "contact_booking_url",
        "toolbox_mcp_url",
        "toolbox_oauth_redirect_uri",
        "toolbox_token_store_path",
        "runtime_settings_path",
        "infomaniak_send_allowlist",
        mode="before",
    )
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

    @field_validator("toolbox_mcp_url", "toolbox_oauth_redirect_uri")
    @classmethod
    def _toolbox_url(cls, value: str | None) -> str | None:
        return None if value is None else toolbox_url(value)

    @field_validator("toolbox_token_store_path")
    @classmethod
    def _token_store_outside_checkout(cls, value: Path | None) -> Path | None:
        return None if value is None else outside_checkout(value, "an OAuth token")

    @field_validator("runtime_settings_path")
    @classmethod
    def _runtime_settings_outside_checkout(cls, value: Path | None) -> Path | None:
        return None if value is None else outside_checkout(value, "API keys")

    @field_validator("infomaniak_send_allowlist")
    @classmethod
    def _allowlist(cls, value: str | None) -> str | None:
        if value is not None:
            parse_allowlist(value)
        return value

    @field_validator("contact_dispatch_interval_ms")
    @classmethod
    def _dispatch_interval(cls, value: int) -> int:
        # The reference raises a small positive period to 500 ms; refused here rather than changed.
        if 0 < value < 500:
            raise ValueError("must be 0 (no worker) or at least 500 ms")
        return value

    @model_validator(mode="after")
    def _score_bands_ordered(self) -> Self:
        if self.prospect_score_red_below >= self.prospect_score_green_from:
            raise ValueError(
                "VIPER_PROSPECT_SCORE_RED_BELOW must be lower than VIPER_PROSPECT_SCORE_GREEN_FROM"
            )
        return self

    @model_validator(mode="after")
    def _model_with_key(self) -> Self:
        if self.openai_api_key is not None and self.openai_model is None:
            raise ValueError("VIPER_OPENAI_MODEL is required when VIPER_OPENAI_API_KEY is set")
        return self

    @property
    def contact_dispatch_on(self) -> bool:
        """The scheduled sending is switched on (a worker runs once the Toolbox is connected)."""
        return self.contact_dispatch_enabled and self.contact_dispatch_interval_ms > 0

    @property
    def generation_available(self) -> bool:
        """The AI drafting is configured (key and model)."""
        return self.openai_api_key is not None and self.openai_model is not None

    @property
    def toolbox_missing_settings(self) -> list[str]:
        """Names (never values) of the unset settings an enabled Toolbox needs."""
        missing = []
        if self.toolbox_mcp_url is None:
            missing.append("VIPER_TOOLBOX_MCP_URL")
        if self.toolbox_oauth_redirect_uri is None:
            missing.append("VIPER_TOOLBOX_OAUTH_REDIRECT_URI")
        return missing

    @property
    def toolbox_token_store(self) -> Path:
        return self.toolbox_token_store_path or DEFAULT_TOOLBOX_TOKEN_STORE

    @property
    def runtime_settings_file(self) -> Path:
        return self.runtime_settings_path or DEFAULT_RUNTIME_SETTINGS

    @property
    def send_allowlist(self) -> tuple[str, ...] | None:
        """The parsed `VIPER_INFOMANIAK_SEND_ALLOWLIST` (S7 checks it before a send); None =
        unset."""
        return (
            None
            if self.infomaniak_send_allowlist is None
            else (parse_allowlist(self.infomaniak_send_allowlist))
        )

    @property
    def contact_dispatch_claim_ttl(self) -> timedelta:
        """The effective claim TTL: never less than twice the Toolbox timeout (a send still
        running is never taken for a dead one)."""
        return timedelta(
            milliseconds=max(self.contact_dispatch_claim_ttl_ms, 2 * self.toolbox_timeout_ms)
        )

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
