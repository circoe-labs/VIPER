"""A discovery mission's warehouse sites become warehouse records of the company.

Acceptance creates them (and says so beforehand), a warehouse already recorded is never
recreated, and `backfill-warehouses` recovers the results accepted before this existed.
"""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.cli import main
from app.models import Company, Warehouse
from app.models.companies import Establishment
from app.models.enums import MissionType
from app.models.prospects import ProspectNote
from app.services import warehouse_discovery
from app.services.warehouse_discovery import is_warehouse_site
from tests.builders import add_company
from tests.test_facility_discovery import (
    OTHER_SIREN,
    SIREN,
    SIRET_HONFLEUR,
    _honfleur,
    _submit,
)
from tests.test_missions import create, mint, rpc


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


# --- a company already in the base ---------------------------------------------------------------


def _known_company(db_session: Session, **values: Any) -> Company:
    """A company of the base with its head office."""
    company = add_company(db_session, display_name="Logistique Y", **values)
    db_session.add(
        Establishment(
            company_id=company.id,
            name="Siège",
            kind="siège",
            city="Le Havre",
            postal_code="76600",
            is_primary=True,
        )
    )
    db_session.flush()
    return company


def _sites(db_session: Session, company_id: uuid.UUID) -> list[Establishment]:
    db_session.expire_all()
    return list(
        db_session.scalars(
            select(Establishment)
            .where(Establishment.company_id == company_id)
            .order_by(Establishment.name)
        )
    )


def test_a_known_company_is_proposed_with_its_new_warehouses_only(
    client: TestClient,
    db_session: Session,
    session_factory: sessionmaker[Session],
    capsys: pytest.CaptureFixture[str],
) -> None:
    company = _known_company(db_session, siren=SIREN)
    company_id, updated_at = company.id, company.updated_at
    sites = [
        *_honfleur()["establishments"],
        {"name": "Siège", "kind": "siège", "city": "Le Havre", "postal_code": "76600"},
    ]
    result_id = _submit(
        client, db_session, [_honfleur(establishments=sites, website_url="https://autre.example")]
    )
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    [item] = proposal["items"]
    assert item["after"] == "Entreprise existante"
    assert item["store"]["existing_company_id"] == str(company_id)
    assert item["store"]["warehouses_to_create"] == 1
    assert [site["name"] for site in item["store"]["establishments"]] == ["Plateforme de Honfleur"]
    assert [row["reason"] for row in proposal["refused"]] == ["not_warehouse"]
    assert _warehouses(db_session) == [] and len(_sites(db_session, company_id)) == 1

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    [warehouse] = _warehouses(db_session)
    new, head = _sites(db_session, company_id)
    assert (new.name, new.is_primary) == ("Plateforme de Honfleur", False)
    assert (head.name, head.is_primary) == ("Siège", True)
    assert warehouse.establishment_id == new.id
    assert warehouse.notes is not None and "nouvel entrepôt" in warehouse.notes
    found = db_session.get_one(Company, company_id)
    assert (found.website_url, found.updated_at) == (None, updated_at)
    assert db_session.scalars(select(Company.display_name)).all().count("Logistique Y") == 1
    assert db_session.scalars(select(ProspectNote)).all() == []
    applied = accepted.json()["applied"]
    assert applied["created"] == []
    assert applied["companies"][0]["existing"] is True
    assert main(["backfill-warehouses", "--apply"], session_factory=session_factory) == 0
    assert "DÉJÀ LIÉ | Logistique Y" in capsys.readouterr().out
    assert len(_warehouses(db_session)) == 1


def test_a_known_site_without_warehouse_gets_one_and_is_not_modified(
    client: TestClient, db_session: Session
) -> None:
    company = _known_company(db_session)
    site = Establishment(company_id=company.id, siret=SIRET_HONFLEUR, city="Honfleur")
    db_session.add(site)
    db_session.flush()
    company_id, site_id = company.id, site.id
    result_id = _submit(client, db_session, [_honfleur(siren=None)])
    assert _item(client, result_id)["store"]["warehouses_to_create"] == 1

    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200

    [warehouse] = _warehouses(db_session)
    assert (warehouse.establishment_id, warehouse.postal_code) == (site_id, "14600")
    assert len(_sites(db_session, company_id)) == 2
    kept = db_session.get_one(Establishment, site_id)
    assert (kept.name, kept.postal_code) == (None, None)


@pytest.mark.parametrize("linked", [True, False])
def test_a_known_company_with_only_known_warehouses_stays_refused(
    client: TestClient, db_session: Session, linked: bool
) -> None:
    company = _known_company(db_session, siren=SIREN)
    site_id = None
    if linked:
        site = Establishment(company_id=company.id, name="Ancien nom", siret=SIRET_HONFLEUR)
        db_session.add(site)
        db_session.flush()
        site_id = site.id
    db_session.add(
        Warehouse(
            name="Plateforme de Honfleur",
            postal_code="14600",
            city="Honfleur",
            establishment_id=site_id,
        )
    )
    db_session.flush()

    result_id = _submit(client, db_session, [_honfleur()])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    assert proposal["items"] == []
    assert [(row["field"], row["reason"]) for row in proposal["refused"]] == [
        ("companies.0", "already_known")
    ]


def test_a_namesake_with_another_siren_receives_nothing(
    client: TestClient, db_session: Session
) -> None:
    _known_company(db_session, siren=OTHER_SIREN)

    result_id = _submit(client, db_session, [_honfleur()])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    assert proposal["items"] == []
    assert proposal["refused"][0]["reason"] == "already_known"


def test_a_warehouse_recorded_since_the_submission_is_not_added_again(
    client: TestClient, db_session: Session
) -> None:
    company_id = _known_company(db_session).id
    result_id = _submit(client, db_session, [_honfleur(siren=None)])
    db_session.add(Warehouse(name="Plateforme de Honfleur", city="Honfleur", postal_code="14600"))
    db_session.flush()

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    assert len(_warehouses(db_session)) == 1 and len(_sites(db_session, company_id)) == 1
    [record] = accepted.json()["applied"]["companies"]
    assert record["skipped_establishments"][0]["reason"] == "duplicate"


def test_a_staged_known_company_adds_its_warehouse_after_review(
    client: TestClient, db_session: Session
) -> None:
    company_id = _known_company(db_session).id
    create(
        client,
        name="Nouveaux entrepôts",
        kind=MissionType.PROSPECTION,
        prompt="Nouveaux entrepôts autour du Havre",
        result_kind="companies",
        run_now=True,
    )
    token = mint(db_session)
    claim = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    assert "already in the base" in claim["instruction"]
    base = {"task_id": claim["task_id"], "claim_id": claim["claim_id"]}
    site = {"name": "Entrepôt du port", "kind": "entrepôt", "city": "Le Havre"}
    staged = rpc(
        client,
        token,
        "viper_add_company",
        {
            **base,
            "action_id": str(uuid.uuid4()),
            "company_data": _honfleur(siren=None, establishments=[site], trigger=None),
        },
    )
    assert staged["isError"] is False, staged
    submitted = rpc(client, token, "viper_submit_task_result", {**base, "result": {}})
    result_id = submitted["structuredContent"]["result_id"]
    assert _item(client, result_id)["store"]["existing_company_id"] == str(company_id)
    assert _warehouses(db_session) == []

    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200

    [warehouse] = _warehouses(db_session)
    assert warehouse.name == "Entrepôt du port"
    assert warehouse.establishment_id in {row.id for row in _sites(db_session, company_id)}
