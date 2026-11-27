"""Warehouse people as prospects (user feedback 2026-11-27, item 6): one pipeline, no duplicate
record, no duplicate send. Synthetic people, fake Toolbox."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.models import (
    Company,
    ContactMessage,
    Establishment,
    Prospect,
    ProspectSource,
    Warehouse,
    WarehouseDraft,
    WarehousePerson,
)
from app.models.enums import ContactabilityStatus, ContactMessageStatus, SendSource
from app.services.warehouse_dispatch import dispatch_warehouses
from app.services.warehouse_people import read_name
from tests.builders import add_cohort, add_company, add_email, add_prospect, start_sequence
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_dispatch import DUE, Clock, config, dispatcher, row, scheduled, toolbox_of
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused
from tests.test_contact_remote_drafts import validated

M = ContactMessageStatus
SENT_AT = datetime(2026, 9, 1, 8, 0, tzinfo=UTC)


def site(
    session: Session,
    *people: dict[str, Any],
    company: Company | None = None,
    name: str = "Quai Exemple",
    **fields: Any,
) -> Warehouse:
    if company is not None:
        building = Establishment(company_id=company.id, name="Entrepôt", city="Ville Test")
        session.add(building)
        session.flush()
        fields["establishment_id"] = building.id
    found = Warehouse(name=name, contacts=list(people), **fields)
    session.add(found)
    session.flush()
    return found


def listed(name: str, email: str | None = None, role: str | None = None) -> dict[str, Any]:
    return {"full_name": name, "email": email, "role": role, "linkedin": None, "to_contact": False}


def mail(
    session: Session,
    warehouse: Warehouse,
    name: str,
    recipient: str,
    state: str | None,
    **over: Any,
) -> WarehouseDraft:
    values: dict[str, Any] = {
        "warehouse_id": warehouse.id,
        "warehouse_name": warehouse.name,
        "contact_name": name,
        "recipient": recipient,
        "subject": "Objet entrepôt",
        "body": "Texte entrepôt",
        "review_note": "Note",
        "send_state": state,
    }
    if state == "sent":
        values["sent_at"] = SENT_AT
    if state == "scheduled":
        values |= {
            "scheduled_at": datetime.now(UTC),
            "validated_at": datetime.now(UTC),
            "human_validated": True,
        }
    draft = WarehouseDraft(**(values | over))
    session.add(draft)
    session.flush()
    return draft


def people(client: TestClient, warehouse: Warehouse) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = ok(client.get(f"/api/warehouses/{warehouse.id}/people"))["people"]
    return found


def path(warehouse: Warehouse) -> str:
    return f"/api/warehouses/{warehouse.id}/people"


def new(company: Company, first: str = "Anne", last: str = "Exemple") -> dict[str, Any]:
    return {"first_name": first, "last_name": last, "company_id": str(company.id)}


def count(session: Session, model: Any) -> int:
    session.expire_all()
    statement = select(func.count()).select_from(model)
    if model is Prospect:  # the signed-in member has a fiche of their own
        statement = statement.where(Prospect.member_user_id.is_(None))
    return session.scalar(statement) or 0


def sends(session: Session, prospect: uuid.UUID) -> list[tuple[int, str, str, SendSource | None]]:
    session.expire_all()
    rows = session.scalars(
        select(ContactMessage)
        .where(ContactMessage.prospect_id == prospect, ContactMessage.status == M.SENT)
        .order_by(ContactMessage.rank)
    )
    return [(m.rank, m.subject, m.body_text, m.sent_source) for m in rows]


@pytest.mark.parametrize(
    ("value", "state", "first", "last"),
    [
        ("Anne EXEMPLE", "person", "Anne", "Exemple"),
        ("EXEMPLE Anne", "person", "Anne", "Exemple"),
        ("Mme Anne De La Tour", "person", "Anne", "De La Tour"),
        ("Anne", "incomplete", "", "Anne"),
        ("Service logistique", "not_a_person", "", ""),
        ("Anne Exemple / Jean Test", "not_a_person", "", ""),
        ("Anne et Jean Test", "not_a_person", "", ""),
        ("contact@exemple.example", "not_a_person", "", ""),
        ("Transports Exemple SARL", "not_a_person", "", ""),
    ],
)
def test_only_one_persons_name_is_read_as_a_person(
    value: str, state: str, first: str, last: str
) -> None:
    found = read_name(value)
    assert (found.state, found.first_name, found.last_name) == (state, first, last)


def test_a_new_person_becomes_a_prospect_once_and_is_shown_linked(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    first = site(
        db_session,
        listed("Anne EXEMPLE", "anne.exemple@exemple.example", "Responsable logistique"),
        listed("Accueil"),
        company=company,
    )
    second = site(db_session, listed("Exemple Anne", None), company=company, name="Autre quai")
    assert [p["status"] for p in people(client, first)] == ["new", "not_a_person"]
    body = {"contact_name": "Anne EXEMPLE", "create": new(company)}

    created = ok(client.post(path(first), json=body))["prospect_id"]

    prospect = db_session.get_one(Prospect, uuid.UUID(created))
    assert (prospect.company_id, prospect.exact_job_title) == (
        company.id,
        "Responsable logistique",
    )
    assert [(e.address, e.is_primary) for e in prospect.emails] == [
        ("anne.exemple@exemple.example", True)
    ]
    assert count(db_session, ProspectSource) == 1
    linked = people(client, first)[0]
    assert (linked["status"], linked["prospect"]["id"]) == ("linked", created)
    assert (linked["state"]["cohort_code"], linked["state"]["sent_count"]) == (None, 0)
    refused(client.post(path(first), json=body), 409, "already_linked")
    # The same person on another site: matched, never created again.
    (other,) = people(client, second)
    assert other["status"] == "match"
    again = {"contact_name": "Exemple Anne", "create": new(company), "distinct_confirmed": True}
    refused(client.post(path(second), json=again), 409, "person_exists")
    chosen = {"contact_name": "Exemple Anne", "prospect_id": created}
    assert ok(client.post(path(second), json=chosen))["prospect_id"] == created
    assert (count(db_session, Prospect), count(db_session, WarehousePerson)) == (1, 2)


def test_a_look_alike_is_for_a_person_to_decide(client: TestClient, db_session: Session) -> None:
    company, elsewhere = add_company(db_session), add_company(db_session, "Autre Exemple SAS")
    homonym = add_prospect(db_session, elsewhere, first_name="Anne", last_name="Exemple")
    warehouse = site(db_session, listed("Anne Exemple"), company=company)

    (found,) = people(client, warehouse)

    assert found["status"] == "ambiguous"
    assert [(c["prospect_id"], c["reasons"]) for c in found["candidates"]] == [
        (str(homonym.id), ["same_name"])
    ]
    body = {"contact_name": "Anne Exemple", "create": new(company)}
    refused(client.post(path(warehouse), json=body), 409, "person_to_confirm")
    ok(client.post(path(warehouse), json=body | {"distinct_confirmed": True}))
    assert count(db_session, Prospect) == 2


def test_an_opposition_carries_over_and_is_never_bypassed(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    opposed = add_prospect(
        db_session,
        company,
        first_name="Anne",
        last_name="Exemple",
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime.now(UTC),
    )
    add_email(db_session, opposed, "ancienne@exemple.example")
    warehouse = site(db_session, listed("Anne Exemple", "autre@exemple.example"), company=company)
    programmed = mail(db_session, warehouse, "Anne Exemple", "autre@exemple.example", "scheduled")
    # Even under another name, the opposed address never goes to a new record.
    typed = new(company, "Zoé", "Inconnue")
    hidden = site(db_session, listed("Zoé Inconnue", "ancienne@exemple.example"), name="Quai 2")
    body = {"contact_name": "Zoé Inconnue", "create": typed, "distinct_confirmed": True}
    refused(client.post(path(hidden), json=body), 409, "person_exists")

    ok(
        client.post(
            path(warehouse), json={"contact_name": "Anne Exemple", "prospect_id": str(opposed.id)}
        )
    )

    db_session.expire_all()
    stopped = db_session.get_one(WarehouseDraft, programmed.id)
    assert (stopped.send_state, stopped.failure_code, stopped.prospect_id) == (
        "failed",
        "prospect_do_not_contact",
        opposed.id,
    )
    assert db_session.get_one(Prospect, opposed.id).contactability_status is (
        ContactabilityStatus.DO_NOT_CONTACT
    )
    assert people(client, warehouse)[0]["state"]["block"] == "prospect_do_not_contact"


def test_a_sent_warehouse_mail_is_the_contact_step_once_a_week_is_chosen(
    connected: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    warehouse = site(db_session, listed("Anne Exemple", "anne@exemple.example"), company=company)
    first = mail(db_session, warehouse, "Anne Exemple", "anne@exemple.example", "sent")
    # The second address of the same day is the same step.
    mail(db_session, warehouse, "Anne Exemple", "a.exemple@exemple.example", "sent")
    body = {"contact_name": "Anne Exemple", "create": new(company)}
    prospect = uuid.UUID(ok(connected.post(path(warehouse), json=body))["prospect_id"])
    state = people(connected, warehouse)[0]["state"]
    assert (state["sent_count"], state["warehouse_uncounted"]) == (0, 2)
    history = ok_list(connected.get(f"/api/warehouses/drafts?prospect_id={prospect}"))
    assert [d["send_state"] for d in history] == ["sent", "sent"]
    cohort = add_cohort(db_session)

    chosen = {"cohort_id": str(cohort.id)}
    ok(connected.put(f"/api/prospects/{prospect}/cohort", json=chosen))

    assert sends(db_session, prospect) == [
        (0, "Objet entrepôt", "Texte entrepôt", SendSource.MIGRATION)
    ]
    db_session.expire_all()
    carried = db_session.get_one(WarehouseDraft, first.id).carried_message_id
    assert carried is not None
    assert people(connected, warehouse)[0]["state"]["warehouse_uncounted"] == 0
    refused(
        connected.put(f"{messages(prospect)}/contact", json={"subject": "S", "body_text": "B"}),
        409,
        "message_sent_immutable",
    )
    # Linking again counts nothing twice.
    again = {"contact_name": "Anne Exemple", "prospect_id": str(prospect)}
    ok(connected.post(path(warehouse), json=again))
    assert len(sends(db_session, prospect)) == 1


def ok_list(response: Any) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    found: list[dict[str, Any]] = response.json()
    return found


def test_linking_a_prospect_in_sequence_counts_the_send_over_the_unsent_step(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = validated(connected, prospect, "contact")["message"]
    warehouse = site(db_session, listed("Jean Test", "jean.test@exemple.example"))
    mail(db_session, warehouse, "Jean Test", "jean.test@exemple.example", "sent")
    # Before the link, the same address and name already hold the send back.
    refused(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        ),
        409,
        "warehouse_send_unrecorded",
    )

    chosen = {"contact_name": "Jean Test", "prospect_id": str(prospect)}
    ok(connected.post(path(warehouse), json=chosen))

    assert [s[:2] for s in sends(db_session, prospect)] == [(0, "Objet entrepôt")]
    assert row(db_session, message["id"]).status is M.SENT


def test_a_later_recorded_send_covers_an_older_warehouse_mail(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    sequence = start_sequence(db_session, prospect)
    db_session.add(
        ContactMessage(
            prospect_id=prospect.id,
            sequence_id=sequence.id,
            rank=0,
            status=M.SENT,
            sent_at=SENT_AT + timedelta(days=30),
            sent_source=SendSource.MANUAL,
        )
    )
    warehouse = site(db_session, listed("Jean Test"))
    draft = mail(db_session, warehouse, "Jean Test", "jean@exemple.example", "sent")

    chosen = {"contact_name": "Jean Test", "prospect_id": str(prospect.id)}
    ok(client.post(path(warehouse), json=chosen))

    assert len(sends(db_session, prospect.id)) == 1
    db_session.expire_all()
    assert db_session.get_one(WarehouseDraft, draft.id).carried_message_id is not None


@pytest.mark.parametrize("state", ["scheduled", "sending", "uncertain"])
def test_nothing_leaves_from_contact_while_a_warehouse_mail_is_not_settled(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session, state: str
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    warehouse = site(db_session, listed("Jean Test"))
    draft = mail(db_session, warehouse, "Jean Test", "autre@exemple.example", state)
    draft.prospect_id = prospect
    db_session.commit()

    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))

    held = row(db_session, message["id"])
    assert (held.status, held.last_error_code) == (M.VALIDATED, "send_warehouse_pending")
    assert fake.sent == []
    refused(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": held.revision, "scheduled_at": FUTURE.isoformat()},
        ),
        409,
        "warehouse_send_pending",
    )


def test_a_programmed_warehouse_mail_leaves_once_and_counts_as_the_contact(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    warehouse = site(db_session, listed("Jean Test"))
    drafts = [
        mail(db_session, warehouse, "Jean Test", address, "scheduled", prospect_id=prospect)
        for address in ("un@exemple.example", "deux@exemple.example")
    ]
    db_session.commit()

    dispatch_warehouses(toolbox_app.state.session_factory, config(), toolbox_of(toolbox_app))

    db_session.expire_all()
    states = sorted(
        (d.send_state, d.failure_code)
        for d in (db_session.get_one(WarehouseDraft, item.id) for item in drafts)
    )
    assert states == [("failed", "contacted_in_contact"), ("sent", None)]
    assert len(fake.sent) == 1
    assert [s[:2] for s in sends(db_session, prospect)] == [(0, "Objet entrepôt")]


def test_a_programmed_warehouse_mail_never_follows_a_contact_send(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    ok(connected.post(f"{messages(prospect)}/mark-sent", json={"rank": 0}), 201)
    warehouse = site(db_session, listed("Jean Test"))
    draft = mail(db_session, warehouse, "Jean Test", "jean.test@exemple.example", "scheduled")
    db_session.commit()

    dispatch_warehouses(toolbox_app.state.session_factory, config(), toolbox_of(toolbox_app))

    db_session.expire_all()
    assert db_session.get_one(WarehouseDraft, draft.id).failure_code == "contacted_in_contact"
    assert fake.sent == []


@pytest.mark.parametrize("sent", [True, False])
def test_a_person_settles_an_unknown_warehouse_send(
    client: TestClient, db_session: Session, sent: bool
) -> None:
    prospect = prospect_id(db_session)
    warehouse = site(db_session, listed("Jean Test"))
    draft = mail(db_session, warehouse, "Jean Test", "x@exemple.example", "uncertain")
    draft.prospect_id = prospect
    db_session.flush()

    answer = ok(
        client.post(
            f"/api/warehouses/drafts/{draft.id}/resolve",
            json={"revision": draft.revision, "sent": sent},
        )
    )

    assert answer["send_state"] == ("sent" if sent else "failed")
    assert len(sends(db_session, prospect)) == (1 if sent else 0)


def test_no_new_warehouse_mail_is_written_and_a_changed_listing_stops_programmed_ones(
    client: TestClient, db_session: Session
) -> None:
    saved = ok(
        client.post(
            "/api/warehouses",
            json={"name": "Quai", "contacts": [listed("Anne Exemple", role="Directrice")]},
        ),
        201,
    )
    saved["contacts"][0]["to_contact"] = True
    saved = ok(client.put(f"/api/warehouses/{saved['id']}", json=saved))
    assert count(db_session, WarehouseDraft) == 0
    warehouse = db_session.get_one(Warehouse, uuid.UUID(saved["id"]))
    draft = mail(db_session, warehouse, "Anne Exemple", "a@exemple.example", "scheduled")
    saved["contacts"][0]["role"] = "Responsable"

    ok(client.put(f"/api/warehouses/{saved['id']}", json=saved))

    db_session.expire_all()
    stopped = db_session.get_one(WarehouseDraft, draft.id)
    assert (stopped.send_state, stopped.failure_code) == ("failed", "warehouse_changed")


def test_the_backfill_lists_first_then_writes_once(
    client: TestClient, db_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    company = add_company(db_session)
    known = add_prospect(db_session, company, first_name="Paul", last_name="Connu")
    add_prospect(
        db_session, add_company(db_session, "Ailleurs SAS"), first_name="Lise", last_name="Homonyme"
    )
    site(
        db_session,
        listed("Anne Exemple", "anne@exemple.example"),
        listed("Paul CONNU"),
        listed("Lise Homonyme"),
        listed("Service quai"),
        company=company,
        owner_name="Foncière Exemple",
    )
    site(db_session, listed("Marc Sanssociete"), name="Sans société")
    site(db_session, listed("Anne Exemple", "anne@exemple.example"), name="Zone Est")
    factory = sessionmaker(bind=db_session.get_bind(), join_transaction_mode="create_savepoint")

    assert cli.main(["warehouse-people"], factory) == 0
    output = capsys.readouterr().out
    for label in ("À CRÉER : 1", "À RATTACHER : 2", "À TRANCHER : 1", "SANS SOCIÉTÉ : 1"):
        assert label in output, output
    assert "PAS UNE PERSONNE : 2" in output and "Simulation" in output
    assert (count(db_session, Prospect), count(db_session, WarehousePerson)) == (2, 0)

    assert cli.main(["warehouse-people", "--apply"], factory) == 0
    capsys.readouterr()
    assert (count(db_session, Prospect), count(db_session, WarehousePerson)) == (3, 3)
    links = set(db_session.scalars(select(WarehousePerson.prospect_id)))
    assert known.id in links and len(links) == 2

    assert cli.main(["warehouse-people", "--apply"], factory) == 0
    assert "DÉJÀ PROSPECT : 3" in capsys.readouterr().out
    assert (count(db_session, Prospect), count(db_session, WarehousePerson)) == (3, 3)
