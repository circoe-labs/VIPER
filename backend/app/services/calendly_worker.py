"""The Calendly sync worker of the API process (Agenda).

A daemon thread runs one sync every `VIPER_CALENDLY_SYNC_INTERVAL_MS` while a Calendly token is
set. It is started and stopped by `IntegrationRuntime` (at startup, and when the token or the
interval changes). Never two passes at once in one process (a lock); a pass that fails — Calendly
unreachable, a revoked token — is logged by its stable code and retried at the next tick, so the
Agenda page and « Synchroniser » stay the place where a person sees why. Idempotent: the upsert is
keyed on the Calendly event.
"""

import logging
import threading
from datetime import UTC, datetime

import httpx2
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.services import audit
from app.services.calendly import CalendlyClient, CalendlyError, SyncReport, sync_appointments

logger = logging.getLogger(__name__)

SYNC_ACTOR = ActorContext(type=ActorType.SYSTEM, display="Synchro Calendly", id="calendly-sync")


class CalendlyWorker:
    def __init__(
        self,
        token: str,
        session_factory: sessionmaker[Session],
        interval_seconds: float,
        *,
        transport: httpx2.BaseTransport | None = None,
    ) -> None:
        self._client = CalendlyClient(token, transport=transport)
        self._session_factory = session_factory
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._pass = threading.Lock()
        self._thread: threading.Thread | None = None
        self.last_pass_at: datetime | None = None
        self.last_code: str | None = None

    def run_once(self) -> SyncReport | None:
        """One sync; None when one already runs. A Calendly failure is recorded, not raised."""
        if not self._pass.acquire(blocking=False):
            return None
        try:
            with audit.attributed_unit_of_work(self._session_factory, SYNC_ACTOR) as session:
                report = sync_appointments(session, self._client)
            self.last_code = None
            return report
        except CalendlyError as error:
            self.last_code = error.code
            logger.warning("calendly.sync_failed code=%s", error.code)
            return None
        finally:
            self.last_pass_at = datetime.now(UTC)
            self._pass.release()

    def _loop(self) -> None:
        logger.info("calendly.worker started interval_s=%s", self._interval)
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("calendly.worker pass_failed")
            self._stop.wait(self._interval)
        logger.info("calendly.worker stopped")

    def start(self) -> None:
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="calendly-sync", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None
