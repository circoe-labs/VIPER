"""A discovery mission's warehouse sites become warehouse records of the company.

Acceptance creates them (and says so beforehand), a warehouse already recorded is never
recreated, and `backfill-warehouses` recovers the results accepted before this existed.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.cli import main
from app.models import Warehouse
from app.models.companies import Establishment
from app.services import warehouse_discovery
from app.services.warehouse_discovery import is_warehouse_site
from tests.test_facility_discovery import SIRET_HONFLEUR, _honfleur, _submit


def _warehouses(db_session: Session) -> list[Warehouse]:
    db_session.expire_all()
    return list(db_session.scalars(select(Warehouse).order_by(Warehouse.name)))


def _item(client: TestClient, result_id: str) -> dict[str, Any]:
    [item] = client.get(f"/api/agents/results/{result_id}").json()["proposal"]["items"]
    found: dict[str, Any] = item
    return found


def test_accepting_a_warehouse_site_creates_the_warehouse_record_of_the_company(
    client: TestClient, db_session: Session
) -> None:
    sites = [
        *_honfleur()["establishments"],
        {"name": "Siège social", "kind": "siège", "postal_code": "76600", "city": "Le Havre"},
    ]
    result_id = _submit(client, db_session, [_honfleur(establishments=sites)])
    store = _item(client, result_id)["store"]
    assert store["warehouses_to_create"] == 1
    assert [site["warehouse"]["action"] for site in store["establishments"]] == ["create", "none"]
    assert _warehouses(db_session) == []  # the preview writes nothing

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    [warehouse] = _warehouses(db_session)
    site = db_session.get_one(Establishment, warehouse.establishment_id)
    assert (warehouse.name, warehouse.address, warehouse.postal_code, warehouse.city) == (
        "Plateforme de Honfleur",
        "Zone portuaire",
        "14600",
        "Honfleur",
    )
    assert warehouse.siret == SIRET_HONFLEUR and warehouse.prospecting_category is None
    assert warehouse.source_reference == "https://presse.example/honfleur-entrepot"
    assert warehouse.notes is not None and "Surface : 18000 m²" in warehouse.notes
    [listed] = client.get("/api/warehouses").json()["items"]
    assert listed["company_id"] == str(site.company_id)
    assert listed["company_name"] == "Logistique Y"
    record = accepted.json()["applied"]["companies"][0]["establishments"][0]
    assert (record["warehouse_id"], record["warehouse_status"]) == (str(warehouse.id), "created")


def test_a_warehouse_already_recorded_is_announced_and_not_recreated(
    client: TestClient, db_session: Session
) -> None:
    created = client.post(
        "/api/warehouses",
        json={"name": "Plateforme de Honfleur", "postal_code": "14600", "city": "Honfleur"},
    )
    assert created.status_code == 201, created.text
    result_id = _submit(client, db_session, [_honfleur()])
    store = _item(client, result_id)["store"]
    assert store["warehouses_to_create"] == 0
    assert store["establishments"][0]["warehouse"] == {
        "action": "duplicate",
        "existing_name": "Plateforme de Honfleur",
    }

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    [warehouse] = _warehouses(db_session)
    assert warehouse.establishment_id is None  # an existing record is never changed
    record = accepted.json()["applied"]["companies"][0]["establishments"][0]
    assert record["warehouse_status"] == "duplicate"


@pytest.mark.parametrize(
    ("kind", "name", "expected"),
    [
        ("entrepôt", None, True),
        ("Plateforme logistique", None, True),
        ("dépôt", None, True),
        ("siège et entrepôt", None, True),
        (None, "Entrepôt du port", True),
        ("siège", "Entrepôts Exemple", False),
        ("agence logistique", None, False),
        ("usine", None, False),
        (None, "Exemple Logistique", False),
        (None, None, False),
    ],
)
def test_what_counts_as_a_warehouse_site(
    kind: str | None, name: str | None, expected: bool
) -> None:
    assert is_warehouse_site(kind, name) is expected


def test_the_backfill_lists_then_creates_the_missing_warehouses_once(
    client: TestClient,
    db_session: Session,
    session_factory: sessionmaker[Session],
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    without_site = {
        "display_name": "Sans Site",
        "confidence": 70,
        "evidence": [{"field": "display_name", "source": "https://annuaire.example/sans-site"}],
    }
    sites = [
        *_honfleur()["establishments"],
        {"name": "Atelier", "kind": "usine", "city": "Le Havre"},
    ]
    result_id = _submit(client, db_session, [_honfleur(establishments=sites), without_site])
    # As accepted before this existed: companies and sites, no warehouse.
    with monkeypatch.context() as patched:
        patched.setattr(warehouse_discovery, "is_warehouse_site", lambda kind, name: False)
        assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200
    assert _warehouses(db_session) == []
    workshop = db_session.scalar(select(Establishment.id).where(Establishment.name == "Atelier"))

    assert main(["backfill-warehouses"], session_factory=session_factory) == 0
    listing = capsys.readouterr().out
    assert "À CRÉER | Logistique Y | Plateforme de Honfleur" in listing
    assert "PAS UN ENTREPÔT | Logistique Y | Atelier" in listing
    assert "AUCUN SITE | Sans Site" in listing and "rien n’a été écrit" in listing
    assert _warehouses(db_session) == []

    assert main(["backfill-warehouses", "--apply"], session_factory=session_factory) == 0
    assert "CRÉÉ | Logistique Y" in capsys.readouterr().out
    [warehouse] = _warehouses(db_session)
    assert warehouse.source_reference == "https://presse.example/honfleur-entrepot"
    assert warehouse.establishment_id is not None

    forced = ["backfill-warehouses", "--apply", "--include", str(workshop)]
    assert main(forced, session_factory=session_factory) == 0
    assert main(forced, session_factory=session_factory) == 0
    assert "DÉJÀ LIÉ | Logistique Y | Plateforme de Honfleur" in capsys.readouterr().out
    assert [row.name for row in _warehouses(db_session)] == ["Atelier", "Plateforme de Honfleur"]
