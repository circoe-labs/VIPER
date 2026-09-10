"""Application factory. Dev server: `uvicorn app.main:create_app --factory --reload --port 8042`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.router import api_router, public_router
from app.core.config import Settings, get_settings
from app.db.session import create_db_engine, create_session_factory
from app.services.login_throttle import LoginThrottle


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = create_db_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        engine.dispose()

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
    app.state.login_throttle = LoginThrottle()
    app.include_router(public_router, prefix="/api")
    app.include_router(api_router, prefix="/api")
    return app
