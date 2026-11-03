"""Organisations, members and roles: who may sign in, and who may change what in « Organisation ».

Rights (`doc/architecture/organizations.md` §3):

- the **platform admin** (one account, `users.is_superadmin`) creates and renames organisations
  and manages the members of every organisation;
- an **admin** manages the members of their organisation: adds them, sets any role, deactivates;
- a **manager** adds members (role « Membre » only) and deactivates or reactivates them;
- a **member** sees the list.

Nobody changes their own role or deactivates themselves, only the platform admin touches the
platform admin, and an organisation always keeps one active admin. Operations flush; the request
commits.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.config import Settings
from app.models.organizations import (
    CIRCOE_ORGANIZATION_ID,
    NAME_MAX_LENGTH,
    Organization,
    OrganizationRole,
)
from app.models.users import User
from app.repositories import users as user_repository
from app.services import audit
from app.services.auth import EMAIL_PATTERN, normalize_email
from app.services.errors import (
    ConflictError,
    DomainError,
    ForbiddenError,
    InvalidFieldError,
    NotFoundError,
)

ORGANIZATION_ENTITY = "organization"
USER_ENTITY = "user"
ALL_ROLES = (OrganizationRole.ADMIN, OrganizationRole.MANAGER, OrganizationRole.MEMBER)
DOMAIN_PATTERN = r"^[a-z0-9.-]+\.[a-z]{2,}$"
# A first Infomaniak sign-in creates the account: nobody is signed in yet.
INFOMANIAK_ACTOR = ActorContext(
    type=ActorType.SYSTEM, display="Connexion Infomaniak", id="infomaniak-signin"
)


class SignInRefused(DomainError):
    """The account may not sign in; `code` is shown on the sign-in page (`?erreur=`)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- Sign-in rules -------------------------------------------------------------------------------


def _domain(email: str) -> str:
    return email.rsplit("@", 1)[-1]


def check_can_sign_in(user: User, settings: Settings) -> None:
    """The development-phase gate, for Infomaniak and password sign-ins alike."""
    if not user.is_active:
        raise SignInRefused("inactive", "This account is deactivated.")
    if _domain(user.email) not in settings.signin_domains:
        raise SignInRefused("domain", "Only CIRCOE addresses may sign in for now.")
    if user.organization_id != CIRCOE_ORGANIZATION_ID:
        # Reads are not filtered per organisation yet: only CIRCOE's own members come in.
        raise SignInRefused("organization", "This organisation is not open yet.")


@dataclass(frozen=True, slots=True)
class Identity:
    """What Infomaniak says about the person (userinfo)."""

    sub: str
    email: str
    email_verified: bool | None
    name: str | None


def sign_in_identity(session: Session, settings: Settings, identity: Identity) -> User:
    """The account behind an Infomaniak identity, created at the first sign-in of a CIRCOE address.

    The account is found by its Infomaniak `sub`, else by its e-mail (then bound to that `sub`).
    A new address joins the organisation whose e-mail domain it has, as a member.
    """
    email = normalize_email(identity.email)
    if identity.email_verified is False:
        raise SignInRefused("unverified", "The Infomaniak address is not verified.")
    if not EMAIL_PATTERN.fullmatch(email) or _domain(email) not in settings.signin_domains:
        raise SignInRefused("domain", "Only CIRCOE addresses may sign in for now.")
    user = session.scalar(select(User).where(User.infomaniak_sub == identity.sub))
    if user is None:
        user = user_repository.get_user_by_email(session, email)
        if user is not None:
            if user.infomaniak_sub is not None and user.infomaniak_sub != identity.sub:
                raise SignInRefused("mismatch", "This address is bound to another account.")
            user.infomaniak_sub = identity.sub
    if user is None:
        organization = session.scalar(
            select(Organization).where(Organization.email_domain == _domain(email))
        )
        if organization is None:
            raise SignInRefused("domain", "No organisation for this address.")
        name = (identity.name or "").strip() or email.split("@", 1)[0]
        user = User(
            email=email,
            display_name=name[:255],
            password_hash=None,
            organization_id=organization.id,
            role=OrganizationRole.MEMBER,
            infomaniak_sub=identity.sub,
        )
        session.add(user)
        session.flush()
        audit.record_event(
            session,
            INFOMANIAK_ACTOR,
            audit.AuditAction.AUTH_USER_CREATED,
            entity_type=USER_ENTITY,
            entity_id=user.id,
            reason="first Infomaniak sign-in",
        )
    _grant_platform_admin(session, settings, user)
    check_can_sign_in(user, settings)
    session.flush()
    return user


def _grant_platform_admin(session: Session, settings: Settings, user: User) -> None:
    """The configured address becomes the platform admin while nobody holds the role."""
    if user.is_superadmin or user.email != normalize_email(settings.platform_admin_email):
        return
    if session.scalar(select(func.count()).select_from(User).where(User.is_superadmin)):
        return
    user.is_superadmin = True
    user.role = OrganizationRole.ADMIN
    session.flush()


def touch_login(user: User, now: datetime | None = None) -> None:
    user.last_login_at = now or datetime.now(UTC)


# --- Rights -------------------------------------------------------------------------------------


def assignable_roles(viewer: User, organization_id: uuid.UUID) -> tuple[OrganizationRole, ...]:
    """The roles `viewer` may give in this organisation (empty: cannot add nor change roles)."""
    if viewer.is_superadmin:
        return ALL_ROLES
    if viewer.organization_id != organization_id or not viewer.is_active:
        return ()
    if viewer.role is OrganizationRole.ADMIN:
        return ALL_ROLES
    if viewer.role is OrganizationRole.MANAGER:
        return (OrganizationRole.MEMBER,)
    return ()


def can_edit_member(viewer: User, member: User) -> bool:
    if member.id == viewer.id:
        return False
    if member.is_superadmin:
        return False
    if viewer.is_superadmin:
        return True
    if viewer.organization_id != member.organization_id:
        return False
    if viewer.role is OrganizationRole.ADMIN:
        return True
    return viewer.role is OrganizationRole.MANAGER and member.role is OrganizationRole.MEMBER


def can_change_role(viewer: User, member: User) -> bool:
    """A manager may (de)activate a member, not change roles."""
    return can_edit_member(viewer, member) and (
        viewer.is_superadmin or viewer.role is OrganizationRole.ADMIN
    )


def _visible(viewer: User, organization_id: uuid.UUID) -> None:
    if not viewer.is_superadmin and viewer.organization_id != organization_id:
        raise NotFoundError("Unknown organisation.")


# --- Organisations ------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OrganizationSummary:
    organization: Organization
    members: int


def list_organizations(session: Session, viewer: User) -> list[OrganizationSummary]:
    statement = (
        select(Organization, func.count(User.id))
        .outerjoin(User, User.organization_id == Organization.id)
        .group_by(Organization.id)
        .order_by(Organization.name)
    )
    if not viewer.is_superadmin:
        statement = statement.where(Organization.id == viewer.organization_id)
    return [
        OrganizationSummary(organization=organization, members=count)
        for organization, count in session.execute(statement).all()
    ]


def get_organization(session: Session, viewer: User, organization_id: uuid.UUID) -> Organization:
    _visible(viewer, organization_id)
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise NotFoundError("Unknown organisation.")
    return organization


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned or len(cleaned) > NAME_MAX_LENGTH:
        raise InvalidFieldError("name", f"1 to {NAME_MAX_LENGTH} characters.", "length")
    return cleaned


def _clean_domain(domain: str | None) -> str | None:
    cleaned = (domain or "").strip().lower().lstrip("@") or None
    if cleaned is not None and not re.fullmatch(DOMAIN_PATTERN, cleaned):
        raise InvalidFieldError("email_domain", "A domain such as circoe.com.", "format")
    return cleaned


def _require_platform_admin(viewer: User) -> None:
    if not viewer.is_superadmin:
        raise ForbiddenError("Only the platform admin manages organisations.")


def create_organization(
    session: Session, viewer: User, actor: ActorContext, name: str, email_domain: str | None
) -> Organization:
    _require_platform_admin(viewer)
    organization = Organization(name=_clean_name(name), email_domain=_clean_domain(email_domain))
    _unique(session, organization)
    session.add(organization)
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.ORGANIZATION_CREATED,
        entity_type=ORGANIZATION_ENTITY,
        entity_id=organization.id,
        changes={"name": {"after": organization.name}},
    )
    return organization


def update_organization(
    session: Session,
    viewer: User,
    actor: ActorContext,
    organization_id: uuid.UUID,
    name: str,
    email_domain: str | None,
) -> Organization:
    _require_platform_admin(viewer)
    organization = get_organization(session, viewer, organization_id)
    before = {"name": organization.name, "email_domain": organization.email_domain}
    organization.name = _clean_name(name)
    organization.email_domain = _clean_domain(email_domain)
    _unique(session, organization)
    session.flush()
    after = {"name": organization.name, "email_domain": organization.email_domain}
    audit.record_event(
        session,
        actor,
        audit.AuditAction.ORGANIZATION_UPDATED,
        entity_type=ORGANIZATION_ENTITY,
        entity_id=organization.id,
        changes={
            key: {"before": before[key], "after": after[key]}
            for key in before
            if before[key] != after[key]
        },
    )
    return organization


def _unique(session: Session, organization: Organization) -> None:
    clash = session.scalar(
        select(Organization).where(
            Organization.id != organization.id,
            (func.lower(Organization.name) == organization.name.lower())
            | (
                (Organization.email_domain == organization.email_domain)
                & Organization.email_domain.is_not(None)
            ),
        )
    )
    if clash is not None:
        field = "name" if clash.name.lower() == organization.name.lower() else "email_domain"
        raise InvalidFieldError(field, "Already used by another organisation.", "taken")


# --- Members ------------------------------------------------------------------------------------


def list_members(session: Session, viewer: User, organization_id: uuid.UUID) -> list[User]:
    get_organization(session, viewer, organization_id)
    return list(
        session.scalars(
            select(User)
            .where(User.organization_id == organization_id)
            .order_by(User.is_active.desc(), User.display_name)
        )
    )


def add_member(
    session: Session,
    viewer: User,
    actor: ActorContext,
    organization_id: uuid.UUID,
    *,
    email: str,
    display_name: str,
    role: OrganizationRole,
) -> User:
    """Register an address in advance: the person then signs in with Infomaniak."""
    get_organization(session, viewer, organization_id)
    if role not in assignable_roles(viewer, organization_id):
        raise ForbiddenError("Your role cannot add a member with this role.")
    address = normalize_email(email)
    if not EMAIL_PATTERN.fullmatch(address):
        raise InvalidFieldError("email", "The email address is not valid.", "format")
    name = " ".join(display_name.split())
    if not name:
        raise InvalidFieldError("display_name", "A name is required.", "missing")
    if user_repository.get_user_by_email(session, address) is not None:
        raise ConflictError("This address already has an account.")
    user = User(
        email=address,
        display_name=name[:255],
        password_hash=None,
        organization_id=organization_id,
        role=role,
    )
    session.add(user)
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MEMBER_ADDED,
        entity_type=USER_ENTITY,
        entity_id=user.id,
        subject=(ORGANIZATION_ENTITY, organization_id),
        changes={"role": {"after": role.value}},
    )
    return user


def update_member(
    session: Session,
    viewer: User,
    actor: ActorContext,
    organization_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    role: OrganizationRole | None = None,
    is_active: bool | None = None,
) -> User:
    get_organization(session, viewer, organization_id)
    member = session.get(User, user_id)
    if member is None or member.organization_id != organization_id:
        raise NotFoundError("Unknown member.")
    if not can_edit_member(viewer, member):
        raise ForbiddenError("Your role cannot change this member.")
    was_admin = member.is_active and member.role is OrganizationRole.ADMIN
    changes: dict[str, dict[str, object]] = {}
    if role is not None and role is not member.role:
        if not can_change_role(viewer, member) or role not in assignable_roles(
            viewer, organization_id
        ):
            raise ForbiddenError("Your role cannot give this role.")
        changes["role"] = {"before": member.role.value, "after": role.value}
        member.role = role
    if is_active is not None and is_active is not member.is_active:
        changes["is_active"] = {"before": member.is_active, "after": is_active}
        member.is_active = is_active
        if not is_active:
            user_repository.revoke_user_sessions(session, member.id, now=datetime.now(UTC))
    if not changes:
        return member
    session.flush()
    if was_admin:
        _keep_an_admin(session, organization_id)
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MEMBER_UPDATED,
        entity_type=USER_ENTITY,
        entity_id=member.id,
        subject=(ORGANIZATION_ENTITY, organization_id),
        changes=changes,
    )
    return member


def _keep_an_admin(session: Session, organization_id: uuid.UUID) -> None:
    admins = session.scalar(
        select(func.count())
        .select_from(User)
        .where(
            User.organization_id == organization_id,
            User.is_active,
            (User.role == OrganizationRole.ADMIN) | User.is_superadmin,
        )
    )
    if not admins:
        raise ConflictError("The organisation must keep at least one active admin.")
