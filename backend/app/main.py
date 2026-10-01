"""Application factory. Dev server: `uvicorn app.main:create_app --factory --reload --port 8042`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from app.api.errors import validation_refused
from app.api.router import api_router, public_router
from app.api.security_headers import SecurityHeadersMiddleware
from app.api.worker_wake import WakeCleanupWorkerMiddleware
from app.core.config import Settings, get_settings
from app.db.session import create_db_engine, create_session_factory
from app.services.contact_dispatch import DispatchConfig
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.explorer.sql_console import create_reader_engine
from app.services.login_throttle import LoginThrottle
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.worker import CleanupWorker


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = create_db_engine(settings.database_url)
    # The SQL console's own engine, logged in as the read-only reader role (ADR-0011).
    sql_engine = create_reader_engine(settings.sql_reader_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # CIRCOE Toolbox (S6): the cleanup worker runs only when enabled and configured with a
        # positive interval; tests may replace `app.state.toolbox` before startup.
        integration: ToolboxIntegration = app.state.toolbox
        worker = None
        if integration.configured and integration.cleanup_interval_seconds > 0:
            worker = CleanupWorker(
                integration, app.state.session_factory, integration.cleanup_interval_seconds
            )
            worker.start()
        app.state.toolbox_worker = worker
        # Scheduled sending (S7): same conditions, `VIPER_CONTACT_DISPATCH_INTERVAL_MS` > 0. A
        # pass sends nothing while the Toolbox is not connected.
        dispatch_config = DispatchConfig.from_settings(app.state.settings)
        dispatcher = None
        if integration.configured and dispatch_config.interval.total_seconds() > 0:
            dispatcher = ContactDispatcher(integration, app.state.session_factory, dispatch_config)
            dispatcher.start()
        app.state.contact_dispatcher = dispatcher
        yield
        # Graceful shutdown: each worker lets its running pass finish (a send included).
        if dispatcher is not None:
            dispatcher.stop()
        if worker is not None:
            worker.stop()
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
    app.state.toolbox = ToolboxIntegration(settings)
    app.state.toolbox_worker = None
    app.state.contact_dispatcher = None

    app.add_middleware(WakeCleanupWorkerMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_exception_handler(RequestValidationError, validation_refused)
    app.include_router(public_router, prefix="/api")
    app.include_router(api_router, prefix="/api")
    return app
