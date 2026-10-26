"""Meaning of the optional ``Statut_verification`` Excel column (decision D10).

The column only tells whether the person is still in post — it feeds the prospect's **activity**
and nothing else (never an e-mail's verification: validating a job is not validating an address,
handoff §8):

- ``Validé`` → active;
- ``Inactif`` → inactive;
- ``Inconnus``, blank or any other note → nothing known (no activity claim).

The activity is then applied with the human-precedence rule (D11, `import_commit`): an empty
(`unknown`) activity is filled, the same value is ignored, a different one stays and raises an
``import_conflict`` alert. The raw cell is always kept in the row's legacy metadata.
"""

from app.models.enums import ActivityStatus
from app.services.imports.fields import ImportField
from app.services.imports.models import PreviewRow
from app.services.imports.text import CellValue, fold, render

ACTIVE_VALUES = frozenset({"valide", "verifie", "verified"})
INACTIVE_VALUES = frozenset({"inactif", "inactive"})


def activity_from_status(value: CellValue) -> ActivityStatus | None:
    """The activity a `Statut_verification` value claims, or None (`Inconnus`, blank, notes)."""
    key = fold(render(value))
    if key in ACTIVE_VALUES:
        return ActivityStatus.ACTIVE
    if key in INACTIVE_VALUES:
        return ActivityStatus.INACTIVE
    return None


def row_activity(row: PreviewRow) -> ActivityStatus | None:
    """The activity claimed by the row's `Statut_verification` cell (kept raw by the engine)."""
    value = row.legacy_metadata.get(ImportField.VERIFICATION_STATUS.value)
    return activity_from_status(value.value if value is not None else None)
