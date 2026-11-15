"""MCP query tools: free filtering of companies, warehouses and people, the verification queue and
the « does it exist? » check. Every tool reads only, and answers what the screens would."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Establishment, Warehouse
from app.models.enums import Civility
from tests.builders import add_company, add_email, add_prospect
from tests.test_mcp_tools import body, call, mint


def ask(client: TestClient, token: str, tool: str, /, **arguments: Any) -> dict[str, Any]:
    return body(call(client, token, tool, arguments))


def add_warehouse(session: Session, name: str, company: Any = None, **fields: Any) -> Warehouse:
    establishment_id = None
    if company is not None:
        building = Establishment(company_id=company.id, name=name, city="Lille")
        session.add(building)
        session.flush()
        establishment_id = building.id
    row = Warehouse(name=name, contacts=[], establishment_id=establishment_id, **fields)
    session.add(row)
    session.flush()
    return row


def test_warehouses_without_company_and_by_owner_names(
    client: TestClient, db_session: Session
) -> None:
    alpha = add_company(db_session, "Alpha Logistique")
    beta = add_company(db_session, "Beta Transports")
    add_company(db_session, "Gamma")
    add_warehouse(db_session, "Entrepot libre", postal_code="59000", city="Lille")
    add_warehouse(db_session, "Entrepot alpha", alpha, postal_code="75008")
    add_warehouse(db_session, "Entrepot beta sans cp", beta)
    add_warehouse(db_session, "Entrepot alpha sans cp", alpha)
    token = mint(db_session)

    orphans = ask(client, token, "viper_find_warehouses", without_company=True)
    assert [row["name"] for row in orphans["warehouses"]] == ["Entrepot libre"]

    # « the warehouses of Alpha and Beta together that have no postal code »
    crossed = ask(
        client,
        token,
        "viper_find_warehouses",
        company_names=["alpha", "BETA transports"],
        lacks=["postal_code"],
    )
    assert crossed["total"] == 2
    assert {row["name"] for row in crossed["warehouses"]} == {
        "Entrepot beta sans cp",
        "Entrepot alpha sans cp",
    }
    assert {match["query"] for match in crossed["resolved_companies"]} == {
        "alpha",
        "BETA transports",
    }
    by_ids = ask(client, token, "viper_find_warehouses", company_ids=[str(alpha.id)])
    assert by_ids["total"] == 2
    unknown = ask(client, token, "viper_find_warehouses", company_names=["Inconnue SA"])
    assert unknown["total"] == 0


def test_company_filters_status_missing_and_links(client: TestClient, db_session: Session) -> None:
    add_company(db_session, "Avec Siren", siren="123456782", email_domain="avec.fr")
    add_company(db_session, "Sans Rien")
    busy = add_company(db_session, "Peuplee")
    add_prospect(db_session, busy, first_name="A", last_name="B")
    add_prospect(db_session, busy, first_name="C", last_name="D")
    token = mint(db_session)

    no_siren = ask(client, token, "viper_find_companies", lacks=["siren"])
    assert {row["display_name"] for row in no_siren["companies"]} == {"Sans Rien", "Peuplee"}
    populated = ask(client, token, "viper_find_companies", min_prospects=2)
    assert [row["display_name"] for row in populated["companies"]] == ["Peuplee"]
    lacking = ask(client, token, "viper_find_companies", missing=["siren"], status="to_verify")
    assert {row["display_name"] for row in lacking["companies"]} == {"Sans Rien", "Peuplee"}
    assert all(row["status"] == "incomplete" for row in lacking["companies"])
    # « verified » needs a SIREN, so every company lacking one is still to verify, with the reason.
    assert all(row["missing"] for row in lacking["companies"])


def test_unknown_filter_name_is_refused_with_the_allowed_ones(
    client: TestClient, db_session: Session
) -> None:
    answer = call(client, mint(db_session), "viper_find_companies", {"lacks": ["colour"]})
    assert answer["isError"] is True


def test_people_of_several_companies_and_people_without_company(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, "Premiere SARL")
    second = add_company(db_session, "Seconde SAS")
    third = add_company(db_session, "Troisieme")
    add_prospect(db_session, first, first_name="Anne", last_name="Un")
    add_prospect(db_session, second, first_name="Paul", last_name="Deux")
    add_prospect(db_session, third, first_name="Luc", last_name="Trois")
    add_prospect(db_session, None, first_name="Orphe", last_name="Lin")
    token = mint(db_session)

    both = ask(client, token, "viper_find_prospects", company_ids=[str(first.id), str(second.id)])
    assert {row["last_name"] for row in both["prospects"]} == {"Un", "Deux"}
    named = ask(client, token, "viper_find_prospects", company_names=["Premiere", "Troisieme"])
    assert {row["last_name"] for row in named["prospects"]} == {"Un", "Trois"}
    alone = ask(client, token, "viper_find_prospects", without_company=True)
    assert [row["last_name"] for row in alone["prospects"]] == ["Lin"]
    nobody = ask(client, token, "viper_find_prospects", company_names=["Inexistante"])
    assert nobody["total"] == 0


def test_review_queue_counts_and_lists_what_is_left_to_verify(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Societe Queue")
    add_prospect(db_session, company, first_name="Incomplet", last_name="Un")
    add_warehouse(db_session, "Entrepot queue")
    token = mint(db_session)

    overview = ask(client, token, "viper_review_queue")["counts"]
    assert overview["company"]["incomplete"] >= 1
    assert overview["warehouse"]["to_verify"] >= 1
    assert overview["prospect"]["incomplete"] >= 1

    warehouses = ask(client, token, "viper_review_queue", entity="warehouse")
    assert warehouses["state"] == "to_verify"
    assert warehouses["warehouses"][0]["missing"]
    people = ask(client, token, "viper_review_queue", entity="prospect")
    assert [row["last_name"] for row in people["prospects"]] == ["Un"]
    done = ask(client, token, "viper_review_queue", entity="company", state="verified")
    assert done["total"] == 0


def test_company_duplicates_by_identifier_name_and_domain(
    client: TestClient, db_session: Session
) -> None:
    add_company(
        db_session,
        "Transports Exemple SARL",
        siren="123456782",
        email_domain="exemple.fr",
        website_url="https://www.exemple.fr",
    )
    token = mint(db_session)

    by_siren = ask(client, token, "viper_check_duplicate", entity="company", siren="123 456 782")
    assert by_siren["verdict"] == "exists"
    by_name = ask(
        client, token, "viper_check_duplicate", entity="company", name="TRANSPORTS EXEMPLE S.A.R.L."
    )
    assert by_name["verdict"] == "probable"
    both = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="company",
        name="Transports Exemple",
        website="http://exemple.fr/contact",
    )
    assert both["verdict"] == "exists"
    other = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="company",
        name="Transports Exemple",
        siren="552100554",
    )
    assert other["verdict"] != "exists"
    assert "different_siren" in other["candidates"][0]["reasons"]
    nothing = ask(client, token, "viper_check_duplicate", entity="company", name="Zorglub")
    assert nothing["verdict"] == "none"


def test_person_duplicate_is_not_decided_on_the_name_alone(
    client: TestClient, db_session: Session
) -> None:
    acme = add_company(db_session, "Acme Logistique SAS")
    other = add_company(db_session, "Autre Societe")
    twin = add_prospect(
        db_session, acme, first_name="Jean", last_name="Dupont", civility=Civility.MR
    )
    add_email(db_session, twin, "jean.dupont@acme.fr")
    token = mint(db_session)

    same = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="prospect",
        first_name="JEAN",
        last_name="dupont",
        company_name="Acme Logistique",
    )
    assert same["verdict"] == "exists"
    assert same["candidates"][0]["comparison"]["company"] == "same"

    swapped = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="prospect",
        first_name="Dupont",
        last_name="Jean",
        company_id=str(acme.id),
    )
    assert swapped["verdict"] == "exists"

    homonym = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="prospect",
        first_name="Jean",
        last_name="Dupont",
        company_id=str(other.id),
    )
    assert homonym["verdict"] == "possible"
    assert homonym["candidates"][0]["comparison"]["company"] == "different"

    by_email = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="prospect",
        first_name="J.",
        last_name="D",
        emails=["Jean.Dupont@acme.fr"],
    )
    assert by_email["verdict"] == "exists"
    assert by_email["candidates"][0]["reasons"][0] == "same_email"


def test_warehouse_duplicates_by_siret_and_by_name_with_location(
    client: TestClient, db_session: Session
) -> None:
    add_warehouse(
        db_session,
        "Entrepôt Sud SARL",
        postal_code="13000",
        city="Marseille",
        siret="73282932000074",
    )
    token = mint(db_session)

    by_siret = ask(
        client, token, "viper_check_duplicate", entity="warehouse", siret="732 829 320 00074"
    )
    assert by_siret["verdict"] == "exists"
    same_place = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="warehouse",
        name="ENTREPOT SUD",
        postal_code="13000",
    )
    assert same_place["verdict"] == "exists"
    elsewhere = ask(
        client,
        token,
        "viper_check_duplicate",
        entity="warehouse",
        name="Entrepot Sud",
        postal_code="59000",
        city="Lille",
    )
    assert elsewhere["verdict"] == "possible"


def test_claim_can_be_limited_to_one_mission(client: TestClient, db_session: Session) -> None:
    answer = call(client, mint(db_session), "viper_claim_task", {"mission_id": "not-a-uuid"})
    assert answer["isError"] is True
    unknown = ask(
        client,
        mint(db_session),
        "viper_claim_task",
        mission_id="018f0000-0000-7000-8000-000000000000",
    )
    assert unknown["task"] is None


def test_mission_options_carry_the_library_to_build_a_mission_from(
    client: TestClient, db_session: Session
) -> None:
    from tests.test_mcp_conversational import mint as mint_assistant

    answer = ask(client, mint_assistant(db_session), "viper_mission_options")
    assert {"categories", "skills", "sources", "sources_total"} <= set(answer)
    assert answer["categories"], "the built-in categories are seeded"
    first = answer["categories"][0]
    assert {"id", "name", "general_prompt", "default_skills", "default_sources"} <= set(first)
