"""Company and warehouse file status: verified / usable / incomplete, from the record itself."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Establishment, Warehouse
from app.models.enums import CompanyKind, VerificationStatus
from tests.builders import add_company, add_email, add_prospect, add_role

COMPANIES = "/api/companies"
WAREHOUSES = "/api/warehouses"


def usable_company(session: Session, name: str = "Societe Exploitable") -> Establishment:
    """A company with everything to be usable, and one building; returns the building."""
    company = add_company(
        session,
        name,
        website_url="https://exemple.example",
        company_kind=CompanyKind.SME,
    )
    building = Establishment(company_id=company.id, name="Site", postal_code="59000", city="Lille")
    session.add(building)
    role = add_role(session)
    person = add_prospect(session, company, first_name="Anne", last_name="Test", role_id=role.id)
    add_email(
        session,
        person,
        "anne@exemple.example",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
    )
    session.flush()
    return building


def company_row(client: TestClient, name: str) -> dict[str, object]:
    page = client.get(COMPANIES, params={"q": name}).json()
    (row,) = page["items"]
    return row


def test_company_needs_a_usable_person_to_be_usable(
    client: TestClient, db_session: Session
) -> None:
    usable_company(db_session)
    bare = add_company(
        db_session,
        "Societe Sans Personne",
        website_url="https://sans.example",
        company_kind=CompanyKind.SME,
        siren="123456782",
    )
    db_session.flush()
    assert bare.id is not None

    good = company_row(client, "Societe Exploitable")
    assert (good["status"], good["missing"]) == (
        "usable",
        ["siren", "legal_name", "size", "segment", "activity"],
    )
    nobody = company_row(client, "Societe Sans Personne")
    assert (nobody["status"], nobody["missing"]) == ("incomplete", ["person"])

    usable = client.get(COMPANIES, params={"status": "usable"}).json()
    assert [item["display_name"] for item in usable["items"]] == ["Societe Exploitable"]
    incomplete = client.get(COMPANIES, params={"status": "incomplete"}).json()
    assert [item["display_name"] for item in incomplete["items"]] == ["Societe Sans Personne"]
    assert client.get(COMPANIES, params={"status": "verified"}).json()["total"] == 0


def test_warehouse_is_usable_only_through_a_usable_company_building(
    client: TestClient, db_session: Session
) -> None:
    building = usable_company(db_session)
    other = add_company(db_session, "Societe Incomplete")
    other_building = Establishment(company_id=other.id, name="Autre", postal_code="1", city="X")
    db_session.add(other_building)
    for name, establishment in (
        ("Entrepot Lie", building),
        ("Entrepot Lie Incomplet", other_building),
        ("Entrepot Libre", None),
    ):
        db_session.add(
            Warehouse(
                name=name,
                postal_code="59000",
                city="Lille",
                prospecting_category="sme",
                contacts=[],
                establishment_id=establishment.id if establishment else None,
            )
        )
    db_session.flush()

    by_name = {
        item["name"]: item for item in client.get(WAREHOUSES, params={"limit": 50}).json()["items"]
    }
    linked = by_name["Entrepot Lie"]
    assert (linked["status"], linked["company_name"]) == ("usable", "Societe Exploitable")
    assert linked["missing"] == ["siret", "address", "interlocutor"]
    assert by_name["Entrepot Lie Incomplet"]["status"] == "incomplete"
    assert by_name["Entrepot Lie Incomplet"]["missing"] == ["company"]
    assert by_name["Entrepot Libre"]["missing"] == ["company"]
    only = client.get(WAREHOUSES, params={"status": "usable"}).json()
    assert [item["name"] for item in only["items"]] == ["Entrepot Lie"]


def test_warehouse_can_be_linked_to_a_building_and_becomes_verified(
    client: TestClient, db_session: Session
) -> None:
    building = usable_company(db_session)
    created = client.post(
        WAREHOUSES,
        json={
            "name": "Entrepot Complet",
            "prospecting_category": "other",
            "postal_code": "59000",
            "city": "Lille",
            "address": "1 rue Exemple",
            "owner_name": "Pierre Test",
            "owner_email": "pierre@exemple.example",
            "establishment_id": str(building.id),
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["missing"] == ["siret"]
    refused = client.post(
        WAREHOUSES,
        json={"name": "X", "establishment_id": "00000000-0000-7000-8000-000000000000"},
    )
    assert refused.status_code == 422, refused.text
