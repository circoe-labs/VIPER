"""Exposure and editability policy: the single place deciding what the explorer may show and change.

Default deny, for reads and for writes. A table is reachable only when listed in `EXPOSED_TABLES`;
every other ORM table must be listed in `UNEXPOSED_TABLES` with its reason (a test fails on
unclassified tables), so a new table — authentication users/sessions holding password or token
hashes in particular — never appears by accident. Objects outside the ORM metadata
(`alembic_version`, system catalogs, views) are unreachable by construction: the explorer only
queries `Table` objects resolved through here.

Column visibility: `HIDDEN` columns do not exist for the explorer (metadata, values, search,
filters, sort, export); `MASKED` columns are listed but their values are never returned, searched,
filtered, sorted, exported or written.

Writes (Task 12): an exposed table is read-only unless its `TableWrites` allow updates, inserts or
deletes; each refusal carries the French reason shown in the grid. Within a writable table a column
is editable unless its `ColumnPolicy` says otherwise or a structural rule applies (`metadata.py`:
generated keys, timestamps, JSON/array values, masked columns). Tables outside the audit registry
(`audit.NOT_AUDITED_TABLES`) stay read-only unless their writes go through an audited owner
(`writes.LINK_TABLES`); a test enforces it.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum


class ColumnVisibility(StrEnum):
    VISIBLE = "visible"
    MASKED = "masked"
    HIDDEN = "hidden"


class ColumnEdit(StrEnum):
    EDITABLE = "editable"
    # Given when the row is created (e.g. the parent of a child row), fixed afterwards.
    INSERT_ONLY = "insert_only"
    READ_ONLY = "read_only"


@dataclass(frozen=True, slots=True)
class ColumnPolicy:
    visibility: ColumnVisibility = ColumnVisibility.VISIBLE
    edit: ColumnEdit = ColumnEdit.EDITABLE
    # Why the column cannot be edited (French, shown in the grid).
    reason: str | None = None


DEFAULT_COLUMN_POLICY = ColumnPolicy()
READ_ONLY_TABLE = "Table en lecture seule dans l’explorateur."


@dataclass(frozen=True, slots=True)
class TableWrites:
    """Staged writes a table accepts: each field is `None` when allowed, else the French reason."""

    update: str | None = READ_ONLY_TABLE
    insert: str | None = READ_ONLY_TABLE
    delete: str | None = READ_ONLY_TABLE


READ_ONLY = TableWrites()
ALL_WRITES = TableWrites(update=None, insert=None, delete=None)


def read_only(reason: str) -> TableWrites:
    return TableWrites(update=reason, insert=reason, delete=reason)


@dataclass(frozen=True, slots=True)
class TablePolicy:
    columns: Mapping[str, ColumnPolicy] = field(default_factory=dict)
    writes: TableWrites = READ_ONLY
    # Columns that name a row for people, shown when picking it as a foreign-key target.
    label_columns: tuple[str, ...] = ()

    def column(self, name: str) -> ColumnPolicy:
        return self.columns.get(name, DEFAULT_COLUMN_POLICY)


@dataclass(frozen=True, slots=True)
class ExposurePolicy:
    tables: Mapping[str, TablePolicy]

    def table(self, name: str) -> TablePolicy | None:
        return self.tables.get(name)


def _fixed(reason: str) -> ColumnPolicy:
    return ColumnPolicy(edit=ColumnEdit.READ_ONLY, reason=reason)


def _set_at_creation(reason: str) -> ColumnPolicy:
    return ColumnPolicy(edit=ColumnEdit.INSERT_ONLY, reason=reason)


PARENT_FIXED = _set_at_creation(
    "Rattachement fixé à la création : supprimez la ligne puis recréez-la sous le bon parent."
)
TAXONOMY = TablePolicy(
    columns={
        "slug": _set_at_creation(
            "Clé technique stable, fixée à la création : les suggestions VIPER s’y réfèrent."
        )
    },
    writes=ALL_WRITES,
    label_columns=("label",),
)
# Durable opposition (ADR-0002): only the prospect form's audited operations may set or lift it.
OPPOSITION = _fixed(
    "Opposition (ne pas contacter) : utilisez la fiche prospect, qui conserve date et motif."
)
PROVENANCE = _fixed("Trace de provenance : non modifiable.")

# Domain tables of the shared prospecting database (doc/architecture/data-model.md).
EXPOSED_TABLES: Mapping[str, TablePolicy] = {
    "activity_categories": TAXONOMY,
    "audit_log": TablePolicy(writes=read_only("Journal d’audit : en ajout seul, jamais modifié.")),
    "commercial_segments": TAXONOMY,
    "companies": TablePolicy(writes=ALL_WRITES, label_columns=("display_name",)),
    # Not audited as rows: written through the company's collection (company.updated).
    "company_activity_categories": TablePolicy(
        writes=TableWrites(
            update="Lien entreprise ↔ catégorie : ajoutez ou supprimez le lien.",
            insert=None,
            delete=None,
        )
    ),
    # Stage changes go through the contact-tracking service, which keeps the status history.
    "contact_tracking": TablePolicy(columns={"prospect_id": PARENT_FIXED}, writes=ALL_WRITES),
    "contact_tracking_status_history": TablePolicy(
        writes=read_only("Historique dérivé des changements d’étape du suivi de contact.")
    ),
    "emails": TablePolicy(
        columns={"prospect_id": PARENT_FIXED}, writes=ALL_WRITES, label_columns=("address",)
    ),
    "establishments": TablePolicy(
        columns={"company_id": PARENT_FIXED}, writes=ALL_WRITES, label_columns=("name", "city")
    ),
    "import_batches": TablePolicy(
        writes=read_only("Lot d’import : écrit uniquement par l’import Excel."),
        label_columns=("filename",),
    ),
    "import_row_metadata": TablePolicy(
        writes=read_only("Trace d’import en écriture unique, hors journal d’audit.")
    ),
    "internal_referents": TablePolicy(writes=ALL_WRITES, label_columns=("first_name", "last_name")),
    "phones": TablePolicy(
        columns={"prospect_id": PARENT_FIXED}, writes=ALL_WRITES, label_columns=("number",)
    ),
    # Only the context of a source can be completed; its origin stays as recorded.
    "prospect_sources": TablePolicy(
        columns={
            name: PROVENANCE
            for name in (
                "prospect_id",
                "source_type",
                "source_reference",
                "import_batch_id",
                "collected_at",
                "actor_type",
                "actor_id",
                "actor_display",
            )
        },
        writes=TableWrites(
            update=None,
            insert="Les provenances sont créées par l’import ou la fiche prospect.",
            delete="La provenance est conservée tant que le prospect existe.",
        ),
    ),
    # A company change goes through the company-change rule (I-13); opposition stays read-only.
    "prospects": TablePolicy(
        columns={
            "contactability_status": OPPOSITION,
            "do_not_contact_at": OPPOSITION,
            "do_not_contact_reason": OPPOSITION,
        },
        writes=TableWrites(
            update=None,
            insert="Créez les prospects depuis Prospection, qui enregistre leur provenance.",
            delete=None,
        ),
        label_columns=("first_name", "last_name"),
    ),
    "roles": TAXONOMY,
}

# ORM tables deliberately kept out of the explorer, with the reason. Never exposed: they are not
# listed, readable, exported, nor disclosed as foreign-key targets.
UNEXPOSED_TABLES: Mapping[str, str] = {
    "users": "Login accounts (ADR-0004): argon2 password hashes; managed only through app.cli.",
    "user_sessions": "Live sign-in sessions (ADR-0004): token hashes and account activity.",
}

DEFAULT_POLICY = ExposurePolicy(tables=EXPOSED_TABLES)
