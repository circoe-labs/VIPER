"""« Organisation »: organisations, members and roles. Each answer carries what the signed-in
person may do (`can_*`, `assignable_roles`), so the page shows only the actions its role allows;
the service checks them again on every change (`app.services.organizations`)."""

import uuid
from datetime import datetime

from fastapi import APIRouter, status
from pydantic import BaseModel, Field

from app.api.dependencies import AuthDep, CurrentActor, SessionDep
from app.api.errors import business_errors
from app.models.organizations import NAME_MAX_LENGTH, Organization, OrganizationRole
from app.models.users import User
from app.services import organizations

router = APIRouter(prefix="/organizations", tags=["organizations"])


class OrganizationOut(BaseModel):
    id: uuid.UUID
    name: str
    email_domain: str | None
    members: int
    created_at: datetime


class MemberOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    role: OrganizationRole
    is_superadmin: bool
    is_active: bool
    # Signed in with Infomaniak at least once.
    infomaniak_linked: bool
    last_login_at: datetime | None
    can_edit: bool
    can_change_role: bool


class OrganizationDetail(BaseModel):
    organization: OrganizationOut
    members: list[MemberOut]
    # The roles the viewer may give here (empty: cannot add nor change roles).
    assignable_roles: list[OrganizationRole]
    can_rename: bool


class OrganizationsOut(BaseModel):
    organizations: list[OrganizationOut]
    can_create: bool


class OrganizationInput(BaseModel):
    name: str = Field(min_length=1, max_length=NAME_MAX_LENGTH)
    email_domain: str | None = Field(default=None, max_length=255)


class MemberInput(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str = Field(min_length=1, max_length=255)
    role: OrganizationRole = OrganizationRole.MEMBER


class MemberPatch(BaseModel):
    role: OrganizationRole | None = None
    is_active: bool | None = None


def _organization(organization: Organization, members: int) -> OrganizationOut:
    return OrganizationOut(
        id=organization.id,
        name=organization.name,
        email_domain=organization.email_domain,
        members=members,
        created_at=organization.created_at,
    )


def _member(viewer: User, member: User) -> MemberOut:
    return MemberOut(
        id=member.id,
        email=member.email,
        display_name=member.display_name,
        role=member.role,
        is_superadmin=member.is_superadmin,
        is_active=member.is_active,
        infomaniak_linked=member.infomaniak_sub is not None,
        last_login_at=member.last_login_at,
        can_edit=organizations.can_edit_member(viewer, member),
        can_change_role=organizations.can_change_role(viewer, member),
    )


def _detail(session: SessionDep, viewer: User, organization_id: uuid.UUID) -> OrganizationDetail:
    organization = organizations.get_organization(session, viewer, organization_id)
    members = organizations.list_members(session, viewer, organization_id)
    return OrganizationDetail(
        organization=_organization(organization, len(members)),
        members=[_member(viewer, member) for member in members],
        assignable_roles=list(organizations.assignable_roles(viewer, organization_id)),
        can_rename=viewer.is_superadmin,
    )


@router.get("")
def list_organizations(auth: AuthDep, session: SessionDep) -> OrganizationsOut:
    summaries = organizations.list_organizations(session, auth.user)
    return OrganizationsOut(
        organizations=[_organization(item.organization, item.members) for item in summaries],
        can_create=auth.user.is_superadmin,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_organization(
    body: OrganizationInput, auth: AuthDep, session: SessionDep, actor: CurrentActor
) -> OrganizationDetail:
    with business_errors():
        organization = organizations.create_organization(
            session, auth.user, actor, body.name, body.email_domain
        )
        return _detail(session, auth.user, organization.id)


@router.get("/{organization_id}")
def get_organization(
    organization_id: uuid.UUID, auth: AuthDep, session: SessionDep
) -> OrganizationDetail:
    with business_errors():
        return _detail(session, auth.user, organization_id)


@router.put("/{organization_id}")
def update_organization(
    organization_id: uuid.UUID,
    body: OrganizationInput,
    auth: AuthDep,
    session: SessionDep,
    actor: CurrentActor,
) -> OrganizationDetail:
    with business_errors():
        organizations.update_organization(
            session, auth.user, actor, organization_id, body.name, body.email_domain
        )
        return _detail(session, auth.user, organization_id)


@router.post("/{organization_id}/members", status_code=status.HTTP_201_CREATED)
def add_member(
    organization_id: uuid.UUID,
    body: MemberInput,
    auth: AuthDep,
    session: SessionDep,
    actor: CurrentActor,
) -> MemberOut:
    with business_errors():
        member = organizations.add_member(
            session,
            auth.user,
            actor,
            organization_id,
            email=body.email,
            display_name=body.display_name,
            role=body.role,
        )
        return _member(auth.user, member)


@router.patch("/{organization_id}/members/{user_id}")
def update_member(
    organization_id: uuid.UUID,
    user_id: uuid.UUID,
    body: MemberPatch,
    auth: AuthDep,
    session: SessionDep,
    actor: CurrentActor,
) -> MemberOut:
    with business_errors():
        member = organizations.update_member(
            session,
            auth.user,
            actor,
            organization_id,
            user_id,
            role=body.role,
            is_active=body.is_active,
        )
        return _member(auth.user, member)
