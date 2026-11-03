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
from app.models.enums import AgentResultStatus, MissionType, SignalKind, SignalOrigin
from app.models.prospects import ProspectNote
from app.services.agent_payloads import FindProspectsResult
from tests.builders import add_company
from tests.test_missions import create, mint, rpc

SIREN = "732829320"
SIRET_HONFLEUR = "73282932010008"
SIRET_ROUEN = "73282932010016"
OTHER_SIREN = "552100554"
OTHER_SIRET_ROUEN = "55210055410004"


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


def _submit(
    client: TestClient,
    db_session: Session,
    companies: list[dict[str, Any]],
    rule: dict[str, Any] | None = None,
    edit_after_run: dict[str, Any] | None = None,
) -> str:
    """Run a discovery mission (with `rule`'s extra fields), optionally edit its live rule once the
    run has started (`edit_after_run`), then claim and submit `companies` as a worker."""
    mission: dict[str, Any] = {
        "name": "Nouveaux entrepôts — Normandie",
        "type": MissionType.PROSPECTION.value,
        "prompt": "Trouve les entreprises qui ont ouvert un entrepôt en Normandie ce trimestre.",
        "targets": [],
        "result_kind": "companies",
        **(rule or {}),
    }
    detail = create(
        client,
        name=mission["name"],
        kind=MissionType.PROSPECTION,
        prompt=mission["prompt"],
        result_kind="companies",
        run_now=True,
        **(rule or {}),
    )
    if edit_after_run is not None:
        edited = client.put(
            f"/api/missions/{detail['card']['id']}", json={**mission, **edit_after_run}
        )
        assert edited.status_code == 200, edited.text
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


def test_a_repeated_or_late_known_site_is_not_recreated(
    client: TestClient, db_session: Session
) -> None:
    # The proposed company gives no SIREN; its sites belong to SIREN 552100554, unknown to the base.
    other = add_company(db_session, display_name="Entrepôts Existants")
    sites = [
        {"name": "Plateforme de Honfleur", "city": "Honfleur"},
        {"name": "plateforme de  honfleur", "city": "HONFLEUR"},
        {"name": "Site de Rouen", "siret": OTHER_SIRET_ROUEN, "city": "Rouen"},
        {"name": "Site de Rouen bis", "siret": OTHER_SIRET_ROUEN, "city": "Rouen"},
        {"kind": "entrepôt"},
    ]
    result_id = _submit(client, db_session, [_honfleur(siren=None, establishments=sites)])
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    reasons = {row["field"]: row["reason"] for row in proposal["refused"]}
    assert reasons == {
        "companies.0.establishments.1": "duplicate",
        "companies.0.establishments.3": "duplicate",
        "companies.0.establishments.4": "unidentified",
    }
    kept = proposal["items"][0]["store"]["establishments"]
    assert [site["name"] for site in kept] == ["Plateforme de Honfleur", "Site de Rouen"]
    # Rouen's SIRET enters the base, on another company, between the submission and the review.
    db_session.add(
        Establishment(company_id=other.id, name="Rouen", siret=OTHER_SIRET_ROUEN, city="Rouen")
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
            select(Establishment.company_id).where(Establishment.siret == OTHER_SIRET_ROUEN)
        )
        == other.id
    )
    [record] = accepted.json()["applied"]["companies"]
    assert record["skipped_establishments"] == [
        {"name": "Site de Rouen", "siret": OTHER_SIRET_ROUEN, "reason": "already_known"}
    ]


def test_a_company_found_through_a_known_site_is_not_proposed_again(
    client: TestClient, db_session: Session
) -> None:
    """QA scenario: « LOGY », no SIREN, cites the Honfleur site of « Logistique Y Normandie »."""
    known = add_company(db_session, display_name="Logistique Y Normandie", siren=SIREN)
    db_session.add(
        Establishment(
            company_id=known.id,
            name="Plateforme de Honfleur",
            siret=SIRET_HONFLEUR,
            city="Honfleur",
        )
    )
    db_session.flush()
    by_site = _honfleur(display_name="LOGY", siren=None)
    # Same SIREN prefix, site not in the base yet: still that company.
    by_prefix = _honfleur(
        display_name="LOGY Rouen",
        siren=None,
        establishments=[{"name": "Site de Rouen", "siret": SIRET_ROUEN, "city": "Rouen"}],
    )
    result_id = _submit(client, db_session, [by_site, by_prefix])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    assert proposal["items"] == []
    assert [(row["field"], row["reason"], row["company_id"]) for row in proposal["refused"]] == [
        ("companies.0", "already_known", str(known.id)),
        ("companies.1", "already_known", str(known.id)),
    ]
    db_session.expire_all()
    assert db_session.scalar(select(Company).where(Company.display_name == "LOGY")) is None
    assert (
        db_session.scalars(
            select(ProspectNote).where(ProspectNote.kind == SignalKind.FACILITY_OPENING)
        ).all()
        == []
    )


def test_acceptance_is_all_or_nothing(client: TestClient, db_session: Session) -> None:
    alpha = _honfleur(display_name="Alpha Logistique", siren=None)
    beta = _honfleur(
        display_name="Beta Logistique",
        siren=OTHER_SIREN,
        establishments=[{"name": "Site de Rouen", "siret": OTHER_SIRET_ROUEN, "city": "Rouen"}],
        trigger={**_honfleur()["trigger"], "source": "https://presse.example/beta"},
    )
    result_id = _submit(client, db_session, [alpha, beta])
    assert len(client.get(f"/api/agents/results/{result_id}").json()["proposal"]["items"]) == 2
    # Beta's SIREN enters the base between the submission and the review.
    add_company(db_session, display_name="Beta Holding", siren=OTHER_SIREN)

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 409, accepted.text
    db_session.expire_all()
    names = ("Alpha Logistique", "Beta Logistique")
    assert db_session.scalars(select(Company).where(Company.display_name.in_(names))).all() == []
    assert (
        db_session.scalars(
            select(Establishment).where(
                Establishment.siret.in_([SIRET_HONFLEUR, OTHER_SIRET_ROUEN])
            )
        ).all()
        == []
    )
    assert (
        db_session.scalars(
            select(ProspectNote).where(ProspectNote.task_result_id == uuid.UUID(result_id))
        ).all()
        == []
    )
    row = db_session.get(AgentTaskResult, uuid.UUID(result_id))
    assert row is not None and row.status is AgentResultStatus.PENDING_REVIEW


def test_an_invalid_trigger_is_refused_alone(client: TestClient, db_session: Session) -> None:
    future = (datetime.now(UTC).date() + timedelta(days=3)).isoformat()
    trigger = {**_honfleur()["trigger"], "observed_on": future}
    result_id = _submit(client, db_session, [_honfleur(trigger=trigger)])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    assert [row["reason"] for row in proposal["refused"]] == ["future"]
    assert proposal["refused"][0]["field"] == "companies.0.trigger"
    assert proposal["items"][0]["store"]["trigger"] is None
    assert len(proposal["items"][0]["store"]["establishments"]) == 1


def test_a_source_that_is_not_a_public_http_url_is_refused(
    client: TestClient, db_session: Session
) -> None:
    trigger = {**_honfleur()["trigger"], "source": "ftp://presse.example/honfleur"}
    site = {**_honfleur()["establishments"][0], "source": "javascript:alert(1)"}
    result_id = _submit(client, db_session, [_honfleur(trigger=trigger, establishments=[site])])

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    assert {(row["field"], row["reason"]) for row in proposal["refused"]} == {
        ("companies.0.trigger", "format"),
        ("companies.0.establishments.0", "format"),
    }
    [item] = proposal["items"]
    assert item["store"]["trigger"] is None
    assert item["store"]["establishments"] == []


def test_a_trigger_older_than_the_mission_period_is_refused(
    client: TestClient, db_session: Session
) -> None:
    trigger = {**_honfleur()["trigger"], "observed_on": _recent(days=60)}
    result_id = _submit(client, db_session, [_honfleur(trigger=trigger)], rule={"period_days": 30})

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    [refusal] = proposal["refused"]
    assert (refusal["field"], refusal["reason"]) == ("companies.0.trigger", "too_old")
    assert "30 jours" in refusal["message"]
    assert proposal["items"][0]["store"]["trigger"] is None


def test_the_result_is_checked_against_the_rule_of_its_run(
    client: TestClient, db_session: Session
) -> None:
    """An edit after the run started (period and maximum widened) does not apply to that run's
    results: `result_limit` and `period_days` are read from the run's snapshot."""
    old_trigger = {**_honfleur()["trigger"], "observed_on": _recent(days=60)}
    second = _honfleur(
        display_name="Entrepôts Z",
        siren=OTHER_SIREN,
        establishments=[
            {**_honfleur()["establishments"][0], "siret": OTHER_SIRET_ROUEN, "city": "Rouen"}
        ],
    )
    result_id = _submit(
        client,
        db_session,
        [_honfleur(trigger=old_trigger), second],
        rule={"period_days": 30, "result_limit": 1},
        edit_after_run={"period_days": 3650, "result_limit": 50},
    )

    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]

    assert {(row["field"], row["reason"]) for row in proposal["refused"]} == {
        ("companies.0.trigger", "too_old"),
        ("companies.1", "limit"),
    }
    assert [item["store"]["display_name"] for item in proposal["items"]] == ["Logistique Y"]


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
