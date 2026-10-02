"""Integration settings set from the browser (Contact port S8, Human request of 2026-10-01).

VIPER is an internal tool: the person configures OpenAI, the default sender, the CIRCOE Toolbox and
the scheduled sending from Paramètres > Connexions instead of `backend/.env`. The proper secret
process will be decided later; until then:

- **Storage**: a private JSON file (`VIPER_RUNTIME_SETTINGS_PATH`, default
  `~/.viper/runtime-settings.json`), outside the database (never in a backup, the explorer or the
  SQL console) and outside the checkout (refused by `Settings`), written atomically with owner-only
  permissions where the OS has them (`app.core.private_file`). The OpenAI key is stored **in clear**
  in that file — accepted for the internal pilot by the Human on 2026-10-01, to be revisited.
- **Precedence**: a value set here overrides the `VIPER_*` variable; resetting it (`null`) falls
  back to the variable, else to the built-in default. `source()` says which applies.
- **Validation**: the merge is validated by `Settings` itself (`model_validate`, which never reads
  the environment): the startup rules are the only rules (http(s) URLs, the loopback rule of the
  Toolbox URLs, the allowlist syntax, ranges, a model whenever a key is set).
- **Secrets** (`SECRET_FIELDS`) are write-only: `secret_meta` gives `set`, the last four
  characters, the source and who changed it — never the value; no log line and no audit event
  carries it.
- **Concurrency**: every write bumps `revision`; a write must name the revision it read (409
  `conflict` otherwise). One API process is assumed (already a constraint of the Toolbox and of the
  login throttle): the file is read at startup and written by this process only.

A file that cannot be read or no longer validates (a variable changed meanwhile) is reported
(`load_error`) and ignored until the next save, which rewrites it: the API still starts.
"""

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, SecretStr, ValidationError

from app.core.actor import ActorContext
from app.core.config import Settings
from app.core.private_file import write_private_json
from app.services.errors import ConflictError, InvalidFieldError, SettingsStorageError

logger = logging.getLogger(__name__)

# The settings editable from the browser, in the order of the page. Everything else (database,
# sessions, token store, SQL reader, import limits…) stays environment-only.
OPENAI_FIELDS = (
    "openai_api_key",
    "openai_model",
    "openai_base_url",
    "openai_timeout_ms",
    "openai_max_retries",
    "contact_booking_url",
)
SENDER_FIELDS = ("default_outbound_email",)
TOOLBOX_FIELDS = ("toolbox_mail_enabled", "toolbox_mcp_url", "toolbox_oauth_redirect_uri")
DISPATCH_FIELDS = (
    "contact_dispatch_enabled",
    "contact_dispatch_interval_ms",
    "infomaniak_send_allowlist",
)
EDITABLE_FIELDS = OPENAI_FIELDS + SENDER_FIELDS + TOOLBOX_FIELDS + DISPATCH_FIELDS
SECRET_FIELDS = frozenset({"openai_api_key"})
# Shown to the person, never a value: the string the audit event keeps for a changed secret.
SECRET_REPLACED = "replaced"
SECRET_REMOVED = "removed"

Source = Literal["ui", "env", "default"]
LoadError = Literal["unreadable", "invalid"]


class StoredValue(BaseModel):
    value: str | int | bool | None
    updated_at: datetime
    updated_by: str | None = None
    # Supplied by VIPER rather than typed by the person: the OAuth redirect URI the page sends when
    # someone connects the Toolbox. A later connection from another address may replace it; a
    # value typed in « Paramètres avancés » is never replaced.
    auto: bool = False
    # The OpenAI key only (S8 QA M1): the API address it was saved with. The key is never sent
    # elsewhere: changing the address requires typing the key again in the same save.
    bound_base_url: str | None = None

    def __repr__(self) -> str:
        # The value may be the OpenAI key: never in a repr, a log line or a traceback.
        return f"StoredValue(value=<hidden>, updated_at={self.updated_at!r}, auto={self.auto})"


class RuntimeFile(BaseModel):
    version: int = 1
    revision: int = 0
    updated_at: datetime | None = None
    updated_by: str | None = None
    values: dict[str, StoredValue] = {}

    def __repr__(self) -> str:
        # The values hold the OpenAI key: never in a repr, a log line or a traceback.
        return f"RuntimeFile(revision={self.revision}, fields={sorted(self.values)})"


class RuntimeSettingsFile:
    """The private file. `read()` answers `(file, load_error)`: no file is the normal first run."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def read(self) -> tuple[RuntimeFile, LoadError | None]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            # intentional: no file is the normal state until the first save from the browser.
            return RuntimeFile(), None
        except OSError as error:
            logger.error("runtime_settings.unreadable error=%s", type(error).__name__)
            return RuntimeFile(), "unreadable"
        try:
            file = RuntimeFile.model_validate_json(raw)
        except ValidationError:
            # Never the error itself: its `input` would echo the stored key.
            logger.error("runtime_settings.invalid_file: ignored until the next save")
            return RuntimeFile(), "invalid"
        if file.version != 1:
            logger.error("runtime_settings.unknown_version version=%s", file.version)
            return RuntimeFile(), "invalid"
        return file, None

    def write(self, file: RuntimeFile) -> None:
        try:
            write_private_json(self.path, file.model_dump(mode="json"))
        except OSError as error:
            # The path is the operator's; the error type says why (permissions, a directory…).
            logger.error(
                "runtime_settings.write_failed path=%s error=%s", self.path, type(error).__name__
            )
            raise SettingsStorageError(
                "The settings file cannot be written on the server: nothing was saved."
            ) from error


@dataclass(frozen=True, slots=True)
class SecretMeta:
    set: bool
    last4: str | None
    source: Source | None
    updated_at: datetime | None
    updated_by: str | None


@dataclass(frozen=True, slots=True)
class RuntimeChange:
    before: Settings
    after: Settings
    # The editable fields whose effective value changed (secrets included, by name only).
    changed: list[str]
    revision: int


def _plain(value: Any) -> Any:
    return value.get_secret_value() if isinstance(value, SecretStr) else value


def _refusal(error: ValidationError) -> InvalidFieldError:
    """The first refused field, from `loc` and the rule's message only — never `input`, which
    would echo a submitted key."""
    first = error.errors(include_input=False, include_url=False)[0]
    location = first.get("loc") or ()
    # The cross-field rule (`_model_with_key`) has no location: the model is what is missing.
    field = str(location[0]) if location else "openai_model"
    message = str(first.get("msg", "invalid value")).removeprefix("Value error, ")
    return InvalidFieldError(field, message, reason=str(first.get("type", "invalid")))


# When a stored value breaks a rule at startup, the value dropped for it (S8 QA m1): a missing
# model drops the key saved without it; a key bound to another API address drops that address.
_DROP_FOR = {"openai_model": "openai_api_key", "openai_api_key": "openai_base_url"}


def merge(base: Settings, values: Mapping[str, Any]) -> Settings:
    """`base` with `values` applied, validated by `Settings`' own rules (`InvalidFieldError`)."""
    data = {name: getattr(base, name) for name in type(base).model_fields}
    data.update(values)
    try:
        return type(base).model_validate(data)
    except ValidationError as error:
        raise _refusal(error) from None


class RuntimeSettings:
    """The effective settings of the API process: environment defaults + the browser's values."""

    def __init__(
        self,
        base: Settings,
        store: RuntimeSettingsFile | None = None,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.base = base
        self.store = store or RuntimeSettingsFile(base.runtime_settings_file)
        self._now = now
        self._lock = threading.Lock()
        file, self.load_error = self.store.read()
        # Keys outside the editable list (a later version, a hand edit) are dropped, not applied.
        file.values = {name: v for name, v in file.values.items() if name in EDITABLE_FIELDS}
        # Only the values that break a rule are dropped (the others apply), and named.
        self.dropped: list[str] = []
        while True:
            try:
                self._effective = self._validated(file)
                break
            except InvalidFieldError as error:
                victim = error.field if error.field in file.values else _DROP_FOR.get(error.field)
                if victim is None or victim not in file.values:
                    self.dropped.extend(sorted(file.values))
                    file = RuntimeFile(revision=file.revision)
                    self._effective = base
                    break
                del file.values[victim]
                self.dropped.append(victim)
        if self.dropped:
            self.load_error = "invalid"
            logger.error(
                "runtime_settings.invalid_values dropped=%s: ignored until the next save",
                self.dropped,
            )
        self._file = file
        logger.info(
            "runtime_settings.loaded path=%s fields=%s load_error=%s",
            self.store.path,
            sorted(file.values),
            self.load_error,
        )

    @staticmethod
    def _overrides(file: RuntimeFile) -> dict[str, Any]:
        return {name: stored.value for name, stored in file.values.items()}

    def _validated(self, file: RuntimeFile) -> Settings:
        """The merge, plus the key's binding to its API address (S8 QA M1): a key saved here is
        only sent to the address it was saved with; the environment's key only to the
        environment's / default address."""
        settings = merge(self.base, self._overrides(file))
        if settings.openai_api_key is not None:
            stored = file.values.get("openai_api_key")
            bound = (
                (stored.bound_base_url or self.base.openai_base_url)
                if stored
                else self.base.openai_base_url
            )
            if settings.openai_base_url != bound:
                raise InvalidFieldError(
                    "openai_api_key",
                    "Changing the API address requires the key again (it is never sent to "
                    "another address).",
                    reason="required_with_base_url",
                )
        return settings

    @property
    def effective(self) -> Settings:
        return self._effective

    @property
    def file(self) -> RuntimeFile:
        return self._file.model_copy(deep=True)

    def source(self, name: str) -> Source:
        if name in self._file.values:
            return "ui"
        field = type(self.base).model_fields[name]
        if name in self.base.model_fields_set and _plain(getattr(self.base, name)) != _plain(
            field.default
        ):
            return "env"
        return "default"

    def fallback(self, name: str) -> Any:
        """What a reset would give (the variable, else the default); never asked for a secret."""
        assert name not in SECRET_FIELDS, "a secret has no displayable fallback"
        return _plain(getattr(self.base, name))

    def stored(self, name: str) -> StoredValue | None:
        return self._file.values.get(name)

    def secret_meta(self, name: str) -> SecretMeta:
        value = _plain(getattr(self._effective, name))
        stored = self._file.values.get(name)
        return SecretMeta(
            set=value is not None,
            last4=value[-4:] if isinstance(value, str) and len(value) >= 8 else None,
            source=self.source(name) if value is not None else None,
            updated_at=stored.updated_at if stored else None,
            updated_by=stored.updated_by if stored else None,
        )

    def is_typed(self, name: str) -> bool:
        """The person typed this value here (not an automatic one, not the environment's)."""
        stored = self._file.values.get(name)
        return stored is not None and not stored.auto

    def update(
        self,
        changes: Mapping[str, Any],
        *,
        expected_revision: int,
        actor: ActorContext,
        auto: frozenset[str] = frozenset(),
    ) -> RuntimeChange:
        """Apply `changes` (`None` = back to the variable / default), validate, save, then switch.

        Nothing changes when a rule refuses a value (422 `invalid` with the field) or when the file
        moved on since `expected_revision` (409 `conflict`)."""
        unknown = sorted(set(changes) - set(EDITABLE_FIELDS))
        if unknown:
            raise InvalidFieldError(unknown[0], "This setting is not editable from the browser.")
        for name in SECRET_FIELDS & set(changes):
            value = changes[name]
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise InvalidFieldError(name, "An empty key is not a key: clear it instead.")
        with self._lock:
            if expected_revision != self._file.revision:
                raise ConflictError(
                    "The integration settings changed since they were read: reload them."
                )
            now = self._now()
            file = self._file.model_copy(deep=True)
            for name, value in changes.items():
                if isinstance(value, str):
                    value = value.strip()
                # An empty text is « back to the default » (S8 QA M2), never a typed "".
                if value is None or value == "":
                    file.values.pop(name, None)
                else:
                    file.values[name] = StoredValue(
                        value=value, updated_at=now, updated_by=actor.display, auto=name in auto
                    )
            new_key = file.values.get("openai_api_key") if changes.get("openai_api_key") else None
            if new_key is not None:
                # A key typed now is bound to the API address of this very save.
                new_key.bound_base_url = merge(self.base, self._overrides(file)).openai_base_url
            after = self._validated(file)
            before = self._effective
            changed = [
                name
                for name in EDITABLE_FIELDS
                if _plain(getattr(before, name)) != _plain(getattr(after, name))
                or (name in changes and (name in file.values) != (name in self._file.values))
            ]
            file.revision += 1
            file.updated_at = now
            file.updated_by = actor.display
            self.store.write(file)
            self._file, self._effective, self.load_error = file, after, None
        logger.info(
            "runtime_settings.saved revision=%s changed=%s by=%s",
            file.revision,
            changed,
            actor.id,
        )
        return RuntimeChange(before=before, after=after, changed=changed, revision=file.revision)
