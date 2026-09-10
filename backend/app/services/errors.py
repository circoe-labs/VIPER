"""Errors raised by application services when a business rule refuses an operation."""


class DomainError(Exception):
    """A business rule refused the operation."""


class NotFoundError(DomainError):
    """The targeted entity does not exist."""
