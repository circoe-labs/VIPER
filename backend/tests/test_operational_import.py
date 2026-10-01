"""Operational reconciliation of the import (`operational_import`) after the sequences rework:
the former rule P7 (« semaine passée → contacté ») is gone (D7, D10): a file week never changes a
state nor plans anything — its raw value stays in the row metadata until the import redesign
(Slice S2) turns it into a cohort — and a referent set by hand is never replaced."""

import uuid
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models import ContactSequence, ContactTracking, Prospect
from app.models.enums import ContactTrackingStatus
from app.services import operational_import
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import OPERATOR, bind_operator
from tests.import_support import seed
from tests.test_import_commit import (
    LIMITS,
    LUC_AGAIN,
    PERSON,
    decide,
    person,
    review_of,
    trace,
    tracking,
    upload,
)

S = ContactTrackingStatus
CLAIRE = "Claire Référente"


@pytest.fixture
def ids(db_session: Session) -> dict[str, uuid.UUID]:
    found = seed(db_session)
    bind_operator(db_session)
    return found


def reconcile(session: Session, *rows: dict[str, Any]) -> None:
    file = upload(list(rows))
    review = review_of(session, file)
    operational_import.commit_import(session, OPERATOR, file, decide(review), LIMITS)


def row_tracking(session: Session, first: str) -> ContactTracking:
    found = tracking(session, person(session, first, PERSON["last_name"]))
    assert found is not None
    return found


@pytest.mark.parametrize("week", ["S10 2026", "S20 2030"])
def test_a_file_week_never_changes_the_state_and_is_kept_raw(
    db_session: Session, ids: dict[str, uuid.UUID], week: str
) -> None:
    reconcile(db_session, {**PERSON, "first_name": "Semaine", "week": week, "referent": CLAIRE})

    found = row_tracking(db_session, "Semaine")
    assert found.status is S.NEUTRAL
    assert found.referent_id == ids["claire"]  # the file's referent is applied as any field
    assert db_session.query(ContactSequence).filter_by(prospect_id=found.prospect_id).count() == 0
    assert trace(db_session, 2).legacy_metadata["planned_contact"]["value"] == week


def test_a_referent_set_by_hand_is_left_alone(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    save_contact_tracking(
        db_session, OPERATOR, ids["luc"], ContactTrackingInput(S.NEUTRAL, referent_id=ids["paul"])
    )

    reconcile(db_session, {**LUC_AGAIN, "week": "S3 2026", "referent": CLAIRE})

    luc = db_session.get(Prospect, ids["luc"])
    assert luc is not None
    found = tracking(db_session, luc)
    assert found is not None
    assert (found.status, found.referent_id) == (S.NEUTRAL, ids["paul"])
