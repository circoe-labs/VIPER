"""FastAPI dependencies shared by routers."""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import unit_of_work


def get_session(request: Request) -> Iterator[Session]:
    """One request = one transaction: committed when the route returns, rolled back if it raises."""
    session_factory: sessionmaker[Session] = request.app.state.session_factory
    with unit_of_work(session_factory) as session:
        yield session


# scope="function": commit before the response is sent, so a failed commit fails the request.
SessionDep = Annotated[Session, Depends(get_session, scope="function")]
