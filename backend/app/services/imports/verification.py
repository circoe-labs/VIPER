"""Operational meaning of the optional ``Statut_verification`` Excel column.

The column is authoritative when it contains one of the four values used by the prospecting team:

- ``Validé``: the person/contact has been reached successfully and is active;
- ``Inactif``: the person is no longer in the relevant job and the imported email is invalid;
- ``Inconnus``: a verification was performed but the person/contact could not be confirmed;
- blank (or an unrecognised legacy note): verification still has to be done.

The raw cell is still retained by the lossless import engine in row legacy metadata.
"""

from enum import StrEnum

from app.models.enums import ActivityStatus, VerificationStatus
from app.services.imports.fields import ImportField
from app.services.imports.models import PreviewRow
from app.services.imports.text import CellValue, fold, render


class ExcelVerificationOutcome(StrEnum):
    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    INACTIVE = "inactive"
    UNKNOWN = "unknown"


VERIFIED_VALUES = frozenset({"valide", "verifie", "verified"})
INACTIVE_VALUES = frozenset({"inactif", "inactive"})
UNKNOWN_VALUES = frozenset({"inconnu", "inconnus", "unknown"})


def verification_value(value: CellValue) -> ExcelVerificationOutcome:
    key = fold(render(value))
    if key in VERIFIED_VALUES:
        return ExcelVerificationOutcome.VERIFIED
    if key in INACTIVE_VALUES:
        return ExcelVerificationOutcome.INACTIVE
    if key in UNKNOWN_VALUES:
        return ExcelVerificationOutcome.UNKNOWN
    return ExcelVerificationOutcome.UNVERIFIED


def row_verification(row: PreviewRow) -> ExcelVerificationOutcome:
    """Read the normalized operational outcome from a preview row.

    The import engine preserves fields it does not otherwise materialize in ``legacy_metadata``;
    using the stable field key here keeps the workbook adapter isolated from domain services.
    """
    value = row.legacy_metadata.get(ImportField.VERIFICATION_STATUS.value)
    return verification_value(value.value if value is not None else None)


def was_checked(outcome: ExcelVerificationOutcome) -> bool:
    return outcome is not ExcelVerificationOutcome.UNVERIFIED


def activity_status(outcome: ExcelVerificationOutcome) -> ActivityStatus:
    if outcome is ExcelVerificationOutcome.VERIFIED:
        return ActivityStatus.ACTIVE
    if outcome is ExcelVerificationOutcome.INACTIVE:
        return ActivityStatus.INACTIVE
    return ActivityStatus.UNKNOWN


def email_verification_status(outcome: ExcelVerificationOutcome) -> VerificationStatus:
    if outcome is ExcelVerificationOutcome.VERIFIED:
        return VerificationStatus.VERIFIED
    if outcome is ExcelVerificationOutcome.INACTIVE:
        return VerificationStatus.INVALID
    if outcome is ExcelVerificationOutcome.UNKNOWN:
        return VerificationStatus.UNKNOWN
    return VerificationStatus.UNVERIFIED
