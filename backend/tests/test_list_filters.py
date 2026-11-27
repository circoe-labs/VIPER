"""The list filters of Prospection, Entreprises and Entrepôts: several values per filter (OR),
filters combined with AND, and old single-value links unchanged."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import ActivityCategory, CommercialSegment, Establishment, Warehouse
from app.models.enums import CompanyKind, VerificationStatus
from tests.builders import (
    add_cohort,
    add_company,
    add_email,
    add_prospect,
    add_role,
    start_sequence,
)

COUNTERS = "/api/prospection/counters"
PROSPECTS = "/api/prospection/prospects"
# The organisation’s own company, seeded by the migrations.
OWN = "CIRCOE"


def get(client: TestClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def people(client: TestClient, params: dict[str, Any]) -> set[str]:
    """The listed last names; the counters of the same criteria must agree with the list."""
    page = get(client, PROSPECTS, params)
    assert get(client, COUNTERS, params)["counts"]["all"] == page["total"]
    return {row["last_name"] for row in page["items"]}


def test_prospect_filters_take_several_values(client: TestClient, db_session: Session) -> None:
    s = db_session
    retail = CommercialSegment(slug="retail", label="Distribution")
    cold = ActivityCategory(slug="froid", label="Froid")
    s.add_all([retail, cold])
    s.flush()
    north = add_company(
        s,
        "Entreprise Nord",
        company_kind=CompanyKind.SME,
        commercial_segment_id=retail.id,
        proposed_services=["iguard"],
    )
    north.activity_categories = [cold]
    south = add_company(s, "Entreprise Sud", company_kind=CompanyKind.LARGE)
    s.add_all(
        [
            Establishment(company_id=north.id, postal_code="59000", city="Ville Nord"),
            Establishment(company_id=south.id, postal_code="97100", city="Ville Outremer"),
        ]
    )
    director = add_role(s, "directeur", "Directeur")
    buyer = add_role(s, "acheteur", "Acheteur")
    a = add_prospect(s, north, last_name="a", role_id=director.id, activity_status="active")
    b = add_prospect(s, south, last_name="b", role_id=buyer.id, activity_status="inactive")
    add_prospect(s, None, last_name="c")
    add_email(
        s, a, "a@exemple.example", verification_status=VerificationStatus.VERIFIED, is_primary=True
    )
    add_email(
        s, b, "b@exemple.example", verification_status=VerificationStatus.INVALID, is_primary=True
    )
    s41, s42 = add_cohort(s, "S41"), add_cohort(s, "S42")
    start_sequence(s, a, s41)
    start_sequence(s, b, s42)
    s.flush()

    # One value (an old link) and several values of one filter (any of them).
    assert people(client, {"role": str(director.id)}) == {"a"}
    assert people(client, {"role": [str(director.id), str(buyer.id)]}) == {"a", "b"}
    assert people(client, {"role": [str(director.id), "none"]}) == {"a", "c"}
    assert people(client, {"activity": ["active", "inactive"]}) == {"a", "b"}
    assert people(client, {"cohort": [str(s41.id), "none"]}) == {"a", "c"}
    assert people(client, {"referent": ["none"]}) == {"a", "b", "c"}
    assert people(client, {"tracking_status": ["neutral", "ignored"]}) == {"a", "b", "c"}
    assert people(client, {"tracking_status": ["response_received", "disqualified"]}) == set()
    assert people(client, {"company": [str(north.id), str(south.id)]}) == {"a", "b"}
    assert people(client, {"company_kind": ["sme", "large"]}) == {"a", "b"}
    assert people(client, {"company_kind": ["large", "unclassified"]}) == {"b", "c"}
    assert people(client, {"email_state": ["verified", "invalid"]}) == {"a", "b"}
    assert people(client, {"email_state": "missing"}) == {"c"}
    assert people(client, {"verification_box": ["todo", "validated"]}) == {"a", "b", "c"}
    assert people(client, {"send_stage": ["sent", "r1"]}) == set()
    assert people(client, {"services": ["iguard", "iadvice"]}) == {"a"}
    assert people(client, {"commercial_segment": str(retail.id)}) == {"a"}
    assert people(client, {"commercial_segment": [str(retail.id), "none"]}) == {"a", "b", "c"}
    assert people(client, {"activity_category": str(cold.id)}) == {"a"}
    assert people(client, {"activity_category": "none"}) == {"b", "c"}
    assert people(client, {"department": ["59", "971"]}) == {"a", "b"}
    # Across filters: all of them must hold.
    assert people(
        client, {"role": [str(director.id), str(buyer.id)], "department": ["971", "75"]}
    ) == {"b"}
    assert people(client, {"company_kind": ["sme", "large"], "activity": "active"}) == {"a"}

    for params in ({"department": "5"}, {"role": ["x"]}, {"email_state": ["nope"]}):
        assert client.get(PROSPECTS, params=params).status_code == 422

    options = get(client, "/api/prospection/filter-options", {})
    # The workspace’s own company (seeded by the migrations) is listed like any other.
    assert [item["label"] for item in options["companies"] if item["label"] != OWN] == [
        "Entreprise Nord",
        "Entreprise Sud",
    ]
    assert options["company_departments"] == ["59", "971"]

    def companies(params: dict[str, Any]) -> list[str]:
        page = get(client, "/api/companies", params)
        assert page["total"] == len(page["items"])
        return [item["display_name"] for item in page["items"] if item["display_name"] != OWN]

    both = ["Entreprise Nord", "Entreprise Sud"]
    assert companies({"company_kind": "sme"}) == ["Entreprise Nord"]
    assert companies({"company_kind": ["sme", "large"]}) == both
    assert companies({"commercial_segment": [str(retail.id), "none"]}) == both
    assert companies({"activity_category": str(cold.id)}) == ["Entreprise Nord"]
    assert companies({"department": ["971"]}) == ["Entreprise Sud"]
    assert companies({"services": ["iguard", "emailing"]}) == ["Entreprise Nord"]
    assert companies({"status": ["usable", "incomplete"]}) == both
    assert companies({"status": "verified"}) == []
    assert companies({"company_kind": ["sme", "large"], "department": "59"}) == ["Entreprise Nord"]


def test_warehouse_filters_take_several_values(client: TestClient, db_session: Session) -> None:
    db_session.add_all(
        [
            Warehouse(name="Site A", contacts=[], prospecting_category="sme", postal_code="59000"),
            Warehouse(
                name="Site B", contacts=[], prospecting_category="other", postal_code="76600"
            ),
            Warehouse(name="Site C", contacts=[], postal_code="inconnu"),
        ]
    )
    db_session.flush()

    def sites(params: dict[str, Any]) -> list[str]:
        page = get(client, "/api/warehouses", params)
        assert page["total"] == len(page["items"])
        return [item["name"] for item in page["items"]]

    assert sites({"category": "sme"}) == ["Site A"]
    assert sites({"category": ["sme", "unclassified"]}) == ["Site A", "Site C"]
    assert sites({"status": ["incomplete", "usable"]}) == ["Site A", "Site B", "Site C"]
    assert sites({"department": ["59", "76"]}) == ["Site A", "Site B"]
    assert sites({"department": ["59", "76"], "category": "other"}) == ["Site B"]
    assert sites({"created_from": "2000-01-01"}) == ["Site A", "Site B", "Site C"]
    assert sites({"created_to": "2000-01-01"}) == []
    options = get(client, "/api/prospection/filter-options", {})
    assert options["warehouse_departments"] == ["59", "76"]
    refused = client.get(
        "/api/warehouses", params={"created_from": "2026-02-02", "created_to": "2026-02-01"}
    )
    assert refused.status_code == 422


def test_filter_options_need_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get("/api/prospection/filter-options").status_code == 401
