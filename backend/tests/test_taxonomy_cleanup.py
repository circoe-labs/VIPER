"""« Nettoyer » a taxonomy: the AI proposes groups, a person edits them, the merge is applied."""

import json
import uuid
from typing import Any

import httpx2
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Prospect, Role
from tests.builders import add_prospect, add_role

INTEGRATIONS = "/api/settings/integrations"
ROLES = "/api/settings/roles"


def enable(app: FastAPI, client: TestClient, groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Configure the AI and answer every request with `groups`; returns the requests received."""
    version = client.get(INTEGRATIONS).json()["version"]
    saved = client.put(
        INTEGRATIONS,
        json={
            "version": version,
            "openai_api_key": "sk-fake",
            "openai_model": "fake-1",
            "openai_base_url": "http://127.0.0.1:9/v1",
        },
    )
    assert saved.status_code == 200, saved.text
    received: list[dict[str, Any]] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        received.append(json.loads(request.content))
        text = json.dumps({"groups": groups})
        output = [{"type": "message", "content": [{"type": "output_text", "text": text}]}]
        return httpx2.Response(
            200, json={"status": "completed", "model": "fake-1", "output": output}
        )

    app.state.openai_transport = httpx2.MockTransport(handle)
    return received


def test_proposal_is_checked_and_completed_without_writing(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    drh = add_role(db_session, "dir-rh", "Dir R.Humaine")
    other = add_role(db_session, "directeur-rh", "directeur RH")
    alone = add_role(db_session, "commercial", "Commercial")
    answer = [
        {"label": "DRH", "ids": [str(drh.id), str(other.id), str(uuid.uuid4())]},
        {"label": "Doublon", "ids": [str(drh.id)]},
    ]  # `alone` is forgotten, an unknown id and a repeated one are given
    requests = enable(app, client, answer)

    response = client.post(f"{ROLES}/cleanup/proposal")

    assert response.status_code == 200, response.text
    groups = {group["label"]: group for group in response.json()["groups"]}
    assert [member["label"] for member in groups["DRH"]["members"]] == [
        "Dir R.Humaine",
        "directeur RH",
    ]
    assert [member["id"] for member in groups["Commercial"]["members"]] == [str(alone.id)]
    assert "Doublon" not in groups
    sent = requests[0]
    assert "DRH" in sent["instructions"]  # the default prompt is the instructions
    assert str(drh.id) in sent["input"]
    assert db_session.scalar(select(Role).where(Role.id == drh.id)).label == "Dir R.Humaine"


def test_apply_renames_merges_and_moves_the_references(
    client: TestClient, db_session: Session
) -> None:
    drh = add_role(db_session, "dir-rh", "Dir R.Humaine")
    other = add_role(db_session, "directeur-rh", "directeur RH")
    person_a = add_prospect(db_session, role_id=drh.id, first_name="A")
    person_b = add_prospect(db_session, role_id=other.id, first_name="B")
    person_c = add_prospect(db_session, role_id=other.id, first_name="C")
    db_session.flush()
    drh_id, other_id = drh.id, other.id
    prospect_ids = [person_a.id, person_b.id, person_c.id]

    response = client.post(
        f"{ROLES}/cleanup/apply",
        json={"groups": [{"label": "DRH", "ids": [str(drh_id), str(other_id)]}]},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"renamed": 1, "merged": 1, "moved": 1}
    db_session.expire_all()
    # The most used value is kept (and renamed); the other is gone; everyone points at the kept one.
    assert db_session.scalar(select(Role).where(Role.id == drh_id)) is None
    kept = db_session.scalar(select(Role).where(Role.id == other_id))
    assert kept is not None and kept.label == "DRH"
    roles = set(db_session.scalars(select(Prospect.role_id).where(Prospect.id.in_(prospect_ids))))
    assert roles == {other_id}


def test_apply_refuses_two_groups_with_the_same_final_label(
    client: TestClient, db_session: Session
) -> None:
    first = add_role(db_session, "a", "Alpha")
    second = add_role(db_session, "b", "Beta")

    response = client.post(
        f"{ROLES}/cleanup/apply",
        json={
            "groups": [
                {"label": "Même", "ids": [str(first.id)]},
                {"label": "même", "ids": [str(second.id)]},
            ]
        },
    )

    assert response.status_code == 422, response.text
    db_session.expire_all()
    assert db_session.get(Role, first.id).label == "Alpha"


def test_proposal_needs_the_ai_to_be_configured(client: TestClient, db_session: Session) -> None:
    add_role(db_session)
    response = client.post(f"{ROLES}/cleanup/proposal")
    assert response.status_code in (409, 422, 503), response.text
    assert "ai_not_configured" in response.text
