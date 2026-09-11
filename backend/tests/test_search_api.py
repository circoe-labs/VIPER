"""Global search HTTP API (`GET /api/search`, Task 17): protection, validation, typed contract."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Establishment
from tests.builders import SIREN, SIRET, add_company, add_email, add_prospect, audit_events

SEARCH = "/api/search"


def test_search_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(SEARCH, params={"q": "fret"}).status_code == 401


@pytest.mark.parametrize("params", [{}, {"q": "a"}, {"q": "   "}, {"q": "x" * 201}])
def test_a_query_needs_2_to_200_characters(client: TestClient, params: dict[str, str]) -> None:
    assert client.get(SEARCH, params=params).status_code == 422


def test_short_query_refusal_names_the_field(client: TestClient) -> None:
    detail = client.get(SEARCH, params={"q": " a "}).json()["detail"]

    assert (detail["code"], detail["field"], detail["reason"]) == ("invalid", "q", "length")


def test_results_are_grouped_typed_hits_never_rows(client: TestClient, db_session: Session) -> None:
    company = add_company(
        db_session, "Témoin Contrat SARL", siren=SIREN, email_domain="contrat.example"
    )
    establishment = Establishment(
        company_id=company.id,
        name="Témoin Contrat Siège",
        siret=SIRET,
        city="Lyon",
        is_primary=True,
    )
    db_session.add(establishment)
    person = add_prospect(db_session, company, first_name="Témoin", last_name="Contrat")
    add_email(db_session, person, "temoin.contrat@contrat.example", is_primary=True)

    response = client.get(SEARCH, params={"q": "  témoin   contrat "})

    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    assert body["query"] == "témoin contrat"
    groups = {group["type"]: group for group in body["groups"]}
    assert [group["type"] for group in body["groups"]] == ["prospect", "company", "establishment"]
    assert groups["prospect"] == {
        "type": "prospect",
        "has_more": False,
        "items": [
            {
                "type": "prospect",
                "id": str(person.id),
                "label": "Témoin Contrat",
                "sublabel": None,
                "match": {"field": "name", "kind": "exact", "value": None},
                "badges": [],
                "open": {"editor": "prospect", "id": str(person.id)},
                "record": {"table": "prospects", "id": str(person.id)},
                "company_id": str(company.id),
                "company_name": "Témoin Contrat SARL",
            }
        ],
    }
    [company_hit] = groups["company"]["items"]
    assert company_hit == {
        "type": "company",
        "id": str(company.id),
        "label": "Témoin Contrat SARL",
        "sublabel": None,
        "match": {"field": "name", "kind": "prefix", "value": None},
        "badges": [],
        "open": {"editor": "company", "id": str(company.id)},
        "record": {"table": "companies", "id": str(company.id)},
        "siren": SIREN,
        "email_domain": "contrat.example",
        "city": "Lyon",
        "prospect_count": 1,
    }
    [establishment_hit] = groups["establishment"]["items"]
    assert establishment_hit["open"] == {"editor": "company", "id": str(company.id)}
    assert establishment_hit["record"] == {"table": "establishments", "id": str(establishment.id)}
    assert establishment_hit["badges"] == ["primary"]
    assert (establishment_hit["siret"], establishment_hit["company_name"]) == (
        SIRET,
        "Témoin Contrat SARL",
    )


def test_no_match_is_an_empty_list_and_nothing_is_written(
    client: TestClient, db_session: Session
) -> None:
    before = len(audit_events(db_session))

    response = client.get(SEARCH, params={"q": "aucun témoin nulle part"})

    assert response.json() == {"query": "aucun témoin nulle part", "groups": []}
    assert len(audit_events(db_session)) == before
