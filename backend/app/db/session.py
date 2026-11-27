"""Engine and session factories, and the unit of work. One engine per application instance."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

CONNECT_TIMEOUT_SECONDS = 5
# One application process (runbook-production.md): at most 30 connections, well under PostgreSQL's
# default 100.
POOL_SIZE = 10
POOL_MAX_OVERFLOW = 20
# A request finding no free connection fails after this long (503 `database_busy`) instead of
# piling up behind the others.
POOL_TIMEOUT_SECONDS = 10
# No statement waits longer than this for another transaction's lock: a stuck writer produces
# errors, never a frozen application.
LOCK_TIMEOUT_MS = 15_000
# PostgreSQL ends a transaction left idle this long, releasing its locks. Longer than any external
# call a request still makes inside a transaction.
IDLE_IN_TRANSACTION_TIMEOUT_MS = 600_000


def create_db_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        pool_pre_ping=True,
        pool_size=POOL_SIZE,
        max_overflow=POOL_MAX_OVERFLOW,
        pool_timeout=POOL_TIMEOUT_SECONDS,
        connect_args={
            "connect_timeout": CONNECT_TIMEOUT_SECONDS,
            "options": f"-c lock_timeout={LOCK_TIMEOUT_MS} "
            f"-c idle_in_transaction_session_timeout={IDLE_IN_TRANSACTION_TIMEOUT_MS}",
        },
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
