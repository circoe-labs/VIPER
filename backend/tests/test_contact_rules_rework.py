"""Contact port S1 rework: the state anchor skips migration 0008 restatements, the Database
Explorer cannot bypass `ignored`, an explicit PATCH week is kept, and the injected clock dates a
response."""

from datetime import UTC, date, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import ContactTracking, ContactTrackingStatusHistory, Prospect
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.contact_workflow import CONTACT_STATES_MIGRATION_ID, state_reached_at
from app.services.exports.projection import ProspectRecord
from app.services.prospect_editor import EditorClock, get_view
from tests.builders import OPERATOR, add_company, add_prospect
from tests.test_prospects_api import PROSPECTS, load

S = ContactTrackingStatus
H = TrackingHistoryStatus
LEGACY_AT = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)  # Wednesday of 2026-W33
MIGRATED_AT = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)


def converted(session: Session, prospect: Prospect) -> ContactTracking:
    """A tracking as migration 0008 leaves it: legacy rows, then the `system` restatement."""
    tracking = ContactTracking(prospect_id=prospect.id, status=S.R1)
    session.add(tracking)
    session.flush()
    rows = [
        (None, H.LEGACY_TO_CONTACT, datetime(2026, 8, 1, tzinfo=UTC), ActorType.HUMAN, None),
        (H.LEGACY_TO_CONTACT, H.LEGACY_FOLLOW_UP_1, LEGACY_AT, ActorType.HUMAN, None),
        (H.LEGACY_FOLLOW_UP_1, H.R1, MIGRATED_AT, ActorType.SYSTEM, CONTACT_STATES_MIGRATION_ID),
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


def test_the_state_anchor_skips_the_0008_restatement(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = converted(db_session, prospect)

    assert state_reached_at(tracking.status_history) == LEGACY_AT
    view = get_view(db_session, prospect.id, EditorClock(now=MIGRATED_AT))
    assert view.tracking is not None
    assert view.tracking.status_since == LEGACY_AT
    # R1 reached in W33: the cadence proposes W35, not two weeks after the migration.
    assert view.tracking.suggested_next_contact_week == "2026-W35"
    assert view.tracking.suggested_next_contact_on == date(2026, 8, 24)
    record = ProspectRecord(prospect, None, None, tracking, None, (), (), ())
    assert record.status_since == LEGACY_AT
    # A later human change is the anchor again.
    save_contact_tracking(db_session, OPERATOR, prospect.id, ContactTrackingInput(S.R2))
    db_session.refresh(tracking)
    assert state_reached_at(tracking.status_history) != LEGACY_AT


def test_only_restatements_give_no_anchor(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    tracking = ContactTracking(prospect_id=prospect.id, status=S.R1)
    db_session.add(tracking)
    db_session.flush()
    db_session.add(
        ContactTrackingStatusHistory(
            contact_tracking_id=tracking.id,
            from_status=H.LEGACY_FOLLOW_UP_1,
            to_status=H.R1,
            actor_type=ActorType.SYSTEM,
            actor_id=CONTACT_STATES_MIGRATION_ID,
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
    moved = explorer(client, {"updates": [{**key, "values": {"status": "contacted"}}]})

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


# --- PATCH: an explicit week is a choice --------------------------------------------------------


def test_an_explicit_patch_week_is_kept_with_a_state_without_next_action(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    path = f"{PROSPECTS}/{prospect.id}/tracking"
    week = {"year": 2026, "week": 44}
    view = client.patch(
        path, json={"version": load(client, prospect.id)["version"], "next_action_week": week}
    ).json()

    for status in ("failure", "response_received", "appointment_obtained"):
        reset = client.patch(path, json={"version": view["version"], "status": "r2"}).json()
        response = client.patch(
            path, json={"version": reset["version"], "status": status, "next_action_week": week}
        )
        assert response.status_code == 200, response.text
        view = response.json()
        assert (view["tracking"]["status"], view["tracking"]["planned_contact_week"]) == (
            status,
            "2026-W44",
        )
    # Without a week in the body, the stored one is cleared as before.
    reset = client.patch(path, json={"version": view["version"], "status": "r2"}).json()
    view = client.patch(path, json={"version": reset["version"], "status": "failure"}).json()
    assert view["tracking"]["planned_contact_on"] is None
    # `ignored` never keeps one.
    view = client.patch(path, json={"version": view["version"], "next_action_week": week}).json()
    refused = client.patch(
        path, json={"version": view["version"], "status": "ignored", "next_action_week": week}
    )
    assert (refused.status_code, refused.json()["detail"]["code"]) == (
        409,
        "ignored_has_no_next_action",
    )


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
