"""Companies HTTP API (`/api/companies`, Task 07): protection, contract and business refusals."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.models import Establishment, User
from tests.builders import (
    BAD_SIRET,
    SIREN,
    SIRET,
    SIRET_2,
    add_company,
    add_prospect,
    audit_events,
)

COMPANIES = "/api/companies"


def settings_value(client: TestClient, path: str, label: str) -> str:
    response = client.post(f"/api/settings/{path}", json={"label": label})
    assert response.status_code == 201, response.text
    value_id: str = response.json()["id"]
    return value_id


def create(client: TestClient, **body: object) -> dict[str, Any]:
    response = client.post(COMPANIES, json={"display_name": "Transports Exemple SARL", **body})
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", COMPANIES),
        ("GET", f"{COMPANIES}/similar"),
        ("GET", f"{COMPANIES}/{uuid.uuid4()}"),
        ("POST", COMPANIES),
        ("PUT", f"{COMPANIES}/{uuid.uuid4()}"),
        ("DELETE", f"{COMPANIES}/{uuid.uuid4()}"),
    ],
)
def test_companies_need_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    assert anonymous_client.request(method, path, json={}).status_code == 401


def test_writes_need_the_csrf_token(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    del client.headers[CSRF_HEADER]

    assert client.get(COMPANIES).status_code == 200
    assert client.post(COMPANIES, json={"display_name": "Sans jeton"}).status_code == 403
    assert client.delete(f"{COMPANIES}/{company.id}").status_code == 403
    client.headers[CSRF_HEADER] = "forged"
    body = {"display_name": "Jeton forgé", "activity_category_ids": [], "establishments": []}
    assert client.put(f"{COMPANIES}/{company.id}", json=body).status_code == 403


def test_company_lifecycle_is_attributed_to_the_signed_in_user(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    segment = settings_value(client, "commercial-segments", "Transporteur API")
    road = settings_value(client, "activity-categories", "Route API")
    storage = settings_value(client, "activity-categories", "Stockage API")

    created = create(
        client,
        siren=f"{SIREN[:3]} {SIREN[3:6]} {SIREN[6:]}",
        website_url="exemple.fr",
        email_domain="@Exemple.fr",
        commercial_segment_id=segment,
        activity_category_ids=[road, storage],
        establishments=[
            {"name": "Siège", "siret": SIRET, "city": "Paris", "kind": "siège"},
            {"name": "Dépôt", "siret": SIRET_2, "city": "Lille", "kind": "entrepôt"},
        ],
    )
    path = f"{COMPANIES}/{created['id']}"

    assert (created["siren"], created["website_url"], created["email_domain"]) == (
        SIREN,
        "https://exemple.fr",
        "exemple.fr",
    )
    assert created["commercial_segment"] == {
        "id": segment,
        "label": "Transporteur API",
        "active": True,
    }
    assert [ref["id"] for ref in created["activity_categories"]] == [road, storage]
    head, depot = created["establishments"]
    assert (head["is_primary"], depot["is_primary"]) == (True, False)

    replaced = client.put(
        path,
        json={
            "display_name": "Transports Exemple",
            "legal_name": "Transports Exemple SARL",
            "commercial_segment_id": None,
            "activity_category_ids": [storage],
            "establishments": [{**depot, "is_primary": True}],
        },
    )
    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert (body["display_name"], body["siren"], body["commercial_segment"]) == (
        "Transports Exemple",
        None,
        None,
    )
    assert [(row["id"], row["is_primary"]) for row in body["establishments"]] == [
        (depot["id"], True)
    ]
    assert client.get(path).json() == body

    listed = client.get(COMPANIES, params={"q": "transports exemple"}).json()
    assert listed["total"] == 1
    assert listed["items"][0] | {"updated_at": None} == {
        "id": created["id"],
        "display_name": "Transports Exemple",
        "legal_name": "Transports Exemple SARL",
        "siren": None,
        # PUT replaces the whole state: fields left out are cleared.
        "email_domain": None,
        "commercial_segment_label": None,
        "city": "Lille",
        "establishment_count": 1,
        "prospect_count": 0,
        "updated_at": None,
    }

    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404

    events = [e for e in audit_events(db_session) if e.subject_id == uuid.UUID(created["id"])]
    assert [event.action for event in events] == [
        "company.created",
        "establishment.created",
        "establishment.created",
        "company.updated",
        "establishment.deleted",
        "establishment.updated",
        "company.deleted",
        "establishment.deleted",
    ]
    assert {(event.actor_type, event.actor_id, event.context["source"]) for event in events} == {
        (ActorType.HUMAN, str(pilot_user.id), "ui")
    }


def test_put_needs_both_lists(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)

    response = client.put(f"{COMPANIES}/{company.id}", json={"display_name": "Sans listes"})

    assert response.status_code == 422
    missing = {tuple(error["loc"]) for error in response.json()["detail"]}
    assert missing == {("body", "activity_category_ids"), ("body", "establishments")}


def test_identifier_conflicts_answer_409_naming_the_company(
    client: TestClient, db_session: Session
) -> None:
    other = add_company(db_session, "Logistique Témoin SAS", siren=SIREN)
    db_session.add(Establishment(company_id=other.id, siret=SIRET, is_primary=True))
    db_session.flush()

    siren = client.post(COMPANIES, json={"display_name": "Doublon", "siren": SIREN})
    siret = client.post(
        COMPANIES,
        json={"display_name": "Doublon", "establishments": [{"name": "A"}, {"siret": SIRET}]},
    )

    expected = {"id": str(other.id), "label": "Logistique Témoin SAS", "active": True}
    assert siren.status_code == siret.status_code == 409
    assert siren.json()["detail"] | {"message": None} == {
        "code": "duplicate",
        "field": "siren",
        "existing": expected,
        "message": None,
    }
    assert siret.json()["detail"]["field"] == "establishments.1.siret"
    assert siret.json()["detail"]["existing"] == expected


@pytest.mark.parametrize(
    ("body", "field", "reason"),
    [
        ({"display_name": " "}, "display_name", "blank"),
        ({"display_name": "X", "siren": "123456789"}, "siren", "checksum"),
        ({"display_name": "X", "email_domain": "gmail.com"}, "email_domain", "webmail"),
        ({"display_name": "X", "website_url": "pas un site"}, "website_url", "format"),
        (
            {"display_name": "X", "establishments": [{"siret": BAD_SIRET}]},
            "establishments.0.siret",
            "checksum",
        ),
        (
            {"display_name": "X", "activity_category_ids": [str(uuid.uuid4())]},
            "activity_category_ids",
            "unknown",
        ),
    ],
)
def test_invalid_values_answer_422_with_field_and_reason(
    client: TestClient, body: dict[str, object], field: str, reason: str
) -> None:
    response = client.post(COMPANIES, json=body)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert (detail["code"], detail["field"], detail["reason"]) == ("invalid", field, reason)


def test_deleting_a_company_with_prospects_answers_409_with_the_count(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company)

    response = client.delete(f"{COMPANIES}/{company.id}")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "in_use"
    assert response.json()["detail"]["usage"] == {"prospects": 1}
    detail = client.get(f"{COMPANIES}/{company.id}").json()
    assert detail["prospect_count"] == 1
    assert detail["prospects"][0] | {"id": None} == {
        "id": None,
        "civility": None,
        "first_name": "Jean",
        "last_name": "Test",
        "role_label": None,
        "exact_job_title": None,
        "activity_status": "unknown",
        "contactability_status": "contactable",
    }


def test_unknown_company_answers_404(client: TestClient) -> None:
    body = {"display_name": "X", "activity_category_ids": [], "establishments": []}
    for response in (
        client.get(f"{COMPANIES}/{uuid.uuid4()}"),
        client.put(f"{COMPANIES}/{uuid.uuid4()}", json=body),
        client.delete(f"{COMPANIES}/{uuid.uuid4()}"),
    ):
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"


def test_similar_companies(client: TestClient, db_session: Session) -> None:
    same = add_company(db_session, "TRANSPORTS EXEMPLE")
    add_company(db_session, "Sans Rapport")

    response = client.get(
        f"{COMPANIES}/similar", params={"name": "Transports Exemple SARL", "email_domain": ""}
    )

    assert response.json() == [
        {
            "id": str(same.id),
            "display_name": "TRANSPORTS EXEMPLE",
            "legal_name": None,
            "email_domain": None,
            "reasons": ["same_company_name"],
        }
    ]
    excluded = client.get(
        f"{COMPANIES}/similar", params={"name": "Transports Exemple", "exclude": str(same.id)}
    )
    assert excluded.json() == []


def test_list_pages_are_bounded(client: TestClient) -> None:
    assert client.get(COMPANIES, params={"limit": 0}).status_code == 422
    assert client.get(COMPANIES, params={"limit": 201}).status_code == 422
    assert client.get(COMPANIES, params={"limit": 200, "offset": 0}).json() == {
        "items": [],
        "total": 0,
    }
