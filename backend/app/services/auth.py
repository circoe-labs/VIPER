"""Authentication: password check, server-side sessions and account bootstrap (ADR-0004).

Sessions are rows in `user_sessions`, looked up by the SHA-256 of the cookie token. They end on
logout (revoked), after `idle_timeout` without requests, or `absolute_timeout` after sign-in.
Sign-in, sign-out and account creation/reset are audited (security trail). Operations flush; the
caller (request or CLI unit of work) commits.
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.config import Settings
from app.core.security import (
    MAX_PASSWORD_LENGTH,
    hash_password,
    new_session_token,
    password_needs_rehash,
    session_token_hash,
    verify_password,
)
from app.models.users import User, UserSession
from app.repositories import users as user_repository
from app.services import audit
from app.services.audit import AuditAction
from app.services.errors import DomainError

MIN_PASSWORD_LENGTH = 12
# `entity_type` of account events; `users`/`user_sessions` field values are never audited.
USER_ENTITY = "user"
# Same rule as the `ck_users_email_format` CHECK.
EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+")
# `last_seen_at` is only rewritten when older than this: one write per minute, not per request.
LAST_SEEN_RESOLUTION = timedelta(minutes=1)


@dataclass(frozen=True, slots=True)
class SessionPolicy:
    idle_timeout: timedelta
    absolute_timeout: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> SessionPolicy:
        return cls(
            idle_timeout=timedelta(minutes=settings.session_idle_timeout_minutes),
            absolute_timeout=timedelta(hours=settings.session_absolute_timeout_hours),
        )


@dataclass(frozen=True, slots=True)
class OpenedSession:
    # Goes to the cookie only; the database keeps its hash.
    token: str
    record: UserSession


def normalize_email(email: str) -> str:
    return email.strip().lower()


def actor_for(user: User) -> ActorContext:
    return ActorContext(type=ActorType.HUMAN, id=str(user.id), display=user.display_name)


def authenticate(session: Session, email: str, password: str) -> User | None:
    """The account matching the credentials, or None — the same answer and cost for an unknown
    email and a wrong password. Upgrades the stored hash when the argon2 profile changed."""
    user = user_repository.get_user_by_email(session, normalize_email(email))
    if not verify_password(user.password_hash if user else None, password) or user is None:
        return None
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
        session.flush()
    return user


def _record_account_event(session: Session, actor: ActorContext, action: str, user: User) -> None:
    # Who and when only: no token, session id, address or user agent (decision I-30).
    audit.record_event(session, actor, action, entity_type=USER_ENTITY, entity_id=user.id)


def open_session(
    session: Session, user: User, policy: SessionPolicy, *, now: datetime | None = None
) -> OpenedSession:
    """Start a new session with a fresh random token (never reuses one the client sent).

    Audited as `auth.login` by the signed-in user.
    """
    now = now or datetime.now(UTC)
    user_repository.delete_dead_sessions(
        session, user.id, now=now, idle_since=now - policy.idle_timeout
    )
    token = new_session_token()
    record = UserSession(
        user=user,
        token_hash=session_token_hash(token),
        last_seen_at=now,
        expires_at=now + policy.absolute_timeout,
    )
    session.add(record)
    session.flush()
    _record_account_event(session, actor_for(user), AuditAction.AUTH_LOGIN, user)
    return OpenedSession(token=token, record=record)


def resolve_session(
    session: Session, token: str, policy: SessionPolicy, *, now: datetime | None = None
) -> UserSession | None:
    """The live session behind a cookie token; None when unknown, revoked or expired."""
    now = now or datetime.now(UTC)
    record = user_repository.get_session_by_token_hash(session, session_token_hash(token))
    if (
        record is None
        or record.revoked_at is not None
        or now >= record.expires_at
        or now >= record.last_seen_at + policy.idle_timeout
    ):
        return None
    if now - record.last_seen_at >= LAST_SEEN_RESOLUTION:
        record.last_seen_at = now
        session.flush()
    return record


def revoke_session(session: Session, record: UserSession) -> None:
    if record.revoked_at is None:
        record.revoked_at = datetime.now(UTC)
        session.flush()


def sign_out(session: Session, record: UserSession) -> None:
    """End the session on the user's request; audited as `auth.logout`."""
    if record.revoked_at is None:
        revoke_session(session, record)
        _record_account_event(session, actor_for(record.user), AuditAction.AUTH_LOGOUT, record.user)


def revoke_token(session: Session, token: str) -> None:
    """Revoke the session behind `token`, if any (e.g. the previous cookie at sign-in)."""
    record = user_repository.get_session_by_token_hash(session, session_token_hash(token))
    if record is not None:
        revoke_session(session, record)


def validate_new_password(password: str) -> None:
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        raise DomainError(
            f"The password must be {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters long."
        )


def create_or_reset_user(
    session: Session,
    actor: ActorContext,
    email: str,
    password: str,
    display_name: str | None = None,
) -> tuple[User, bool]:
    """Create the account, or reset its password when the email exists; returns (user, created).

    A reset signs out every session of the account. `display_name` is required to create and
    optional to reset (kept when omitted). Audited as `auth.user_created` / `auth.password_reset`
    (no field values: account rows never enter the audit log).
    """
    validate_new_password(password)
    email = normalize_email(email)
    if not EMAIL_PATTERN.fullmatch(email):
        raise DomainError("The email address is not valid.")
    name = (display_name or "").strip()
    user = user_repository.get_user_by_email(session, email)
    created = user is None
    if user is None:
        if not name:
            raise DomainError("A display name is required to create an account.")
        user = User(email=email, display_name=name, password_hash=hash_password(password))
        session.add(user)
    else:
        user.password_hash = hash_password(password)
        if name:
            user.display_name = name
        user_repository.revoke_user_sessions(session, user.id, now=datetime.now(UTC))
    session.flush()
    action = AuditAction.AUTH_USER_CREATED if created else AuditAction.AUTH_PASSWORD_RESET
    _record_account_event(session, actor, action, user)
    return user, created
