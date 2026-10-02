"""The integrations of one API process, reconfigured live when their settings change (S8).

Owns, on `app.state`:

- `settings`            the effective `Settings` every route reads at use time (`SettingsDep`):
                        the OpenAI client, the booking link and the default sender follow a save
                        on the next request, without any restart;
- `toolbox`             the CIRCOE Toolbox integration, rebuilt when its switch or URLs change
                        (the OAuth token file is kept; a connection started but not finished is
                        lost and must be started again);
- `toolbox_worker`      the obsolete-draft cleanup worker, and
- `contact_dispatcher`  the scheduled-sending worker (when its interval is not « Désactivé »):
                        both run only once the Toolbox is connected — started at startup when it
                        already is, or right after « Se connecter à CIRCOE Toolbox » — and are
                        stopped and started again when the Toolbox or the dispatch settings
                        change. Stopping lets a running pass finish (a send is bounded by the
                        Toolbox timeout), so a save may wait for it.

Thread-safe (one lock): two saves never interleave their restarts. Single process assumed.
"""

import logging
import threading
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.services.contact_dispatch import DispatchConfig
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.runtime_settings import TOOLBOX_FIELDS
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.worker import CleanupWorker

logger = logging.getLogger(__name__)

ToolboxFactory = Callable[[Settings], ToolboxIntegration]


class IntegrationRuntime:
    def __init__(self, state: Any, *, toolbox_factory: ToolboxFactory = ToolboxIntegration) -> None:
        # `state` is the app's `State` (attributes set by `create_app`; tests may replace
        # `toolbox`, `session_factory` or `toolbox_factory` before startup).
        self._state = state
        self.toolbox_factory = toolbox_factory
        # The workers' sessions; None = the app's. Tests give the threads their own sessions (the
        # per-test connection must not be shared across threads).
        self.worker_session_factory: sessionmaker[Session] | None = None
        # Re-entrant: a save holds it around `RuntimeSettings.update` + `apply` (S8 QA m6), so
        # the file, `app.state.settings` and the integration always change together.
        self.lock = threading.RLock()

    @property
    def _session_factory(self) -> sessionmaker[Session]:
        factory: sessionmaker[Session] = self.worker_session_factory or self._state.session_factory
        return factory

    def _start_cleanup(self, integration: ToolboxIntegration) -> None:
        worker = None
        if integration.cleanup_interval_seconds > 0:
            worker = CleanupWorker(
                integration, self._session_factory, integration.cleanup_interval_seconds
            )
            worker.start()
        self._state.toolbox_worker = worker

    def _start_dispatcher(self, integration: ToolboxIntegration, settings: Settings) -> None:
        config = DispatchConfig.from_settings(settings)
        dispatcher = None
        if config.interval.total_seconds() > 0:
            dispatcher = ContactDispatcher(integration, self._session_factory, config)
            dispatcher.start()
        self._state.contact_dispatcher = dispatcher

    def _stop_cleanup(self) -> None:
        worker: CleanupWorker | None = self._state.toolbox_worker
        if worker is not None:
            worker.stop()
        self._state.toolbox_worker = None

    def _stop_dispatcher(self) -> None:
        dispatcher: ContactDispatcher | None = self._state.contact_dispatcher
        if dispatcher is not None:
            dispatcher.stop()
        self._state.contact_dispatcher = None

    def _sync(self) -> None:
        """Workers run only while the Toolbox is connected (S8): started once it is, stopped when
        it is forgotten. A connection that expires later keeps them, idle (a pass does nothing
        without a usable token), until the next reconnection or « Se déconnecter »."""
        integration: ToolboxIntegration = self._state.toolbox
        if integration.connected():
            if self._state.toolbox_worker is None:
                self._start_cleanup(integration)
            if self._state.contact_dispatcher is None:
                self._start_dispatcher(integration, self._state.settings)
        elif not integration.configured:
            self._stop_dispatcher()
            self._stop_cleanup()

    def start(self) -> None:
        """At startup: the workers, when the Toolbox is already connected."""
        with self.lock:
            self._sync()
            self._log("started")

    def sync(self) -> None:
        """After a connection or a « Se déconnecter »: start or stop the workers accordingly."""
        with self.lock:
            before = (self._state.toolbox_worker, self._state.contact_dispatcher)
            self._sync()
            if before != (self._state.toolbox_worker, self._state.contact_dispatcher):
                self._log("synced")

    def stop(self) -> None:
        """At shutdown: each worker lets its running pass finish (a send included)."""
        with self.lock:
            self._stop_dispatcher()
            self._stop_cleanup()

    def apply(self, before: Settings, after: Settings) -> bool:
        """Switch to `after`: the routes see it at once; the Toolbox and the workers follow.

        A changed Toolbox server address forgets the token (S8 QA B1): it was issued for the
        previous server and is never sent to another one. Answers whether a token was forgotten.
        """
        forgot = False
        with self.lock:
            self._state.settings = after
            toolbox_changed = any(
                getattr(before, name) != getattr(after, name) for name in TOOLBOX_FIELDS
            )
            dispatch_changed = DispatchConfig.from_settings(before) != DispatchConfig.from_settings(
                after
            )
            if toolbox_changed:
                self._stop_dispatcher()
                self._stop_cleanup()
                previous: ToolboxIntegration = self._state.toolbox
                integration = self.toolbox_factory(after)
                if before.toolbox_mcp_url != after.toolbox_mcp_url:
                    forgot = integration.forget()
                integration.adopt(previous)
                self._state.toolbox = integration
            elif dispatch_changed:
                self._stop_dispatcher()
            self._sync()
            if toolbox_changed or dispatch_changed:
                self._log("reconfigured")
        return forgot

    def _log(self, event: str) -> None:
        integration: ToolboxIntegration = self._state.toolbox
        logger.info(
            "integrations.%s toolbox_configured=%s cleanup_worker=%s dispatcher=%s",
            event,
            integration.configured,
            self._state.toolbox_worker is not None,
            self._state.contact_dispatcher is not None,
        )
