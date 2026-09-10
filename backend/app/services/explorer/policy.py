"""Exposure policy: the single place deciding which tables and columns the explorer may show.

Default deny. A table is reachable only when listed in `EXPOSED_TABLES`; every other ORM table must
be listed in `UNEXPOSED_TABLES` with its reason (a test fails on unclassified tables), so a new
table — authentication users/sessions holding password or token hashes in particular — never
appears by accident. Objects outside the ORM metadata (`alembic_version`, system catalogs, views)
are unreachable by construction: the explorer only queries `Table` objects resolved through here.

Column rules: `HIDDEN` columns do not exist for the explorer (metadata, values, search, filters,
sort, export); `MASKED` columns are listed but their values are never returned, searched, filtered,
sorted or exported. Task 12 adds per-column editability to `ColumnPolicy`.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum


class ColumnVisibility(StrEnum):
    VISIBLE = "visible"
    MASKED = "masked"
    HIDDEN = "hidden"


@dataclass(frozen=True, slots=True)
class ColumnPolicy:
    visibility: ColumnVisibility = ColumnVisibility.VISIBLE


DEFAULT_COLUMN_POLICY = ColumnPolicy()


@dataclass(frozen=True, slots=True)
class TablePolicy:
    columns: Mapping[str, ColumnPolicy] = field(default_factory=dict)

    def column(self, name: str) -> ColumnPolicy:
        return self.columns.get(name, DEFAULT_COLUMN_POLICY)


@dataclass(frozen=True, slots=True)
class ExposurePolicy:
    tables: Mapping[str, TablePolicy]

    def table(self, name: str) -> TablePolicy | None:
        return self.tables.get(name)


# Domain tables of the shared prospecting database (doc/architecture/data-model.md).
EXPOSED_TABLES: Mapping[str, TablePolicy] = {
    name: TablePolicy()
    for name in (
        "activity_categories",
        "audit_log",
        "commercial_segments",
        "companies",
        "company_activity_categories",
        "contact_tracking",
        "contact_tracking_status_history",
        "emails",
        "establishments",
        "import_batches",
        "import_row_metadata",
        "internal_referents",
        "phones",
        "prospect_sources",
        "prospects",
        "roles",
    )
}

# ORM tables deliberately kept out of the explorer, with the reason. Authentication tables (Task 04)
# belong here: credentials, password hashes and session tokens must never be listed or read.
UNEXPOSED_TABLES: Mapping[str, str] = {}

DEFAULT_POLICY = ExposurePolicy(tables=EXPOSED_TABLES)
