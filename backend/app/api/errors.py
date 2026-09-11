"""Service refusals → HTTP answers with a stable `detail.code` the UI turns into French copy.

404 `not_found`; 422 `invalid` (with the `field`, and a `reason` when the service gives one);
409 `duplicate` (with the `field` and the `existing` row holding the value, which may be
inactive); 409 `in_use` (with usage counts); 409 `conflict` (the record changed since it was read);
409 `do_not_contact` (the operation would erase a durable opposition). Raising inside
`business_errors()` also rolls the request's transaction back.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import HTTPException, status

from app.services.errors import (
    ConflictError,
    DoNotContactError,
    DuplicateValueError,
    InUseError,
    InvalidFieldError,
    NotFoundError,
)


def refusal(status_code: int, code: str, message: str, **details: Any) -> HTTPException:
    return HTTPException(status_code, {"code": code, "message": message, **details})


@contextmanager
def business_errors() -> Iterator[None]:
    try:
        yield
    except NotFoundError as error:
        raise refusal(status.HTTP_404_NOT_FOUND, "not_found", str(error)) from error
    except InvalidFieldError as error:
        reason = {"reason": error.reason} if error.reason else {}
        raise refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid",
            str(error),
            field=error.field,
            **reason,
        ) from error
    except DuplicateValueError as error:
        existing = error.existing
        raise refusal(
            status.HTTP_409_CONFLICT,
            "duplicate",
            str(error),
            field=error.field,
            existing=None
            if existing is None
            else {"id": str(existing.id), "label": existing.label, "active": existing.active},
        ) from error
    except InUseError as error:
        raise refusal(status.HTTP_409_CONFLICT, "in_use", str(error), usage=error.usage) from error
    except ConflictError as error:
        raise refusal(status.HTTP_409_CONFLICT, "conflict", str(error)) from error
    except DoNotContactError as error:
        raise refusal(status.HTTP_409_CONFLICT, "do_not_contact", str(error)) from error
