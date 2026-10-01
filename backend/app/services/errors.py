"""Errors raised by application services when a business rule refuses an operation."""

import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


class DomainError(Exception):
    """A business rule refused the operation."""


class NotFoundError(DomainError):
    """The targeted entity does not exist."""


class InvalidInputError(DomainError):
    """Well-formed request whose values do not fit the target (unknown column, wrong type)."""


class InvalidFieldError(InvalidInputError):
    """One named field has an unacceptable value (blank label, malformed e-mail…).

    `field` may be a path into a nested payload (`establishments.1.siret`); `reason` is an
    optional stable code when one field can fail in several ways (`format`, `checksum`…).
    """

    def __init__(self, field: str, message: str, reason: str | None = None) -> None:
        super().__init__(message)
        self.field = field
        self.reason = reason


@dataclass(frozen=True, slots=True)
class ExistingValue:
    """The row that already holds a value, so the user can pick or reactivate it instead."""

    id: uuid.UUID
    label: str
    active: bool


class DuplicateValueError(DomainError):
    """Another row already holds this value (compared case-, accent- and space-insensitively)."""

    def __init__(self, field: str, existing: ExistingValue | None) -> None:
        super().__init__(f"Another value already has this {field}.")
        self.field = field
        self.existing = existing


class InUseError(DomainError):
    """The row is still referenced: it can be deactivated, not deleted."""

    def __init__(self, usage: Mapping[str, int]) -> None:
        super().__init__("Still referenced: deactivate it instead of deleting it.")
        self.usage = dict(usage)


class ConflictError(DomainError):
    """The record changed since the client read it (optimistic concurrency): reload, then redo."""


class DoNotContactError(DomainError):
    """The operation would erase a durable do-not-contact restriction (e.g. deleting the person)."""


class TrackingRuleError(DomainError):
    """A Contact tracking rule refused the change; `code` is stable (`ignored_is_terminal`,
    `ignored_has_no_next_action`)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ContactMessageError(DomainError):
    """The Contact message state machine refused the operation. `code` is stable (the UI turns it
    into French copy), `status` is its HTTP status and `details` add machine-readable context
    (e.g. the missing `fields` of an incomplete message). Codes: `app.services.contact_messages`.
    """

    def __init__(self, code: str, http_status: int, message: str, **details: object) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.details = details


class BusinessRuleError(DomainError):
    """A cohort, sequence, send or quality-alert rule refused the operation (sequences rework).
    `code` is stable (the UI turns it into French copy), `http_status` its HTTP status and
    `details` add machine-readable context. Codes: `app.services.cohorts`,
    `app.services.contact_sequences`, `app.services.quality_alerts`, `app.services.app_settings`.
    """

    def __init__(self, code: str, http_status: int, message: str, **details: object) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.details = details


class MailGenerationError(DomainError):
    """The AI drafting of a Contact message failed or is not configured; nothing was saved.
    `code` is stable (`ai_not_configured`, `ai_timeout`, `ai_rate_limited`, `ai_auth_failed`,
    `ai_upstream_error`, `ai_refused`, `ai_invalid_output`: `app.services.mail_generation`),
    `http_status` its HTTP status. `upstream_status` / `upstream_code` (the provider's HTTP status
    and error type) are for the log only: never the key, the prompt or the provider's text."""

    def __init__(
        self,
        code: str,
        http_status: int,
        message: str,
        *,
        upstream_status: int | None = None,
        upstream_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.upstream_status = upstream_status
        self.upstream_code = upstream_code


class ToolboxError(DomainError):
    """A CIRCOE Toolbox operation (OAuth or MCP) failed or is not possible. `code` is stable
    (`toolbox_*`, `app.services.toolbox.errors`), `http_status` its HTTP status. `retryable`: the
    same call may be replayed safely; `outcome_unknown`: the Toolbox may have executed it without
    answering (a `send_draft` timeout) — never replayed blindly. `upstream_status` is the
    Toolbox's HTTP status, for the log only: never a token, an address or the Toolbox's text."""

    def __init__(
        self,
        code: str,
        http_status: int,
        message: str,
        *,
        retryable: bool = False,
        outcome_unknown: bool = False,
        upstream_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.retryable = retryable
        self.outcome_unknown = outcome_unknown
        self.upstream_status = upstream_status


class ActorNotAllowedError(DomainError):
    """This kind of actor may not make this change (e.g. a contact state chosen by an agent)."""


def violated_constraint(error: IntegrityError) -> str | None:
    """Name of the constraint or index a database write violated (ADR-0002 naming)."""
    diagnostics = getattr(error.orig, "diag", None)
    name = getattr(diagnostics, "constraint_name", None)
    return name if isinstance(name, str) else None


def is_foreign_key_violation(error: IntegrityError) -> bool:
    return getattr(error.orig, "sqlstate", None) == "23503"


@contextmanager
def translated_violations(
    session: Session, translate: Callable[[IntegrityError], DomainError | None]
) -> Iterator[None]:
    """Run the block's changes and their flush in a savepoint.

    A constraint violation that `translate` recognizes (e.g. a duplicate that raced past a
    service's pre-check) is raised as that `DomainError`; the savepoint is rolled back, so the
    caller's transaction stays usable. Other violations propagate unchanged.
    """
    try:
        with session.begin_nested():
            yield
            session.flush()
    except IntegrityError as error:
        domain_error = translate(error)
        if domain_error is None:
            raise
        raise domain_error from error
