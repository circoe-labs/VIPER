"""Evidence for « the application froze »: slow requests and a busy database are logged.

A request still running after `SLOW_REQUEST_SECONDS` is logged while it runs (one that never ends
would otherwise leave no line) and again when it ends. A request that finds no free pool connection,
or waits too long for another transaction's lock, answers 503 `database_busy` (limits in
`app.db.session`). Every line carries the pool's state. Route templates only: never a query string,
an identifier or a token.
"""

import asyncio
import logging
import time

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

SLOW_REQUEST_SECONDS = 5.0
# PostgreSQL `lock_not_available`: `lock_timeout` expired.
LOCK_NOT_AVAILABLE = "55P03"


def pool_state(app: FastAPI) -> str:
    engine: Engine = app.state.session_factory.kw["bind"]
    # « Pool size: 10  Connections in pool: 0 Current Overflow: 20 Current Checked out: 30 »
    return engine.pool.status()


def _route(scope: Scope) -> str:
    return str(getattr(scope.get("route"), "path", "unmatched"))


class SlowRequestLogMiddleware:
    """Pure ASGI (like `security_headers`): bodies untouched."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        status_code = 500
        started = time.monotonic()

        def still_running() -> None:
            logger.warning(
                "request.still_running method=%s route=%s seconds=%.0f pool=[%s]",
                scope["method"],
                _route(scope),
                time.monotonic() - started,
                pool_state(scope["app"]),
            )

        async def record_status(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        timer = asyncio.get_running_loop().call_later(SLOW_REQUEST_SECONDS, still_running)
        try:
            await self.app(scope, receive, record_status)
        finally:
            timer.cancel()
            duration = time.monotonic() - started
            if duration >= SLOW_REQUEST_SECONDS:
                logger.warning(
                    "request.slow method=%s route=%s status=%s seconds=%.1f pool=[%s]",
                    scope["method"],
                    _route(scope),
                    status_code,
                    duration,
                    pool_state(scope["app"]),
                )


def _busy(request: Request, cause: str) -> JSONResponse:
    logger.error(
        "database.busy cause=%s method=%s route=%s pool=[%s]",
        cause,
        request.method,
        _route(request.scope),
        pool_state(request.app),
    )
    detail = {
        "code": "database_busy",
        "message": "The database is busy: nothing was changed. Try again in a moment.",
    }
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": detail})


async def _pool_exhausted(request: Request, error: Exception) -> JSONResponse:
    return _busy(request, "pool_exhausted")


async def _operational_error(request: Request, error: Exception) -> JSONResponse:
    original = getattr(error, "orig", None)
    if getattr(original, "sqlstate", None) != LOCK_NOT_AVAILABLE:
        raise error
    return _busy(request, "lock_timeout")


def install(app: FastAPI) -> None:
    app.add_middleware(SlowRequestLogMiddleware)
    app.add_exception_handler(PoolTimeoutError, _pool_exhausted)
    app.add_exception_handler(OperationalError, _operational_error)
