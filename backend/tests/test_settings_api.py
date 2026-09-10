"""Settings HTTP API (`/api/settings`): protection, contract and business refusals (Task 06)."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.models import ContactTracking, User
from tests.builders import add_prospect, audit_events

ROLES = "/api/settings/roles"
CATEGORIES = "/api/settings/activity-categories"
SEGMENTS = "/api/settings/commercial-segments"
REFERENTS = "/api/settings/referents"


def create(client: TestClient, path: str, label: str) -> dict[str, object]:
    response = client.post(path, json={"label": label})
    assert response.status_code == 201, response.text
    body: dict[str, object] = response.json()
    return body


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ROLES),
        ("POST", ROLES),
        ("PATCH", f"{ROLES}/{uuid.uuid4()}"),
        ("DELETE", f"{CATEGORIES}/{uuid.uuid4()}"),
        ("GET", REFERENTS),
        ("PUT", f"{REFERENTS}/{uuid.uuid4()}"),
    ],
)
def test_settings_need_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    assert anonymous_client.request(method, path, json={}).status_code == 401


def test_writes_need_the_csrf_token(client: TestClient) -> None:
    del client.headers[CSRF_HEADER]

    assert client.get(ROLES).status_code == 200
    assert client.post(ROLES, json={"label": "Sans jeton"}).status_code == 403
    assert client.post(REFERENTS, json={"first_name": "A", "last_name": "B"}).status_code == 403
    client.headers[CSRF_HEADER] = "forged"
    assert client.post(ROLES, json={"label": "Jeton forgé"}).status_code == 403


def test_role_lifecycle_through_the_api_is_attributed_to_the_signed_in_user(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    created = create(client, ROLES, "Responsable qualité")
    path = f"{ROLES}/{created['id']}"

    renamed = client.patch(path, json={"label": "Responsable qualité et sécurité"}).json()
    deactivated = client.patch(path, json={"active": False}).json()
    listed = client.get(ROLES, params={"q": "QUALITE securite", "active": "false"}).json()

    assert (created["slug"], created["active"], created["usage_count"]) == (
        "responsable-qualite",
        True,
        0,
    )
    assert (renamed["id"], renamed["slug"], renamed["label"]) == (
        created["id"],
        "responsable-qualite",
        "Responsable qualité et sécurité",
    )
    assert deactivated["active"] is False
    assert [value["id"] for value in listed] == [created["id"]]
    assert client.delete(path).status_code == 204
    assert client.get(ROLES).json() == []

    events = audit_events(db_session, entity_type="role")
    assert [event.action for event in events] == [
        "role.created",
        "role.renamed",
        "role.deactivated",
        "role.deleted",
    ]
    assert {(event.actor_type, event.actor_id, event.context["source"]) for event in events} == {
        (ActorType.HUMAN, str(pilot_user.id), "ui")
    }


def test_duplicates_answer_409_with_the_existing_value(client: TestClient) -> None:
    existing = create(client, SEGMENTS, "Entrepôt")
    client.patch(f"{SEGMENTS}/{existing['id']}", json={"active": False})

    response = client.post(SEGMENTS, json={"label": "  ENTREPOT "})

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert (detail["code"], detail["field"]) == ("duplicate", "label")
    assert detail["existing"] == {"id": existing["id"], "label": "Entrepôt", "active": False}


def test_deleting_a_value_in_use_answers_409_with_the_usage(
    client: TestClient, db_session: Session
) -> None:
    role = create(client, ROLES, "Chef d'équipe")
    add_prospect(db_session, role_id=uuid.UUID(str(role["id"])))

    response = client.delete(f"{ROLES}/{role['id']}")

    assert response.status_code == 409
    assert response.json()["detail"] | {"message": None} == {
        "code": "in_use",
        "usage": {"prospects": 1},
        "message": None,
    }
    assert client.get(ROLES).json()[0]["usage_count"] == 1


@pytest.mark.parametrize(
    ("method", "path", "body", "status", "code"),
    [
        ("POST", CATEGORIES, {"label": "   "}, 422, "invalid"),
        ("PATCH", f"{CATEGORIES}/{uuid.uuid4()}", {"label": "Nouveau"}, 404, "not_found"),
        ("DELETE", f"{REFERENTS}/{uuid.uuid4()}", None, 404, "not_found"),
        ("POST", REFERENTS, {"first_name": "A", "last_name": "B", "email": "non"}, 422, "invalid"),
    ],
)
def test_business_refusals_carry_a_stable_code(
    client: TestClient,
    method: str,
    path: str,
    body: dict[str, str] | None,
    status: int,
    code: str,
) -> None:
    response = client.request(method, path, json=body)

    assert response.status_code == status
    assert response.json()["detail"]["code"] == code


def test_malformed_requests_are_rejected_by_validation(client: TestClient) -> None:
    role = create(client, ROLES, "Valide")

    assert client.patch(f"{ROLES}/{role['id']}", json={}).status_code == 422
    assert client.post(ROLES, json={"label": "x" * 256}).status_code == 422
    assert client.get("/api/settings/unknown-taxonomy").status_code == 422


def test_referent_lifecycle_through_the_api(client: TestClient, db_session: Session) -> None:
    response = client.post(
        REFERENTS, json={"first_name": "Camille", "last_name": "Exemple", "email": None}
    )
    assert response.status_code == 201
    referent = response.json()
    path = f"{REFERENTS}/{referent['id']}"

    edited = client.put(
        path,
        json={"first_name": "Camille", "last_name": "Exemple", "email": "Camille@Example.com"},
    ).json()
    prospect = add_prospect(db_session)
    db_session.add(ContactTracking(prospect_id=prospect.id, referent_id=uuid.UUID(referent["id"])))
    db_session.flush()
    deactivated = client.patch(path, json={"active": False}).json()
    in_use = client.delete(path)
    duplicate = client.post(REFERENTS, json={"first_name": "camille", "last_name": "EXEMPLE"})

    assert edited["email"] == "camille@example.com"
    assert (deactivated["active"], deactivated["usage_count"]) == (False, 1)
    assert (in_use.status_code, in_use.json()["detail"]["usage"]) == (409, {"contact_trackings": 1})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["existing"]["label"] == "Camille Exemple"
    assert [value["id"] for value in client.get(REFERENTS, params={"q": "exemple"}).json()] == [
        referent["id"]
    ]
    assert [
        event.action for event in audit_events(db_session, entity_type="internal_referent")
    ] == [
        "internal_referent.created",
        "internal_referent.updated",
        "internal_referent.deactivated",
    ]
