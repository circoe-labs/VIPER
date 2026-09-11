"""Application factory. Dev server: `uvicorn app.main:create_app --factory --reload --port 8042`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.router import api_router, public_router
from app.api.security_headers import SecurityHeadersMiddleware
from app.core.config import Settings, get_settings
from app.db.session import create_db_engine, create_session_factory
from app.services.explorer.sql_console import create_reader_engine
from app.services.login_throttle import LoginThrottle


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = create_db_engine(settings.database_url)
    # The SQL console's own engine, logged in as the read-only reader role (ADR-0011).
    sql_engine = create_reader_engine(settings.sql_reader_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        engine.dispose()
        sql_engine.dispose()

    app = FastAPI(
        title="VIPER API",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        swagger_ui_oauth2_redirect_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.session_factory = create_session_factory(engine)
    app.state.sql_engine = sql_engine
    app.state.login_throttle = LoginThrottle()
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(public_router, prefix="/api")
    app.include_router(api_router, prefix="/api")
    return app
