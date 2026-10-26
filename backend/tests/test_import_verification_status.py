"""`Statut_verification` (D10): it only claims an activity, never an e-mail verification."""

import pytest

from app.models.enums import ActivityStatus
from app.services.imports import verification
from app.services.imports.fields import FIELD_BY_HEADER, SPECS, ImportField
from app.services.imports.text import CellValue, fold
from app.services.imports.verification import activity_from_status


def test_verification_status_header_is_recognised_and_preserved() -> None:
    assert FIELD_BY_HEADER[fold("Statut_verification")] is ImportField.VERIFICATION_STATUS
    assert FIELD_BY_HEADER[fold("Statut vérification")] is ImportField.VERIFICATION_STATUS
    assert SPECS[ImportField.VERIFICATION_STATUS].opaque is True


@pytest.mark.parametrize(
    ("raw", "activity"),
    [
        ("Validé", ActivityStatus.ACTIVE),
        ("validé", ActivityStatus.ACTIVE),
        ("Inactif", ActivityStatus.INACTIVE),
        ("inactif", ActivityStatus.INACTIVE),
        ("Inconnus", None),  # checked, nothing known: no activity claim
        ("inconnus", None),
        ("à rappeler", None),  # a note
        ("", None),
        (None, None),
    ],
)
def test_the_status_only_claims_an_activity(
    raw: CellValue, activity: ActivityStatus | None
) -> None:
    assert activity_from_status(raw) is activity


def test_the_status_says_nothing_about_e_mails() -> None:
    public = {name for name in dir(verification) if not name.startswith("_")}

    assert not {name for name in public if "email" in name.lower()}
