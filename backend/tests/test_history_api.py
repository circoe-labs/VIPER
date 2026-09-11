"""History API (Task 19): `GET /api/prospects/{id}/history` and `/api/companies/{id}/history` —
protection, contract, a real editor save read back, pages. Synthetic values only."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import User
from tests.builders import add_company, add_email, add_prospect
from tests.test_prospects_api import PROSPECTS, body_of, load

COMPANIES = "/api/companies"


def history(client: TestClient, path: str, **params: Any) -> dict[str, Any]:
    response = client.get(f"{path}/history", params=params)
    assert response.status_code == 200, response.text
    page: dict[str, Any] = response.json()
    return page


def lines(entry: dict[str, Any]) -> list[tuple[str, str | None, str | None]]:
    return [(change["label"], change["before"], change["after"]) for change in entry["changes"]]


@pytest.mark.parametrize("base", [PROSPECTS, COMPANIES])
def test_history_needs_a_session(anonymous_client: TestClient, base: str) -> None:
    assert anonymous_client.get(f"{base}/{uuid.uuid4()}/history").status_code == 401


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 51}, {"before": "not-an-id"}])
def test_history_parameters_are_bounded(client: TestClient, params: dict[str, Any]) -> None:
    response = client.get(f"{PROSPECTS}/{uuid.uuid4()}/history", params=params)

    assert response.status_code == 422


def test_an_editor_save_reads_back_as_one_entry_by_the_signed_in_user(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    other = add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, company, first_name="Paul", last_name="Test")
    add_email(db_session, prospect, "ancienne@exemple.example", is_primary=True)
    view = load(client, prospect.id)
    emails = [
        {**view["emails"][0], "is_primary": False},
        {"address": "nouvelle@exemple.example", "is_primary": True},
    ]
    for email in emails:
        email.pop("last_verified_at", None)
        email.pop("origin_type", None)
        email.pop("imported_unverified", None)
    body = body_of(
        view,
        company_id=str(other.id),
        emails=emails,
        tracking={"status": "contacted"},
    )
    assert client.put(f"{PROSPECTS}/{prospect.id}", json=body).status_code == 200

    page = history(client, f"{PROSPECTS}/{prospect.id}")

    entry = page["items"][0]
    assert entry["actor"] == {
        "kind": "human",
        "label": "Pilote Test",
        "id": str(pilot_user.id),
        "on_behalf_of": None,
    }
    assert (entry["source"], entry["title"]) == ("ui", "Changement d’entreprise")
    assert lines(entry) == [
        ("Entreprise", "Transports Exemple SARL", "Nouvel Employeur SAS"),
        ("E-mail principal", "ancienne@exemple.example", "nouvelle@exemple.example"),
        ("E-mail ajouté", None, "nouvelle@exemple.example"),
        ("Étape", None, "Contacté"),
    ]
    assert entry["summary"] == [
        "Changement d’entreprise",
        "E-mail principal modifié",
        "E-mail ajouté",
        "Suivi : Contacté",
    ]
    assert set(entry) == {
        "id",
        "occurred_at",
        "actor",
        "source",
        "actions",
        "title",
        "summary",
        "changes",
    }
    # The fixture writes that created the person come after, as their own entry.
    assert page["items"][1]["title"] == "Fiche créée"
    assert page["next_cursor"] is None


def test_the_opposition_reason_reads_in_the_prospect_history(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    opposition = {"do_not_contact": True, "reason": "Demande orale (synthétique)"}
    response = client.put(
        f"{PROSPECTS}/{prospect.id}/contactability", json=opposition | {"version": view["version"]}
    )
    assert response.status_code == 200

    (entry, _) = history(client, f"{PROSPECTS}/{prospect.id}")["items"]
    assert lines(entry) == [("Opposition enregistrée — motif", None, "Demande orale (synthétique)")]


def test_company_history_pages_with_the_cursor(client: TestClient) -> None:
    created = client.post(
        COMPANIES,
        json={
            "display_name": "Entrepôts Exemple SAS",
            "establishments": [{"name": "Siège", "city": "Lyon", "is_primary": True}],
        },
    ).json()
    for city in ("Nantes", "Rennes"):
        company = client.get(f"{COMPANIES}/{created['id']}").json()
        establishment = company["establishments"][0] | {"city": city}
        body = {
            key: company[key]
            for key in ("display_name", "legal_name", "siren", "website_url", "email_domain")
        } | {"activity_category_ids": [], "establishments": [establishment]}
        assert client.put(f"{COMPANIES}/{created['id']}", json=body).status_code == 200

    first = history(client, f"{COMPANIES}/{created['id']}", limit=2)
    rest = history(client, f"{COMPANIES}/{created['id']}", limit=2, before=first["next_cursor"])

    assert [lines(entry) for entry in first["items"]] == [
        [("Établissement Siège · ville", "Nantes", "Rennes")],
        [("Établissement Siège · ville", "Lyon", "Nantes")],
    ]
    (creation,) = rest["items"]
    assert creation["title"] == "Entreprise créée"
    assert ("Établissement ajouté", None, "Siège · Lyon · principal") in lines(creation)
    assert rest["next_cursor"] is None
