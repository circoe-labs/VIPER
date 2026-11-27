"""WHERE building blocks of the list filters shared by Prospection, Entreprises and Entrepôts.

Every filter takes several values: within one filter they are alternatives (OR), and the filters
combine with AND (the caller's list of conditions). An empty selection adds no condition.
"""

import uuid
from collections.abc import Sequence
from typing import Literal

from sqlalchemy import ColumnElement, SQLColumnExpression, case, exists, func, or_, select

from app.models import Company, Establishment
from app.models.companies import company_activity_categories

# "No value" in a filter selection (no segment, no category, no role…).
NONE: Literal["none"] = "none"
# A French department as filtered: two digits, three for overseas (971…, 98x).
DEPARTMENT_PATTERN = r"^([0-9]{2}|9[78][0-9])$"


def any_ref(
    column: SQLColumnExpression[uuid.UUID | None], values: Sequence[uuid.UUID | str]
) -> list[ColumnElement[bool]]:
    """`column` is one of `values`; `none` among them also matches an empty column."""
    if not values:
        return []
    ids = [value for value in values if isinstance(value, uuid.UUID)]
    choices: list[ColumnElement[bool]] = [column.in_(ids)] if ids else []
    if NONE in values:
        choices.append(column.is_(None))
    return [or_(*choices)]


def department_of(postal_code: SQLColumnExpression[str | None]) -> ColumnElement[str | None]:
    """The department of a French postal code; NULL for anything but five digits."""
    code = func.btrim(postal_code)
    return case(
        (code.regexp_match("^9[78][0-9]{3}$"), func.left(code, 3)),
        (code.regexp_match("^[0-9]{5}$"), func.left(code, 2)),
    )


def company_conditions(
    *,
    kinds: Sequence[str] = (),
    segments: Sequence[uuid.UUID | str] = (),
    categories: Sequence[uuid.UUID | str] = (),
    departments: Sequence[str] = (),
    services: Sequence[str] = (),
) -> list[ColumnElement[bool]]:
    """Filters on `Company` rows (or on a person's outer-joined company)."""
    conditions: list[ColumnElement[bool]] = []
    if kinds:
        known = [kind for kind in kinds if kind != "unclassified"]
        choices: list[ColumnElement[bool]] = [Company.company_kind.in_(known)] if known else []
        if "unclassified" in kinds:
            choices.append(Company.company_kind.is_(None))
        conditions.append(or_(*choices))
    conditions += any_ref(Company.commercial_segment_id, segments)
    if categories:
        link = company_activity_categories.c
        ids = [value for value in categories if isinstance(value, uuid.UUID)]
        choices = []
        if ids:
            choices.append(
                exists().where(link.company_id == Company.id, link.activity_category_id.in_(ids))
            )
        if NONE in categories:
            choices.append(~exists().where(link.company_id == Company.id))
        conditions.append(or_(*choices))
    if departments:
        # Any of the company's sites is in one of the departments.
        conditions.append(
            Company.id.in_(
                select(Establishment.company_id)
                .where(department_of(Establishment.postal_code).in_(departments))
                .correlate(None)
            )
        )
    if services:
        conditions.append(Company.proposed_services.overlap(list(services)))
    return conditions
