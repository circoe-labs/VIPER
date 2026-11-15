"""« Nettoyer » a taxonomy (roles, activity categories, commercial segments): an AI proposes a
cleaner list of labels, a person edits it, then it is applied to the database.

**Propose** (`propose`): the active values (id, label, usage) go to the model with the
`taxonomy_cleanup_prompt`; it answers groups `{label, ids}` — every id in exactly one group. The
answer is checked and completed (an id the model forgot keeps its own label), so a proposal never
drops a value. Nothing is written.

**Apply** (`apply`): each group becomes one value. The group's most used member is kept (its id and
slug stay), renamed to the group's label; the other members are merged into it — every prospect or
company that referenced them now references the kept value — and deleted. Everything happens in the
caller's transaction: a refusal (duplicate label, unknown value) writes nothing.
"""

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, exists, func, insert, literal, select, update
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.config import Settings
from app.models import Company, Prospect
from app.models.companies import company_activity_categories
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories import taxonomies as repository
from app.services import audit
from app.services.errors import InvalidFieldError
from app.services.mail_generation.openai_client import (
    OpenAIMailGenerator,
    config_from_settings,
    not_configured,
)
from app.services.taxonomies import (
    LABEL_MAX_LENGTH,
    Taxonomy,
    list_values,
    rename_value,
    required_text,
)

SCHEMA_NAME = "taxonomy_cleanup"
SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["groups"],
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "ids"],
                "properties": {
                    "label": {"type": "string"},
                    "ids": {"type": "array", "items": {"type": "string"}},
                },
            },
        }
    },
}
# A list this long does not fit one answer; the person cleans it in parts (search) instead.
MAX_VALUES = 400


@dataclass(frozen=True, slots=True)
class Member:
    id: uuid.UUID
    label: str
    usage_count: int


@dataclass(frozen=True, slots=True)
class Group:
    label: str
    members: list[Member]


@dataclass(frozen=True, slots=True)
class Proposal:
    groups: list[Group]
    model: str


@dataclass(frozen=True, slots=True)
class Applied:
    renamed: int
    merged: int
    moved: int


def propose(
    session: Session, settings: Settings, taxonomy: Taxonomy, *, prompt: str, transport: Any = None
) -> Proposal:
    values = list_values(session, taxonomy, active=True)
    if len(values) > MAX_VALUES:
        raise InvalidFieldError(
            "taxonomy", f"Too many values to clean at once (at most {MAX_VALUES}).", "too_many"
        )
    members = {value.id: Member(value.id, value.label, value.usage_count) for value in values}
    if not members:
        return Proposal([], "")
    config = config_from_settings(settings)
    if config is None:
        raise not_configured([])
    generator = OpenAIMailGenerator(config, transport=transport)
    listing = json.dumps(
        [
            {"id": str(member.id), "label": member.label, "usage": member.usage_count}
            for member in members.values()
        ],
        ensure_ascii=False,
    )
    answer, model = generator.structured(
        prompt, f"Liste des libellés à nettoyer :\n{listing}", SCHEMA_NAME, SCHEMA
    )
    return Proposal(_checked_groups(answer, members), model)


def _checked_groups(answer: dict[str, Any], members: dict[uuid.UUID, Member]) -> list[Group]:
    """The model's groups, with unknown / repeated ids dropped, empty labels repaired and every
    value the model forgot put back under its own label. Ordered by label."""
    seen: set[uuid.UUID] = set()
    groups: list[Group] = []
    for raw in answer.get("groups") or []:
        if not isinstance(raw, dict):
            continue
        found: list[Member] = []
        for raw_id in raw.get("ids") or []:
            try:
                member = members.get(uuid.UUID(str(raw_id)))
            except ValueError:
                continue
            if member is not None and member.id not in seen:
                seen.add(member.id)
                found.append(member)
        if not found:
            continue
        label = " ".join(str(raw.get("label") or "").split())[:LABEL_MAX_LENGTH]
        groups.append(Group(label or found[0].label, found))
    groups.extend(
        Group(member.label, [member]) for member in members.values() if member.id not in seen
    )
    return sorted(groups, key=lambda group: group.label.casefold())


# --- apply ---------------------------------------------------------------------------------------

MODELS = {
    Taxonomy.ROLE: Role,
    Taxonomy.ACTIVITY_CATEGORY: ActivityCategory,
    Taxonomy.COMMERCIAL_SEGMENT: CommercialSegment,
}


def apply(
    session: Session,
    actor: ActorContext,
    taxonomy: Taxonomy,
    groups: Sequence[tuple[str, Sequence[uuid.UUID]]],
) -> Applied:
    """Apply the edited groups `(final label, member ids)`. Every id of a group must be an existing
    value, in no other group; two groups cannot end with the same label (merge them instead)."""
    model = MODELS[taxonomy]
    labels: dict[str, str] = {}
    claimed: set[uuid.UUID] = set()
    cleaned: list[tuple[str, list[uuid.UUID]]] = []
    for raw_label, ids in groups:
        label = required_text("label", raw_label, LABEL_MAX_LENGTH)
        key = _key(session, label)
        if key in labels:
            raise InvalidFieldError("label", f"« {label} » is used by two groups.", "duplicate")
        labels[key] = label
        members = list(dict.fromkeys(ids))
        if claimed & set(members):
            raise InvalidFieldError("ids", "A value is in two groups.", "duplicate")
        claimed |= set(members)
        cleaned.append((label, members))
    usage = {
        row.id: count
        for row, count in repository.list_values(session, model, search=None, active=None)
    }
    for _, members in cleaned:
        for member_id in members:
            if member_id not in usage:
                raise InvalidFieldError("ids", "Unknown value.", "unknown")
    renamed = merged = moved = 0
    for label, members in cleaned:
        if not members:
            continue
        keep = max(members, key=lambda member_id: (usage[member_id], str(member_id)))
        others = [member_id for member_id in members if member_id != keep]
        for other in others:
            moved += _move_references(session, taxonomy, other, keep)
        for other in others:
            _delete(session, actor, model, other)
            merged += 1
        session.flush()
        row = session.get(model, keep)
        if row is not None and row.label != label:
            rename_value(session, actor, taxonomy, keep, label)
            renamed += 1
    if merged:
        audit.record_event(
            session,
            actor,
            audit.settings_action(taxonomy.value, audit.SettingsChange.MERGED),
            entity_type=taxonomy.value,
            entity_id=None,
            changes={
                "merged": {"before": merged, "after": None},
                "moved": {"before": moved, "after": None},
            },
        )
    return Applied(renamed=renamed, merged=merged, moved=moved)


def _key(session: Session, label: str) -> str:
    return str(session.scalar(select(repository.label_key(label))))


def _delete(session: Session, actor: ActorContext, model: type, value_id: uuid.UUID) -> None:
    row = session.get(model, value_id)
    if row is None:
        return
    audit.annotate(session, actor, row)
    session.delete(row)


def _move_references(
    session: Session, taxonomy: Taxonomy, source: uuid.UUID, target: uuid.UUID
) -> int:
    """Point everything that referenced `source` at `target`; returns how many rows moved."""
    if taxonomy is Taxonomy.ROLE:
        return session.execute(
            update(Prospect).where(Prospect.role_id == source).values(role_id=target)
        ).rowcount
    if taxonomy is Taxonomy.COMMERCIAL_SEGMENT:
        return session.execute(
            update(Company)
            .where(Company.commercial_segment_id == source)
            .values(commercial_segment_id=target)
        ).rowcount
    links = company_activity_categories
    already = links.alias("already")
    # A company that already has the target keeps one link; the others move to it.
    session.execute(
        insert(links).from_select(
            ["company_id", "activity_category_id"],
            select(links.c.company_id, literal(target)).where(
                links.c.activity_category_id == source,
                ~exists().where(
                    already.c.company_id == links.c.company_id,
                    already.c.activity_category_id == target,
                ),
            ),
        )
    )
    moved = session.execute(
        select(func.count()).select_from(links).where(links.c.activity_category_id == source)
    ).scalar_one()
    session.execute(delete(links).where(links.c.activity_category_id == source))
    return int(moved)
