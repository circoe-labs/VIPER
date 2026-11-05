"""Warehouse parsing, persistence and protection, with synthetic workbook data only."""

import io
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Company, Email, Prospect, Warehouse
from app.services.errors import InvalidFieldError
from app.services.warehouse_import import preview
from tests.builders import audit_events


def workbook() -> bytes:
    book = Workbook()
    small = book.active
    assert small is not None
    small.title = "Extrait"
    small.append(
        [
            "Nom entrepôt",
            "Propriétaire immobilier / foncier",
            "email",
            "linkedIn",
            "Prospect a contacter",
            "fonction",
            "email2",
            "linkedIn3",
        ]
    )
    small.append(
        [
            "Site Atlas",
            None,
            None,
            None,
            "Anne Test",
            "Direction",
            "anne@exemple.test ou a.test@exemple.test",
            "https://www.linkedin.com/in/test-anne",
        ]
    )
    small.append([None, None, None, None, "Bruno Test", "Logistique", None, None])
    full = book.create_sheet("Suite")
    full.append(
        [
            "Nom entrepôt",
            "Propriétaire immobilier / foncier",
            "Fonction",
            "email",
            "linkedIn",
            "Prospect a contacter",
            "fonction",
            "email",
            "linkedIn",
        ]
    )
    full.append(
        [
            "Site Atlas",
            "Propriétaire Test",
            "Foncière",
            None,
            None,
            "Anne Test",
            "Direction",
            "anne@exemple.test ou a.test@exemple.test",
            "https://www.linkedin.com/in/test-anne",
        ]
    )
    full.append([None, None, None, None, None, "Bruno Test", "Logistique", None, None])
    full.append(["Site Bêta", None, None, None, None, "Claire Test", "Exploitation", None, None])
    full.merge_cells("A2:A3")
    full.merge_cells("B2:B3")
    output = io.BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def upload(client: TestClient, operation: str) -> dict[str, Any]:
    response = client.post(
        f"/api/warehouses/{operation}",
        files={
            "file": (
                "synthetic-warehouses.xlsx",
                workbook(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def test_parser_groups_merged_sites_and_deduplicates_overlapping_sheets() -> None:
    result = preview(workbook(), "synthetic.xlsx")
    assert (result.warehouses, result.contacts) == (2, 3)
    first = result.items[0]
    assert first.name == "Site Atlas"
    assert first.owner_name == "Propriétaire Test"
    assert [person.full_name for person in first.contacts] == ["Anne Test", "Bruno Test"]
    assert first.contacts[0].email == "anne@exemple.test ou a.test@exemple.test"
    assert result.items[1].owner_name is None
    assert first.address is first.siret is None


def test_import_preview_is_read_only_and_commit_is_idempotent_and_audited(
    client: TestClient, db_session: Session
) -> None:
    before = {
        model.__tablename__: db_session.scalar(select(func.count()).select_from(model))
        for model in [Company, Prospect, Email]
    }
    plan = upload(client, "import-preview")
    assert (plan["warehouses"], plan["contacts"], plan["existing"]) == (2, 3, 0)
    assert db_session.scalar(select(func.count()).select_from(Warehouse)) == 0
    assert upload(client, "import") == {"created": 2, "skipped": 0, "contacts": 3}
    assert upload(client, "import") == {"created": 0, "skipped": 2, "contacts": 0}
    assert upload(client, "import-preview")["existing"] == 2
    assert db_session.scalar(select(func.count()).select_from(Warehouse)) == 2
    assert before == {
        model.__tablename__: db_session.scalar(select(func.count()).select_from(model))
        for model in [Company, Prospect, Email]
    }
    events = audit_events(db_session, entity_type="warehouse", action="warehouse.created")
    assert len(events) == 2
    assert all(event.actor_type.value == "human" for event in events)


def test_create_read_update_retains_contacts_and_refuses_stale_edits(client: TestClient) -> None:
    response = client.post(
        "/api/warehouses",
        json={
            "name": " Entrepôt Exemple ",
            "city": "Lyon",
            "contacts": [
                {"full_name": "Anne Test", "email": "anne@exemple.test ou a.test@exemple.test"}
            ],
        },
    )
    assert response.status_code == 201, response.text
    original = response.json()
    assert original["name"] == "Entrepôt Exemple"
    changed = {**original, "owner_name": "Propriétaire Test"}
    response = client.put(f"/api/warehouses/{original['id']}", json=changed)
    assert response.status_code == 200, response.text
    saved = client.get(f"/api/warehouses/{original['id']}").json()
    assert saved["owner_name"] == "Propriétaire Test"
    assert saved["contacts"] == original["contacts"]
    assert client.put(f"/api/warehouses/{original['id']}", json=changed).status_code == 409


def test_search_matches_contacts_and_accents_and_pagination_is_real(client: TestClient) -> None:
    upload(client, "import")
    result = client.get("/api/warehouses?q=bruno").json()
    assert result["total"] == 1
    assert result["items"][0]["name"] == "Site Atlas"
    assert client.get("/api/warehouses?q=beta").json()["total"] == 1
    second = client.get("/api/warehouses?limit=1&offset=1").json()
    assert second["total"] == 2
    assert [item["name"] for item in second["items"]] == ["Site Bêta"]


@pytest.mark.parametrize(
    "path", ["/api/warehouses", "/api/warehouses/import-preview", "/api/warehouses/import"]
)
def test_warehouse_endpoints_require_authentication(
    anonymous_client: TestClient, path: str
) -> None:
    assert anonymous_client.get(path).status_code in (401, 405)
    assert anonymous_client.post(path, json={"name": "No session"}).status_code == 401


def test_invalid_workbook_and_name_are_rejected_without_writes(client: TestClient) -> None:
    assert client.post("/api/warehouses", json={"name": "   "}).status_code == 422
    assert client.post("/api/warehouses", json={"name": "Test", "siret": "bad"}).status_code == 422
    with pytest.raises(InvalidFieldError):
        preview(b"not an xlsx", "test.xlsx")
