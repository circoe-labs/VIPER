"""Mission categories, instruction skills and the field-level inheritance of a mission.

Admin-managed taxonomy (`MissionCategory`) and reusable instruction text (`MissionSkill`); the
mission service (`app.services.missions`) uses `resolve_category`, `apply_inheritance` and
`effective_skills` so a mission follows its category until a person overrides a field.

- A category's `mission_type` is the technical execution discriminator (`MissionType`): chosen at
  creation, immutable, copied to `Mission.type`. Editing the taxonomy never re-routes a mission.
- Inheritable mission fields: `prompt`, `skills` and `sources` (`INHERITABLE_FIELDS`; the
  source library and its defaults live in `mission_sources`, Slice 02). A field is *overridden*
  only when `Mission.overridden_fields` says so; a category edit rewrites `Mission.prompt` for
  the missions that still inherit it, never for an overriding one.
- Any category may be deleted; one still used by missions answers 409 `in_use` unless the caller
  confirms the cascade (each mission goes through `missions.delete`). A skill deletion detaches it everywhere.

Operations flush; the caller owns the transaction. Changes are audited
(`mission_category.*` / `mission_skill.*`, plus `mission.updated` for a propagated prompt).
Contract: `doc/architecture/missions.md`.
"""

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import MissionType
from app.models.mission_categories import (
    CATEGORY_DESCRIPTION_MAX_LENGTH,
    CATEGORY_ICON_MAX_LENGTH,
    CATEGORY_NAME_MAX_LENGTH,
    CATEGORY_PROMPT_MAX_LENGTH,
    COLOR_PATTERN,
    ICON_PATTERN,
    INHERITABLE_FIELDS,
    SKILL_CONTENT_MAX_LENGTH,
    SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_NAME_MAX_LENGTH,
    MissionCategory,
    MissionCategorySkill,
    MissionSkill,
    MissionSkillLink,
)
from app.models.missions import Mission
from app.services import audit, mission_sources
from app.services.errors import (
    DuplicateValueError,
    ExistingValue,
    InUseError,
    InvalidFieldError,
    NotFoundError,
)

PROMPT_FIELD = "prompt"
SKILLS_FIELD = "skills"
SOURCES_FIELD = mission_sources.SOURCES_FIELD


@dataclass(frozen=True, slots=True)
class CategoryInput:
    """The editable part of a category (a `PUT` rewrites all of it, skills included)."""

    name: str
    icon: str
    color: str
    general_prompt: str
    description: str | None = None
    # Required on creation; on update it must equal the stored one (immutable) when given.
    mission_type: MissionType | None = None
    skill_ids: tuple[uuid.UUID, ...] = ()
    position: int | None = None
    # None = leave the default sources as they are (a `PUT` without the field keeps them).
    source_ids: tuple[uuid.UUID, ...] | None = None


@dataclass(frozen=True, slots=True)
class SkillInput:
    name: str
    content: str
    description: str | None = None


@dataclass(frozen=True, slots=True)
class SkillRef:
    id: uuid.UUID
    name: str


@dataclass(frozen=True, slots=True)
class CategoryRef:
    """What a mission card needs from its category: the visual identity."""

    id: uuid.UUID
    key: str | None
    name: str
    icon: str
    color: str


@dataclass(frozen=True, slots=True)
class CategoryRow:
    id: uuid.UUID
    key: str | None
    name: str
    description: str | None
    icon: str
    color: str
    general_prompt: str
    mission_type: MissionType
    position: int
    skills: list[SkillRef]
    missions_count: int
    created_at: datetime
    updated_at: datetime
    # The external sources a mission of this category follows until it overrides `sources`.
    sources: list[mission_sources.SourceRef] = field(default_factory=list)

    @property
    def is_system(self) -> bool:
        return self.key is not None


@dataclass(frozen=True, slots=True)
class SkillRow:
    id: uuid.UUID
    name: str
    description: str | None
    content: str
    categories_count: int
    missions_count: int


@dataclass(frozen=True, slots=True)
class MissionInheritance:
    """Where a mission stands against its category, for the edit form."""

    category_id: uuid.UUID | None
    overridden_fields: list[str]
    prompt_inherited: bool
    skills_inherited: bool
    # What the category would give now (`None` without a category): « Rétablir » shows it.
    category_prompt: str | None
    category_skills: list[SkillRef]
    sources_inherited: bool = True
    category_sources: list[mission_sources.SourceRef] = field(default_factory=list)


# --- validation ---------------------------------------------------------------------------------


def _text(name: str, value: str, max_length: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise InvalidFieldError(name, "A value is required.", "empty")
    if len(cleaned) > max_length:
        raise InvalidFieldError(name, f"At most {max_length} characters.", "too_long")
    return cleaned


def _optional_text(name: str, value: str | None, max_length: int) -> str | None:
    cleaned = (value or "").strip()
    if len(cleaned) > max_length:
        raise InvalidFieldError(name, f"At most {max_length} characters.", "too_long")
    return cleaned or None


def _icon(value: str) -> str:
    cleaned = _text("icon", value, CATEGORY_ICON_MAX_LENGTH)
    if not re.fullmatch(ICON_PATTERN, cleaned):
        raise InvalidFieldError("icon", "A lowercase glyph key such as « shield-check ».", "format")
    return cleaned


def _color(value: str) -> str:
    cleaned = value.strip()
    if not re.fullmatch(COLOR_PATTERN, cleaned):
        raise InvalidFieldError("color", "A colour as #RRGGBB.", "format")
    return cleaned.lower()


def _duplicate[T: (MissionCategory, MissionSkill)](
    session: Session,
    model: type[T],
    name: str,
    *,
    except_id: uuid.UUID | None = None,
) -> None:
    statement = select(model).where(func.lower(model.name) == name.lower())
    if except_id is not None:
        statement = statement.where(model.id != except_id)
    existing = session.scalars(statement).first()
    if existing is not None:
        raise DuplicateValueError("name", ExistingValue(existing.id, existing.name, True))


# --- skills -------------------------------------------------------------------------------------


def _skill_row(session: Session, skill: MissionSkill) -> SkillRow:
    categories = session.scalar(
        select(func.count())
        .select_from(MissionCategorySkill)
        .where(MissionCategorySkill.skill_id == skill.id)
    )
    missions = session.scalar(
        select(func.count())
        .select_from(MissionSkillLink)
        .where(MissionSkillLink.skill_id == skill.id)
    )
    return SkillRow(
        id=skill.id,
        name=skill.name,
        description=skill.description,
        content=skill.content,
        categories_count=categories or 0,
        missions_count=missions or 0,
    )


def list_skills(session: Session) -> list[SkillRow]:
    skills = session.scalars(select(MissionSkill).order_by(func.lower(MissionSkill.name))).all()
    return [_skill_row(session, skill) for skill in skills]


def get_skill(session: Session, skill_id: uuid.UUID) -> SkillRow:
    return _skill_row(session, _skill(session, skill_id))


def _skill(session: Session, skill_id: uuid.UUID) -> MissionSkill:
    skill = session.get(MissionSkill, skill_id)
    if skill is None:
        raise NotFoundError("Unknown skill.")
    return skill


def create_skill(session: Session, actor: ActorContext, data: SkillInput) -> SkillRow:
    name = _text("name", data.name, SKILL_NAME_MAX_LENGTH)
    _duplicate(session, MissionSkill, name)
    skill = MissionSkill(
        name=name,
        description=_optional_text("description", data.description, SKILL_DESCRIPTION_MAX_LENGTH),
        content=_text("content", data.content, SKILL_CONTENT_MAX_LENGTH),
    )
    audit.annotate(session, actor, skill)
    session.add(skill)
    session.flush()
    return _skill_row(session, skill)


def update_skill(
    session: Session, actor: ActorContext, skill_id: uuid.UUID, data: SkillInput
) -> SkillRow:
    skill = _skill(session, skill_id)
    name = _text("name", data.name, SKILL_NAME_MAX_LENGTH)
    _duplicate(session, MissionSkill, name, except_id=skill.id)
    audit.annotate(session, actor, skill)
    skill.name = name
    skill.description = _optional_text(
        "description", data.description, SKILL_DESCRIPTION_MAX_LENGTH
    )
    skill.content = _text("content", data.content, SKILL_CONTENT_MAX_LENGTH)
    session.flush()
    return _skill_row(session, skill)


def delete_skill(session: Session, actor: ActorContext, skill_id: uuid.UUID) -> None:
    """Delete a skill; it leaves every category and mission that used it (FK cascade). The audit
    event says how many places it left."""
    skill = _skill(session, skill_id)
    row = _skill_row(session, skill)
    audit.annotate(
        session,
        actor,
        skill,
        reason=f"detached from {row.categories_count} categories, {row.missions_count} missions",
    )
    session.delete(skill)
    session.flush()


def _skills_by_ids(session: Session, skill_ids: Sequence[uuid.UUID]) -> list[MissionSkill]:
    """The skills, in the order given and without duplicates; an unknown id is a 422."""
    ordered = list(dict.fromkeys(skill_ids))
    found = {
        skill.id: skill
        for skill in session.scalars(select(MissionSkill).where(MissionSkill.id.in_(ordered)))
    }
    missing = [skill_id for skill_id in ordered if skill_id not in found]
    if missing:
        raise InvalidFieldError("skill_ids", f"Unknown skill: {missing[0]}.", "not_found")
    return [found[skill_id] for skill_id in ordered]


# --- categories ---------------------------------------------------------------------------------


def _category(session: Session, category_id: uuid.UUID, *, lock: bool = False) -> MissionCategory:
    statement = select(MissionCategory).where(MissionCategory.id == category_id)
    category = session.scalar(statement.with_for_update() if lock else statement)
    if category is None:
        raise NotFoundError("Unknown category.")
    return category


def category_skill_refs(session: Session, category_id: uuid.UUID) -> list[SkillRef]:
    rows = session.execute(
        select(MissionSkill.id, MissionSkill.name)
        .join(MissionCategorySkill, MissionCategorySkill.skill_id == MissionSkill.id)
        .where(MissionCategorySkill.category_id == category_id)
        .order_by(MissionCategorySkill.position, MissionSkill.name)
    ).all()
    return [SkillRef(id=skill_id, name=name) for skill_id, name in rows]


def _category_row(session: Session, category: MissionCategory) -> CategoryRow:
    missions = session.scalar(
        select(func.count()).select_from(Mission).where(Mission.category_id == category.id)
    )
    return CategoryRow(
        id=category.id,
        key=category.key,
        name=category.name,
        description=category.description,
        icon=category.icon,
        color=category.color,
        general_prompt=category.general_prompt,
        mission_type=category.mission_type,
        position=category.position,
        skills=category_skill_refs(session, category.id),
        missions_count=missions or 0,
        created_at=category.created_at,
        updated_at=category.updated_at,
        sources=mission_sources.category_source_refs(session, category.id),
    )


def category_ref(category: MissionCategory) -> CategoryRef:
    return CategoryRef(
        id=category.id,
        key=category.key,
        name=category.name,
        icon=category.icon,
        color=category.color,
    )


def list_categories(session: Session) -> list[CategoryRow]:
    categories = session.scalars(
        select(MissionCategory).order_by(MissionCategory.position, MissionCategory.created_at)
    ).all()
    return [_category_row(session, category) for category in categories]


def get_category(session: Session, category_id: uuid.UUID) -> CategoryRow:
    return _category_row(session, _category(session, category_id))


def _set_default_skills(
    session: Session, category: MissionCategory, skill_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    skills = _skills_by_ids(session, skill_ids)
    session.execute(
        sql_delete(MissionCategorySkill).where(MissionCategorySkill.category_id == category.id)
    )
    session.flush()
    for position, skill in enumerate(skills):
        session.add(
            MissionCategorySkill(category_id=category.id, skill_id=skill.id, position=position)
        )
    session.flush()
    return [skill.id for skill in skills]


def _replace_default_skills(
    session: Session,
    actor: ActorContext,
    category: MissionCategory,
    skill_ids: Sequence[uuid.UUID],
) -> None:
    """Replace the category's default skills; the change is audited on the category."""
    previous = [skill.id for skill in category_skill_refs(session, category.id)]
    skills = _set_default_skills(session, category, skill_ids)
    if skills == previous:
        return
    audit.record_event(
        session,
        actor,
        audit.lifecycle_action("mission_category", audit.Lifecycle.UPDATED),
        entity_type="mission_category",
        entity_id=category.id,
        changes={
            "skill_ids": {
                "before": [str(skill_id) for skill_id in previous],
                "after": [str(skill_id) for skill_id in skills],
            }
        },
    )


def set_category_skills(
    session: Session,
    actor: ActorContext,
    category_id: uuid.UUID,
    skill_ids: Sequence[uuid.UUID],
) -> CategoryRow:
    """`PUT /mission-categories/{id}/skills`: the whole ordered list of default skills."""
    category = _category(session, category_id, lock=True)
    _replace_default_skills(session, actor, category, skill_ids)
    return _category_row(session, category)


def _replace_default_sources(
    session: Session,
    actor: ActorContext,
    category: MissionCategory,
    source_ids: Sequence[uuid.UUID],
) -> None:
    """Replace the category's default sources; the change is audited on the category."""
    previous = [source.id for source in mission_sources.category_sources(session, category.id)]
    stored = mission_sources.set_category_sources(session, category, source_ids)
    if stored == previous:
        return
    audit.record_event(
        session,
        actor,
        audit.lifecycle_action("mission_category", audit.Lifecycle.UPDATED),
        entity_type="mission_category",
        entity_id=category.id,
        changes={
            "source_ids": {
                "before": [str(source_id) for source_id in previous],
                "after": [str(source_id) for source_id in stored],
            }
        },
    )


def set_category_sources(
    session: Session,
    actor: ActorContext,
    category_id: uuid.UUID,
    source_ids: Sequence[uuid.UUID],
) -> CategoryRow:
    """`PUT /mission-categories/{id}/sources`: the whole ordered list of default sources. Nothing
    is written to missions: those still inheriting `sources` read the live defaults."""
    category = _category(session, category_id, lock=True)
    _replace_default_sources(session, actor, category, source_ids)
    return _category_row(session, category)


def create_category(session: Session, actor: ActorContext, data: CategoryInput) -> CategoryRow:
    if data.mission_type is None:
        raise InvalidFieldError("mission_type", "The execution type is required.", "missing")
    name = _text("name", data.name, CATEGORY_NAME_MAX_LENGTH)
    _duplicate(session, MissionCategory, name)
    if data.position is None:
        last = session.scalar(select(func.max(MissionCategory.position)))
        position = (last if last is not None else -1) + 1
    else:
        position = data.position
    category = MissionCategory(
        key=None,
        name=name,
        description=_optional_text(
            "description", data.description, CATEGORY_DESCRIPTION_MAX_LENGTH
        ),
        icon=_icon(data.icon),
        color=_color(data.color),
        general_prompt=_text("general_prompt", data.general_prompt, CATEGORY_PROMPT_MAX_LENGTH),
        mission_type=data.mission_type,
        position=position,
    )
    audit.annotate(session, actor, category)
    session.add(category)
    session.flush()
    if data.skill_ids:
        _set_default_skills(session, category, data.skill_ids)
    if data.source_ids:
        mission_sources.set_category_sources(session, category, data.source_ids)
    return _category_row(session, category)


def update_category(
    session: Session, actor: ActorContext, category_id: uuid.UUID, data: CategoryInput
) -> CategoryRow:
    """Rewrite the editable fields. The new general prompt reaches only the missions that still
    inherit it; the execution type cannot change (422 `immutable`)."""
    category = _category(session, category_id, lock=True)
    if data.mission_type is not None and data.mission_type is not category.mission_type:
        raise InvalidFieldError(
            "mission_type", "The execution type of a category cannot change.", "immutable"
        )
    name = _text("name", data.name, CATEGORY_NAME_MAX_LENGTH)
    _duplicate(session, MissionCategory, name, except_id=category.id)
    prompt = _text("general_prompt", data.general_prompt, CATEGORY_PROMPT_MAX_LENGTH)
    icon, color = _icon(data.icon), _color(data.color)
    description = _optional_text("description", data.description, CATEGORY_DESCRIPTION_MAX_LENGTH)

    prompt_changed = prompt != category.general_prompt
    audit.annotate(session, actor, category)
    category.name = name
    category.description = description
    category.icon = icon
    category.color = color
    category.general_prompt = prompt
    if data.position is not None:
        category.position = data.position
    session.flush()
    _replace_default_skills(session, actor, category, data.skill_ids)
    if data.source_ids is not None:
        _replace_default_sources(session, actor, category, data.source_ids)
    if prompt_changed:
        propagate_prompt(session, actor, category)
    return _category_row(session, category)


def delete_category(
    session: Session,
    actor: ActorContext,
    category_id: uuid.UUID,
    *,
    confirm_cascade: bool = False,
) -> int:
    """Delete a category (built-in or not). A used category needs `confirm_cascade`: each mission is
    then removed through `missions.delete` (open tasks cancelled, pending results rejected, audit),
    never a raw SQL cascade. Returns the number of missions deleted."""
    from app.services import missions as mission_service  # missions imports this module

    category = _category(session, category_id, lock=True)
    mission_ids = session.scalars(
        select(Mission.id).where(Mission.category_id == category.id).order_by(Mission.id)
    ).all()
    if mission_ids and not confirm_cascade:
        raise InUseError({"missions": len(mission_ids)})
    for mission_id in mission_ids:
        mission_service.delete(session, actor, mission_id)
    audit.annotate(session, actor, category)
    session.delete(category)
    session.flush()
    return len(mission_ids)


# --- inheritance --------------------------------------------------------------------------------


def propagate_prompt(session: Session, actor: ActorContext, category: MissionCategory) -> int:
    """Write the category's prompt into every mission still inheriting it. Returns the count.

    A mission with `prompt` in `overridden_fields` is never touched, whatever its text says."""
    rows = session.scalars(
        select(Mission).where(Mission.category_id == category.id).with_for_update()
    ).all()
    changed = 0
    for mission in rows:
        if PROMPT_FIELD in (mission.overridden_fields or []):
            continue
        if mission.prompt == category.general_prompt:
            continue
        before = mission.prompt
        mission.prompt = category.general_prompt
        changed += 1
        audit.record_event(
            session,
            actor,
            audit.AuditAction.MISSION_UPDATED,
            entity_type="mission",
            entity_id=mission.id,
            changes={"prompt": {"before": before, "after": mission.prompt}},
            reason="category default propagated",
        )
    session.flush()
    return changed


def default_category(session: Session, mission_type: MissionType) -> MissionCategory | None:
    """The seeded category of a technical type (what a bare `type` resolves to)."""
    return session.scalars(
        select(MissionCategory).where(MissionCategory.key == mission_type.value)
    ).first()


def resolve_category(
    session: Session, category_id: uuid.UUID | None, mission_type: MissionType | None
) -> tuple[MissionCategory | None, MissionType]:
    """`(category, technical type)` for a mission being saved.

    A `category_id` gives its type (a different explicit `mission_type` is refused: 422
    `category_mismatch`); a bare type resolves to the seeded category of that type."""
    if category_id is not None:
        category = session.get(MissionCategory, category_id)
        if category is None:
            raise InvalidFieldError("category_id", "Unknown category.", "not_found")
        if mission_type is not None and mission_type is not category.mission_type:
            raise InvalidFieldError(
                "type",
                "The type does not match the category's execution type.",
                "category_mismatch",
            )
        return category, category.mission_type
    if mission_type is None:
        raise InvalidFieldError("category_id", "A category is required.", "missing")
    return default_category(session, mission_type), mission_type


def mission_skills(session: Session, mission_id: uuid.UUID) -> list[MissionSkill]:
    return list(
        session.scalars(
            select(MissionSkill)
            .join(MissionSkillLink, MissionSkillLink.skill_id == MissionSkill.id)
            .where(MissionSkillLink.mission_id == mission_id)
            .order_by(MissionSkillLink.position, MissionSkill.name)
        )
    )


def effective_skills(session: Session, mission: Mission) -> list[MissionSkill]:
    """The instruction skills a mission works with: its own list when it overrides `skills`,
    else the current defaults of its category. Instruction text only (no capability grant)."""
    if SKILLS_FIELD in (mission.overridden_fields or []):
        return mission_skills(session, mission.id)
    if mission.category_id is None:
        return []
    return list(
        session.scalars(
            select(MissionSkill)
            .join(MissionCategorySkill, MissionCategorySkill.skill_id == MissionSkill.id)
            .where(MissionCategorySkill.category_id == mission.category_id)
            .order_by(MissionCategorySkill.position, MissionSkill.name)
        )
    )


def set_mission_skills(
    session: Session, mission: Mission, skill_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    skills = _skills_by_ids(session, skill_ids)
    session.execute(sql_delete(MissionSkillLink).where(MissionSkillLink.mission_id == mission.id))
    session.flush()
    for position, skill in enumerate(skills):
        session.add(MissionSkillLink(mission_id=mission.id, skill_id=skill.id, position=position))
    session.flush()
    return [skill.id for skill in skills]


def apply_inheritance(
    session: Session,
    mission: Mission,
    category: MissionCategory | None,
    *,
    prompt: str | None,
    skill_ids: Sequence[uuid.UUID] | None,
    creating: bool,
    keep: frozenset[str] = frozenset(),
    source_ids: Sequence[uuid.UUID] | None = None,
) -> None:
    """Set `mission.prompt`, its skills, its sources and `overridden_fields` from what the person
    sent.

    `prompt` / `skill_ids` / `source_ids` of `None` mean « follow the category » (and reset an
    earlier override); a value overrides; a field named in `keep` (omitted from an update) keeps
    its state. On update only, a value equal to what an inherited field already holds is a form
    resubmitted unchanged: it stays inherited (and follows the category). Without a category a
    field cannot be inherited (a prompt is then required)."""
    overridden = [name for name in (mission.overridden_fields or []) if name in INHERITABLE_FIELDS]

    if PROMPT_FIELD in keep and not creating:
        prompt_inherited = PROMPT_FIELD not in overridden and category is not None
        if prompt_inherited and category is not None:
            mission.prompt = category.general_prompt
    elif prompt is None:
        if category is None:
            raise InvalidFieldError("prompt", "A value is required.", "empty")
        mission.prompt = category.general_prompt
        overridden = [name for name in overridden if name != PROMPT_FIELD]
    else:
        cleaned = _text("prompt", prompt, CATEGORY_PROMPT_MAX_LENGTH)
        unchanged = (
            not creating
            and PROMPT_FIELD not in overridden
            and category is not None
            and cleaned == mission.prompt
        )
        if unchanged and category is not None:
            mission.prompt = category.general_prompt
        else:
            mission.prompt = cleaned
            if PROMPT_FIELD not in overridden:
                overridden.append(PROMPT_FIELD)

    if SKILLS_FIELD in keep and not creating:
        pass
    elif skill_ids is None:
        if SKILLS_FIELD in overridden:
            session.execute(
                sql_delete(MissionSkillLink).where(MissionSkillLink.mission_id == mission.id)
            )
            overridden = [name for name in overridden if name != SKILLS_FIELD]
    else:
        wanted = list(dict.fromkeys(skill_ids))
        unchanged_skills = (
            not creating
            and SKILLS_FIELD not in overridden
            and category is not None
            and wanted == [skill.id for skill in effective_skills(session, mission)]
        )
        if not unchanged_skills:
            set_mission_skills(session, mission, wanted)
            if SKILLS_FIELD not in overridden:
                overridden.append(SKILLS_FIELD)
    if SOURCES_FIELD in keep and not creating:
        pass
    elif source_ids is None:
        if SOURCES_FIELD in overridden:
            mission_sources.clear_mission_sources(session, mission)
            overridden = [name for name in overridden if name != SOURCES_FIELD]
    else:
        wanted_sources = list(dict.fromkeys(source_ids))
        unchanged_sources = (
            not creating
            and SOURCES_FIELD not in overridden
            and category is not None
            and wanted_sources
            == [source.id for source in mission_sources.effective_sources(session, mission)]
        )
        if not unchanged_sources:
            mission_sources.set_mission_sources(session, mission, wanted_sources)
            if SOURCES_FIELD not in overridden:
                overridden.append(SOURCES_FIELD)
    mission.overridden_fields = sorted(overridden)
    session.flush()


def inheritance(session: Session, mission: Mission) -> MissionInheritance:
    category = session.get(MissionCategory, mission.category_id) if mission.category_id else None
    overridden = list(mission.overridden_fields or [])
    return MissionInheritance(
        category_id=mission.category_id,
        overridden_fields=overridden,
        prompt_inherited=category is not None and PROMPT_FIELD not in overridden,
        skills_inherited=category is not None and SKILLS_FIELD not in overridden,
        category_prompt=category.general_prompt if category is not None else None,
        category_skills=category_skill_refs(session, category.id) if category is not None else [],
        sources_inherited=category is not None and SOURCES_FIELD not in overridden,
        category_sources=(
            mission_sources.category_source_refs(session, category.id)
            if category is not None
            else []
        ),
    )
