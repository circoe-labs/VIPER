"""FastAPI dependencies shared by routers."""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, sessionmaker

from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE, cleared_session_cookie_header
from app.core.actor import ActorContext
from app.core.config import Settings
from app.core.security import csrf_token_matches
from app.db.session import unit_of_work
from app.models.users import User, UserSession
from app.services.auth import SessionPolicy, actor_for, resolve_session

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def get_session(request: Request) -> Iterator[Session]:
    """One request = one transaction: committed when the route returns, rolled back if it raises."""
    session_factory: sessionmaker[Session] = request.app.state.session_factory
    with unit_of_work(session_factory) as session:
        yield session


# scope="function": commit before the response is sent, so a failed commit fails the request.
SessionDep = Annotated[Session, Depends(get_session, scope="function")]


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


SettingsDep = Annotated[Settings, Depends(get_app_settings)]


@dataclass(frozen=True, slots=True)
class Authenticated:
    record: UserSession
    # The cookie value, needed to derive the CSRF token; never logged or returned.
    token: str

    @property
    def user(self) -> User:
        return self.record.user


def require_session(request: Request, session: SessionDep, settings: SettingsDep) -> Authenticated:
    """Guard of every non-public route (mounted on `api_router`).

    401 without a live session (an invalid cookie is also expired on the client); 403 when an
    unsafe method lacks the session's CSRF token.
    """
    token = request.cookies.get(SESSION_COOKIE)
    record = (
        resolve_session(session, token, SessionPolicy.from_settings(settings)) if token else None
    )
    if token is None or record is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Not authenticated.",
            headers=cleared_session_cookie_header(settings) if token else None,
        )
    if request.method not in SAFE_METHODS and not csrf_token_matches(
        token, request.headers.get(CSRF_HEADER, "")
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing or invalid CSRF token.")
    return Authenticated(record=record, token=token)


AuthDep = Annotated[Authenticated, Depends(require_session)]


def get_current_actor(auth: AuthDep) -> ActorContext:
    """The signed-in human, built from the server-side session — never from the request body."""
    return actor_for(auth.user)


# Mutation routes pass this to services as their `actor` argument.
CurrentActor = Annotated[ActorContext, Depends(get_current_actor)]
