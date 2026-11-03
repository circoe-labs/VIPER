"""The recurring missions worker: one thread, one short transaction per pass.

The API process owns it (started with the app, stopped with it); a pass locks due missions
`SKIP LOCKED`, starts their runs and lets `missions.run_mission` advance `next_run_at`. The worker
never applies a result: it only creates the execution an agent will claim.

Tests call `missions.run_due` directly; the app fixture replaces `app.state.mission_scheduler` with
`None` so no thread runs during a test.
"""

import logging
import threading
import uuid
from datetime import datetime

from sqlalchemy.orm import Session, sessionmaker

from app.db.session import unit_of_work
from app.services import missions

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 60


class MissionScheduler:
    """A daemon thread that runs `missions.run_due` every `interval_seconds`."""

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._interval = max(1, interval_seconds)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name="viper-mission-scheduler", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def run_once(self, now: datetime | None = None) -> list[uuid.UUID]:
        """One pass, committed when it returns: the unit the tests and the loop share."""
        with unit_of_work(self._session_factory) as session:
            return [run.id for run in missions.run_due(session, now=now)]

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.run_once()
            except Exception:  # a scheduler pass must never kill the API
                logger.exception("mission scheduler pass failed")
