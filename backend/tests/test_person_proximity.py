"""Proximity score of a prospect from the members (`/api/links/proximity/prospect/{id}`)."""

import uuid
from itertools import pairwise
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.services.person_proximity import aggregate, path_strength
from tests.builders import add_prospect, referent_user
from tests.test_person_links import LINKS, make, member, prospect


def read(client: TestClient, prospect_id: uuid.UUID) -> Any:
    response = client.get(f"{LINKS}/proximity/prospect/{prospect_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_formula_pieces() -> None:
    assert path_strength([100]) == 1.0
    assert abs(path_strength([100, 100]) - 0.6) < 1e-9
    assert aggregate([]) == 0
    assert aggregate([0.5]) == 50
    assert aggregate([1.0, 1.0]) == 100


def test_unknown_prospect_is_404(client: TestClient) -> None:
    assert client.get(f"{LINKS}/proximity/prospect/{uuid.uuid4()}").status_code == 404


def test_no_link_is_empty(client: TestClient, db_session: Session) -> None:
    person = add_prospect(db_session)
    db_session.flush()

    body = read(client, person.id)

    assert (body["state"], body["score"], body["path_count"], body["paths"]) == ("empty", 0, 0, [])


def test_direct_strong_link(client: TestClient, db_session: Session) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    person = add_prospect(db_session)
    db_session.flush()
    make(client, prospect(person.id), member(robin.id), relation="frère", score=100)

    body = read(client, person.id)

    assert (body["state"], body["score"], body["path_count"]) == ("reachable", 100, 1)
    path = body["paths"][0]
    assert path["hops"] == 1 and path["strength"] == 100
    assert path["member"]["id"] == str(robin.id)
    assert [p["kind"] for p in path["people"]] == ["member", "prospect"]
    assert path["edges"][0]["relation"] == "frère"
    assert body["members"][0]["strength"] == 100


def test_multi_hop_is_penalised(client: TestClient, db_session: Session) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    middle = add_prospect(db_session, first_name="Paul")
    person = add_prospect(db_session, first_name="Anne")
    db_session.flush()
    make(client, member(robin.id), prospect(middle.id), score=100)
    make(client, prospect(middle.id), prospect(person.id), score=80)

    body = read(client, person.id)

    assert body["score"] == 48  # 100 * 1.0 * 0.8 * 0.6
    path = body["paths"][0]
    assert path["hops"] == 2
    assert [p["id"] for p in path["people"]] == [str(robin.id), str(middle.id), str(person.id)]
    assert [e["score"] for e in path["edges"]] == [100, 80]


def test_hops_beyond_the_limit_are_unreachable(client: TestClient, db_session: Session) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    chain = [add_prospect(db_session, first_name=f"P{i}") for i in range(4)]
    db_session.flush()
    make(client, member(robin.id), prospect(chain[0].id))
    for first, second in pairwise(chain):
        make(client, prospect(first.id), prospect(second.id))

    # chain[3] is 4 links from Robin; chain[2] is 3.
    body = read(client, chain[3].id)
    assert (body["state"], body["score"]) == ("unreachable", 0)
    assert read(client, chain[2].id)["paths"][0]["hops"] == 3


def test_multiple_paths_raise_the_score(client: TestClient, db_session: Session) -> None:
    robin = referent_user("Robin", "Pote")
    lea = referent_user("Léa", "Autre")
    db_session.add_all([robin, lea])
    person = add_prospect(db_session)
    db_session.flush()
    make(client, prospect(person.id), member(robin.id), score=60)
    alone = read(client, person.id)["score"]
    make(client, prospect(person.id), member(lea.id), score=50)

    body = read(client, person.id)

    assert alone == 60
    assert body["path_count"] == 2
    assert body["score"] == 66  # 100 * (1 - 0.4 * (1 - 0.3 * 0.5))
    assert {m["member"]["id"] for m in body["members"]} == {str(robin.id), str(lea.id)}


def test_links_not_reaching_a_member_are_unreachable(
    client: TestClient, db_session: Session
) -> None:
    first = add_prospect(db_session, first_name="Anne")
    second = add_prospect(db_session, first_name="Paul")
    db_session.flush()
    make(client, prospect(first.id), prospect(second.id), score=90)

    body = read(client, first.id)

    assert (body["state"], body["score"], body["paths"]) == ("unreachable", 0, [])


def test_link_edits_recompute(client: TestClient, db_session: Session) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    person = add_prospect(db_session)
    db_session.flush()
    link = make(client, prospect(person.id), member(robin.id), score=40).json()
    assert read(client, person.id)["score"] == 40

    client.patch(f"{LINKS}/{link['id']}", json={"score": 90})
    assert read(client, person.id)["score"] == 90

    client.patch(f"{LINKS}/{link['id']}", json={"score": 0})
    assert read(client, person.id)["state"] == "empty"

    client.patch(f"{LINKS}/{link['id']}", json={"score": 70})
    assert read(client, person.id)["score"] == 70
    client.delete(f"{LINKS}/{link['id']}")
    assert read(client, person.id)["state"] == "empty"


def test_proximity_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(f"{LINKS}/proximity/prospect/{uuid.uuid4()}").status_code == 401
