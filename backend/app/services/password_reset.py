"""Password reset (« Mot de passe oublié ? » and the admin's reset link).

A token (random, single-use, valid one hour) is e-mailed as a link to `/reinitialisation/<token>`;
only its SHA-256 is stored (`users.password_reset_token_hash`). A new request replaces the previous
token. Following the link sets a new password, clears the token and signs the account out
everywhere. Same pattern as `signups.py`: the mail goes out through the CIRCOE Toolbox once the
request is saved, and a mail failure never undoes it.

Self-service never reveals whether an address has an account: `request_reset` returns None for an
unknown, deactivated or pending account and the route answers the same thing.
"""

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models.users import User
from app.repositories import users as user_repository
from app.services import audit
from app.services.auth import USER_ENTITY, actor_for, normalize_email, validate_new_password
from app.services.errors import DomainError, ForbiddenError, NotFoundError
from app.services.organizations import can_edit_member
from app.services.toolbox.mcp_client import DraftInput, MailToolbox

logger = logging.getLogger(__name__)

TOKEN_VALIDITY = timedelta(hours=1)


class PasswordResetRefused(DomainError):
    """The new password is refused (`code` "password") or the link is dead (`code` "token")."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ResetIssued:
    """Who gets the mail and the raw token of its link (never stored)."""

    user_id: uuid.UUID
    email: str
    token: str


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _issue(session: Session, user: User) -> ResetIssued:
    token = secrets.token_urlsafe(32)
    user.password_reset_token_hash = _token_hash(token)
    user.password_reset_expires_at = datetime.now(UTC) + TOKEN_VALIDITY
    session.flush()
    return ResetIssued(user_id=user.id, email=user.email, token=token)


def request_reset(session: Session, email: str) -> ResetIssued | None:
    """Issue a token for an existing, active, non-pending account; None otherwise (logged only)."""
    user = user_repository.get_user_by_email(session, normalize_email(email))
    if user is None or not user.is_active or user.signup_token_hash is not None:
        logger.info("password_reset.ignored reason=no_eligible_account")
        return None
    issued = _issue(session, user)
    audit.record_event(
        session,
        actor_for(user),
        audit.AuditAction.MEMBER_UPDATED,
        entity_type=USER_ENTITY,
        entity_id=user.id,
        reason="password reset requested by the account",
    )
    logger.info("password_reset.requested user=%s", user.id)
    return issued


def request_for_member(
    session: Session, viewer: User, organization_id: uuid.UUID, user_id: uuid.UUID
) -> ResetIssued:
    """A member's reset link sent by who may edit that member (same rule as « Organisation »)."""
    member = session.get(User, user_id)
    if member is None or member.organization_id != organization_id:
        raise NotFoundError("Unknown member.")
    if not can_edit_member(viewer, member):
        raise ForbiddenError("Your role cannot reset this member's password.")
    issued = _issue(session, member)
    audit.record_event(
        session,
        actor_for(viewer),
        audit.AuditAction.MEMBER_UPDATED,
        entity_type=USER_ENTITY,
        entity_id=member.id,
        reason="password reset link sent by an administrator",
    )
    logger.info("password_reset.requested_by_admin user=%s by=%s", member.id, viewer.id)
    return issued


def confirm_reset(session: Session, token: str, new_password: str) -> User:
    """Set the new password behind a valid token; the token dies and every session is revoked."""
    user = session.scalar(select(User).where(User.password_reset_token_hash == _token_hash(token)))
    now = datetime.now(UTC)
    if (
        user is None
        or user.password_reset_expires_at is None
        or user.password_reset_expires_at <= now
        or not user.is_active
    ):
        raise PasswordResetRefused("token", "This link is invalid or has expired.")
    try:
        validate_new_password(new_password)
    except DomainError as error:
        raise PasswordResetRefused("password", str(error)) from error
    user.password_hash = hash_password(new_password)
    user.password_reset_token_hash = None
    user.password_reset_expires_at = None
    user_repository.revoke_user_sessions(session, user.id, now=now)
    session.flush()
    audit.record_event(
        session,
        actor_for(user),
        audit.AuditAction.AUTH_PASSWORD_RESET,
        entity_type=USER_ENTITY,
        entity_id=user.id,
        reason="password reset with the e-mailed link",
    )
    logger.info("password_reset.done user=%s", user.id)
    return user


def reset_mail(*, to: str, link: str) -> DraftInput:
    return DraftInput(
        to=[to],
        subject="VIPER — réinitialisation de votre mot de passe",
        text=(
            "Bonjour,\n\n"
            "Une réinitialisation du mot de passe de votre compte VIPER a été demandée. "
            "Pour choisir un nouveau mot de passe :\n"
            f"{link}\n\n"
            "Ce lien est valable 1 heure et ne peut servir qu'une fois.\n\n"
            "Ignorez ce message si vous n'êtes pas à l'origine de la demande : "
            "votre mot de passe actuel reste inchangé.\n\n"
            "— VIPER"
        ),
    )


def send_reset_mail(toolbox: MailToolbox | None, *, to: str, link: str) -> bool:
    """Send the link; False (logged) when it cannot leave. Never undoes the issued token."""
    if toolbox is None:
        logger.warning("password_reset.mail_skipped reason=toolbox_not_connected")
        return False
    try:
        toolbox.send_draft(toolbox.create_draft(reset_mail(to=to, link=link)))
    except Exception:
        logger.exception("password_reset.mail_failed")
        return False
    logger.info("password_reset.mail_sent")
    return True
