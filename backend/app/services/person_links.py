"""Relational links between people (prospects and members): rules and the graph read model.

A link joins two distinct people — each a prospect or a member — with a relation label and a
strength 0-100. It is undirected and unique per pair (`PersonLink.pair_key`). The graph groups the
prospects by company; a member stands on its own.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.companies import Company
from app.models.person_links import NOTE_MAX_LENGTH, RELATION_MAX_LENGTH, PersonLink
from app.models.prospects import Prospect
from app.models.users import User
from app.services.errors import InvalidFieldError, NotFoundError

logger = logging.getLogger(__name__)

Kind = Literal["prospect", "member"]
# Each company shows at most this many prospects in the graph (the linked ones always come first).
GRAPH_COMPANY_LIMIT = 40
GRAPH_LINK_LIMIT = 2000


@dataclass(frozen=True)
class Person:
    kind: Kind
    id: uuid.UUID

    @property
    def token(self) -> str:
        return f"{'p' if self.kind == 'prospect' else 'u'}:{self.id}"


@dataclass(frozen=True)
class PersonView:
    kind: Kind
    id: uuid.UUID
    name: str
    company_id: uuid.UUID | None
    company_name: str | None


@dataclass(frozen=True)
class LinkView:
    id: uuid.UUID
    a: PersonView
    b: PersonView
    relation: str
    score: int
    note: str | None


@dataclass(frozen=True)
class GraphCompany:
    id: uuid.UUID | None
    name: str
    prospects: list[PersonView]


@dataclass(frozen=True)
class Graph:
    members: list[PersonView]
    companies: list[GraphCompany]
    links: list[LinkView]


def pair_key(first: Person, second: Person) -> str:
    return "|".join(sorted((first.token, second.token)))


def _prospect_name(prospect: Prospect) -> str:
    name = f"{prospect.first_name or ''} {prospect.last_name or ''}".strip()
    return name or "Prospect sans nom"


def _people(session: Session, people: set[Person]) -> dict[Person, PersonView]:
    prospect_ids = [person.id for person in people if person.kind == "prospect"]
    member_ids = [person.id for person in people if person.kind == "member"]
    views: dict[Person, PersonView] = {}
    if prospect_ids:
        rows = session.execute(
            select(Prospect, Company.display_name)
            .outerjoin(Company, Company.id == Prospect.company_id)
            .where(Prospect.id.in_(prospect_ids))
        )
        for prospect, company_name in rows:
            views[Person("prospect", prospect.id)] = PersonView(
                "prospect", prospect.id, _prospect_name(prospect), prospect.company_id, company_name
            )
    if member_ids:
        for user in session.scalars(select(User).where(User.id.in_(member_ids))):
            views[Person("member", user.id)] = PersonView(
                "member", user.id, user.display_name, None, None
            )
    return views


def people_views(session: Session, people: set[Person]) -> dict[Person, PersonView]:
    """Public seam of `_people` for the proximity service."""
    return _people(session, people)


def _require_exists(session: Session, person: Person) -> None:
    model = Prospect if person.kind == "prospect" else User
    if session.get(model, person.id) is None:
        raise NotFoundError(f"The {person.kind} does not exist.")


def sides(link: PersonLink) -> tuple[Person, Person]:
    def side(prospect_id: uuid.UUID | None, user_id: uuid.UUID | None) -> Person:
        if prospect_id is not None:
            return Person("prospect", prospect_id)
        assert user_id is not None
        return Person("member", user_id)

    return side(link.a_prospect_id, link.a_user_id), side(link.b_prospect_id, link.b_user_id)


def _relation(value: str) -> str:
    text = " ".join(value.split())
    if not text:
        raise InvalidFieldError("relation", "The relation must not be blank.", "blank")
    if len(text) > RELATION_MAX_LENGTH:
        raise InvalidFieldError("relation", "The relation is too long.", "too_long")
    return text


def _score(value: int) -> int:
    if not 0 <= value <= 100:
        raise InvalidFieldError("score", "The score is between 0 and 100.", "range")
    return value


def _note(value: str | None) -> str | None:
    text = (value or "").strip()
    if len(text) > NOTE_MAX_LENGTH:
        raise InvalidFieldError("note", "The note is too long.", "too_long")
    return text or None


def _author(actor: ActorContext) -> uuid.UUID | None:
    try:
        return uuid.UUID(actor.id) if actor.id else None
    except ValueError:
        return None


def create_link(
    session: Session,
    actor: ActorContext,
    first: Person,
    second: Person,
    relation: str,
    score: int,
    note: str | None,
) -> PersonLink:
    if first == second:
        raise InvalidFieldError("target", "A person cannot be linked to themselves.", "self")
    _require_exists(session, first)
    _require_exists(session, second)
    link = PersonLink(
        a_prospect_id=first.id if first.kind == "prospect" else None,
        a_user_id=first.id if first.kind == "member" else None,
        b_prospect_id=second.id if second.kind == "prospect" else None,
        b_user_id=second.id if second.kind == "member" else None,
        pair_key=pair_key(first, second),
        relation=_relation(relation),
        score=_score(score),
        note=_note(note),
        created_by_user_id=_author(actor),
    )
    try:
        with session.begin_nested():
            session.add(link)
            session.flush()
    except IntegrityError as error:
        raise InvalidFieldError(
            "target", "These two people are already linked.", "duplicate"
        ) from error
    logger.info("person_link.created link=%s", link.id)
    return link


def get_link(session: Session, link_id: uuid.UUID) -> PersonLink:
    link = session.get(PersonLink, link_id)
    if link is None:
        raise NotFoundError("The link does not exist.")
    return link


def update_link(
    session: Session,
    link_id: uuid.UUID,
    *,
    relation: str | None = None,
    score: int | None = None,
    note: str | None = None,
    note_sent: bool = False,
) -> PersonLink:
    link = get_link(session, link_id)
    if relation is not None:
        link.relation = _relation(relation)
    if score is not None:
        link.score = _score(score)
    if note_sent:
        link.note = _note(note)
    session.flush()
    return link


def delete_link(session: Session, link_id: uuid.UUID) -> None:
    session.delete(get_link(session, link_id))
    session.flush()
    logger.info("person_link.deleted link=%s", link_id)


def view_of(session: Session, link: PersonLink) -> LinkView:
    return _views(session, [link])[0]


def _views(session: Session, links: list[PersonLink]) -> list[LinkView]:
    people: set[Person] = set()
    for link in links:
        people.update(sides(link))
    known = _people(session, people)
    views = []
    for link in links:
        first, second = sides(link)
        if first in known and second in known:
            views.append(
                LinkView(link.id, known[first], known[second], link.relation, link.score, link.note)
            )
    return views


def links_of(session: Session, person: Person) -> list[LinkView]:
    column_a = PersonLink.a_prospect_id if person.kind == "prospect" else PersonLink.a_user_id
    column_b = PersonLink.b_prospect_id if person.kind == "prospect" else PersonLink.b_user_id
    links = session.scalars(
        select(PersonLink)
        .where(or_(column_a == person.id, column_b == person.id))
        .order_by(PersonLink.score.desc(), PersonLink.created_at)
    ).all()
    return _views(session, list(links))


def relation_labels(session: Session) -> list[str]:
    """The relation labels already used, most used first: suggestions for the next link."""
    rows = session.execute(
        select(PersonLink.relation, func.count())
        .group_by(PersonLink.relation)
        .order_by(func.count().desc(), PersonLink.relation)
    )
    return [relation for relation, _ in rows]


def graph(
    session: Session,
    *,
    min_score: int = 0,
    relation: str | None = None,
    company_id: uuid.UUID | None = None,
    include_unlinked: bool = False,
) -> Graph:
    """The links above `min_score`, the people they join, and the prospects grouped by company.

    A company appears when one of its prospects is linked (or is the `company_id` asked for). Its
    other prospects are listed only with `include_unlinked` (or when that company is asked for).
    """
    statement = select(PersonLink).where(PersonLink.score >= min_score)
    if relation:
        statement = statement.where(PersonLink.relation == relation)
    links = list(
        session.scalars(statement.order_by(PersonLink.score.desc()).limit(GRAPH_LINK_LIMIT))
    )
    views = _views(session, links)
    if company_id is not None:
        views = [link for link in views if company_id in (link.a.company_id, link.b.company_id)]
    linked: dict[Person, PersonView] = {}
    for link in views:
        for person in (link.a, link.b):
            linked[Person(person.kind, person.id)] = person
    members = [person for person in linked.values() if person.kind == "member"]

    groups: dict[uuid.UUID | None, GraphCompany] = {}
    for person in linked.values():
        if person.kind != "prospect":
            continue
        group = groups.setdefault(
            person.company_id, GraphCompany(person.company_id, person.company_name or "Sans société", [])
        )
        group.prospects.append(person)
    wanted = {key for key in groups if key is not None}
    if company_id is not None:
        wanted.add(company_id)
    if include_unlinked or company_id is not None:
        for key in wanted:
            company = session.get(Company, key)
            if company is None:
                continue
            group = groups.setdefault(key, GraphCompany(key, company.display_name, []))
            present = [person.id for person in group.prospects]
            others = session.scalars(
                select(Prospect)
                .where(Prospect.company_id == key, Prospect.id.not_in(present))
                .order_by(Prospect.last_name, Prospect.first_name)
                .limit(max(0, GRAPH_COMPANY_LIMIT - len(group.prospects)))
            )
            for prospect in others:
                group.prospects.append(
                    PersonView(
                        "prospect", prospect.id, _prospect_name(prospect), key, company.display_name
                    )
                )
    companies = sorted(groups.values(), key=lambda group: group.name.lower())
    return Graph(members, companies, views)
