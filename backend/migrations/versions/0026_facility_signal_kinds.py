"""Site signal kinds: `facility_opening`, `facility_expansion`, `construction`, `relocation`.

A discovery mission (« nouveaux entrepôts en Normandie ») keeps the business event that brought the
company in as a dated signal; these kinds name it instead of hiding it under `other`.
`prospect_notes.kind` is a `text_enum` (varchar + CHECK), so only the constraint changes. The
downgrade folds rows of the new kinds into `other` before restoring the narrower CHECK.

Revision ID: 0026
Revises: 0024
Create Date: 2026-11-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0026"
# Slice 04 branched from 0024 while Slice 01 takes 0025 in parallel; rechained at integration.
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PREVIOUS_KINDS = (
    "hiring",
    "funding",
    "news",
    "social_post",
    "event",
    "product_launch",
    "partnership",
    "tech_change",
    "need_expressed",
    "other",
)
FACILITY_KINDS = ("facility_opening", "facility_expansion", "construction", "relocation")


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _replace_kind_check(kinds: tuple[str, ...]) -> None:
    op.drop_constraint(op.f("ck_prospect_notes_kind"), "prospect_notes", type_="check")
    op.create_check_constraint(
        op.f("ck_prospect_notes_kind"),
        "prospect_notes",
        f"kind IS NULL OR kind IN ({_values(kinds)})",
    )


def upgrade() -> None:
    _replace_kind_check(PREVIOUS_KINDS + FACILITY_KINDS)


def downgrade() -> None:
    op.execute(
        f"UPDATE prospect_notes SET kind = 'other' WHERE kind IN ({_values(FACILITY_KINDS)})"
    )
    _replace_kind_check(PREVIOUS_KINDS)
