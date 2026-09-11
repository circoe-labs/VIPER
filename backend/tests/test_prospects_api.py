"""Prospects HTTP API (`/api/prospects`, Task 15): protection, contract, refusals, atomicity."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.models import Prospect, Role, User
from app.models.enums import ContactabilityStatus
from tests.builders import add_company, add_email, add_prospect, add_role, audit_events

PROSPECTS = "/api/prospects"
CONTEXT = "Saisie manuelle — prospection B2B (synthétique)"


def body_of(view: dict[str, Any], **changes: Any) -> dict[str, Any]:
    """The PUT body the editor sends for an unchanged form, then `changes`."""
    alias = ("id", "is_primary", "is_active", "verification_status", "source_reference")
    tracking = view["tracking"]
    body = {
        "version": view["version"],
        "civility": view["civility"],
        "first_name": view["first_name"],
        "last_name": view["last_name"],
        "company_id": view["company"]["id"] if view["company"] else None,
        "role_id": view["role"]["id"] if view["role"] else None,
        "exact_job_title": view["exact_job_title"],
        "activity_status": view["activity_status"],
        "emails": [
            {"address": email["address"], **{key: email[key] for key in alias}}
            for email in view["emails"]
        ],
        "phones": [
            {"number": phone["number"], "type": phone["type"], **{key: phone[key] for key in alias}}
            for phone in view["phones"]
        ],
        "tracking": None
        if tracking is None
        else {
            "status": tracking["status"],
            "planned_contact_on": tracking["planned_contact_on"],
            "response_received_on": tracking["response_received_on"],
            "appointment_on": tracking["appointment_on"],
            "appointment_time": tracking["appointment_time"],
            "referent_id": tracking["referent"]["id"] if tracking["referent"] else None,
        },
    }
    return body | changes


def load(client: TestClient, prospect_id: uuid.UUID | str) -> dict[str, Any]:
    response = client.get(f"{PROSPECTS}/{prospect_id}")
    assert response.status_code == 200, response.text
    view: dict[str, Any] = response.json()
    return view


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", f"{PROSPECTS}/{uuid.uuid4()}"),
        ("POST", PROSPECTS),
        ("PUT", f"{PROSPECTS}/{uuid.uuid4()}"),
        ("PUT", f"{PROSPECTS}/{uuid.uuid4()}/contactability"),
        ("DELETE", f"{PROSPECTS}/{uuid.uuid4()}?version=x"),
    ],
)
def test_prospects_need_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    assert anonymous_client.request(method, path, json={}).status_code == 401


def test_writes_need_the_csrf_token(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    del client.headers[CSRF_HEADER]

    assert client.put(f"{PROSPECTS}/{prospect.id}", json=body_of(view)).status_code == 403
    reason = {"do_not_contact": True, "reason": "x", "version": view["version"]}
    assert client.put(f"{PROSPECTS}/{prospect.id}/contactability", json=reason).status_code == 403
    client.headers[CSRF_HEADER] = "forged"
    path = f"{PROSPECTS}/{prospect.id}?version={view['version']}"
    assert client.delete(path).status_code == 403
    assert db_session.get(Prospect, prospect.id) is not None


def test_lifecycle_is_attributed_to_the_signed_in_user(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    company = add_company(db_session)
    created = client.post(
        PROSPECTS,
        json={
            "first_name": "Jean",
            "last_name": "Api",
            "company_id": str(company.id),
            "role_label": "Rôle créé en ligne",
            "employment_verification": {"action": "verified_now"},
            "emails": [{"address": "Jean.Api@Exemple.example", "verified_now": True}],
            "phones": [{"number": "06 00 00 00 01", "type": "mobile"}],
            "tracking": {"status": "to_contact", "planned_contact_on": "2026-09-21"},
            "provenance": {"legal_basis_or_collection_context": CONTEXT},
        },
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert view["emails"][0]["address"] == "jean.api@exemple.example"
    assert view["emails"][0]["verification_status"] == "verified"
    assert view["phones"][0]["number"] == "+33600000001"
    assert view["tracking"]["planned_contact_week"] == "2026-W39"
    assert view["sources"][0]["source_type"] == "manual"
    assert view["sources"][0]["recorded_by"] == {
        "kind": "human",
        "label": "Pilote Test",
        "id": str(pilot_user.id),
        "on_behalf_of": None,
    }
    assert view["verification_state"] == "verified"

    saved = client.put(f"{PROSPECTS}/{view['id']}", json=body_of(view, last_name="Api-Modifié"))
    assert saved.status_code == 200, saved.text
    blocked = client.put(
        f"{PROSPECTS}/{view['id']}/contactability",
        json={
            "do_not_contact": True,
            "reason": "Demande (synthétique)",
            "version": saved.json()["version"],
        },
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["contactability_status"] == "do_not_contact"

    events = audit_events(db_session)
    assert {event.actor_id for event in events} == {str(pilot_user.id)}
    assert {event.actor_type for event in events} == {ActorType.HUMAN}
    assert {event.context["source"] for event in events} == {"ui"}
    assert "role.created" in {event.action for event in events}


def test_contactability_cannot_travel_with_the_save(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(
        db_session,
        add_company(db_session),
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=func.now(),
    )
    view = load(client, prospect.id)

    response = client.put(
        f"{PROSPECTS}/{prospect.id}",
        json=body_of(view, contactability_status="contactable", do_not_contact_reason=None),
    )

    assert response.status_code == 422
    assert load(client, prospect.id)["contactability_status"] == "do_not_contact"
    lift = {"do_not_contact": False, "reason": " ", "version": view["version"]}
    refused = client.put(f"{PROSPECTS}/{prospect.id}/contactability", json=lift)
    assert refused.status_code == 422
    assert refused.json()["detail"] == {
        "code": "invalid",
        "field": "reason",
        "reason": "blank",
        "message": "reason must not be blank.",
    }


def test_a_failing_alias_rolls_back_the_whole_save(client: TestClient, db_session: Session) -> None:
    old, new = add_company(db_session), add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, old)
    view = load(client, prospect.id)
    body = body_of(
        view,
        last_name="Jamais",
        company_id=str(new.id),
        role_label="Rôle jamais créé",
        emails=[{"address": "valide@exemple.example"}],
        phones=[{"number": "pas un numéro", "type": "mobile"}],
    )

    response = client.put(f"{PROSPECTS}/{prospect.id}", json=body)

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "phones.0.number"
    db_session.expire_all()
    after = load(client, prospect.id)
    assert (after["last_name"], after["company"]["id"], after["emails"]) == (
        "Test",
        str(old.id),
        [],
    )
    assert db_session.scalar(select(func.count()).select_from(Role)) == 0
    assert [event.action for event in audit_events(db_session)] == ["auth.login"]


def test_refusals_have_stable_codes(client: TestClient, db_session: Session) -> None:
    add_role(db_session, "logistique", "Responsable logistique")
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    path = f"{PROSPECTS}/{prospect.id}"

    duplicate = client.put(path, json=body_of(view, role_label="responsable logistique"))
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "duplicate"
    assert duplicate.json()["detail"]["field"] == "role_label"

    invalid = client.put(
        path, json=body_of(view, emails=[{"address": "a@b.example"}, {"address": "x"}])
    )
    assert invalid.status_code == 422
    assert (invalid.json()["detail"]["field"], invalid.json()["detail"]["reason"]) == (
        "emails.1.address",
        "format",
    )

    stale = client.put(path, json=body_of(view, version="0" * 32))
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "conflict"

    missing_lists = {key: value for key, value in body_of(view).items() if key != "phones"}
    assert client.put(path, json=missing_lists).status_code == 422
    assert client.get(f"{PROSPECTS}/{uuid.uuid4()}").json()["detail"]["code"] == "not_found"


def test_a_concurrent_change_is_a_conflict(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    add_email(db_session, prospect, "ajout@exemple.example", is_primary=True)

    response = client.put(f"{PROSPECTS}/{prospect.id}", json=body_of(view, last_name="Écrasé"))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "conflict"
    assert load(client, prospect.id)["last_name"] == "Test"


def test_delete_is_refused_for_an_opposed_prospect_then_allowed(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    reason = "Demande de l’intéressé (synthétique)"
    blocked = client.put(
        f"{PROSPECTS}/{prospect.id}/contactability",
        json={"do_not_contact": True, "reason": reason, "version": view["version"]},
    ).json()

    refused = client.delete(f"{PROSPECTS}/{prospect.id}?version={blocked['version']}")
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "do_not_contact"

    lifted = client.put(
        f"{PROSPECTS}/{prospect.id}/contactability",
        json={
            "do_not_contact": False,
            "reason": "Erreur (synthétique)",
            "version": blocked["version"],
        },
    ).json()
    deleted = client.delete(f"{PROSPECTS}/{prospect.id}?version={lifted['version']}")
    assert deleted.status_code == 204
    assert client.get(f"{PROSPECTS}/{prospect.id}").status_code == 404
