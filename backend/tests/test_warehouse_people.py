"""Warehouse people as prospects (user feedback 2026-11-27, item 6): one pipeline, no duplicate
record, no duplicate send. Synthetic people, fake Toolbox."""

import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.core.actor import ActorContext, ActorType
from app.db.session import create_session_factory
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
from app.services import warehouse_companies, warehouse_people
from app.services.audit import attributed_unit_of_work
from app.services.errors import BusinessRuleError
from app.services.warehouse_companies import looks_like_company
from app.services.warehouse_dispatch import dispatch_warehouses
from app.services.warehouse_people import read_name
from tests.builders import add_cohort, add_company, add_email, add_prospect, start_sequence
from tests.fake_toolbox import FakeToolbox
from tests.support import reset_database
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


def proposals(client: TestClient) -> dict[str, dict[str, Any]]:
    return {
        p["warehouse_name"]: p for p in ok_list(client.get("/api/warehouses/company-proposals"))
    }


def test_a_company_is_proposed_from_domain_owner_or_name_and_never_arbitrarily(
    client: TestClient, db_session: Session
) -> None:
    by_domain = add_company(db_session, "Alpha Exemple", email_domain="alpha.example")
    by_staff = add_company(db_session, "Beta Exemple")
    add_email(db_session, add_prospect(db_session, by_staff), "x.beta@beta.example")
    owner = add_company(db_session, "Gamma Exemple SAS")
    named = add_company(db_session, "Delta Exemple")
    add_company(db_session, "Epsilon Exemple")
    add_company(db_session, "Epsilon Exemple SARL")
    anyone = listed("Anne Exemple")
    for name, people, fields in (
        ("Quai A", [listed("Anne Exemple", "anne@alpha.example")], {}),
        ("Quai B", [listed("Anne Exemple", "anne@beta.example")], {}),
        ("Quai C", [anyone], {"owner_name": "Gamma Exemple"}),
        ("Delta Exemple - Rue des Tests", [anyone], {}),
        ("Epsilon Exemple", [anyone], {}),
        ("Delta Exemple / Zeta Exemple", [anyone], {}),
        ("Zeta Transports - Ville Test", [listed("Anne Exemple", "anne@gmail.com")], {}),
        ("Entrepôt nord", [anyone], {}),
        ("Quai D", [listed("Anne", "a@alpha.example"), listed("Paul", "p@beta.example")], {}),
        ("Sans personne", [], {}),
    ):
        site(db_session, *people, name=name, **fields)
    site(db_session, anyone, name="Déjà rattaché", company=named)

    found = proposals(client)

    def read(name: str) -> tuple[str, str | None, list[str]]:
        item = found[name]
        return item["status"], item["company_id"] or item["company_name"], item["sources"]

    assert read("Quai A") == ("existing", str(by_domain.id), ["domain"])
    assert read("Quai B") == ("existing", str(by_staff.id), ["domain"])
    assert read("Quai C") == ("existing", str(owner.id), ["owner"])
    assert read("Delta Exemple - Rue des Tests") == ("existing", str(named.id), ["name"])
    assert read("Zeta Transports - Ville Test") == ("new", "Zeta Transports", ["name"])
    assert [
        (read(n)[0], read(n)[1], len(found[n]["candidates"]))
        for n in (
            "Epsilon Exemple",
            "Delta Exemple / Zeta Exemple",
            "Entrepôt nord",
            "Quai D",
        )
    ] == [
        ("ambiguous", None, 2),
        ("several", None, 1),
        ("none", None, 0),
        ("ambiguous", None, 2),
    ]
    assert "Sans personne" not in found and "Déjà rattaché" not in found


@pytest.mark.parametrize(
    ("part", "company"),
    [("Zeta Transports", True), ("Plateforme Test", False), ("12 rue des Tests", False)],
)
def test_a_place_label_is_not_a_company(part: str, company: bool) -> None:
    assert looks_like_company(part) is company


def test_confirming_the_company_attaches_the_warehouse_once(
    client: TestClient, db_session: Session
) -> None:
    first = site(db_session, listed("Anne Exemple"), name="Zeta Transports - Quai 1", city="Ville")
    second = site(db_session, listed("Paul Exemple"), name="Zeta Transports - Quai 2")
    companies_before = count(db_session, Company)
    answer = ok(client.get(f"/api/warehouses/{first.id}/people"))
    assert answer["proposal"]["company_name"] == "Zeta Transports"
    url = f"/api/warehouses/{first.id}/company"

    created = ok(client.post(url, json={"new_name": "Zeta Transports"}))

    assert created["created"] is True
    after = ok(client.get(f"/api/warehouses/{first.id}/people"))
    assert (after["company_id"], after["proposal"]) == (created["company_id"], None)
    shown = ok(client.get(f"/api/warehouses/{first.id}"))
    assert (shown["company_name"], shown["building_name"]) == ("Zeta Transports", first.name)
    # The other site now proposes the same company, and naming it again creates no second one.
    assert proposals(client)[second.name]["company_id"] == created["company_id"]
    again = ok(
        client.post(
            f"/api/warehouses/{second.id}/company", json={"new_name": "Zeta Transports SAS"}
        )
    )
    assert (again["company_id"], again["created"]) == (created["company_id"], False)
    assert count(db_session, Company) == companies_before + 1
    assert count(db_session, Establishment) == 2
    # Repeating is harmless; another company is refused.
    ok(client.post(url, json={"company_id": created["company_id"]}))
    other = add_company(db_session, "Autre Exemple")
    db_session.flush()
    refused(client.post(url, json={"company_id": str(other.id)}), 409, "already_attached")
    assert count(db_session, Establishment) == 2


def test_the_dry_run_shows_the_companies_and_attaches_none(
    client: TestClient, db_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    site(db_session, listed("Anne Exemple"), name="Zeta Transports - Quai")
    site(db_session, listed("Paul Exemple"), name="Alpha / Beta")
    factory = sessionmaker(bind=db_session.get_bind(), join_transaction_mode="create_savepoint")
    before = (count(db_session, Company), count(db_session, Establishment))

    for arguments in (["warehouse-people"], ["warehouse-people", "--apply"]):
        assert cli.main(arguments, factory) == 0
        output = capsys.readouterr().out
        assert "Zeta Transports (nouvelle ; source : nom de l’entrepôt)" in output
        assert "SOCIÉTÉ À CHOISIR | Alpha / Beta" in output
    assert (count(db_session, Company), count(db_session, Establishment)) == before


def test_simultaneous_requests_create_one_person_and_one_company(
    engine: Engine, test_database_url: str
) -> None:
    """Real connections, committed (the database is reset afterwards): four warehouses ask for
    the same new company, then for the same new person, at once."""
    factory = create_session_factory(engine)
    pilot = ActorContext(type=ActorType.HUMAN, display="Pilote", id=str(uuid.uuid4()))
    try:
        with attributed_unit_of_work(factory, pilot) as session:
            sites = [
                site(session, listed("Zoé Simultanée", "zoe@simul.example"), name=f"Simul {i}")
                for i in range(4)
            ]
            ids = [item.id for item in sites]

        def at_once(write: Callable[[Session, uuid.UUID], object]) -> list[str]:
            barrier = threading.Barrier(len(ids))

            def run(warehouse_id: uuid.UUID) -> str:
                barrier.wait()
                try:
                    with attributed_unit_of_work(factory, pilot) as session:
                        write(session, warehouse_id)
                except BusinessRuleError as error:
                    return error.code
                return "ok"

            with ThreadPoolExecutor(len(ids)) as pool:
                return sorted(pool.map(run, ids))

        assert (
            at_once(lambda s, w: warehouse_companies.attach(s, pilot, w, new_name="Simul Fret"))
            == ["ok"] * 4
        )
        with factory() as session:
            (company,) = session.scalars(
                select(Company.id).where(Company.display_name == "Simul Fret")
            )
        person = warehouse_people.NewPerson("Zoé", "Simultanée", company)

        assert at_once(
            lambda s, w: warehouse_people.create(
                s, pilot, w, "Zoé Simultanée", person, distinct_confirmed=True
            )
        ) == ["ok", "person_exists", "person_exists", "person_exists"]
        with factory() as session:
            found = session.scalar(select(func.count()).where(Prospect.last_name == "Simultanée"))
        assert found == 1
    finally:
        reset_database(engine, test_database_url)


@pytest.mark.parametrize("state", ["scheduled", "doubt"])
def test_a_sent_warehouse_mail_never_overwrites_a_programmed_or_doubtful_step(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session, state: str
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    if state == "doubt":
        found = row(db_session, message["id"])
        ok(
            connected.post(
                f"{messages(prospect)}/contact/unschedule",
                json={"expected_revision": found.revision},
            )
        )
        found = row(db_session, message["id"])
        found.sent_doubt_reason, found.sent_doubt_at = "send_outcome_unknown", datetime.now(UTC)
        db_session.commit()
    warehouse = site(db_session, listed("Jean Test"))
    draft = mail(db_session, warehouse, "Jean Test", "jean.test@exemple.example", "sent")
    db_session.commit()
    before = row(db_session, message["id"])
    kept = (before.status, before.subject, before.scheduled_at, before.sent_doubt_reason)

    chosen = {"contact_name": "Jean Test", "prospect_id": str(prospect)}
    ok(connected.post(path(warehouse), json=chosen))

    after = row(db_session, message["id"])
    assert (after.status, after.subject, after.scheduled_at, after.sent_doubt_reason) == kept
    assert db_session.get_one(WarehouseDraft, draft.id).carried_message_id is None
    assert people(connected, warehouse)[0]["state"]["warehouse_uncounted"] == 1
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert fake.sent == []


@pytest.mark.parametrize("linked", [True, False])
def test_a_programmed_mail_never_follows_a_contact_send_under_another_name(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    linked: bool,
) -> None:
    prospect = prospect_id(db_session)
    ok(connected.post(f"{messages(prospect)}/mark-sent", json={"rank": 0}), 201)
    warehouse = site(db_session, listed("Jeannot Essai"))
    # Linked: another address, found by the listing entry. Unlinked: the person's own address.
    address = "autre@exemple.example" if linked else "jean.test@exemple.example"
    if linked:
        db_session.add(
            WarehousePerson(
                warehouse_id=warehouse.id,
                contact_key="essai jeannot",
                contact_name="Jeannot Essai",
                prospect_id=prospect,
                linked_by_display="Pilote",
            )
        )
    draft = mail(db_session, warehouse, "Jeannot Essai", address, "scheduled")
    db_session.commit()

    dispatch_warehouses(toolbox_app.state.session_factory, config(), toolbox_of(toolbox_app))

    db_session.expire_all()
    assert db_session.get_one(WarehouseDraft, draft.id).failure_code == "contacted_in_contact"
    assert fake.sent == []
