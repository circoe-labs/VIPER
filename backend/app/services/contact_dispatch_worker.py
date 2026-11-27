"""The scheduled-sending worker of the API process (Contact port S7, P5: background work runs in the
API process, on by default since S9, with a `--once` CLI twin: `python -m app.cli contact-dispatch
--once`).

A daemon thread runs `contact_dispatch.Dispatcher.run_pass` every
`VIPER_CONTACT_DISPATCH_INTERVAL_MS` while the Toolbox is enabled, configured and connected (a
pass does nothing otherwise — no message is touched while nothing can be sent). It is started by
`IntegrationRuntime` once the Toolbox is connected (at startup, or right after the OAuth return)
when the sending is switched on (`contact_dispatch_enabled`) with a positive interval.
Never two passes at once in one process (a lock); across processes (two API instances, the CLI)
the claim's row lock lets one win. A pass that crashes is logged with its traceback and the loop
goes on; `stop()` lets the running pass finish (a send is bounded by the Toolbox timeout).
"""

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from app.services.contact_dispatch import DispatchConfig, Dispatcher, DispatchReport
from app.services.contact_draft_check import check_scheduled_drafts
from app.services.errors import ToolboxError
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.mcp_client import MailToolbox
from app.services.warehouse_dispatch import dispatch_warehouses

logger = logging.getLogger(__name__)

# How often the scheduled messages' drafts are looked for, and how soon after a failed look.
CHECK_INTERVAL = timedelta(minutes=15)
CHECK_RETRY = timedelta(minutes=1)


@dataclass(frozen=True, slots=True)
class WorkerStatus:
    # The worker thread runs (the Toolbox may still be disconnected: see `active`).
    running: bool
    # A scheduled message will really leave: the worker runs and the Toolbox is connected.
    active: bool
    last_pass_at: datetime | None
    # `ok` | `error` (the pass crashed: see the server log) | None before the first pass.
    last_outcome: str | None


class ContactDispatcher:
    def __init__(
        self,
        integration: ToolboxIntegration,
        session_factory: sessionmaker[Session],
        config: DispatchConfig,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._integration = integration
        self._interval = config.interval.total_seconds()
        self._dispatcher = Dispatcher(session_factory, config, now=now)
        self._warehouse_factory = session_factory
        self._warehouse_config = config
        self._now = now
        self._stop = threading.Event()
        self._pass = threading.Lock()
        self._thread: threading.Thread | None = None
        self._last_pass_at: datetime | None = None
        self._last_outcome: str | None = None
        # The next draft check, and the connection (`connected_at`) the last one saw.
        self._next_check: datetime | None = None
        self._checked_connection: datetime | None = None

    def _check_drafts(self, toolbox: MailToolbox) -> None:
        """Right after a (re)connection, then every `CHECK_INTERVAL` (`contact_draft_check`)."""
        now = self._now()
        connection = self._integration.status().connected_at
        due = self._next_check is None or now >= self._next_check
        if not due and connection == self._checked_connection:
            return
        self._checked_connection = connection
        try:
            check_scheduled_drafts(self._warehouse_factory, toolbox)
        except ToolboxError as error:
            self._next_check = now + CHECK_RETRY
            logger.warning("contact_dispatch.draft_check_failed code=%s", error.code)
            return
        self._next_check = now + CHECK_INTERVAL

    def check_soon(self) -> None:
        """Look at the drafts at the next pass (messages were just scheduled again: their drafts
        may belong to a former connection)."""
        self._next_check = None

    def run_once(self) -> DispatchReport | None:
        """One pass; None when the Toolbox is not usable or a pass is already running."""
        toolbox = self._integration.mail_toolbox()
        if toolbox is None or not self._pass.acquire(blocking=False):
            return None
        try:
            report = self._dispatcher.run_pass(toolbox)
            dispatch_warehouses(self._warehouse_factory, self._warehouse_config, toolbox)
            self._check_drafts(toolbox)
            self._last_outcome = "ok"
            return report
        except Exception:
            self._last_outcome = "error"
            raise
        finally:
            self._last_pass_at = self._now()
            self._pass.release()

    def _loop(self) -> None:
        logger.info("contact_dispatch.worker started interval_s=%s", self._interval)
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                # A crashed pass must not end the worker: logged with its traceback, retried.
                logger.exception("contact_dispatch.worker pass_failed")
            self._stop.wait(self._interval)
        logger.info("contact_dispatch.worker stopped")

    def start(self) -> None:
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="contact-dispatch", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 60.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None

    @property
    def interval_seconds(self) -> float:
        return self._interval

    def status(self) -> WorkerStatus:
        running = self._thread is not None and self._thread.is_alive()
        return WorkerStatus(
            running=running,
            active=running and self._integration.connected(),
            last_pass_at=self._last_pass_at,
            last_outcome=self._last_outcome,
        )
