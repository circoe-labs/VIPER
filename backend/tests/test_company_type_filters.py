"""Company classification filters use stored company data, for all its contacts."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import ContactTracking
from app.models.enums import CompanyKind, ContactTrackingStatus
from tests.builders import add_company, add_prospect


@pytest.mark.parametrize("kind", ["sme", "large", "institutional", "unclassified"])
def test_company_type_filters_share_counts_and_paginate(
    client: TestClient, db_session: Session, kind: str
) -> None:
    companies = {}
    people = {}
    for value in ["sme", "large", "institutional", "unclassified"]:
        company = add_company(
            db_session,
            f"Entreprise {value}",
            company_kind=None if value == "unclassified" else CompanyKind(value),
        )
        companies[value] = str(company.id)
        people[value] = {
            str(
                add_prospect(
                    db_session,
                    company,
                    first_name=f"Contact {index}",
                    employment_verified_at=datetime.now(UTC),
                ).id
            )
            for index in range(2)
        }
    params = {"company_kind": kind, "limit": 1}
    page = client.get("/api/companies", params=params)
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 1
    assert page.json()["items"][0]["id"] == companies[kind]
    assert page.json()["items"][0]["company_kind"] == (None if kind == "unclassified" else kind)
    prospect_params = {**params, "validated_only": "true"}
    first = client.get("/api/prospection/prospects", params=prospect_params).json()
    second = client.get(
        "/api/prospection/prospects", params={**prospect_params, "offset": 1}
    ).json()
    assert first["total"] == second["total"] == 2
    assert {row["id"] for row in first["items"] + second["items"]} == people[kind]
    counters = client.get("/api/prospection/counters", params=prospect_params).json()
    assert counters["counts"]["all"] == 2
    assert client.get("/api/companies", params={**params, "q": "introuvable"}).json()["total"] == 0
    assert client.get("/api/prospection/prospects").json()["total"] == 8
    assert client.get("/api/companies").json()["total"] == 4


def test_unclassified_includes_contacts_without_an_employer(
    client: TestClient, db_session: Session
) -> None:
    person = add_prospect(db_session)
    page = client.get("/api/prospection/prospects?company_kind=unclassified").json()
    assert page["total"] == 1
    assert page["items"][0]["id"] == str(person.id)


def test_unknown_company_types_are_rejected(client: TestClient) -> None:
    for path in ["/api/companies", "/api/prospection/prospects", "/api/prospection/counters"]:
        assert client.get(path, params={"company_kind": "invented"}).status_code == 422


def test_company_directory_counts_every_company_once_even_without_prospects(
    client: TestClient, db_session: Session
) -> None:
    for kind in CompanyKind:
        company = add_company(db_session, f"Classified {kind.value}", company_kind=kind)
        for _ in range(3):
            add_prospect(db_session, company)
    # An unclassified company with no person or establishment still belongs in the directory.
    add_company(db_session, "Unclassified without prospects")
    response = client.get("/api/companies/counts")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "all": 4,
        "sme": 1,
        "large": 1,
        "institutional": 1,
        "unclassified": 1,
    }
    for kind, expected in response.json().items():
        params = {} if kind == "all" else {"company_kind": kind}
        assert client.get("/api/companies", params=params).json()["total"] == expected


def test_company_directory_empty_counts_are_real_zeros(client: TestClient) -> None:
    assert client.get("/api/companies/counts").json() == {
        "all": 0,
        "sme": 0,
        "large": 0,
        "institutional": 0,
        "unclassified": 0,
    }


def test_company_directory_counts_need_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get("/api/companies/counts").status_code == 401


def test_company_category_excludes_ignored_but_keeps_valid_and_uncertain(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Entreprise test", company_kind=CompanyKind.SME)
    valid = add_prospect(db_session, company, employment_verified_at=datetime.now(UTC))
    uncertain = add_prospect(db_session, company)
    ignored = add_prospect(db_session, company)
    db_session.add(ContactTracking(prospect_id=ignored.id, status=ContactTrackingStatus.IGNORED))
    db_session.flush()
    params = {"company_kind": "sme"}
    page = client.get("/api/prospection/prospects", params=params).json()
    assert {row["id"] for row in page["items"]} == {str(valid.id), str(uncertain.id)}
    assert client.get("/api/prospection/counters", params=params).json()["counts"]["all"] == 2
    assert client.get("/api/prospection/prospects").json()["total"] == 3
