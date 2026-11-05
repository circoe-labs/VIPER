"""Self-service sign-up (« Créer un compte » on the sign-in page).

Someone with an address of an open domain (`VIPER_SIGNIN_EMAIL_DOMAINS`) asks for an account: it
is created **deactivated**, with its password, and waits. The platform admin receives an e-mail
(through the CIRCOE Toolbox, like the Contact mails) with a link to `/inscriptions/<token>`; once
signed in, an admin approves (the account can sign in) or refuses (the request is deleted).

Who may decide: the platform admin, or an admin of the organisation the account joins. An address
that already has an account gets the same answer as a new one (no account enumeration) and nothing
changes for that account.
"""

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import hash_password
from app.models.organizations import Organization, OrganizationRole
from app.models.users import User
from app.repositories import users as user_repository
from app.services import audit
from app.services.auth import (
    EMAIL_PATTERN,
    USER_ENTITY,
    actor_for,
    normalize_email,
    validate_new_password,
)
from app.services.errors import ActorNotAllowedError, DomainError, NotFoundError
from app.services.toolbox.mcp_client import DraftInput, MailToolbox

logger = logging.getLogger(__name__)


class SignupRefused(DomainError):
    """The request cannot be made; `code` is shown on the sign-up page."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SignupRequested:
    """A new pending account and the raw token of its approval link (never stored)."""

    user_id: uuid.UUID
    token: str


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _domain(email: str) -> str:
    return email.rsplit("@", 1)[-1]


def request_signup(
    session: Session,
    *,
    email: str,
    display_name: str,
    password: str,
    allowed_domains: tuple[str, ...],
) -> SignupRequested | None:
    """Create the pending account; None when the address already has one (nothing changes)."""
    email = normalize_email(email)
    name = display_name.strip()
    if not EMAIL_PATTERN.fullmatch(email):
        raise SignupRefused("email", "The email address is not valid.")
    if not name:
        raise SignupRefused("name", "A name is required.")
    try:
        validate_new_password(password)
    except DomainError as error:
        raise SignupRefused("password", str(error)) from error
    if _domain(email) not in allowed_domains:
        raise SignupRefused("domain", "Only CIRCOE addresses may ask for an account.")
    organization = session.scalar(
        select(Organization).where(Organization.email_domain == _domain(email))
    )
    if organization is None:
        raise SignupRefused("domain", "No organisation for this address.")
    if user_repository.get_user_by_email(session, email) is not None:
        logger.info("signup.existing_account")
        return None
    token = secrets.token_urlsafe(32)
    user = User(
        email=email,
        display_name=name[:255],
        password_hash=hash_password(password),
        organization_id=organization.id,
        role=OrganizationRole.MEMBER,
        is_active=False,
        signup_requested_at=datetime.now(UTC),
        signup_token_hash=_token_hash(token),
    )
    session.add(user)
    session.flush()
    audit.record_event(
        session,
        actor_for(user),
        audit.AuditAction.AUTH_USER_CREATED,
        entity_type=USER_ENTITY,
        entity_id=user.id,
        reason="sign-up request, awaiting approval",
    )
    return SignupRequested(user_id=user.id, token=token)


def admin_email(session: Session) -> str | None:
    """Where the approval requests go: the platform admin."""
    return session.scalar(select(User.email).where(User.is_superadmin.is_(True)))


def pending_by_token(session: Session, token: str) -> User:
    user = session.scalar(select(User).where(User.signup_token_hash == _token_hash(token)))
    if user is None:
        raise NotFoundError("This sign-up request no longer exists (already handled?).")
    return user


def _check_can_decide(viewer: User, user: User) -> None:
    if viewer.is_superadmin:
        return
    if viewer.role == OrganizationRole.ADMIN and viewer.organization_id == user.organization_id:
        return
    raise ActorNotAllowedError("Only an admin may approve or refuse a sign-up request.")


def approve(session: Session, viewer: User, token: str) -> User:
    user = pending_by_token(session, token)
    _check_can_decide(viewer, user)
    user.is_active = True
    user.signup_token_hash = None
    user.signup_requested_at = None
    session.flush()
    audit.record_event(
        session,
        actor_for(viewer),
        audit.AuditAction.MEMBER_UPDATED,
        entity_type=USER_ENTITY,
        entity_id=user.id,
        reason="sign-up approved",
    )
    return user


def refuse(session: Session, viewer: User, token: str) -> None:
    user = pending_by_token(session, token)
    _check_can_decide(viewer, user)
    user_id = user.id
    session.delete(user)
    session.flush()
    audit.record_event(
        session,
        actor_for(viewer),
        audit.AuditAction.MEMBER_UPDATED,
        entity_type=USER_ENTITY,
        entity_id=user_id,
        reason="sign-up refused, request deleted",
    )


def approval_mail(*, admin: str, name: str, email: str, link: str) -> DraftInput:
    return DraftInput(
        to=[admin],
        subject=f"VIPER — demande de création de compte : {name}",
        text=(
            "Bonjour,\n\n"
            f"{name} ({email}) demande un compte sur VIPER.\n\n"
            "Le compte est créé mais désactivé. Pour le confirmer ou refuser la demande :\n"
            f"{link}\n\n"
            "— VIPER"
        ),
    )


def notify_admin(
    session_factory: sessionmaker[Session],
    toolbox: MailToolbox | None,
    *,
    user_id: uuid.UUID,
    link: str,
) -> bool:
    """Send the approval request to the platform admin; False (logged) when it cannot leave.

    Runs after the response: a failure never undoes the request, the account stays pending and
    visible in « Organisation ».
    """
    with session_factory() as session:
        admin = admin_email(session)
        user = session.get(User, user_id)
    if user is None:
        return False
    if admin is None:
        logger.warning("signup.notify_skipped reason=no_admin user=%s", user_id)
        return False
    if toolbox is None:
        logger.warning("signup.notify_skipped reason=toolbox_not_connected user=%s", user_id)
        return False
    try:
        draft_id = toolbox.create_draft(
            approval_mail(admin=admin, name=user.display_name, email=user.email, link=link)
        )
        toolbox.send_draft(draft_id)
    except Exception:
        logger.exception("signup.notify_failed user=%s", user_id)
        return False
    logger.info("signup.notified user=%s", user_id)
    return True
