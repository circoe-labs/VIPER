"""Mission categories and instruction skills (`/api/mission-categories`, `/api/mission-skills`).

Reads are open to any signed-in person (the mission form lists them); writes are an admin's
(platform admin or « Organisation » admin, 403 `forbidden` otherwise). Skills are instruction text
only. Refusals: 404 `not_found`, 422 `invalid` (`field`, `reason`: `immutable`, `format`…), 409
`duplicate` (a category / skill with that name), 409 `in_use` (a category still used by missions),
409 `category_system` (a built-in category cannot be deleted).

Contract: `doc/architecture/missions.md` § « Catégories, skills et héritage ».
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import AuthDep, CurrentActor, SessionDep
from app.api.errors import business_errors
from app.models.enums import MissionType
from app.models.organizations import OrganizationRole
from app.services import mission_categories as service
from app.services.errors import ForbiddenError

categories_router = APIRouter(prefix="/mission-categories", tags=["mission-categories"])
skills_router = APIRouter(prefix="/mission-skills", tags=["mission-skills"])


def require_admin(auth: AuthDep) -> None:
    """Category and skill administration: the platform admin or an organisation admin."""
    if not (auth.user.is_superadmin or auth.user.role is OrganizationRole.ADMIN):
        raise ForbiddenError("Only an administrator manages mission categories and skills.")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SkillRefOut(BaseModel):
    id: uuid.UUID
    name: str


class CategoryOut(BaseModel):
    id: uuid.UUID
    # A built-in category carries its technical type here and cannot be deleted; null otherwise.
    key: str | None
    is_system: bool
    name: str
    description: str | None
    icon: str
    color: str
    general_prompt: str
    # The technical execution discriminator (immutable): how VIPER runs missions of this category.
    mission_type: MissionType
    position: int
    skills: list[SkillRefOut]
    missions_count: int
    created_at: datetime
    updated_at: datetime


class CategoryIn(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    icon: str = Field(min_length=1, max_length=40)
    color: str = Field(min_length=1, max_length=7)
    general_prompt: str = Field(min_length=1, max_length=5000)
    # Required on creation; on update it must match the stored value.
    mission_type: MissionType | None = None
    skill_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
    position: int | None = Field(default=None, ge=0, le=10_000)


class CategorySkillsIn(StrictModel):
    skill_ids: list[uuid.UUID] = Field(max_length=100)


class SkillOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    content: str
    categories_count: int
    missions_count: int


class SkillIn(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    content: Annotated[str, Field(min_length=1, max_length=5000)]


def _category_out(row: service.CategoryRow) -> CategoryOut:
    return CategoryOut(
        id=row.id,
        key=row.key,
        is_system=row.is_system,
        name=row.name,
        description=row.description,
        icon=row.icon,
        color=row.color,
        general_prompt=row.general_prompt,
        mission_type=row.mission_type,
        position=row.position,
        skills=[SkillRefOut(id=skill.id, name=skill.name) for skill in row.skills],
        missions_count=row.missions_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _category_input(body: CategoryIn) -> service.CategoryInput:
    return service.CategoryInput(
        name=body.name,
        description=body.description,
        icon=body.icon,
        color=body.color,
        general_prompt=body.general_prompt,
        mission_type=body.mission_type,
        skill_ids=tuple(body.skill_ids),
        position=body.position,
    )


# --- categories ---------------------------------------------------------------------------------


@categories_router.get("")
def list_categories(session: SessionDep) -> list[CategoryOut]:
    return [_category_out(row) for row in service.list_categories(session)]


@categories_router.get("/{category_id}")
def get_category(category_id: uuid.UUID, session: SessionDep) -> CategoryOut:
    with business_errors():
        return _category_out(service.get_category(session, category_id))


@categories_router.post("", status_code=status.HTTP_201_CREATED)
def create_category(
    body: CategoryIn, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> CategoryOut:
    with business_errors():
        require_admin(auth)
        return _category_out(service.create_category(session, actor, _category_input(body)))


@categories_router.put("/{category_id}")
def update_category(
    category_id: uuid.UUID,
    body: CategoryIn,
    session: SessionDep,
    actor: CurrentActor,
    auth: AuthDep,
) -> CategoryOut:
    """Rewrite the category; its new prompt reaches only the missions still inheriting it."""
    with business_errors():
        require_admin(auth)
        return _category_out(
            service.update_category(session, actor, category_id, _category_input(body))
        )


@categories_router.put("/{category_id}/skills")
def set_category_skills(
    category_id: uuid.UUID,
    body: CategorySkillsIn,
    session: SessionDep,
    actor: CurrentActor,
    auth: AuthDep,
) -> CategoryOut:
    """The ordered default skills of the category (association API)."""
    with business_errors():
        require_admin(auth)
        return _category_out(
            service.set_category_skills(session, actor, category_id, body.skill_ids)
        )


@categories_router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: uuid.UUID, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> None:
    with business_errors():
        require_admin(auth)
        service.delete_category(session, actor, category_id)


# --- skills -------------------------------------------------------------------------------------


@skills_router.get("")
def list_skills(session: SessionDep) -> list[SkillOut]:
    return [
        SkillOut.model_validate(row, from_attributes=True) for row in service.list_skills(session)
    ]


@skills_router.get("/{skill_id}")
def get_skill(skill_id: uuid.UUID, session: SessionDep) -> SkillOut:
    with business_errors():
        return SkillOut.model_validate(service.get_skill(session, skill_id), from_attributes=True)


@skills_router.post("", status_code=status.HTTP_201_CREATED)
def create_skill(
    body: SkillIn, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> SkillOut:
    with business_errors():
        require_admin(auth)
        row = service.create_skill(
            session,
            actor,
            service.SkillInput(name=body.name, content=body.content, description=body.description),
        )
    return SkillOut.model_validate(row, from_attributes=True)


@skills_router.put("/{skill_id}")
def update_skill(
    skill_id: uuid.UUID, body: SkillIn, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> SkillOut:
    with business_errors():
        require_admin(auth)
        row = service.update_skill(
            session,
            actor,
            skill_id,
            service.SkillInput(name=body.name, content=body.content, description=body.description),
        )
    return SkillOut.model_validate(row, from_attributes=True)


@skills_router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_skill(
    skill_id: uuid.UUID, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> None:
    """Delete a skill: it leaves every category and mission that used it."""
    with business_errors():
        require_admin(auth)
        service.delete_skill(session, actor, skill_id)
