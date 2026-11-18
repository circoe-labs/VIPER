"""Relational links between people (`/api/links`): who knows whom, and how well.

A link joins two people, each a prospect or a member of the organisation, with a relation label
(« frère », « amis »…) and a strength 0-100. `GET /links/graph` is the read model of the Prospection
graph; `GET /links/person/{kind}/{id}` lists the links of one person (a prospect's sheet).
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import person_links
from app.services.person_links import LinkView, Person, PersonView

router = APIRouter(prefix="/links", tags=["links"])

Kind = Literal["prospect", "member"]


class PersonOut(BaseModel):
    kind: Kind
    id: uuid.UUID
    name: str
    company_id: uuid.UUID | None
    company_name: str | None


class LinkOut(BaseModel):
    id: uuid.UUID
    a: PersonOut
    b: PersonOut
    relation: str
    score: int
    note: str | None


class PersonRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    id: uuid.UUID


class LinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a: PersonRef
    b: PersonRef
    relation: str = Field(max_length=200)
    score: int = Field(ge=0, le=100)
    note: str | None = Field(default=None, max_length=2000)


class LinkPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relation: str | None = Field(default=None, max_length=200)
    score: int | None = Field(default=None, ge=0, le=100)
    note: str | None = Field(default=None, max_length=2000)


class GraphCompanyOut(BaseModel):
    id: uuid.UUID | None
    name: str
    prospects: list[PersonOut]


class GraphOut(BaseModel):
    members: list[PersonOut]
    companies: list[GraphCompanyOut]
    links: list[LinkOut]


def person_out(person: PersonView) -> PersonOut:
    return PersonOut(
        kind=person.kind,
        id=person.id,
        name=person.name,
        company_id=person.company_id,
        company_name=person.company_name,
    )


def link_out(link: LinkView) -> LinkOut:
    return LinkOut(
        id=link.id,
        a=person_out(link.a),
        b=person_out(link.b),
        relation=link.relation,
        score=link.score,
        note=link.note,
    )


@router.get("/graph")
def get_graph(
    session: SessionDep,
    min_score: Annotated[int, Query(ge=0, le=100)] = 0,
    relation: Annotated[str | None, Query(max_length=200)] = None,
    company_id: uuid.UUID | None = None,
    include_unlinked: bool = False,
) -> GraphOut:
    with business_errors():
        graph = person_links.graph(
            session,
            min_score=min_score,
            relation=relation,
            company_id=company_id,
            include_unlinked=include_unlinked,
        )
    return GraphOut(
        members=[person_out(person) for person in graph.members],
        companies=[
            GraphCompanyOut(
                id=company.id,
                name=company.name,
                prospects=[person_out(person) for person in company.prospects],
            )
            for company in graph.companies
        ],
        links=[link_out(link) for link in graph.links],
    )


@router.get("/relations")
def list_relations(session: SessionDep) -> list[str]:
    """The relation labels already in use, most used first (suggestions)."""
    return person_links.relation_labels(session)


@router.get("/person/{kind}/{person_id}")
def links_of_person(kind: Kind, person_id: uuid.UUID, session: SessionDep) -> list[LinkOut]:
    return [link_out(link) for link in person_links.links_of(session, Person(kind, person_id))]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_link(body: LinkCreate, session: SessionDep, actor: CurrentActor) -> LinkOut:
    with business_errors():
        link = person_links.create_link(
            session,
            actor,
            Person(body.a.kind, body.a.id),
            Person(body.b.kind, body.b.id),
            body.relation,
            body.score,
            body.note,
        )
        return link_out(person_links.view_of(session, link))


@router.patch("/{link_id}")
def update_link(link_id: uuid.UUID, body: LinkPatch, session: SessionDep) -> LinkOut:
    sent = body.model_dump(exclude_unset=True)
    with business_errors():
        link = person_links.update_link(
            session,
            link_id,
            relation=body.relation,
            score=body.score,
            note=body.note,
            note_sent="note" in sent,
        )
        return link_out(person_links.view_of(session, link))


@router.delete("/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_link(link_id: uuid.UUID, session: SessionDep) -> None:
    with business_errors():
        person_links.delete_link(session, link_id)
