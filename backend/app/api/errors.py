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

from fastapi import HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

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


async def validation_refused(_: Request, error: Exception) -> JSONResponse:
    """FastAPI's 422 for a malformed request, without the submitted values: its `input` field would
    echo a password, a name or an e-mail address back (Task 20, I-159)."""
    assert isinstance(error, RequestValidationError)
    errors = [
        {key: value for key, value in item.items() if key != "input"} for item in error.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": jsonable_encoder(errors)},
    )
