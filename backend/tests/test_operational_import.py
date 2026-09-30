"""Operational reconciliation of the import (`operational_import`, decision P7): only the row's own
week and referent are read; a past week makes a neutral prospect `contacted` with the R1 week as
next action; a referent set by hand is never removed."""

import uuid
from datetime import datetime
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core.business_time import start_of_day
from app.models import ContactTracking, Prospect
from app.models.enums import ContactTrackingStatus
from app.services import operational_import
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.contact_workflow import IsoWeek
from tests.builders import OPERATOR, bind_operator
from tests.import_support import seed
from tests.test_import_commit import (
    LIMITS,
    LUC_AGAIN,
    PERSON,
    decide,
    person,
    review_of,
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


def monday(year: int, week: int) -> datetime:
    return start_of_day(IsoWeek(year, week).monday)


def row_tracking(session: Session, first: str) -> ContactTracking:
    found = tracking(session, person(session, first, PERSON["last_name"]))
    assert found is not None
    return found


def test_a_past_file_week_is_a_contact_with_the_r1_week_as_next_action(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    reconcile(db_session, {**PERSON, "first_name": "Passe", "week": "S10 2026", "referent": CLAIRE})

    found = row_tracking(db_session, "Passe")
    assert found.status is S.CONTACTED
    assert found.planned_contact_at == monday(2026, 12)  # W10 + 2 weeks, its Monday
    assert found.referent_id == ids["claire"]  # contacted: the file's referent stays


def test_a_future_file_week_stays_neutral_without_the_files_referent(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    reconcile(db_session, {**PERSON, "first_name": "Futur", "week": "S20 2030", "referent": CLAIRE})

    found = row_tracking(db_session, "Futur")
    assert (found.status, found.planned_contact_at) == (S.NEUTRAL, monday(2030, 20))
    assert found.referent_id is None


def hand_tracking(session: Session, prospect_id: uuid.UUID, referent: uuid.UUID) -> None:
    save_contact_tracking(
        session,
        OPERATOR,
        prospect_id,
        ContactTrackingInput(S.NEUTRAL, planned_contact_at=monday(2026, 5), referent_id=referent),
    )


def test_a_week_and_referent_set_by_hand_are_left_alone(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    hand_tracking(db_session, ids["luc"], ids["paul"])
    # The file brings no week and another referent for Luc.
    luc_again = {key: value for key, value in LUC_AGAIN.items() if key != "week"}

    reconcile(db_session, {**luc_again, "referent": CLAIRE})

    luc = db_session.get(Prospect, ids["luc"])
    assert luc is not None
    found = tracking(db_session, luc)
    assert found is not None
    # Its past week was set by hand, not read from this row: no contact is inferred.
    assert (found.status, found.planned_contact_at) == (S.NEUTRAL, monday(2026, 5))
    assert found.referent_id == ids["paul"]


def test_a_file_week_the_import_did_not_apply_is_not_read(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    hand_tracking(db_session, ids["luc"], ids["paul"])

    reconcile(db_session, {**LUC_AGAIN, "week": "S3 2026"})

    luc = db_session.get(Prospect, ids["luc"])
    assert luc is not None
    found = tracking(db_session, luc)
    assert found is not None
    # The import only fills an empty week: the hand-set one stays, and so does the state.
    assert (found.status, found.planned_contact_at) == (S.NEUTRAL, monday(2026, 5))
