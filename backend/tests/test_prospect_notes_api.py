"""Prospect notes API and score in the editor view (prospect-contact-ux S1)."""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ProspectNote
from tests.builders import add_company, add_prospect, audit_events

PROSPECTS = "/api/prospects"


def notes_url(prospect_id: uuid.UUID, note_id: uuid.UUID | str = "") -> str:
    return f"{PROSPECTS}/{prospect_id}/notes" + (f"/{note_id}" if note_id else "")


def make(client: TestClient, prospect_id: uuid.UUID, **body: Any) -> dict[str, Any]:
    response = client.post(notes_url(prospect_id), json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def view(client: TestClient, prospect_id: uuid.UUID) -> dict[str, Any]:
    response = client.get(f"{PROSPECTS}/{prospect_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_notes_need_a_session(anonymous_client: TestClient) -> None:
    url = notes_url(uuid.uuid4())

    assert anonymous_client.get(url).status_code == 401
    assert anonymous_client.post(url, json={"fact_text": "x"}).status_code == 401


def test_a_note_is_created_listed_newest_first_and_trimmed(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    undated = make(client, prospect.id, fact_text="  Sans   date  ")
    old = make(client, prospect.id, fact_text="Ancien", noted_on="2026-01-02")
    recent = make(
        client,
        prospect.id,
        fact_text="Récent",
        noted_on="2026-09-01",
        source_type="linkedin",
        source_label="Post du 1er sept.",
        score_delta=5,
    )

    listed = client.get(notes_url(prospect.id)).json()

    assert [note["id"] for note in listed] == [recent["id"], old["id"], undated["id"]]
    assert undated["fact_text"] == "Sans date"
    assert (recent["source_type"], recent["score_delta"]) == ("linkedin", 5)
    assert undated["score_delta"] is None and undated["noted_on"] is None


def test_a_note_can_be_updated_partially_and_optional_fields_cleared(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    note = make(client, prospect.id, fact_text="Fait", source_label="Appel", score_delta=10)

    changed = client.patch(
        notes_url(prospect.id, note["id"]), json={"fact_text": "Fait corrigé", "score_delta": None}
    )

    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert (body["fact_text"], body["score_delta"], body["source_label"]) == (
        "Fait corrigé",
        None,
        "Appel",
    )


def test_a_note_is_deleted_and_audited(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    note = make(client, prospect.id, fact_text="À retirer")

    assert client.delete(notes_url(prospect.id, note["id"])).status_code == 204

    assert client.get(notes_url(prospect.id)).json() == []
    actions = [entry.action for entry in audit_events(db_session)]
    assert "prospect_note.created" in actions
    assert "prospect_note.deleted" in actions


def test_refusals_use_the_stable_codes(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    other = add_prospect(db_session, add_company(db_session))
    note = make(client, prospect.id, fact_text="Fait")
    url = notes_url(prospect.id)

    blank = client.post(url, json={"fact_text": "   "})
    too_big = client.post(url, json={"fact_text": "x", "score_delta": 51})
    unknown_field = client.post(url, json={"fact_text": "x", "score": 3})
    clearing = client.patch(notes_url(prospect.id, note["id"]), json={"fact_text": None})
    wrong_owner = client.patch(notes_url(other.id, note["id"]), json={"fact_text": "y"})
    no_prospect = client.get(notes_url(uuid.uuid4()))
    no_note = client.delete(notes_url(prospect.id, uuid.uuid4()))

    assert blank.status_code == 422
    assert blank.json()["detail"]["field"] == "fact_text"
    assert too_big.status_code == 422
    assert unknown_field.status_code == 422
    assert clearing.status_code == 422
    assert clearing.json()["detail"]["reason"] == "blank"
    assert wrong_owner.status_code == 404
    assert no_prospect.status_code == 404
    assert no_prospect.json()["detail"]["code"] == "not_found"
    assert no_note.status_code == 404


def test_a_long_fact_is_refused_with_the_length_reason(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    response = client.post(notes_url(prospect.id), json={"fact_text": "x" * 1001})

    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "length"


def test_the_prospect_view_carries_a_backend_computed_score(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    empty = view(client, prospect.id)["score"]
    first = make(client, prospect.id, fact_text="a liké un post", score_delta=5)
    make(client, prospect.id, fact_text="faible pertinence du poste", score_delta=-8)
    make(client, prospect.id, fact_text="simple remarque")

    score = view(client, prospect.id)["score"]

    assert (empty["total"], empty["band"], empty["contributions"]) == (50, "yellow", [])
    assert (score["total"], score["band"]) == (47, "yellow")
    assert {item["delta"] for item in score["contributions"]} == {5, -8}
    liked = next(item for item in score["contributions"] if item["source_ref"] == first["id"])
    assert (liked["reason"], liked["origin"], liked["source_type"]) == (
        "a liké un post",
        "manual",
        "note",
    )


def test_a_note_write_does_not_make_the_open_editor_stale(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    before = view(client, prospect.id)["version"]

    make(client, prospect.id, fact_text="Fait", score_delta=10)

    assert view(client, prospect.id)["version"] == before


def test_deleting_a_prospect_deletes_its_notes(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    make(client, prospect.id, fact_text="Fait", score_delta=10)
    version = view(client, prospect.id)["version"]

    response = client.delete(f"{PROSPECTS}/{prospect.id}", params={"version": version})

    assert response.status_code == 204, response.text
    assert db_session.scalar(select(func.count()).select_from(ProspectNote)) == 0
