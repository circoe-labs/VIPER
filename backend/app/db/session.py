"""Engine and session factories, and the unit of work. One engine per application instance."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

CONNECT_TIMEOUT_SECONDS = 5


def create_db_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
    )


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


@contextmanager
def unit_of_work(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    """One transaction: commit when the block succeeds, roll back if it raises.

    The only place that commits. Services flush; HTTP requests (`SessionDep`) and non-HTTP
    callers (CLI, import jobs) wrap their whole operation in one unit of work.
    """
    with session_factory.begin() as session:
        yield session
