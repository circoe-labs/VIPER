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
    """One named field has an unacceptable value (blank label, malformed e-mail…)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


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
