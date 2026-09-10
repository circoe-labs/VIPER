"""Errors raised by application services when a business rule refuses an operation."""


class DomainError(Exception):
    """A business rule refused the operation."""


class NotFoundError(DomainError):
    """The targeted entity does not exist."""


class InvalidInputError(DomainError):
    """Well-formed request whose values do not fit the target (unknown column, wrong type)."""
