"""Warehouse parsing, persistence and protection, with synthetic workbook data only."""

import io
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Company, Email, Prospect, Warehouse, WarehouseDraft
from app.services.contact_dispatch import DispatchConfig
from app.services.errors import InvalidFieldError
from app.services.warehouse_dispatch import dispatch_warehouses
from app.services.warehouse_import import preview
from tests.builders import audit_events


def test_warehouse_drafts_are_read_only_and_require_authentication(
    client: TestClient, anonymous_client: TestClient, db_session: Session
) -> None:
    site = Warehouse(name="Site Exemple", contacts=[], prospecting_category="other")
    db_session.add(site)
    db_session.flush()
    db_session.add(
        WarehouseDraft(
            warehouse_id=site.id,
            warehouse_name=site.name,
            contact_name="Anne Test",
            source_email="a@example.test ou b@example.test",
            recipient=None,
            subject="Prise de contact",
            body="Bonjour",
            review_note="Adresse à vérifier",
        )
    )
    db_session.flush()
    assert anonymous_client.get("/api/warehouses/drafts").status_code == 401
    response = client.get("/api/warehouses/drafts")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["recipient"] is None
    assert response.json()[0]["body"] == "Bonjour"
    assert client.post("/api/warehouses/drafts", json={}).status_code == 405


def test_draft_greetings_include_known_civilities() -> None:
    from app.services.warehouse_draft_text import greeting

    assert greeting('Stéphanie PELAZZA') == 'Bonjour Madame Stéphanie PELAZZA,'
    assert greeting('COUDRAIS Jean-Paul') == 'Bonjour Monsieur COUDRAIS Jean-Paul,'
    assert greeting('Josik Morel') == 'Bonjour Monsieur Josik Morel,'


@pytest.mark.parametrize("fail", [False, True])
def test_warehouse_dispatch_never_retries_uncertain_send(
    db_session: Session, session_factory: sessionmaker[Session], fail: bool
) -> None:
    class Toolbox:
        sends = 0

        def create_draft(self, draft: Any) -> str:
            assert draft.to == ["anne@example.test"]
            return "remote-1"

        def send_draft(self, draft_id: str) -> None:
            self.sends += 1
            if fail:
                raise TimeoutError()

    site = Warehouse(name="Site", contacts=[])
    db_session.add(site)
    db_session.flush()
    draft = WarehouseDraft(
        warehouse_id=site.id,
        warehouse_name="Site",
        contact_name="Anne",
        recipient="anne@example.test",
        subject="Objet",
        body="Bonjour",
        review_note="À vérifier",
        scheduled_at=datetime.now(UTC) - timedelta(minutes=1),
        send_state="scheduled",
        validated_at=datetime.now(UTC) - timedelta(minutes=2),
        human_validated=True,
    )
    db_session.add(draft)
    db_session.flush()
    config = DispatchConfig(
        interval=timedelta(seconds=30),
        max_lateness=timedelta(hours=6),
        claim_ttl=timedelta(minutes=10),
        max_attempts=3,
        retry_base=timedelta(minutes=1),
    )
    toolbox = Toolbox()
    dispatch_warehouses(session_factory, config, toolbox)  # type: ignore[arg-type]
    dispatch_warehouses(session_factory, config, toolbox)  # type: ignore[arg-type]
    db_session.expire_all()
    assert db_session.get(WarehouseDraft, draft.id).send_state == ("uncertain" if fail else "sent")
    assert toolbox.sends == 1


def test_preplanned_draft_is_never_sent_without_validation(
    db_session: Session, session_factory: sessionmaker[Session]
) -> None:
    class Toolbox:
        def create_draft(self, draft: Any) -> str:
            raise AssertionError("An unvalidated draft must not be sent")

    site = Warehouse(name="Site", contacts=[])
    db_session.add(site)
    db_session.flush()
    draft = WarehouseDraft(
        warehouse_id=site.id,
        warehouse_name="Site",
        contact_name="Anne",
        recipient="anne@example.test",
        subject="Objet",
        body="Bonjour",
        review_note="À vérifier",
        scheduled_at=datetime.now(UTC) - timedelta(minutes=1),
        send_state="planned",
    )
    db_session.add(draft)
    db_session.flush()
    config = DispatchConfig(
        interval=timedelta(seconds=30),
        max_lateness=timedelta(hours=6),
        claim_ttl=timedelta(minutes=10),
        max_attempts=3,
        retry_base=timedelta(minutes=1),
    )
    dispatch_warehouses(session_factory, config, Toolbox())  # type: ignore[arg-type]
    db_session.expire_all()
    assert db_session.get(WarehouseDraft, draft.id).send_state == "planned"


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


def test_list_sort_orders_by_name_created_or_updated_with_id_tie_break(
    client: TestClient, db_session: Session
) -> None:
    now = datetime.now(UTC)
    day = timedelta(days=1)
    stamps = {
        "Bravo Tri": (now - 3 * day, now),
        "Zulu Tri": (now - 2 * day, now - 3 * day),
        "alpha Tri": (now - day, now - 2 * day),
    }
    for name, (created, updated) in stamps.items():
        db_session.add(Warehouse(name=name, created_at=created, updated_at=updated))
    tied = now - 9 * day
    ties = [Warehouse(name="Egal Tie", created_at=tied, updated_at=tied) for _ in "abc"]
    db_session.add_all(ties)
    db_session.flush()

    def get(q: str, sort: str | None) -> list[dict[str, Any]]:
        params = {"q": q, **({"sort": sort} if sort else {})}
        response = client.get("/api/warehouses", params=params)
        assert response.status_code == 200, response.text
        items: list[dict[str, Any]] = response.json()["items"]
        return items

    def names(sort: str | None) -> list[str]:
        return [item["name"] for item in get("Tri", sort)]

    assert names(None) == ["alpha Tri", "Bravo Tri", "Zulu Tri"]
    assert names("name") == names(None)
    assert names("created") == ["alpha Tri", "Zulu Tri", "Bravo Tri"]
    assert names("updated") == ["Bravo Tri", "alpha Tri", "Zulu Tri"]
    expected = sorted(str(row.id) for row in ties)
    for sort in ("name", "created", "updated"):
        assert [item["id"] for item in get("Egal Tie", sort)] == expected, sort


def test_list_sort_rejects_unknown_values(client: TestClient) -> None:
    assert client.get("/api/warehouses", params={"sort": "popularity"}).status_code == 422


def test_search_covers_name_owner_city_and_address(
    client: TestClient, db_session: Session
) -> None:
    db_session.add(
        Warehouse(
            name="Plateforme Xylophone",
            owner_name="Société Mérovingienne",
            city="Quimperlé",
            address="12 rue des Tisserands",
        )
    )
    db_session.flush()

    for term in ("xylophone", "merovingienne", "quimperle", "tisserands"):
        found = client.get("/api/warehouses", params={"q": term}).json()
        assert [item["name"] for item in found["items"]] == ["Plateforme Xylophone"], term


def test_counts_cover_all_sites_and_update_when_contacts_change(client: TestClient) -> None:
    assert client.get("/api/warehouses/counts").json() == {
        "warehouses": 0,
        "contacts": 0,
        "to_contact": 0,
        "sme": 0, "other": 0, "unclassified": 0,
    }
    upload(client, "import")
    assert client.get("/api/warehouses/counts").json() == {
        "warehouses": 2,
        "contacts": 3,
        "to_contact": 0,
        "sme": 0, "other": 0, "unclassified": 2,
    }
    site = client.get("/api/warehouses?limit=1").json()["items"][0]
    site["contacts"].append({"full_name": "Nouveau contact", "to_contact": True})
    assert client.put(f"/api/warehouses/{site['id']}", json=site).status_code == 200
    assert client.get("/api/warehouses/counts").json() == {
        "warehouses": 2,
        "contacts": 4,
        "to_contact": 1,
        "sme": 0, "other": 0, "unclassified": 2,
    }
    filtered = client.get("/api/warehouses?to_contact=true").json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["id"] == site["id"]
    assert filtered["items"][0]["contacts"][-1]["to_contact"] is True


def test_other_and_unclassified_drafts_have_specific_openings_without_dihnamo() -> None:
    from app.services.warehouse_draft_text import draft_text

    for category in ('other', None):
        body = draft_text('Anne Test', 'Site', 'Responsable logistique', category)
        assert 'logistique' in body
        assert 'DIHNAMO' not in body
        assert '\n\n\n' not in body
    commercial = draft_text('Anne Test', 'Site', 'Directrice commerciale', 'other')
    assert 'suivi des clients' in commercial


def test_draft_uses_company_name_without_site_location() -> None:
    from app.services.warehouse_draft_text import draft_text

    label = 'Entreposage Havrais – Allée de la Plaine'
    body = draft_text('Anne Test', label, 'Coordinatrice logistique', 'sme')
    assert 'Entreposage Havrais' in body
    assert 'Allée de la Plaine' not in body
    assert 'Coordinatrice logistique' in body


@pytest.mark.parametrize(
    "path", ["/api/warehouses", "/api/warehouses/import-preview", "/api/warehouses/import"]
)
def test_warehouse_endpoints_require_authentication(
    anonymous_client: TestClient, path: str
) -> None:
    assert anonymous_client.get(path).status_code in (401, 405)
    assert anonymous_client.post(path, json={"name": "No session"}).status_code == 401


def test_warehouse_counts_require_authentication(anonymous_client: TestClient) -> None:
    assert anonymous_client.get("/api/warehouses/counts").status_code == 401


def test_invalid_workbook_and_name_are_rejected_without_writes(client: TestClient) -> None:
    assert client.post("/api/warehouses", json={"name": "   "}).status_code == 422
    assert client.post("/api/warehouses", json={"name": "Test", "siret": "bad"}).status_code == 422
    with pytest.raises(InvalidFieldError):
        preview(b"not an xlsx", "test.xlsx")
