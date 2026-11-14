"""Shared `sort` contract of the Prospection entity lists (companies, warehouses).

Same values as `ProspectSort` (`name`, `created`, `updated`) so one control bar drives the three
entities. Every order ends on the id, so pages never overlap or skip rows.
"""

from enum import StrEnum
from typing import Any

from sqlalchemy import ColumnElement, SQLColumnExpression

from app.repositories.taxonomies import label_key


class EntitySort(StrEnum):
    NAME = "name"  # A to Z, case and accents ignored
    CREATED = "created"  # date added, newest first
    UPDATED = "updated"  # last change, newest first


def entity_order_by(
    sort: EntitySort,
    name: SQLColumnExpression[str | None],
    created_at: SQLColumnExpression[Any],
    updated_at: SQLColumnExpression[Any],
    id_: SQLColumnExpression[Any],
) -> list[ColumnElement[Any]]:
    by_name = label_key(name)
    match sort:
        case EntitySort.CREATED:
            return [created_at.desc(), by_name, id_]
        case EntitySort.UPDATED:
            return [updated_at.desc(), by_name, id_]
        case EntitySort.NAME:
            return [by_name, id_]
