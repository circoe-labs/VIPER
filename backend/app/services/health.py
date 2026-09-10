"""Health checks behind the `/api/health` probe."""

import logging

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def database_is_reachable(session: Session) -> bool:
    try:
        session.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        # Class name only: driver messages may include connection details.
        logger.warning("Database health check failed: %s", type(exc).__name__)
        return False
    return True
