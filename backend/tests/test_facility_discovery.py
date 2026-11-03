"""Discovery with its sites and trigger: « nouveaux entrepôts en Normandie ».

A `find_prospects` result may carry, per company, the sites the brief is about (`establishments`)
and the dated event that brought the company in (`trigger`, the shape of a `surveil_signals`
signal). Accepting it creates the company, its sites and the signal in the request's single
transaction, with their provenance; a site already in the base is never recreated; and results
stored before these fields existed are accepted exactly as before.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company
from app.models.agent_missions import AgentTaskResult
from app.models.audit import AuditLogEntry
from app.models.companies import Establishment
from app.models.enums import MissionType, SignalKind, SignalOrigin
from app.models.prospects import ProspectNote
from app.services.agent_payloads import FindProspectsResult
from tests.builders import add_company
from tests.test_missions import create, mint, rpc

SIREN = "732829320"
SIRET_HONFLEUR = "73282932010008"
SIRET_ROUEN = "73282932010016"
SIRET_KNOWN = "73282932010024"


def _recent(days: int = 10) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def _honfleur(**overrides: Any) -> dict[str, Any]:
    company: dict[str, Any] = {
        "display_name": "Logistique Y",
        "siren": SIREN,
        "confidence": 85,
        "evidence": [{"field": "siren", "source": "https://annuaire.example/logistique-y"}],
        "establishments": [
            {
                "name": "Plateforme de Honfleur",
                "kind": "entrepôt",
                "siret": SIRET_HONFLEUR,
                "address_line1": "Zone portuaire",
                "postal_code": "14600",
                "city": "Honfleur",
                "country": "FR",
                "opened_on": _recent(),
                "surface_m2": 18000,
                "source": "https://presse.example/honfleur-entrepot",
            }
        ],
        "trigger": {
            "kind": "facility_opening",
            "signal": "Ouverture d'un nouvel entrepôt de 18 000 m² à Honfleur.",
            "score": 20,
            "score_reason": "Nouvelle implantation logistique exploitable commercialement.",
            "source": "https://presse.example/honfleur-entrepot",
            "observed_on": _recent(),
            "relevance": 90,
        },
    }
    company.update(overrides)
    return company


def _submit(client: TestClient, db_session: Session, companies: list[dict[str, Any]]) -> str:
    create(
        client,
        name="Nouveaux entrepôts — Normandie",
        kind=MissionType.PROSPECTION,
        prompt="Trouve les entreprises qui ont ouvert un entrepôt en Normandie ce trimestre.",
        result_kind="companies",
        run_now=True,
    )
    token = mint(db_session, label="Agent découverte", scopes=["find_prospects"])
    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    company_schema = payload["output_schema"]["$defs"]["CompanyProposal"]["properties"]
    assert "establishments" in company_schema and "trigger" in company_schema
    assert "facility_opening" in payload["instruction"]
    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"companies": companies, "confidence": 80},
        },
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    result_id: str = submitted["structuredContent"]["result_id"]
    return result_id


def test_accepting_a_honfleur_warehouse_creates_company_site_and_signal(
    client: TestClient, db_session: Session
) -> None:
    result_id = _submit(client, db_session, [_honfleur()])
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    [item] = proposal["items"]
    assert proposal["refused"] == []
    assert item["store"]["establishments"][0]["city"] == "Honfleur"
    assert item["store"]["trigger"]["kind"] == "facility_opening"
    assert item["store"]["trigger"]["valid_until"]

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    company = db_session.scalar(select(Company).where(Company.display_name == "Logistique Y"))
    assert company is not None
    [site] = db_session.scalars(
        select(Establishment).where(Establishment.company_id == company.id)
    ).all()
    assert (site.name, site.siret, site.city, site.kind, site.postal_code) == (
        "Plateforme de Honfleur",
        SIRET_HONFLEUR,
        "Honfleur",
        "entrepôt",
        "14600",
    )
    [signal] = db_session.scalars(
        select(ProspectNote).where(ProspectNote.task_result_id == uuid.UUID(result_id))
    ).all()
    assert signal.company_id == company.id and signal.prospect_id is None
    assert signal.kind is SignalKind.FACILITY_OPENING
    assert signal.origin is SignalOrigin.AGENT
    assert signal.source_url == "https://presse.example/honfleur-entrepot"
    assert signal.valid_until is not None and signal.score_delta == 20
    # Provenance: the result maps every created id to what the agent cited.
    applied = accepted.json()["applied"]
    assert applied["created"] == [str(company.id)]
    [record] = applied["companies"]
    assert record["signal_id"] == str(signal.id)
    assert record["source"] == "https://annuaire.example/logistique-y"
    [site_record] = record["establishments"]
    assert site_record["id"] == str(site.id)
    assert site_record["source"] == "https://presse.example/honfleur-entrepot"
    assert site_record["surface_m2"] == 18000 and site_record["opened_on"] == _recent()
    # The company and its site are audited as the person's acceptance.
    actions = set(
        db_session.scalars(
            select(AuditLogEntry.action).where(AuditLogEntry.entity_id.in_([company.id, site.id]))
        )
    )
    assert {"company.created", "establishment.created"} <= actions
    # The company page lists the trigger like any signal.
    listed = client.get(f"/api/companies/{company.id}/signals").json()
    assert [row["kind"] for row in listed] == ["facility_opening"]


def test_a_known_or_repeated_site_is_not_recreated(client: TestClient, db_session: Session) -> None:
    other = add_company(db_session, display_name="Entrepôts Existants")
    db_session.add(
        Establishment(
            company_id=other.id, name="Dépôt du Havre", siret=SIRET_KNOWN, city="Le Havre"
        )
    )
    db_session.flush()
    sites = [
        {"name": "Dépôt du Havre", "siret": SIRET_KNOWN, "city": "Le Havre"},
        {"name": "Plateforme de Honfleur", "city": "Honfleur"},
        {"name": "plateforme de  honfleur", "city": "HONFLEUR"},
        {"name": "Site de Rouen", "siret": SIRET_ROUEN, "city": "Rouen"},
        {"name": "Site de Rouen bis", "siret": SIRET_ROUEN, "city": "Rouen"},
        {"kind": "entrepôt"},
    ]
    result_id = _submit(client, db_session, [_honfleur(establishments=sites)])
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    reasons = {row["field"]: row["reason"] for row in proposal["refused"]}
    assert reasons == {
        "companies.0.establishments.0": "already_known",
        "companies.0.establishments.2": "duplicate",
        "companies.0.establishments.4": "duplicate",
        "companies.0.establishments.5": "unidentified",
    }
    kept = proposal["items"][0]["store"]["establishments"]
    assert [site["name"] for site in kept] == ["Plateforme de Honfleur", "Site de Rouen"]
    # Rouen's SIRET enters the base between the submission and the review.
    db_session.add(
        Establishment(company_id=other.id, name="Rouen", siret=SIRET_ROUEN, city="Rouen")
    )
    db_session.flush()

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    company = db_session.scalar(select(Company).where(Company.display_name == "Logistique Y"))
    assert company is not None
    names = db_session.scalars(
        select(Establishment.name).where(Establishment.company_id == company.id)
    ).all()
    assert names == ["Plateforme de Honfleur"]
    assert (
        db_session.scalar(
            select(Establishment.company_id).where(Establishment.siret == SIRET_KNOWN)
        )
        == other.id
    )
    [record] = accepted.json()["applied"]["companies"]
    assert record["skipped_establishments"] == [
        {"name": "Site de Rouen", "siret": SIRET_ROUEN, "reason": "already_known"}
    ]


def test_an_invalid_trigger_is_refused_alone(client: TestClient, db_session: Session) -> None:
    future = (datetime.now(UTC).date() + timedelta(days=3)).isoformat()
    trigger = {**_honfleur()["trigger"], "observed_on": future}
    result_id = _submit(client, db_session, [_honfleur(trigger=trigger)])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    assert [row["reason"] for row in proposal["refused"]] == ["future"]
    assert proposal["refused"][0]["field"] == "companies.0.trigger"
    assert proposal["items"][0]["store"]["trigger"] is None
    assert len(proposal["items"][0]["store"]["establishments"]) == 1


def test_results_without_sites_or_trigger_stay_valid(
    client: TestClient, db_session: Session
) -> None:
    legacy = {
        key: value for key, value in _honfleur().items() if key not in ("establishments", "trigger")
    }
    assert FindProspectsResult.model_validate({"companies": [legacy], "confidence": 80})
    result_id = _submit(client, db_session, [legacy])
    # A proposal stored before Slice 04 has no `establishments` / `trigger` keys at all.
    row = db_session.get(AgentTaskResult, uuid.UUID(result_id))
    assert row is not None
    proposal = dict(row.proposal)
    proposal["items"] = [
        {
            **item,
            "store": {
                key: value
                for key, value in item["store"].items()
                if key not in ("establishments", "trigger")
            },
        }
        for item in proposal["items"]
    ]
    row.proposal = proposal
    db_session.flush()

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    company = db_session.scalar(select(Company).where(Company.display_name == "Logistique Y"))
    assert company is not None
    assert company.establishments == []
    assert (
        db_session.scalars(
            select(ProspectNote).where(ProspectNote.task_result_id == uuid.UUID(result_id))
        ).all()
        == []
    )
    [record] = accepted.json()["applied"]["companies"]
    assert record["signal_id"] is None and record["establishments"] == []
