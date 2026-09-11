"""Engine and session factories, and the unit of work. One engine per application instance."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

CONNECT_TIMEOUT_SECONDS = 5


def create_db_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
        # Bound values (names, e-mail addresses…) never appear in exception messages, hence in
        # tracebacks and logs.
        hide_parameters=True,
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


# Planner features turned off for statements that read a whole prospect base (ADR-0019).
WHOLE_BASE_OFF = "name IN ('enable_nestloop', 'jit')"


@contextmanager
def whole_base_plan(session: Session) -> Iterator[None]:
    """Plan the block's statements — each reads every (filtered) prospect with its one-row
    sources — without nested-loop joins and without JIT compilation (ADR-0019).

    A nested loop never beats a hash join over a whole base, and when the planner believes a table
    is empty (a VACUUM that ran while rows were being written leaves `reltuples = 0` on a full
    table until the next ANALYZE) it rescans the inner table for every outer row: minutes instead
    of milliseconds. JIT compiles for longer than such a statement runs. The settings are
    transaction-local and back to their defaults after the block (on an error, with the rollback).
    """
    session.execute(
        text(f"SELECT set_config(name, 'off', true) FROM pg_settings WHERE {WHOLE_BASE_OFF}")
    )
    yield
    session.execute(
        text(f"SELECT set_config(name, reset_val, true) FROM pg_settings WHERE {WHOLE_BASE_OFF}")
    )
