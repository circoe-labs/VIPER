"""What deleting rows would do, before the user confirms: blockers and ON DELETE effects.

Walks the incoming foreign keys of the ORM metadata (every table, exposed or not) from the rows to
delete: RESTRICT / NO ACTION references block the deletion, CASCADE ones delete rows (walked
further, so cascades of cascades are counted), SET NULL ones empty a reference. Domain blockers
come on top: a do-not-contact prospect cannot be deleted (ADR-0002). Read-only.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Prospect
from app.models.enums import ContactabilityStatus
from app.services.explorer.metadata import TableInfo
from app.services.explorer.policy import ExposurePolicy
from app.services.explorer.writes import DO_NOT_CONTACT_DELETE

MAX_DELETE_CHECK_KEYS = 100
MAX_CASCADE_DEPTH = 4


class DeleteAction(StrEnum):
    RESTRICT = "restrict"
    CASCADE = "cascade"
    SET_NULL = "set_null"


_ACTIONS = {"CASCADE": DeleteAction.CASCADE, "SET NULL": DeleteAction.SET_NULL}


@dataclass(frozen=True, slots=True)
class DeleteEffect:
    """`count` rows of `table` reference the deleted rows through `column`."""

    # None: a table the explorer does not expose (its name is not disclosed).
    table: str | None
    column: str | None
    action: DeleteAction
    count: int
    # 1 = references a deleted row directly; 2 = references a row deleted in cascade…
    depth: int


@dataclass(frozen=True, slots=True)
class DeleteCheck:
    rows: int
    blockers: list[str] = field(default_factory=list)
    effects: list[DeleteEffect] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return not self.blockers


def check_delete(
    session: Session,
    policy: ExposurePolicy,
    table: TableInfo,
    keys: Sequence[Mapping[str, object]],
) -> DeleteCheck:
    blockers: list[str] = []
    if table.writes.delete is not None:
        blockers.append(table.writes.delete)
    if len(keys) > 1 and not table.bulk_delete:
        blockers.append(
            "Suppression groupée impossible ici (suppressions en cascade) : supprimez les lignes"
            " une par une."
        )
    key_columns = [column.column for column in table.primary_key]
    rows = sa.select(table.table).where(
        sa.tuple_(*key_columns).in_([tuple(key[c.name] for c in key_columns) for key in keys])
    )
    found = session.scalar(sa.select(sa.func.count()).select_from(rows.subquery())) or 0
    if found < len(keys):
        blockers.append(f"{len(keys) - found} ligne(s) n’existent plus : actualisez la table.")
    effects: list[DeleteEffect] = []
    _walk(session, policy, table.table, rows, 1, effects, blockers)
    return DeleteCheck(rows=found, blockers=blockers, effects=effects)


def _walk(
    session: Session,
    policy: ExposurePolicy,
    parent: sa.Table,
    parent_rows: sa.Select[Any],
    depth: int,
    effects: list[DeleteEffect],
    blockers: list[str],
) -> None:
    blockers.extend(_domain_blockers(session, parent, parent_rows))
    for child in sorted(Base.metadata.tables.values(), key=lambda table: table.name):
        for foreign_key in sorted(child.foreign_keys, key=lambda fk: fk.parent.name):
            if foreign_key.column.table is not parent:
                continue
            match = foreign_key.parent.in_(parent_rows.with_only_columns(foreign_key.column))
            count = session.scalar(sa.select(sa.func.count()).select_from(child).where(match))
            if not count:
                continue
            action = _ACTIONS.get(foreign_key.ondelete or "", DeleteAction.RESTRICT)
            exposed = policy.table(child.name) is not None
            effects.append(
                DeleteEffect(
                    table=child.name if exposed else None,
                    column=foreign_key.parent.name if exposed else None,
                    action=action,
                    count=count,
                    depth=depth,
                )
            )
            if action is DeleteAction.RESTRICT:
                blockers.append(_restrict_message(parent, child, count, exposed))
            elif action is DeleteAction.CASCADE and depth < MAX_CASCADE_DEPTH:
                child_rows = sa.select(child).where(match)
                _walk(session, policy, child, child_rows, depth + 1, effects, blockers)


def _restrict_message(parent: sa.Table, child: sa.Table, count: int, exposed: bool) -> str:
    where = child.name if exposed else "des données non exposées"
    message = f"{count} ligne(s) de {where} y font référence : suppression bloquée."
    # Taxonomies and referents in use are deactivated, never deleted (ADR-0002).
    if "active" in parent.columns:
        message += " Désactivez plutôt la ligne (active = false)."
    return message


def _domain_blockers(session: Session, table: sa.Table, rows: sa.Select[Any]) -> list[str]:
    if table.name != Prospect.__tablename__:
        return []
    blocked = rows.subquery()
    count = session.scalar(
        sa.select(sa.func.count())
        .select_from(blocked)
        .where(blocked.c.contactability_status == ContactabilityStatus.DO_NOT_CONTACT.value)
    )
    return [DO_NOT_CONTACT_DELETE] if count else []
