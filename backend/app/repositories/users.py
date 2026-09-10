"""Login account and session persistence."""

import uuid
from datetime import datetime

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.models.users import User, UserSession


def get_user_by_email(session: Session, email: str) -> User | None:
    return session.execute(select(User).where(User.email == email)).scalar_one_or_none()


def get_session_by_token_hash(session: Session, token_hash: str) -> UserSession | None:
    return session.execute(
        select(UserSession).where(UserSession.token_hash == token_hash)
    ).scalar_one_or_none()


def delete_dead_sessions(
    session: Session, user_id: uuid.UUID, *, now: datetime, idle_since: datetime
) -> None:
    """Drop the user's revoked or expired sessions so the table stays small."""
    session.execute(
        delete(UserSession).where(
            UserSession.user_id == user_id,
            or_(
                UserSession.revoked_at.is_not(None),
                UserSession.expires_at <= now,
                UserSession.last_seen_at <= idle_since,
            ),
        )
    )


def revoke_user_sessions(session: Session, user_id: uuid.UUID, *, now: datetime) -> None:
    session.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now)
        .execution_options(synchronize_session="fetch")
    )
