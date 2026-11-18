"""Relational links between prospects and members (`/api/links`)."""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.builders import add_company, add_prospect, referent_user

LINKS = "/api/links"


def make(client: TestClient, a: dict[str, Any], b: dict[str, Any], **body: Any) -> Any:
    payload = {"a": a, "b": b, "relation": "frère", "score": 100, **body}
    return client.post(LINKS, json=payload)


def prospect(id_: uuid.UUID) -> dict[str, Any]:
    return {"kind": "prospect", "id": str(id_)}


def member(id_: uuid.UUID) -> dict[str, Any]:
    return {"kind": "member", "id": str(id_)}


def test_links_need_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(f"{LINKS}/graph").status_code == 401


def test_a_link_between_a_prospect_and_a_member_reads_from_both_sides(
    client: TestClient, db_session: Session
) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    person = add_prospect(db_session, first_name="Anne", last_name="Martin")
    db_session.flush()

    created = make(client, prospect(person.id), member(robin.id), relation="frère", score=100)

    assert created.status_code == 201, created.text
    assert created.json()["score"] == 100
    for kind, id_ in (("prospect", person.id), ("member", robin.id)):
        listed = client.get(f"{LINKS}/person/{kind}/{id_}").json()
        assert [(link["relation"], link["score"]) for link in listed] == [("frère", 100)]


def test_a_pair_is_linked_once_whichever_side_comes_first(
    client: TestClient, db_session: Session
) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    person = add_prospect(db_session)
    db_session.flush()
    assert make(client, prospect(person.id), member(robin.id)).status_code == 201

    again = make(client, member(robin.id), prospect(person.id), relation="amis")

    assert again.status_code == 422
    assert again.json()["detail"]["reason"] == "duplicate"


def test_invalid_links_are_refused(client: TestClient, db_session: Session) -> None:
    person = add_prospect(db_session)
    db_session.flush()

    assert make(client, prospect(person.id), prospect(person.id)).status_code == 422
    assert make(client, prospect(person.id), member(uuid.uuid4())).status_code == 404
    other = add_prospect(db_session, first_name="Paul")
    db_session.flush()
    assert make(client, prospect(person.id), prospect(other.id), relation="  ").status_code == 422
    assert make(client, prospect(person.id), prospect(other.id), score=101).status_code == 422


def test_a_link_is_edited_and_deleted(client: TestClient, db_session: Session) -> None:
    first = add_prospect(db_session, first_name="Anne")
    second = add_prospect(db_session, first_name="Paul")
    db_session.flush()
    link = make(client, prospect(first.id), prospect(second.id), score=40).json()

    edited = client.patch(f"{LINKS}/{link['id']}", json={"score": 78, "relation": "amis"})

    assert (edited.json()["score"], edited.json()["relation"]) == (78, "amis")
    assert client.delete(f"{LINKS}/{link['id']}").status_code == 204
    assert client.delete(f"{LINKS}/{link['id']}").status_code == 404
    assert client.get(f"{LINKS}/person/prospect/{first.id}").json() == []


def test_the_graph_groups_linked_prospects_by_company_and_filters(
    client: TestClient, db_session: Session
) -> None:
    robin = referent_user("Robin", "Pote")
    db_session.add(robin)
    acme = add_company(db_session, display_name="Acme Transports")
    anne = add_prospect(db_session, acme, first_name="Anne")
    add_prospect(db_session, acme, first_name="Sans lien")
    paul = add_prospect(db_session, first_name="Paul")
    db_session.flush()
    make(client, prospect(anne.id), member(robin.id), relation="frère", score=100)
    make(client, prospect(paul.id), member(robin.id), relation="amis", score=30)

    full = client.get(f"{LINKS}/graph").json()
    strong = client.get(f"{LINKS}/graph", params={"min_score": 50}).json()
    friends = client.get(f"{LINKS}/graph", params={"relation": "amis"}).json()
    with_all = client.get(f"{LINKS}/graph", params={"include_unlinked": "true"}).json()

    assert [company["name"] for company in full["companies"]] == ["Acme Transports", "Sans société"]
    assert [person["name"] for person in full["companies"][0]["prospects"]] == ["Anne Test"]
    assert [member_["name"] for member_ in full["members"]] == ["Robin Pote"]
    assert len(full["links"]) == 2
    assert [link["relation"] for link in strong["links"]] == ["frère"]
    assert [link["relation"] for link in friends["links"]] == ["amis"]
    assert len(with_all["companies"][0]["prospects"]) == 2
    assert client.get(f"{LINKS}/relations").json() == ["amis", "frère"]
