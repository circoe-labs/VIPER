from app.models.enums import ActivityStatus, VerificationStatus
from app.services.imports.fields import FIELD_BY_HEADER, ImportField, SPECS
from app.services.imports.text import fold
from app.services.imports.verification import (
    ExcelVerificationOutcome,
    activity_status,
    email_verification_status,
    verification_value,
    was_checked,
)


def test_verification_status_header_is_recognised_and_preserved() -> None:
    assert FIELD_BY_HEADER[fold("Statut_verification")] is ImportField.VERIFICATION_STATUS
    assert FIELD_BY_HEADER[fold("Statut vérification")] is ImportField.VERIFICATION_STATUS
    assert SPECS[ImportField.VERIFICATION_STATUS].opaque is True


def test_operational_verification_values() -> None:
    assert verification_value("Validé") is ExcelVerificationOutcome.VERIFIED
    assert verification_value("Inactif") is ExcelVerificationOutcome.INACTIVE
    assert verification_value("Inconnus") is ExcelVerificationOutcome.UNKNOWN
    assert verification_value("") is ExcelVerificationOutcome.UNVERIFIED
    assert verification_value(None) is ExcelVerificationOutcome.UNVERIFIED


def test_verified_means_active_and_verified_email() -> None:
    outcome = verification_value("Validé")
    assert was_checked(outcome) is True
    assert activity_status(outcome) is ActivityStatus.ACTIVE
    assert email_verification_status(outcome) is VerificationStatus.VERIFIED


def test_inactive_means_inactive_and_invalid_email() -> None:
    outcome = verification_value("Inactif")
    assert was_checked(outcome) is True
    assert activity_status(outcome) is ActivityStatus.INACTIVE
    assert email_verification_status(outcome) is VerificationStatus.INVALID


def test_unknown_is_checked_but_not_verified() -> None:
    outcome = verification_value("Inconnus")
    assert was_checked(outcome) is True
    assert activity_status(outcome) is ActivityStatus.UNKNOWN
    assert email_verification_status(outcome) is VerificationStatus.UNKNOWN


def test_blank_remains_to_verify() -> None:
    outcome = verification_value(None)
    assert was_checked(outcome) is False
    assert email_verification_status(outcome) is VerificationStatus.UNVERIFIED
