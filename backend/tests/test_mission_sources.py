"""Source library, internal context and evidence effectiveness (task
`viper_mission_agent_configuration_v2`, Slice 02): root / sub-source hierarchy, URL roll-up,
category default sources and inheritance, successful-contribution counters (idempotent, accepted
items only, one credit per source and item), read-only internal context distinct from targets, and
the migration that keeps existing links.
"""

import uuid
from typing import Any

from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from app.models import AgentTask, AgentTaskResult
from app.models.enums import MissionType
from app.models.mission_sources import MissionEvidenceCitation, MissionSourceContribution
from app.services import mission_context, mission_sources
from tests.builders import FIXTURE_ACTOR, add_company, add_email, add_prospect
from tests.support import alembic_config
from tests.test_mission_categories import by_key, new_category
from tests.test_missions import MISSIONS, create, mint, rpc

SOURCES = f"{MISSIONS}/sources"
CATEGORIES = "/api/mission-categories"


def add(client: TestClient, url: str, **extra: Any) -> dict[str, Any]:
    response = client.post(SOURCES, json={"url": url, **extra})
    assert response.status_code == 201, response.text
    row: dict[str, Any] = response.json()
    return row


# --- hierarchy and roll-up ----------------------------------------------------------------------


def test_a_deep_url_is_filed_under_its_site_root_instead_of_cluttering_the_library(
    client: TestClient,
) -> None:
    root = add(client, "https://www.linkedin.com", label="LinkedIn")
    jobs = add(client, "https://www.linkedin.com/jobs", label="Jobs")
    profile = add(client, "https://fr.linkedin.com/in/jean-dupont")
    other = add(client, "https://hunter.io")

    assert root["parent_id"] is None and root["domain"] == "linkedin.com"
    assert jobs["parent_id"] == root["id"] and jobs["path_prefix"] == "/jobs"
    assert profile["parent_id"] == root["id"]
    assert other["parent_id"] is None
    top_level = client.get(SOURCES, params={"roots_only": True}).json()
    assert {row["url"] for row in top_level} == {"https://www.linkedin.com", "https://hunter.io"}
    assert next(row for row in top_level if row["id"] == root["id"])["children_count"] == 2
    children = client.get(SOURCES, params={"parent_id": root["id"]}).json()
    assert {row["id"] for row in children} == {jobs["id"], profile["id"]}


def test_a_new_root_adopts_the_lone_sources_it_covers(client: TestClient) -> None:
    jobs = add(client, "https://www.linkedin.com/jobs")
    assert jobs["parent_id"] is None

    root = add(client, "https://www.linkedin.com")

    assert client.get(f"{SOURCES}/{jobs['id']}").json()["parent_id"] == root["id"]


def test_the_hierarchy_has_one_level_and_a_root_with_children_cannot_be_deleted(
    client: TestClient,
) -> None:
    root = add(client, "https://www.linkedin.com")
    jobs = add(client, "https://www.linkedin.com/jobs")
    other = add(client, "https://hunter.io")

    too_deep = client.post(
        SOURCES, json={"url": "https://www.linkedin.com/jobs/view/1", "parent_id": jobs["id"]}
    )
    assert too_deep.status_code == 422 and too_deep.json()["detail"]["reason"] == "too_deep"
    foreign = client.patch(f"{SOURCES}/{jobs['id']}", json={"parent_id": other["id"]})
    assert foreign.status_code == 422 and foreign.json()["detail"]["reason"] == "domain"
    parent_with_children = client.patch(f"{SOURCES}/{root['id']}", json={"parent_id": other["id"]})
    assert parent_with_children.status_code == 422
    assert parent_with_children.json()["detail"]["reason"] == "has_children"
    refused = client.delete(f"{SOURCES}/{root['id']}")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "in_use"

    edited = client.patch(
        f"{SOURCES}/{jobs['id']}", json={"description": "Offres d’emploi", "parent_id": None}
    )
    assert edited.status_code == 200 and edited.json()["parent_id"] is None
    assert edited.json()["description"] == "Offres d’emploi"
    assert client.delete(f"{SOURCES}/{root['id']}").status_code == 204


def test_library_filters_search_description_and_order(client: TestClient) -> None:
    add(client, "https://hunter.io", label="Hunter", description="Trouver des e-mails pro")
    add(client, "https://www.pappers.fr", label="Pappers", description="Registre des sociétés")

    found = client.get(SOURCES, params={"q": "e-mails"}).json()
    assert [row["label"] for row in found] == ["Hunter"]
    assert [row["label"] for row in client.get(SOURCES, params={"order": "name"}).json()] == [
        "Hunter",
        "Pappers",
    ]
    assert client.get(SOURCES, params={"min_successful_uses": 1}).json() == []


def test_a_cited_url_rolls_up_to_the_most_specific_source(db_session: Session) -> None:
    for url in ("https://www.linkedin.com", "https://www.linkedin.com/jobs", "https://hunter.io"):
        mission_sources.add_source(db_session, FIXTURE_ACTOR, url, None)

    def hit(url: str) -> str | None:
        source = mission_sources.resolve_source(db_session, url)
        return source.url if source is not None else None

    assert hit("https://www.linkedin.com/jobs/view/123?trk=x") == "https://www.linkedin.com/jobs"
    assert hit("https://www.linkedin.com/jobsearch") == "https://www.linkedin.com"
    assert hit("https://fr.linkedin.com/company/2sn") == "https://www.linkedin.com"
    assert hit("https://hunter.io/domain-search") == "https://hunter.io"
    assert hit("https://unknown.example/page") is None
    assert hit("not a url") is None


# --- evidence and effectiveness -----------------------------------------------------------------


def claim_company_update(
    client: TestClient, db_session: Session, result: dict[str, Any]
) -> tuple[str, Any]:
    company = add_company(db_session, display_name="2SN")
    create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    token = mint(db_session)
    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {"task_id": payload["task_id"], "claim_id": payload["claim_id"], "result": result},
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    return submitted["structuredContent"]["result_id"], company


def uses(client: TestClient) -> dict[str, dict[str, Any]]:
    return {row["url"]: row for row in client.get(SOURCES).json()}


def test_a_fact_supported_by_three_sources_credits_each_once_and_a_visit_counts_for_nothing(
    client: TestClient, db_session: Session
) -> None:
    add(client, "https://www.linkedin.com", label="LinkedIn")
    add(client, "https://www.linkedin.com/jobs", label="Jobs")
    add(client, "https://hunter.io", label="Hunter")
    add(client, "https://registre.example", label="Registre")
    result_id, _ = claim_company_update(
        client,
        db_session,
        {
            "website_url": "https://www.2sn.fr",
            "legal_name": "2SN SAS",
            "confidence": 80,
            "evidence": [
                {
                    "field": "website_url",
                    "source": "https://www.linkedin.com/company/2sn",
                    "quote": "Site web : 2sn.fr",
                    "confidence": 90,
                    "source_checked_at": "2026-11-01T10:00:00Z",
                },
                {"field": "website_url", "source": "https://hunter.io/domain-search/2sn.fr"},
                {"field": "website_url", "source": "https://registre.example/fiche/2sn"},
                {"field": "website_url", "source": "https://www.linkedin.com/company/2sn/about"},
                {"field": "legal_name", "source": "https://www.linkedin.com/jobs/view/42"},
                {"field": "legal_name", "source": "Greffe du tribunal"},
            ],
        },
    )
    # Submitted, not reviewed: nothing counts yet (a source that was merely opened or cited).
    assert all(row["successful_uses"] == 0 for row in uses(client).values())

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})
    assert accepted.status_code == 200, accepted.text

    library = uses(client)
    assert library["https://hunter.io"]["successful_uses"] == 1
    assert library["https://registre.example"]["successful_uses"] == 1
    # Two LinkedIn URLs for the same item: the root is credited once for it.
    assert library["https://www.linkedin.com"]["successful_uses"] == 1
    assert library["https://www.linkedin.com/jobs"]["successful_uses"] == 1
    # Roll-up counts distinct items: website_url (root) + legal_name (jobs).
    assert library["https://www.linkedin.com"]["rolled_up_uses"] == 2
    citations = client.get(
        f"{SOURCES}/{library['https://www.linkedin.com']['id']}/citations"
    ).json()
    assert {row["url"] for row in citations} == {
        "https://www.linkedin.com/company/2sn",
        "https://www.linkedin.com/company/2sn/about",
        "https://www.linkedin.com/jobs/view/42",
    }
    first = next(row for row in citations if row["url"].endswith("/company/2sn"))
    assert first["quote"] == "Site web : 2sn.fr" and first["confidence"] == 90
    assert first["item_key"] == "website_url" and first["source_checked_at"] is not None
    # The concrete URLs are evidence, not library rows.
    assert len(library) == 4


def test_crediting_twice_never_inflates_the_counters(
    client: TestClient, db_session: Session
) -> None:
    add(client, "https://hunter.io", label="Hunter")
    result_id, _ = claim_company_update(
        client,
        db_session,
        {
            "website_url": "https://www.2sn.fr",
            "confidence": 80,
            "evidence": [{"field": "website_url", "source": "https://hunter.io/x"}],
        },
    )
    client.post(f"/api/agents/results/{result_id}/accept", json={})
    result = db_session.get(AgentTaskResult, uuid.UUID(result_id))
    assert result is not None
    task = db_session.get(AgentTask, result.task_id)
    assert task is not None

    again = mission_sources.credit_accepted_result(db_session, result, task, ["website_url"])
    mission_sources.refresh_counters(db_session)

    assert again.credited_sources == 1  # recorded again, stored once
    assert uses(client)["https://hunter.io"]["successful_uses"] == 1
    assert len(db_session.scalars(select(MissionSourceContribution)).all()) == 1
    assert len(db_session.scalars(select(MissionEvidenceCitation)).all()) == 1


def test_only_accepted_items_count_and_unknown_sites_join_the_library(
    client: TestClient, db_session: Session
) -> None:
    add(client, "https://hunter.io", label="Hunter")
    add(client, "https://registre.example", label="Registre")
    result_id, _ = claim_company_update(
        client,
        db_session,
        {
            "website_url": "https://www.2sn.fr",
            "legal_name": "2SN SAS",
            "confidence": 80,
            "evidence": [
                {"field": "website_url", "source": "https://hunter.io/x"},
                {"field": "legal_name", "source": "https://registre.example/y"},
                {"field": "legal_name", "source": "https://not-in-library.example/z"},
            ],
        },
    )

    accepted = client.post(
        f"/api/agents/results/{result_id}/accept", json={"accepted_items": ["legal_name"]}
    )
    assert accepted.status_code == 200, accepted.text

    library = uses(client)
    assert library["https://hunter.io"]["successful_uses"] == 0  # its item was not accepted
    assert library["https://registre.example"]["successful_uses"] == 1
    cited = {row.url: row.source_id for row in db_session.scalars(select(MissionEvidenceCitation))}
    # An unknown cited site joins the library (its site root) when its item is accepted.
    assert cited["https://not-in-library.example/z"] is not None
    assert library["https://hunter.io"]["successful_uses"] == 0
    added = uses(client)["https://not-in-library.example"]
    assert added["successful_uses"] == 1 and added["label"] == "not-in-library.example"
    assert len(cited) == 2


def test_a_rejected_result_credits_nothing(client: TestClient, db_session: Session) -> None:
    add(client, "https://hunter.io")
    result_id, _ = claim_company_update(
        client,
        db_session,
        {
            "website_url": "https://www.2sn.fr",
            "confidence": 80,
            "evidence": [{"field": "website_url", "source": "https://hunter.io/x"}],
        },
    )

    rejected = client.post(f"/api/agents/results/{result_id}/reject", json={"reason": "faux"})

    assert rejected.status_code == 200, rejected.text
    assert uses(client)["https://hunter.io"]["successful_uses"] == 0
    assert db_session.scalars(select(MissionEvidenceCitation)).all() == []


def test_forgetting_a_source_keeps_its_citations_as_evidence(
    client: TestClient, db_session: Session
) -> None:
    source = add(client, "https://hunter.io")
    result_id, _ = claim_company_update(
        client,
        db_session,
        {
            "website_url": "https://www.2sn.fr",
            "confidence": 80,
            "evidence": [{"field": "website_url", "source": "https://hunter.io/x"}],
        },
    )
    client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert client.delete(f"{SOURCES}/{source['id']}").status_code == 204

    db_session.expire_all()
    citation = db_session.scalars(select(MissionEvidenceCitation)).one()
    assert citation.url == "https://hunter.io/x" and citation.source_id is None
    assert db_session.scalars(select(MissionSourceContribution)).all() == []


# --- category defaults and inheritance ----------------------------------------------------------


def test_a_mission_follows_its_category_sources_until_it_overrides_them(
    client: TestClient, db_session: Session
) -> None:
    hunter = add(client, "https://hunter.io", label="Hunter")
    pappers = add(client, "https://www.pappers.fr", label="Pappers")
    category = new_category(client, source_ids=[hunter["id"]])
    assert [row["id"] for row in category["sources"]] == [hunter["id"]]

    body: dict[str, Any] = {
        "name": "Veille",
        "category_id": category["id"],
        "result_kind": "companies",
    }
    inheriting = client.post(MISSIONS, json=body).json()
    overriding = client.post(
        MISSIONS, json={**body, "name": "À moi", "source_ids": [pappers["id"]]}
    ).json()

    assert [row["id"] for row in inheriting["sources"]] == [hunter["id"]]
    assert inheriting["inheritance"]["sources_inherited"] is True
    assert inheriting["inheritance"]["category_sources"][0]["id"] == hunter["id"]
    assert "sources" not in inheriting["inheritance"]["overridden_fields"]
    assert [row["id"] for row in overriding["sources"]] == [pappers["id"]]
    assert "sources" in overriding["inheritance"]["overridden_fields"]

    # The category's defaults change: only the inheriting mission follows.
    changed = client.put(
        f"{CATEGORIES}/{category['id']}/sources", json={"source_ids": [pappers["id"], hunter["id"]]}
    )
    assert changed.status_code == 200
    assert [row["id"] for row in changed.json()["sources"]] == [pappers["id"], hunter["id"]]
    now = client.get(f"{MISSIONS}/{inheriting['card']['id']}").json()
    assert [row["id"] for row in now["sources"]] == [pappers["id"], hunter["id"]]
    still = client.get(f"{MISSIONS}/{overriding['card']['id']}").json()
    assert [row["id"] for row in still["sources"]] == [pappers["id"]]

    # Editing without mentioning sources keeps the state; sending null goes back to the category.
    edit = {"name": "À moi (v2)", "category_id": category["id"], "result_kind": "companies"}
    kept = client.put(f"{MISSIONS}/{overriding['card']['id']}", json=edit).json()
    assert [row["id"] for row in kept["sources"]] == [pappers["id"]]
    reset = client.put(
        f"{MISSIONS}/{overriding['card']['id']}", json={**edit, "source_ids": None}
    ).json()
    assert [row["id"] for row in reset["sources"]] == [pappers["id"], hunter["id"]]
    assert reset["inheritance"]["sources_inherited"] is True


def test_category_sources_validation_and_cleanup(client: TestClient) -> None:
    hunter = add(client, "https://hunter.io")
    seeded = by_key(client)["enrichment"]

    unknown = client.put(
        f"{CATEGORIES}/{seeded['id']}/sources", json={"source_ids": [str(uuid.uuid4())]}
    )
    assert unknown.status_code == 404
    assert (
        client.put(
            f"{CATEGORIES}/{seeded['id']}/sources", json={"source_ids": [hunter["id"]]}
        ).status_code
        == 200
    )
    # An edit of the category that does not mention sources leaves its defaults alone.
    edited = client.put(
        f"{CATEGORIES}/{seeded['id']}",
        json={
            "name": seeded["name"],
            "icon": seeded["icon"],
            "color": seeded["color"],
            "general_prompt": seeded["general_prompt"],
        },
    )
    assert [row["id"] for row in edited.json()["sources"]] == [hunter["id"]]

    assert client.delete(f"{SOURCES}/{hunter['id']}").status_code == 204
    assert client.get(f"{CATEGORIES}/{seeded['id']}").json()["sources"] == []


def test_the_agent_claim_carries_the_category_default_sources(
    client: TestClient, db_session: Session
) -> None:
    hunter = add(client, "https://hunter.io", label="Hunter")
    seeded = by_key(client)["enrichment"]
    client.put(f"{CATEGORIES}/{seeded['id']}/sources", json={"source_ids": [hunter["id"]]})
    company = add_company(db_session, display_name="2SN")
    client.post(
        MISSIONS,
        json={
            "name": "Fiches",
            "category_id": seeded["id"],
            "result_kind": "enrichment",
            "targets": [{"kind": "company", "id": str(company.id)}],
        },
    )

    answer = rpc(client, mint(db_session), "viper_claim_task", {"task_types": ["update_company"]})

    assert answer["structuredContent"]["mission"]["sources"] == [
        {"url": "https://hunter.io", "label": "Hunter", "description": None}
    ]


# --- internal context ---------------------------------------------------------------------------


def test_a_record_linked_as_context_is_not_a_target_and_resolves_only_allowed_fields(
    client: TestClient, db_session: Session
) -> None:
    target = add_company(db_session, display_name="Cible SAS")
    client_card = add_company(
        db_session,
        display_name="Client Historique",
        legal_name="Client Historique SARL",
        siren="123456789",
        project_done_with_circoe="Contrat confidentiel 2024",
        client_approach="Ne jamais relancer avant mars",
    )
    contact = add_prospect(db_session, client_card, first_name="Awa", last_name="Diallo")
    add_email(db_session, contact, "awa.diallo@client.example")

    detail = create(
        client,
        targets=[{"kind": "company", "id": str(target.id)}],
        context_refs=[
            {"kind": "company", "id": str(client_card.id), "note": "Client de référence"},
            {"kind": "prospect", "id": str(contact.id)},
        ],
        run_now=True,
    )

    assert [row["label"] for row in detail["targets"]] == ["Cible SAS"]
    assert {(row["kind"], row["label"]) for row in detail["context_refs"]} == {
        ("company", "Client Historique"),
        ("prospect", "Awa Diallo"),
    }
    # Only the target produced a task: context is never a subject.
    assert len(detail["tasks"]) == 1 and detail["tasks"][0]["company_id"] == str(target.id)

    preview = client.get(f"{MISSIONS}/{detail['card']['id']}/context").json()
    company_view = next(row for row in preview if row["kind"] == "company")
    assert company_view["read_only"] is True and company_view["note"] == "Client de référence"
    assert company_view["fields"]["siren"] == "123456789"
    assert company_view["fields"]["legal_name"] == "Client Historique SARL"
    prospect_view = next(row for row in preview if row["kind"] == "prospect")
    assert prospect_view["fields"]["company"] == "Client Historique"
    serialised = str(preview)
    assert "Contrat confidentiel" not in serialised and "Ne jamais relancer" not in serialised
    assert "awa.diallo@client.example" not in serialised

    # Fresh at resolution time: the record changed since it was linked.
    client_card.display_name = "Client Historique Group"
    db_session.flush()
    again = mission_context.resolve(db_session, uuid.UUID(detail["card"]["id"]))
    assert {row["label"] for row in again} == {"Client Historique Group", "Awa Diallo"}


def test_context_links_are_added_removed_and_never_count_as_evidence(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="Client X")
    add(client, "https://hunter.io", label="Hunter")
    mission = create(client, kind=MissionType.PROSPECTION, result_kind="companies")
    mission_id = mission["card"]["id"]

    linked = client.post(
        f"{MISSIONS}/{mission_id}/context", json={"kind": "company", "id": str(company.id)}
    )
    assert linked.status_code == 201 and len(linked.json()) == 1
    again = client.post(
        f"{MISSIONS}/{mission_id}/context", json={"kind": "company", "id": str(company.id)}
    )
    assert len(again.json()) == 1
    missing = client.post(
        f"{MISSIONS}/{mission_id}/context", json={"kind": "prospect", "id": str(uuid.uuid4())}
    )
    assert missing.status_code == 404
    bad_kind = client.post(
        f"{MISSIONS}/{mission_id}/context", json={"kind": "warehouse", "id": str(company.id)}
    )
    assert bad_kind.status_code == 422

    assert client.delete(f"{MISSIONS}/{mission_id}/context/company/{company.id}").status_code == 204
    assert client.delete(f"{MISSIONS}/{mission_id}/context/company/{company.id}").status_code == 404
    assert client.get(f"{MISSIONS}/{mission_id}").json()["context_refs"] == []
    # Context is not a source: the library and its counters are untouched.
    assert uses(client)["https://hunter.io"]["successful_uses"] == 0


def test_context_candidates_search_allowed_records(client: TestClient, db_session: Session) -> None:
    add_company(db_session, display_name="Transports Martin")

    found = client.get(
        f"{MISSIONS}/context-candidates", params={"kind": "company", "q": "Martin"}
    ).json()

    assert [row["label"] for row in found] == ["Transports Martin"]


# --- migration ----------------------------------------------------------------------------------


def test_the_migration_keeps_existing_links_and_files_sites_under_a_root(
    engine: Engine, test_database_url: str
) -> None:
    config = alembic_config(test_database_url)
    command.downgrade(config, "0049")
    try:
        with engine.begin() as connection:
            for url in (
                "https://www.linkedin.com/jobs/view/1",
                "https://www.linkedin.com/in/jean",
                "https://hunter.io/search",
            ):
                connection.execute(
                    text(
                        "INSERT INTO mission_sources (url, created_by_display) "
                        "VALUES (:url, 'Test')"
                    ),
                    {"url": url},
                )
            mission_id = connection.execute(
                text(
                    "INSERT INTO missions (name, type, prompt, result_kind, created_by_type, "
                    "created_by_display) VALUES ('migr-links', 'other', 'x', 'enrichment', "
                    "'human', 'Test') RETURNING id"
                )
            ).scalar_one()
            connection.execute(
                text(
                    "INSERT INTO mission_source_links (mission_id, source_id) "
                    "SELECT :mission, id FROM mission_sources"
                ),
                {"mission": mission_id},
            )
        command.upgrade(config, "head")
        with engine.begin() as connection:
            rows = connection.execute(
                text(
                    "SELECT s.url, s.domain, s.path_prefix, p.url AS parent_url "
                    "FROM mission_sources s LEFT JOIN mission_sources p ON p.id = s.parent_id "
                    "ORDER BY s.url"
                )
            ).all()
            by_url = {row[0]: row for row in rows}
            assert by_url["https://www.linkedin.com/jobs/view/1"][1:] == (
                "linkedin.com",
                "/jobs/view/1",
                "https://linkedin.com",
            )
            # A new root was made for the domain holding several URLs; a lone URL stays top-level.
            assert by_url["https://linkedin.com"][3] is None
            assert by_url["https://hunter.io/search"][3] is None
            links = connection.execute(
                text("SELECT count(*) FROM mission_source_links WHERE mission_id = :m"),
                {"m": mission_id},
            ).scalar_one()
            assert links == 3  # every saved link survived
            assert connection.execute(
                text("SELECT overridden_fields FROM missions WHERE id = :m"), {"m": mission_id}
            ).scalar_one() == ["sources"]
        # The downgrade is reversible without losing links either.
        command.downgrade(config, "0049")
        with engine.begin() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM mission_source_links")).scalar_one()
                == 3
            )
            assert (
                connection.execute(text("SELECT count(*) FROM mission_sources")).scalar_one() == 3
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM missions WHERE name = 'migr-links'"))
            connection.execute(text("DELETE FROM mission_sources"))
        command.upgrade(config, "head")


def test_a_signal_credits_the_source_of_each_accepted_signal_only(
    client: TestClient, db_session: Session
) -> None:
    add(client, "https://example.test", label="Example")
    add(client, "https://linkedin.test", label="LinkedIn test")
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        kind=MissionType.SIGNALS,
        targets=[{"kind": "company", "id": str(company.id)}],
        result_kind="signals",
        run_now=True,
        allow_multiple=True,
    )
    token = mint(db_session, label="Agent veille", scopes=["surveil_signals"])
    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    signals = [
        {
            "subject": {"type": "company"},
            "kind": "hiring",
            "signal": text_,
            "score": 15,
            "score_reason": "Budget.",
            "source": url,
            "observed_on": "2026-10-25",
            "relevance": 80,
        }
        for text_, url in (
            ("2SN recrute.", "https://example.test/2sn-recrutement"),
            ("2SN recrute encore.", "https://linkedin.test/company/2sn"),
        )
    ]
    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"signals": signals, "confidence": 80},
        },
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    result_id = submitted["structuredContent"]["result_id"]
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    first_key = proposal["items"][0]["key"]

    accepted = client.post(
        f"/api/agents/results/{result_id}/accept", json={"accepted_items": [first_key]}
    )

    assert accepted.status_code == 200, accepted.text
    library = uses(client)
    assert library["https://example.test"]["successful_uses"] == 1
    assert library["https://linkedin.test"]["successful_uses"] == 0
