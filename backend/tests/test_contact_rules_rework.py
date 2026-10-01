"""Contact port S1 rework, kept by the sequences rework: the state anchor skips migration
restatements (0008 and 0010), the Database Explorer cannot bypass `ignored` nor write a former
state, and the injected clock dates a response."""

from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import ContactTracking, ContactTrackingStatusHistory, Prospect
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.contact_workflow import (
    CONTACT_SEQUENCES_MIGRATION_ID,
    CONTACT_STATES_MIGRATION_ID,
    state_reached_at,
)
from app.services.exports.projection import ProspectRecord
from app.services.prospect_editor import EditorClock, get_view
from tests.builders import OPERATOR, add_company, add_prospect

S = ContactTrackingStatus
H = TrackingHistoryStatus
LEGACY_AT = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)  # Wednesday of 2026-W33
MIGRATED_AT = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)
RESEQUENCED_AT = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)


def converted(session: Session, prospect: Prospect) -> ContactTracking:
    """A tracking as migrations 0008 then 0010 leave it: legacy rows, then two `system`
    restatements (follow_up_1 -> r1, then r1 -> neutral)."""
    tracking = ContactTracking(prospect_id=prospect.id, status=S.NEUTRAL)
    session.add(tracking)
    session.flush()
    rows = [
        (None, H.LEGACY_TO_CONTACT, datetime(2026, 8, 1, tzinfo=UTC), ActorType.HUMAN, None),
        (H.LEGACY_TO_CONTACT, H.LEGACY_FOLLOW_UP_1, LEGACY_AT, ActorType.HUMAN, None),
        (
            H.LEGACY_FOLLOW_UP_1,
            H.LEGACY_R1,
            MIGRATED_AT,
            ActorType.SYSTEM,
            CONTACT_STATES_MIGRATION_ID,
        ),
        (H.LEGACY_R1, H.NEUTRAL, RESEQUENCED_AT, ActorType.SYSTEM, CONTACT_SEQUENCES_MIGRATION_ID),
    ]
    for before, after, at, actor_type, actor_id in rows:
        session.add(
            ContactTrackingStatusHistory(
                contact_tracking_id=tracking.id,
                from_status=before,
                to_status=after,
                changed_at=at,
                actor_type=actor_type,
                actor_id=actor_id,
                actor_display="Test",
            )
        )
    session.flush()
    session.refresh(tracking)
    return tracking


def test_the_state_anchor_skips_the_migration_restatements(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = converted(db_session, prospect)

    assert state_reached_at(tracking.status_history) == LEGACY_AT
    view = get_view(db_session, prospect.id, EditorClock(now=RESEQUENCED_AT))
    assert view.tracking is not None
    assert view.tracking.status_since == LEGACY_AT
    record = ProspectRecord(prospect, None, None, tracking, None, (), (), ())
    assert record.status_since == LEGACY_AT
    # A later human change is the anchor again.
    save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(S.RESPONSE_RECEIVED)
    )
    db_session.refresh(tracking)
    assert state_reached_at(tracking.status_history) != LEGACY_AT


def test_only_restatements_give_no_anchor(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = ContactTracking(prospect_id=prospect.id, status=S.NEUTRAL)
    db_session.add(tracking)
    db_session.flush()
    db_session.add(
        ContactTrackingStatusHistory(
            contact_tracking_id=tracking.id,
            from_status=H.LEGACY_FAILURE,
            to_status=H.NEUTRAL,
            actor_type=ActorType.SYSTEM,
            actor_id=CONTACT_SEQUENCES_MIGRATION_ID,
            actor_display="Migration",
        )
    )
    db_session.flush()
    db_session.refresh(tracking)

    assert state_reached_at(tracking.status_history) is None


# --- Database Explorer ----------------------------------------------------------------------------


def explorer(client: TestClient, body: dict[str, Any]) -> tuple[int, Any]:
    response = client.post("/api/explorer/tables/contact_tracking/changes", json=body)
    return response.status_code, response.json()


def test_the_explorer_cannot_delete_or_leave_an_ignored_tracking(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(S.IGNORED)
    )
    key = {"key": {"id": str(tracking.id)}, "version": tracking.updated_at.isoformat()}

    deleted = explorer(client, {"deletes": [key]})
    moved = explorer(client, {"updates": [{**key, "values": {"status": "neutral"}}]})

    for status, body in (deleted, moved):
        assert status in (409, 422), body
        assert [error["code"] for error in body["detail"]["errors"]] == ["rejected"]
    db_session.expire_all()
    assert db_session.get(ContactTracking, tracking.id) is not None
    assert tracking.status is S.IGNORED
    # Other columns of an ignored tracking stay editable (the referent, a date…).
    edited = explorer(
        client, {"updates": [{**key, "values": {"appointment_at": "2026-10-05T10:00:00+02:00"}}]}
    )
    assert edited[0] == 200, edited[1]


@pytest.mark.parametrize("former", ["contacted", "r1", "r2", "failure"])
def test_the_explorer_cannot_write_a_former_state(
    client: TestClient, db_session: Session, former: str
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(S.NEUTRAL)
    )
    key = {"key": {"id": str(tracking.id)}, "version": tracking.updated_at.isoformat()}

    status, body = explorer(client, {"updates": [{**key, "values": {"status": former}}]})

    assert status in (409, 422), body
    db_session.expire_all()
    assert tracking.status is S.NEUTRAL


def test_the_response_date_comes_from_the_callers_clock(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(S.RESPONSE_RECEIVED),
        now=MIGRATED_AT,
    )

    assert tracking.response_received_at == MIGRATED_AT
