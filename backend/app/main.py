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
from app.services.explorer.sql_console import create_reader_engine
from app.services.integration_runtime import IntegrationRuntime
from app.services.login_throttle import LoginThrottle
from app.services.runtime_settings import RuntimeSettings
from app.services.toolbox.integration import ToolboxIntegration


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = create_db_engine(settings.database_url)
    # The SQL console's own engine, logged in as the read-only reader role (ADR-0011).
    sql_engine = create_reader_engine(settings.sql_reader_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # CIRCOE Toolbox cleanup worker (S6) and scheduled-sending worker (S7): started when the
        # effective settings call for them, restarted by a save from Paramètres > Connexions (S8);
        # tests may replace `app.state.toolbox` before startup.
        integrations: IntegrationRuntime = app.state.integrations
        integrations.start()
        yield
        # Graceful shutdown: each worker lets its running pass finish (a send included).
        integrations.stop()
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
    # Integration settings set from the browser (S8) override the environment's: `settings` is
    # the effective configuration, replaced live by `app.state.integrations.apply`.
    app.state.runtime_settings = RuntimeSettings(settings)
    settings = app.state.runtime_settings.effective
    app.state.settings = settings
    app.state.session_factory = create_session_factory(engine)
    app.state.sql_engine = sql_engine
    app.state.login_throttle = LoginThrottle()
    app.state.toolbox = ToolboxIntegration(settings)
    app.state.toolbox_worker = None
    app.state.contact_dispatcher = None
    app.state.integrations = IntegrationRuntime(app.state)
    # Test seam of « Tester la clé » (an `httpx2.MockTransport`); None = the network.
    app.state.openai_transport = None

    app.add_middleware(WakeCleanupWorkerMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_exception_handler(RequestValidationError, validation_refused)
    app.include_router(public_router, prefix="/api")
    app.include_router(api_router, prefix="/api")
    return app
