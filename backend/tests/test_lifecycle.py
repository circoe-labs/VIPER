"""Prospecting lifecycle (migration 0063): one eligibility rule for lists, messages and sends, and
unsent messages that follow an e-mail change (fake Toolbox, synthetic people)."""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Email, Prospect, ProspectingHold, Warehouse, WarehouseDraft
from app.models.enums import ActivityStatus, ContactabilityStatus, ContactMessageStatus
from app.services.contact_draft_check import check_scheduled_drafts
from app.services.warehouse_dispatch import dispatch_warehouses
from tests.builders import add_company, add_email, add_prospect, start_sequence
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_dispatch import (
    DUE,
    Clock,
    actions_of,
    config,
    dispatcher,
    row,
    scheduled,
    toolbox_of,
)
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused
from tests.test_explorer_writes import update

M = ContactMessageStatus


def act(client: TestClient, subject: str, id_: uuid.UUID, action: str, **body: Any) -> Any:
    return ok(client.post(f"/api/{subject}/{id_}/lifecycle", json={"action": action, **body}))


def person(session: Session, id_: uuid.UUID) -> Prospect:
    session.expire_all()
    found = session.get(Prospect, id_)
    assert found is not None
    return found


def to_send_ids(client: TestClient) -> set[str]:
    page = ok(client.get("/api/contact/prospects?category=to_send&limit=200"))
    return {item["id"] for item in page["items"]}


def due_total(client: TestClient) -> int:
    return int(ok(client.get("/api/prospection/prospects?segment=due"))["total"])


# --- each way out of prospecting, everywhere ----------------------------------------------------


@pytest.mark.parametrize(
    ("subject", "action", "body", "block"),
    [
        ("prospects", "depart", {"departure_reason": "retired"}, "prospect_departed"),
        ("prospects", "archive", {}, "prospect_archived"),
        ("prospects", "exclude", {"reason": "No angle for now"}, "prospect_excluded"),
        ("companies", "archive", {}, "company_archived"),
        ("companies", "exclude", {"reason": "No angle for now"}, "company_excluded"),
    ],
)
def test_a_removal_cancels_what_could_leave_and_refuses_every_preparation(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    subject: str,
    action: str,
    body: dict[str, str],
    block: str,
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    company = person(db_session, prospect).company_id
    assert company is not None
    draft = ok(
        connected.put(f"{messages(prospect)}/r1", json={"subject": "Later", "body_text": "Draft"}),
        201,
    )["message"]
    assert str(prospect) in to_send_ids(connected)
    target = prospect if subject == "prospects" else company

    answer = act(connected, subject, target, action, **body)

    assert (answer["changed"], answer["cancelled_messages"]) == (True, 1)
    cancelled = row(db_session, message["id"])
    assert (cancelled.status, cancelled.cancel_reason) == (M.CANCELLED, block)
    assert cancelled.missed_scheduled_at is not None  # the visible trace
    assert row(db_session, draft["id"]).status is M.DRAFT  # reversible: drafts are kept
    assert ("contact_message.cancelled", block) in actions_of(db_session, message["id"])
    # Out of every list and counter.
    assert str(prospect) not in to_send_ids(connected)
    assert due_total(connected) == 0
    assert ok(connected.get("/api/contact/unsent"))["items"] == []
    sheet = ok(connected.get(f"/api/prospects/{prospect}"))
    assert sheet["lifecycle"]["block"] == block
    assert sheet["contact"]["next_due_on"] is None
    # Nothing can be prepared, validated or reopened.
    path = messages(prospect)
    refused(connected.put(f"{path}/r1", json={"expected_revision": 1, "subject": "x"}), 409, block)
    refused(connected.post(f"{path}/r1/validate", json={"expected_revision": 1}), 409, block)
    refused(connected.post(f"{path}/contact/reopen", json={"expected_revision": 1}), 409, block)
    # Nothing leaves.
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert fake.sent == []


def test_the_dispatcher_refuses_a_departure_written_by_any_other_path(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    # Written under the services' feet: only the send-time check is left.
    db_session.connection().exec_driver_sql(
        "UPDATE prospects SET activity_status = 'inactive' WHERE id = %(id)s", {"id": prospect}
    )
    db_session.expire_all()

    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))

    assert fake.sent == []
    after = row(db_session, message["id"])
    assert (after.status, after.cancel_reason) == (M.CANCELLED, "prospect_departed")


def test_the_editor_marking_someone_inactive_cancels_the_scheduled_mail(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)

    saved = save(connected, prospect, activity_status="inactive")

    assert saved["cancelled_messages"] == 1
    assert row(db_session, message["id"]).cancel_reason == "prospect_departed"


def test_coming_back_restores_eligibility_without_rescheduling_or_lifting_an_opposition(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    company = person(db_session, prospect).company_id
    assert company is not None
    refused(
        connected.post(f"/api/companies/{company}/lifecycle", json={"action": "exclude"}),
        422,
        "invalid",
    )
    act(connected, "companies", company, "exclude", reason="Timing")
    # A reason says what changed.
    refused(
        connected.post(f"/api/companies/{company}/lifecycle", json={"action": "reinstate"}),
        422,
        "invalid",
    )
    ok(
        connected.put(
            f"/api/prospects/{prospect}/contactability",
            json={
                "do_not_contact": True,
                "reason": "Asked",
                "version": ok(connected.get(f"/api/prospects/{prospect}"))["version"],
            },
        )
    )

    answer = act(connected, "companies", company, "reinstate", reason="New angle")

    assert answer["lifecycle"] == {"block": None, "departure_reason": None, "holds": []}
    assert person(db_session, prospect).contactability_status is (
        ContactabilityStatus.DO_NOT_CONTACT
    )
    assert row(db_session, message["id"]).status is M.CANCELLED
    held = db_session.scalars(select(ProspectingHold)).one()  # the history stays
    assert (held.reason, held.lift_reason) == ("Timing", "New angle")
    assert held.lifted_by_display and held.placed_by_display
    history = ok(connected.get(f"/api/companies/{company}/history"))
    assert "Réintégré dans la prospection" in str(history)


def test_departure_and_return(client: TestClient, db_session: Session) -> None:
    prospect = prospect_id(db_session)
    refused(
        client.post(f"/api/prospects/{prospect}/lifecycle", json={"action": "depart"}),
        422,
        "invalid",
    )
    gone = act(client, "prospects", prospect, "depart", departure_reason="retired")
    assert gone["lifecycle"]["departure_reason"] == "retired"
    assert not act(client, "prospects", prospect, "depart", departure_reason="retired")["changed"]

    back = act(client, "prospects", prospect, "return")

    assert back["lifecycle"]["block"] is None
    found = person(db_session, prospect)
    assert (found.activity_status, found.departure_reason, found.employment_verified_at) == (
        ActivityStatus.UNKNOWN,
        None,
        None,
    )


def test_the_archived_are_hidden_unless_asked(client: TestClient, db_session: Session) -> None:
    prospect = prospect_id(db_session)
    company = person(db_session, prospect).company_id
    assert company is not None
    act(client, "prospects", prospect, "archive")
    act(client, "companies", company, "archive")

    assert ok(client.get("/api/prospection/prospects"))["total"] == 0
    (listed,) = ok(client.get("/api/prospection/prospects?include_archived=true"))["items"]
    assert listed["block"] == "prospect_archived"

    def listed_companies(query: str = "") -> dict[str, Any]:
        items = ok(client.get(f"/api/companies{query}"))["items"]
        return {item["id"]: item for item in items}

    assert str(company) not in listed_companies()
    shown = listed_companies("?include_archived=true")[str(company)]
    assert shown["block"] == "company_archived"
    # Still there, still openable.
    assert ok(client.get(f"/api/prospects/{prospect}"))["id"] == str(prospect)


def test_completing_a_record_makes_it_usable_by_itself(
    client: TestClient, db_session: Session
) -> None:
    """« Incomplet » is computed, never stored: nothing to lift."""
    company = add_company(db_session, "Entreprise Test")
    found = add_prospect(db_session, company=company)
    db_session.commit()
    (listed,) = ok(client.get("/api/prospection/prospects"))["items"]
    assert (listed["review"], listed["block"]) == ("incomplete", None)
    assert found.id


# --- warehouse mails -----------------------------------------------------------------------------


def warehouse_draft(session: Session, recipient: str) -> WarehouseDraft:
    site = Warehouse(name="Site Test")
    session.add(site)
    session.flush()
    draft = WarehouseDraft(
        warehouse_id=site.id,
        warehouse_name=site.name,
        contact_name="Camille Test",
        recipient=recipient,
        subject="Subject",
        body="Body",
        review_note="Note",
        send_state="scheduled",
        scheduled_at=datetime(2026, 1, 5, 8, 0, tzinfo=UTC),
        validated_at=datetime(2026, 1, 4, tzinfo=UTC),
        human_validated=True,
    )
    session.add(draft)
    session.flush()
    return draft


def test_a_warehouse_mail_to_someone_who_left_is_stopped_and_refused(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    found = add_prospect(db_session)
    add_email(db_session, found, "camille@example.test")
    draft = warehouse_draft(db_session, "Camille@example.test")
    db_session.commit()

    act(connected, "prospects", found.id, "depart", departure_reason="left_company")

    db_session.expire_all()
    stopped = db_session.get(WarehouseDraft, draft.id)
    assert stopped is not None
    assert (stopped.send_state, stopped.failure_code) == ("failed", "prospect_departed")
    refused(
        connected.post(
            f"/api/warehouses/drafts/{draft.id}/schedule",
            json={"revision": stopped.revision, "scheduled_at": FUTURE.isoformat()},
        ),
        409,
        "prospect_departed",
    )
    # And the dispatcher checks by itself.
    stopped.send_state, stopped.human_validated = "scheduled", True
    stopped.scheduled_at = datetime.now(UTC)
    stopped.validated_at = datetime.now(UTC)
    db_session.commit()
    dispatch_warehouses(toolbox_app.state.session_factory, config(), toolbox_of(toolbox_app))
    db_session.expire_all()
    assert fake.sent == []
    again = db_session.get(WarehouseDraft, draft.id)
    assert again is not None and again.failure_code == "prospect_departed"


# --- e-mail addresses ----------------------------------------------------------------------------


def save(
    client: TestClient,
    prospect: uuid.UUID,
    emails: list[dict[str, Any]] | None = None,
    **changes: Any,
) -> Any:
    view = ok(client.get(f"/api/prospects/{prospect}"))
    body = {
        "version": view["version"],
        "first_name": view["first_name"],
        "last_name": view["last_name"],
        "company_id": view["company"]["id"],
        "activity_status": view["activity_status"],
        "emails": emails if emails is not None else [alias(item) for item in view["emails"]],
        "phones": [],
        **changes,
    }
    return ok(client.put(f"/api/prospects/{prospect}", json=body))


def alias(item: dict[str, Any], **changes: Any) -> dict[str, Any]:
    keys = ("id", "address", "is_primary", "is_active", "verification_status", "source_reference")
    return {**{key: item[key] for key in keys}, **changes}


def with_two_addresses(client: TestClient, session: Session) -> tuple[uuid.UUID, list[Any]]:
    prospect = prospect_id(session)
    first = ok(client.get(f"/api/prospects/{prospect}"))["emails"]
    saved = save(
        client,
        prospect,
        [
            *(alias(item) for item in first),
            {"address": "second@example.test", "is_primary": False},
        ],
    )
    return prospect, saved["emails"]


def test_two_addresses_exchange_their_values_in_one_save(
    client: TestClient, db_session: Session
) -> None:
    prospect, (one, two) = with_two_addresses(client, db_session)
    saved = save(
        client,
        prospect,
        [
            alias(one, address=two["address"], verification_status="unverified"),
            alias(two, address=one["address"], verification_status="unverified"),
        ],
    )
    by_address = {item["address"]: item for item in saved["emails"]}
    assert set(by_address) == {one["address"], two["address"]}
    # The verification stays with the address; the primary flag goes where the person put it.
    assert by_address[one["address"]]["verification_status"] == one["verification_status"]
    assert by_address[two["address"]]["is_primary"] is True


@pytest.mark.parametrize("change", ["edit", "switch_primary", "remove"])
def test_open_messages_follow_the_address_and_lose_their_validation(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    change: str,
) -> None:
    prospect, (one, two) = with_two_addresses(connected, db_session)
    message = scheduled(connected, prospect)
    assert row(db_session, message["id"]).to_recipients == [one["address"]]
    if change == "edit":
        new = "renamed@example.test"
        emails = [alias(one, address=new, verification_status="unverified"), alias(two)]
    elif change == "switch_primary":
        new = two["address"]
        emails = [alias(one, is_primary=False), alias(two, is_primary=True)]
    else:
        new = two["address"]
        emails = [alias(two, is_primary=True)]

    saved = save(connected, prospect, emails)

    assert (saved["updated_recipients"], saved["unvalidated_messages"]) == (1, 1)
    after = row(db_session, message["id"])
    assert (after.status, after.to_recipients, after.validated_at) == (M.DRAFT, [new], None)
    assert (after.missed_reason, after.last_error_code) == (
        "recipient_changed",
        "recipient_changed",
    )
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert fake.sent == []


def test_an_unrelated_address_change_keeps_the_validation(
    connected: TestClient, db_session: Session
) -> None:
    prospect, (one, two) = with_two_addresses(connected, db_session)
    message = scheduled(connected, prospect)
    saved = save(connected, prospect, [alias(one), alias(two, address="other@example.test")])
    assert saved["updated_recipients"] == 0
    assert row(db_session, message["id"]).status is M.SCHEDULED


def test_a_departed_person_can_still_have_a_real_send_recorded(
    client: TestClient, db_session: Session
) -> None:
    found = add_prospect(db_session, company=add_company(db_session, "Entreprise Test"))
    start_sequence(db_session, found)
    db_session.commit()
    act(client, "prospects", found.id, "depart", departure_reason="other")
    ok(client.post(f"{messages(found.id)}/mark-sent", json={"rank": 0}), 201)


@pytest.mark.parametrize("change", ["address", "archive"])
def test_a_lost_draft_keeps_the_may_have_left_doubt_through_an_automatic_change(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session, change: str
) -> None:
    prospect, (one, two) = with_two_addresses(connected, db_session)
    message = scheduled(connected, prospect)
    del fake.drafts[str(row(db_session, message["id"]).remote_draft_id)]  # sent by hand
    check_scheduled_drafts(toolbox_app.state.session_factory, toolbox_of(toolbox_app))

    if change == "address":
        save(connected, prospect, [alias(one, is_primary=False), alias(two, is_primary=True)])
    else:
        act(connected, "prospects", prospect, "archive")
        act(connected, "prospects", prospect, "unarchive")

    after = row(db_session, message["id"])
    assert after.status is (M.DRAFT if change == "address" else M.CANCELLED)
    assert after.sent_doubt_reason == "draft_missing"
    (item,) = ok(connected.get("/api/contact/unsent"))["items"]
    assert (item["kind"], item["send"]["needs_sent_check"]) == ("doubt", True)
    path = f"{messages(prospect)}/contact"
    if change == "archive":
        ok(connected.post(f"{path}/reopen", json={"expected_revision": after.revision}))
    revision = {"expected_revision": row(db_session, message["id"]).revision}
    ok(connected.post(f"{path}/validate", json=revision))
    refused(
        connected.post(f"{path}/schedule", json=revision | {"scheduled_at": FUTURE.isoformat()}),
        409,
        "sent_check_required",
    )


# --- warehouse mails and address changes ----------------------------------------------------------


def send_warehouses(app: FastAPI) -> None:
    dispatch_warehouses(app.state.session_factory, config(), toolbox_of(app))


def due_warehouse_draft(session: Session, recipient: str) -> WarehouseDraft:
    draft = warehouse_draft(session, recipient)
    draft.scheduled_at = datetime.now(UTC)
    session.commit()
    return draft


def stored(session: Session, draft: WarehouseDraft) -> WarehouseDraft:
    session.expire_all()
    found = session.get(WarehouseDraft, draft.id)
    assert found is not None
    return found


def renamed(client: TestClient, prospect: uuid.UUID, **changes: Any) -> str:
    """The person's only address is changed to another one; returns the former address."""
    (first,) = ok(client.get(f"/api/prospects/{prospect}"))["emails"]
    new = alias(first, address="new@example.test", verification_status="unverified")
    save(client, prospect, [new], **changes)
    return str(first["address"])


@pytest.mark.parametrize("then", ["nothing", "same_save_departure", "opposition", "removed"])
def test_a_warehouse_mail_to_a_former_address_never_leaves(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    then: str,
) -> None:
    prospect = prospect_id(db_session)
    (first,) = ok(connected.get(f"/api/prospects/{prospect}"))["emails"]
    draft = due_warehouse_draft(db_session, first["address"])

    if then == "removed":
        save(connected, prospect, [])
    elif then == "same_save_departure":
        renamed(connected, prospect, activity_status="inactive")
    else:
        renamed(connected, prospect)
    if then == "opposition":
        version = ok(connected.get(f"/api/prospects/{prospect}"))["version"]
        body = {"do_not_contact": True, "reason": "Asked", "version": version}
        ok(connected.put(f"/api/prospects/{prospect}/contactability", json=body))
    send_warehouses(toolbox_app)

    after = stored(db_session, draft)
    assert fake.sent == []
    assert (after.send_state, after.failure_code, after.human_validated) == (
        "failed",
        "recipient_changed",
        False,
    )


@pytest.mark.parametrize(
    ("departed", "code"), [(False, "recipient_changed"), (True, "prospect_departed")]
)
def test_the_send_checks_a_removed_address_by_itself(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    departed: bool,
    code: str,
) -> None:
    """Even if no path had stopped the mail (it is put back to « scheduled » by hand)."""
    prospect = prospect_id(db_session)
    (first,) = ok(connected.get(f"/api/prospects/{prospect}"))["emails"]
    draft = due_warehouse_draft(db_session, first["address"])
    renamed(connected, prospect, **({"activity_status": "inactive"} if departed else {}))
    forced = stored(db_session, draft)
    forced.send_state, forced.human_validated = "scheduled", True
    forced.validated_at = forced.scheduled_at = datetime.now(UTC)
    db_session.commit()

    send_warehouses(toolbox_app)

    assert fake.sent == []
    after = stored(db_session, draft)
    assert after.failure_code == code
    body = {"revision": after.revision, "scheduled_at": FUTURE.isoformat()}
    refused(connected.post(f"/api/warehouses/drafts/{draft.id}/schedule", json=body), 409, code)


def test_a_new_validation_decides_for_a_removed_address(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    (first,) = ok(connected.get(f"/api/prospects/{prospect}"))["emails"]
    draft = due_warehouse_draft(db_session, first["address"])
    warehouse = db_session.get(Warehouse, draft.warehouse_id)
    assert warehouse is not None
    warehouse.prospecting_category = "other"
    db_session.commit()
    renamed(connected, prospect)
    item = {"id": str(draft.id), "revision": stored(db_session, draft).revision}
    planned = {"scheduled_at": FUTURE.isoformat(), "drafts": [item]}

    ok(connected.post("/api/warehouses/drafts/plan-batch", json=planned))
    body = {"revision": stored(db_session, draft).revision}
    answer = ok(connected.post(f"/api/warehouses/drafts/{draft.id}/validate", json=body))

    assert answer["send_state"] == "scheduled"


# --- the other writers of e-mail rows -------------------------------------------------------------


def test_two_explorer_changes_swapping_the_primary_keep_a_recipient(
    connected: TestClient, db_session: Session
) -> None:
    prospect, (one, two) = with_two_addresses(connected, db_session)
    message = scheduled(connected, prospect)
    updates = []
    for item, primary in ((one, False), (two, True)):
        email = db_session.get(Email, uuid.UUID(item["id"]))
        assert email is not None
        db_session.refresh(email)
        updates.append(update(email, is_primary=primary))

    ok(connected.post("/api/explorer/tables/emails/changes", json={"updates": updates}))

    after = row(db_session, message["id"])
    assert (after.status, after.to_recipients) == (M.DRAFT, [two["address"]])
