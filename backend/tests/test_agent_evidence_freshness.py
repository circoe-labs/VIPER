"""Per-item confidence and source dates on evidence (`mission-telemetry.md` §9).

Backward compatible: payloads and stored results from before the extension validate and review,
the three fields read as « unknown », and a publication date is never invented.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentTask
from app.services.agent_payloads import (
    CompanyUpdateResult,
    Evidence,
    SignalProposal,
    build_proposal,
)
from tests.test_agent_review import submitted

NULLS = {"confidence": None, "source_published_at": None, "source_checked_at": None}


def evidence(**extra: Any) -> dict[str, Any]:
    return {"field": "legal_name", "source": "https://2sn.fr/mentions", **extra}


def test_old_evidence_without_the_new_fields_validates_as_unknown() -> None:
    item = Evidence.model_validate(evidence())

    assert item.confidence is None
    assert item.source_published_at is None
    assert item.source_checked_at is None


def test_new_evidence_keeps_its_values_and_timezone() -> None:
    item = Evidence.model_validate(
        evidence(
            confidence=80,
            source_published_at="2026-01-05",
            source_checked_at="2026-01-06T10:00:00+02:00",
        )
    )

    assert item.confidence == 80
    assert item.source_published_at == date(2026, 1, 5)
    assert item.source_checked_at is not None
    assert item.source_checked_at.utcoffset() == timedelta(hours=2)


@pytest.mark.parametrize("confidence", [-1, 101])
def test_item_confidence_is_bounded(confidence: int) -> None:
    with pytest.raises(ValidationError):
        Evidence.model_validate(evidence(confidence=confidence))


def test_unknown_evidence_field_is_still_refused() -> None:
    with pytest.raises(ValidationError):
        Evidence.model_validate(evidence(published="2026-01-05"))


def test_future_publication_date_is_refused() -> None:
    future = (datetime.now(UTC) + timedelta(days=3)).date().isoformat()

    with pytest.raises(ValidationError):
        Evidence.model_validate(evidence(source_published_at=future))


def test_checked_at_tolerates_clock_skew_but_not_the_future() -> None:
    soon = (datetime.now(UTC) + timedelta(minutes=2)).isoformat()
    later = (datetime.now(UTC) + timedelta(minutes=30)).isoformat()

    assert Evidence.model_validate(evidence(source_checked_at=soon)).source_checked_at is not None
    with pytest.raises(ValidationError):
        Evidence.model_validate(evidence(source_checked_at=later))


def test_signal_carries_the_same_optional_fields() -> None:
    base = {
        "kind": "news",
        "signal": "Ouverture d'un entrepôt",
        "score": 10,
        "score_reason": "Besoin d'outillage",
        "source": "https://example.fr/a",
        "observed_on": "2026-01-05",
        "relevance": 70,
    }

    assert SignalProposal.model_validate(base).source_published_at is None
    dated = SignalProposal.model_validate({**base, "source_published_at": "2026-01-04"})
    assert dated.source_published_at == date(2026, 1, 4)


def test_proposal_items_carry_the_evidence_fields(client: TestClient, db_session: Session) -> None:
    result_id = submitted(
        client,
        db_session,
        {
            "legal_name": "2SN SAS",
            "confidence": 50,
            "evidence": [
                evidence(
                    quote="2SN SAS",
                    confidence=90,
                    source_published_at="2026-01-05",
                    source_checked_at="2026-01-06T10:00:00+00:00",
                )
            ],
        },
    )

    body = client.get(f"/api/agents/results/{result_id}").json()

    item = body["proposal"]["items"][0]
    assert item["confidence"] == 90
    assert item["source_published_at"] == "2026-01-05"
    assert item["source_checked_at"] == "2026-01-06T10:00:00+00:00"
    assert item["source"] == "https://2sn.fr/mentions"
    assert item["quote"] == "2SN SAS"
    assert body["proposal"]["confidence"] == 50


def test_publication_date_is_never_invented(client: TestClient, db_session: Session) -> None:
    # Checked but no stated publication date: the check date must not leak into publication.
    result_id = submitted(
        client,
        db_session,
        {
            "legal_name": "2SN SAS",
            "confidence": 50,
            "evidence": [evidence(source_checked_at="2026-01-06T10:00:00+00:00")],
        },
    )

    item = client.get(f"/api/agents/results/{result_id}").json()["proposal"]["items"][0]

    assert item["source_published_at"] is None
    assert item["source_checked_at"] == "2026-01-06T10:00:00+00:00"


def test_item_without_evidence_carries_nulls(client: TestClient, db_session: Session) -> None:
    result_id = submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})

    item = client.get(f"/api/agents/results/{result_id}").json()["proposal"]["items"][0]

    assert {key: item[key] for key in NULLS} == NULLS
    assert item["source"] is None


def test_historical_result_rebuilds_without_the_new_fields(
    client: TestClient, db_session: Session
) -> None:
    submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})
    task = db_session.scalars(select(AgentTask)).one()
    historical = {
        "legal_name": "2SN SAS",
        "confidence": 50,
        "evidence": [{"field": "legal_name", "source": "https://2sn.fr", "quote": "q"}],
    }

    assert CompanyUpdateResult.model_validate(historical).evidence[0].confidence is None
    proposal = build_proposal(db_session, task, historical)

    item = proposal["items"][0]
    assert item["source"] == "https://2sn.fr"
    assert {key: item[key] for key in NULLS} == NULLS
