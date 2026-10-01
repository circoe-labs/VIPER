"""The remote-draft cleanup worker of the API process (S6; Contact port P5: background work runs in
the API process, off by default, with a `--once` CLI twin).

A daemon thread runs `contact_remote_drafts.process_cleanups` every
`VIPER_TOOLBOX_CLEANUP_INTERVAL_MS` while the Toolbox is enabled, configured and connected (a pass
does nothing otherwise), and right away when `wake()` is called after a write that may have queued
a draft. Never two passes at once in one process; across processes the queue rows are taken with
`SKIP LOCKED`. A pass that crashes is logged with its traceback and the loop goes on; `stop()`
lets the running pass finish (bounded by the Toolbox timeout per draft).
"""

import logging
import threading

from sqlalchemy.orm import Session, sessionmaker

from app.services.contact_remote_drafts import CleanupReport, process_cleanups
from app.services.toolbox.integration import ToolboxIntegration

logger = logging.getLogger(__name__)


class CleanupWorker:
    def __init__(
        self,
        integration: ToolboxIntegration,
        session_factory: sessionmaker[Session],
        interval_seconds: float,
    ) -> None:
        self._integration = integration
        self._session_factory = session_factory
        self._interval = interval_seconds
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._pass = threading.Lock()
        self._thread: threading.Thread | None = None

    def run_once(self) -> CleanupReport | None:
        """One pass; None when the Toolbox is not usable or a pass is already running."""
        toolbox = self._integration.mail_toolbox()
        if toolbox is None or not self._pass.acquire(blocking=False):
            return None
        try:
            return process_cleanups(self._session_factory, toolbox)
        finally:
            self._pass.release()

    def _loop(self) -> None:
        logger.info("toolbox.cleanup_worker started interval_s=%s", self._interval)
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                # A crashed pass must not end the worker: logged with its traceback, retried.
                logger.exception("toolbox.cleanup_worker pass_failed")
            self._wake.wait(self._interval)
            self._wake.clear()
        logger.info("toolbox.cleanup_worker stopped")

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="toolbox-cleanup", daemon=True)
            self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None
