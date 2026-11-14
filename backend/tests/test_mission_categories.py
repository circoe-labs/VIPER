"""Mission categories, instruction skills and mission inheritance (task `agent_configuration_v2`,
Slice 01): seeded catalog, admin CRUD with safe-reference rules, reusable skills, field-level
inheritance (a category edit reaches only the missions still inheriting) and the mission-creator
prompt setting.
"""

import uuid
from typing import Any

from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy import update as sql_update
from sqlalchemy.orm import Session

from app.models import Mission, MissionCategory, User
from app.models.enums import MissionType
from app.models.organizations import OrganizationRole
from tests.builders import add_company, audit_events
from tests.support import alembic_config

CATEGORIES = "/api/mission-categories"
SKILLS = "/api/mission-skills"
MISSIONS = "/api/missions"
INTEGRATIONS = "/api/settings/integrations"


def by_key(client: TestClient) -> dict[str, Any]:
    rows = client.get(CATEGORIES).json()
    return {row["key"]: row for row in rows if row["key"]}


def new_category(client: TestClient, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Veille concurrents",
        "description": "Suivre les concurrents directs.",
        "icon": "radar",
        "color": "#112233",
        "general_prompt": "Surveille les concurrents listés.",
        "mission_type": "prospection",
        **extra,
    }
    response = client.post(CATEGORIES, json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def new_skill(client: TestClient, name: str = "Citer ses sources", **extra: Any) -> dict[str, Any]:
    body = {"name": name, "content": "Cite toujours l’URL exacte de chaque source.", **extra}
    response = client.post(SKILLS, json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def new_mission(client: TestClient, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Veille Normandie",
        "targets": [],
        # No linked records: a discovery mission, the one shape every category may take.
        "result_kind": "companies",
        **extra,
    }
    response = client.post(MISSIONS, json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


# --- the seeded catalog and the backfill --------------------------------------------------------


def test_the_current_categories_are_seeded_with_their_technical_type(client: TestClient) -> None:
    seeded = by_key(client)

    assert set(seeded) == {value.value for value in MissionType}
    for key, row in seeded.items():
        assert row["is_system"] is True
        assert row["mission_type"] == key
        assert row["color"].startswith("#") and row["icon"] and row["general_prompt"]


def test_the_migration_maps_existing_missions_to_their_category_and_keeps_their_consigne(
    engine: Engine, test_database_url: str
) -> None:
    config = alembic_config(test_database_url)
    command.downgrade(config, "0046")
    try:
        with engine.begin() as connection:
            for kind in ("signals", "other"):
                connection.execute(
                    text(
                        "INSERT INTO missions (name, type, prompt, result_kind, created_by_type, "
                        "created_by_display) VALUES (:name, :kind, 'Consigne écrite à la main', "
                        "'enrichment', 'human', 'Test')"
                    ),
                    {"name": f"backfill-{kind}", "kind": kind},
                )
        command.upgrade(config, "head")
        with engine.begin() as connection:
            rows = connection.execute(
                text(
                    "SELECT m.type, c.key, m.overridden_fields, m.prompt FROM missions m "
                    "JOIN mission_categories c ON c.id = m.category_id "
                    "WHERE m.name LIKE 'backfill-%' ORDER BY m.type"
                )
            ).all()
            assert [(row[0], row[1], row[2], row[3]) for row in rows] == [
                ("other", "other", ["prompt"], "Consigne écrite à la main"),
                ("signals", "signals", ["prompt"], "Consigne écrite à la main"),
            ]
            connection.execute(text("DELETE FROM missions WHERE name LIKE 'backfill-%'"))
    finally:
        command.upgrade(config, "head")


# --- category administration ---------------------------------------------------------------------


def test_an_admin_creates_edits_and_deletes_a_category(
    client: TestClient, db_session: Session
) -> None:
    category = new_category(client)
    assert category["is_system"] is False and category["key"] is None
    assert category["mission_type"] == "prospection" and category["missions_count"] == 0

    edited = client.put(
        f"{CATEGORIES}/{category['id']}",
        json={
            "name": "Veille concurrentielle",
            "icon": "compass",
            "color": "#AABBCC",
            "general_prompt": "Nouveau prompt général.",
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["color"] == "#aabbcc"
    assert edited.json()["general_prompt"] == "Nouveau prompt général."

    assert client.delete(f"{CATEGORIES}/{category['id']}").status_code == 204
    assert client.get(f"{CATEGORIES}/{category['id']}").status_code == 404
    actions = [event.action for event in audit_events(db_session, entity_type="mission_category")]
    assert actions == [
        "mission_category.created",
        "mission_category.updated",
        "mission_category.deleted",
    ]


def test_category_values_are_validated_and_names_are_unique(client: TestClient) -> None:
    new_category(client)
    duplicate = client.post(
        CATEGORIES,
        json={
            "name": "veille CONCURRENTS",
            "icon": "radar",
            "color": "#112233",
            "general_prompt": "x",
            "mission_type": "other",
        },
    )
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "duplicate"

    for field, value in (("color", "bleu"), ("icon", "Not An Icon"), ("name", "   ")):
        refused = client.post(
            CATEGORIES,
            json={
                "name": "Divers",
                "icon": "radar",
                "color": "#112233",
                "general_prompt": "x",
                "mission_type": "other",
                field: value,
            },
        )
        assert refused.status_code == 422, (field, refused.text)

    missing_type = client.post(
        CATEGORIES,
        json={"name": "Sans type", "icon": "radar", "color": "#112233", "general_prompt": "x"},
    )
    assert missing_type.status_code == 422
    assert missing_type.json()["detail"]["field"] == "mission_type"


def test_the_technical_type_of_a_category_cannot_change(client: TestClient) -> None:
    category = new_category(client)
    refused = client.put(
        f"{CATEGORIES}/{category['id']}",
        json={
            "name": category["name"],
            "icon": "radar",
            "color": "#112233",
            "general_prompt": "x",
            "mission_type": "signals",
        },
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "immutable"


def test_a_built_in_category_can_be_deleted_when_unused(client: TestClient) -> None:
    built_in = by_key(client)["signals"]
    assert client.delete(f"{CATEGORIES}/{built_in['id']}").status_code == 204
    assert "signals" not in by_key(client)


def test_a_used_category_needs_the_cascade_confirmation(client: TestClient) -> None:
    category = new_category(client)
    new_mission(client, category_id=category["id"])
    in_use = client.delete(f"{CATEGORIES}/{category['id']}")
    assert in_use.status_code == 409
    assert in_use.json()["detail"]["code"] == "in_use"
    assert in_use.json()["detail"]["usage"] == {"missions": 1}
    assert client.get(MISSIONS).status_code == 200  # nothing was removed
    assert any(row["id"] == category["id"] for row in client.get(CATEGORIES).json())


def test_the_cascade_deletes_missions_through_the_mission_service(
    client: TestClient, db_session: Session
) -> None:
    from sqlalchemy import select

    from app.models.agent_missions import AgentTask, AgentTaskResult
    from app.models.enums import AgentResultStatus, AgentTaskStatus
    from tests.test_mission_stop import claim, mission_with, submit
    from tests.test_missions import mint

    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Acme")
    mission_id = mission_with(client, first, second)
    category_id = client.get(f"{MISSIONS}/{mission_id}").json()["inheritance"]["category_id"]
    token = mint(db_session)
    result_id = body_of(submit(client, token, claim(client, token)))["result_id"]

    unconfirmed = client.delete(f"{CATEGORIES}/{category_id}")
    assert unconfirmed.status_code == 409
    assert unconfirmed.json()["detail"]["usage"] == {"missions": 1}

    confirmed = client.delete(f"{CATEGORIES}/{category_id}", params={"confirm_cascade": "true"})
    assert confirmed.status_code == 204, confirmed.text
    db_session.expire_all()
    assert client.get(f"{MISSIONS}/{mission_id}").status_code == 404
    assert {task.status for task in db_session.scalars(select(AgentTask))} == {
        AgentTaskStatus.CANCELLED
    }
    result = db_session.get(AgentTaskResult, result_id)
    assert result is not None and result.status is AgentResultStatus.REJECTED
    assert db_session.get(MissionCategory, uuid.UUID(category_id)) is None


def test_the_cascade_keeps_accepted_results(client: TestClient, db_session: Session) -> None:
    from app.models.agent_missions import AgentTaskResult
    from app.models.enums import AgentResultStatus
    from tests.test_mission_stop import claim, mission_with, submit
    from tests.test_missions import mint

    company = add_company(db_session, display_name="2SN")
    mission_id = mission_with(client, company)
    category_id = client.get(f"{MISSIONS}/{mission_id}").json()["inheritance"]["category_id"]
    token = mint(db_session)
    result_id = body_of(submit(client, token, claim(client, token)))["result_id"]
    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})
    assert accepted.status_code == 200, accepted.text

    deleted = client.delete(f"{CATEGORIES}/{category_id}", params={"confirm_cascade": "true"})
    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    result = db_session.get(AgentTaskResult, result_id)
    assert result is not None and result.status is not AgentResultStatus.REJECTED


def body_of(response: Any) -> dict[str, Any]:
    from tests.test_mcp_tools import body

    return body(response)


def test_only_an_admin_writes_categories_and_skills(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    db_session.execute(
        sql_update(User).where(User.id == pilot_user.id).values(role=OrganizationRole.MEMBER)
    )
    db_session.flush()

    assert client.get(CATEGORIES).status_code == 200
    assert client.get(SKILLS).status_code == 200
    category_body = {
        "name": "X",
        "icon": "radar",
        "color": "#112233",
        "general_prompt": "x",
        "mission_type": "other",
    }
    assert client.post(CATEGORIES, json=category_body).status_code == 403
    assert client.post(SKILLS, json={"name": "X", "content": "x"}).status_code == 403
    assert client.delete(f"{CATEGORIES}/{by_key(client)['other']['id']}").status_code == 403


# --- skills --------------------------------------------------------------------------------------


def test_a_skill_is_reused_by_several_categories_and_detached_on_deletion(
    client: TestClient,
) -> None:
    skill = new_skill(client)
    first = new_category(client, name="Une", skill_ids=[skill["id"]])
    second = new_category(client, name="Deux")
    attached = client.put(f"{CATEGORIES}/{second['id']}/skills", json={"skill_ids": [skill["id"]]})
    assert attached.status_code == 200, attached.text

    assert [item["id"] for item in first["skills"]] == [skill["id"]]
    assert [item["id"] for item in attached.json()["skills"]] == [skill["id"]]
    assert client.get(f"{SKILLS}/{skill['id']}").json()["categories_count"] == 2

    edited = client.put(
        f"{SKILLS}/{skill['id']}", json={"name": "Sources citées", "content": "Nouvelle règle."}
    )
    assert edited.json()["content"] == "Nouvelle règle."
    duplicate = client.post(SKILLS, json={"name": "SOURCES citées", "content": "x"})
    assert duplicate.status_code == 409

    assert client.delete(f"{SKILLS}/{skill['id']}").status_code == 204
    assert client.get(f"{CATEGORIES}/{first['id']}").json()["skills"] == []
    unknown = client.put(
        f"{CATEGORIES}/{first['id']}/skills", json={"skill_ids": [str(uuid.uuid4())]}
    )
    assert unknown.status_code == 422


# --- inheritance ---------------------------------------------------------------------------------


def category_body(category: dict[str, Any], **changes: Any) -> dict[str, Any]:
    body = {
        "name": category["name"],
        "icon": category["icon"],
        "color": category["color"],
        "general_prompt": category["general_prompt"],
        "skill_ids": [skill["id"] for skill in category["skills"]],
    }
    return {**body, **changes}


def test_a_mission_without_a_consigne_inherits_its_category_and_follows_its_edits(
    client: TestClient,
) -> None:
    skill = new_skill(client)
    category = new_category(client, skill_ids=[skill["id"]])

    mission = new_mission(client, category_id=category["id"])

    assert mission["prompt"] == category["general_prompt"]
    assert mission["card"]["type"] == "prospection"
    assert mission["card"]["category"] == {
        "id": category["id"],
        "key": None,
        "name": category["name"],
        "icon": "radar",
        "color": "#112233",
    }
    assert mission["inheritance"]["overridden_fields"] == []
    assert mission["inheritance"]["prompt_inherited"] and mission["inheritance"]["skills_inherited"]
    assert [item["id"] for item in mission["skills"]] == [skill["id"]]

    client.put(
        f"{CATEGORIES}/{category['id']}",
        json=category_body(
            category, general_prompt="Prompt révisé.", color="#445566", skill_ids=[]
        ),
    )
    followed = client.get(f"{MISSIONS}/{mission['card']['id']}").json()
    assert followed["prompt"] == "Prompt révisé."
    assert followed["card"]["category"]["color"] == "#445566"
    assert followed["skills"] == []


def test_an_explicit_override_survives_category_edits(client: TestClient) -> None:
    skill = new_skill(client)
    other_skill = new_skill(client, "Ton sobre")
    category = new_category(client, skill_ids=[skill["id"]])
    mission = new_mission(
        client,
        category_id=category["id"],
        prompt="Consigne propre à cette mission.",
        skill_ids=[other_skill["id"]],
    )
    assert sorted(mission["inheritance"]["overridden_fields"]) == ["prompt", "skills"]

    client.put(
        f"{CATEGORIES}/{category['id']}",
        json=category_body(category, general_prompt="Prompt révisé.", skill_ids=[]),
    )

    after = client.get(f"{MISSIONS}/{mission['card']['id']}").json()
    assert after["prompt"] == "Consigne propre à cette mission."
    assert [item["id"] for item in after["skills"]] == [other_skill["id"]]
    assert after["inheritance"]["category_prompt"] == "Prompt révisé."


def test_an_override_equal_to_the_category_text_is_still_an_override(client: TestClient) -> None:
    category = new_category(client)
    mission = new_mission(client, category_id=category["id"], prompt=category["general_prompt"])
    assert mission["inheritance"]["overridden_fields"] == ["prompt"]

    client.put(
        f"{CATEGORIES}/{category['id']}", json=category_body(category, general_prompt="Révisé.")
    )

    assert (
        client.get(f"{MISSIONS}/{mission['card']['id']}").json()["prompt"]
        == category["general_prompt"]
    )


def edit_body(mission: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "name": mission["card"]["name"],
        "type": mission["card"]["type"],
        "prompt": mission["prompt"],
        "result_kind": mission["result_kind"],
        **changes,
    }


def test_editing_a_mission_keeps_inherited_fields_inherited_and_can_reset_an_override(
    client: TestClient,
) -> None:
    category = new_category(client)
    mission = new_mission(client, category_id=category["id"])
    mission_id = mission["card"]["id"]

    # The whole form is resubmitted with the text it read: nothing becomes an override.
    resubmitted = client.put(f"{MISSIONS}/{mission_id}", json=edit_body(mission, name="Renommée"))
    assert resubmitted.status_code == 200, resubmitted.text
    assert resubmitted.json()["inheritance"]["overridden_fields"] == []

    overridden = client.put(
        f"{MISSIONS}/{mission_id}", json=edit_body(mission, prompt="Ma consigne.")
    ).json()
    assert overridden["inheritance"]["overridden_fields"] == ["prompt"]

    # A request that does not mention the prompt leaves it overridden.
    untouched = client.put(
        f"{MISSIONS}/{mission_id}",
        json={k: v for k, v in edit_body(mission).items() if k != "prompt"},
    ).json()
    assert untouched["prompt"] == "Ma consigne."
    assert untouched["inheritance"]["overridden_fields"] == ["prompt"]

    # `prompt: null` goes back to following the category.
    reset = client.put(f"{MISSIONS}/{mission_id}", json=edit_body(mission, prompt=None)).json()
    assert reset["prompt"] == category["general_prompt"]
    assert reset["inheritance"]["overridden_fields"] == []


def test_a_mission_can_move_to_another_category_and_follows_it(client: TestClient) -> None:
    first = new_category(client, name="Première", general_prompt="Prompt un.")
    second = new_category(client, name="Seconde", general_prompt="Prompt deux.", icon="pencil")
    mission = new_mission(client, category_id=first["id"])

    moved = client.put(
        f"{MISSIONS}/{mission['card']['id']}",
        json={
            "name": "Veille Normandie",
            "category_id": second["id"],
            "result_kind": "companies",
        },
    )

    assert moved.status_code == 200, moved.text
    assert moved.json()["card"]["category"]["id"] == second["id"]
    assert moved.json()["prompt"] == "Prompt deux."


def test_the_technical_type_comes_from_the_category_and_must_not_contradict_it(
    client: TestClient, db_session: Session
) -> None:
    category = new_category(client, mission_type="enrichment")
    target = [{"kind": "company", "id": str(add_company(db_session).id)}]
    mission = new_mission(
        client, category_id=category["id"], targets=target, result_kind="enrichment"
    )
    assert mission["card"]["type"] == "enrichment"

    refused = client.post(
        MISSIONS,
        json={"name": "X", "category_id": category["id"], "type": "signals", "targets": []},
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "category_mismatch"

    nothing = client.post(MISSIONS, json={"name": "X", "targets": []})
    assert nothing.status_code == 422
    assert nothing.json()["detail"]["field"] == "category_id"


def test_a_bare_type_resolves_to_its_built_in_category(
    client: TestClient, db_session: Session
) -> None:
    target = [{"kind": "company", "id": str(add_company(db_session).id)}]
    mission = new_mission(
        client,
        type="enrichment",
        prompt="Complète les fiches.",
        targets=target,
        result_kind="enrichment",
    )

    assert mission["card"]["category"]["key"] == "enrichment"
    row = db_session.get(Mission, uuid.UUID(mission["card"]["id"]))
    assert row is not None and row.type is MissionType.ENRICHMENT
    category = db_session.get(MissionCategory, row.category_id)
    assert category is not None and category.mission_type is MissionType.ENRICHMENT
    assert row.overridden_fields == ["prompt"]


def test_propagating_a_category_prompt_is_audited_per_mission(
    client: TestClient, db_session: Session
) -> None:
    category = new_category(client)
    mission = new_mission(client, category_id=category["id"])
    client.put(
        f"{CATEGORIES}/{category['id']}", json=category_body(category, general_prompt="Révisé.")
    )

    events = audit_events(db_session, action="mission.updated")
    assert [event.entity_id for event in events] == [uuid.UUID(mission["card"]["id"])]
    assert events[0].context["reason"] == "category default propagated"


# --- the mission-creator prompt ------------------------------------------------------------------


def test_the_mission_creator_prompt_has_a_default_an_override_and_a_reset(
    client: TestClient,
) -> None:
    initial = client.get(f"{MISSIONS}/creator-prompt").json()
    assert initial["is_default"] is True and initial["source"] == "default"
    assert initial["prompt"] == initial["default"] and initial["prompt"]

    version = client.get(INTEGRATIONS).json()["version"]
    saved = client.put(
        INTEGRATIONS, json={"version": version, "mission_creator_prompt": "  Sois bref.  "}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["fields"]["mission_creator_prompt"]["value"] == "Sois bref."
    assert saved.json()["mission_creator_prompt_default"] == initial["default"]
    # The worker-side category prompts and the contact prompt are unaffected.
    assert saved.json()["fields"]["contact_initial_prompt"]["value"] is None

    overridden = client.get(f"{MISSIONS}/creator-prompt").json()
    assert (overridden["prompt"], overridden["is_default"], overridden["source"]) == (
        "Sois bref.",
        False,
        "ui",
    )

    reset = client.put(
        INTEGRATIONS, json={"version": saved.json()["version"], "mission_creator_prompt": None}
    )
    assert reset.status_code == 200
    assert client.get(f"{MISSIONS}/creator-prompt").json()["is_default"] is True
    too_long = client.put(
        INTEGRATIONS,
        json={"version": reset.json()["version"], "mission_creator_prompt": "x" * 8001},
    )
    assert too_long.status_code == 422
