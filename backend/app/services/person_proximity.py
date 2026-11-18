"""Proximity score: how directly Circoe members can reach a prospect through the person-link graph.

CANONICAL and the only proximity/path scoring implementation (decision 2026-11, task
viper_prospect_sheet_missions_scoring_redesign S3). Deterministic, no LLM. It reads `person_links`
and is NOT an input of the commercial-fit score (`prospect_score.py`): the two never mix.
Contract and formula: doc/features/proximity-score.md. Computed on every read from the live links,
so any link edit (create/patch/delete) is reflected by the next read: nothing is cached or stored.

Formula (FORMULA_VERSION 1):
  edge        = link score 0-100 (0 = ignored)
  path        = member -> ... -> prospect, at most MAX_HOPS links, simple, and it never crosses
                another member (a path ends at the first member met from the prospect)
  path score  = 100 * prod(edge/100) * HOP_FACTOR[hops]   (1 hop 1.00, 2 hops 0.60, 3 hops 0.35)
  score       = 100 * (1 - (1 - best) * prod(1 - CORROBORATION * other_i)), best/other_i in 0-1,
                over the best path and up to CORROBORATION_PATHS other paths (best first)
So a lone 100 link gives 100; a lone 50 link gives 50; a lone 100-100 two-hop path gives 60; extra
independent paths raise the score but never above 100.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.person_links import PersonLink
from app.models.prospects import Prospect
from app.services.errors import NotFoundError
from app.services.person_links import Person, PersonView, people_views, sides

logger = logging.getLogger(__name__)

FORMULA_VERSION = 1
MAX_HOPS = 3
HOP_FACTOR = {1: 1.0, 2: 0.6, 3: 0.35}
CORROBORATION = 0.3
CORROBORATION_PATHS = 4
SHOWN_PATHS = 3
# Safety bounds on a dense graph: links read, and paths enumerated, per request.
LINK_LIMIT = 5000
PATH_LIMIT = 500

State = Literal["reachable", "unreachable", "empty"]


@dataclass(frozen=True)
class PathEdge:
    a: PersonView
    b: PersonView
    relation: str
    score: int


@dataclass(frozen=True)
class ProximityPath:
    member: PersonView
    hops: int
    strength: int  # 0-100, the path score above
    people: list[PersonView]  # member first, prospect last
    edges: list[PathEdge]


@dataclass(frozen=True)
class ProximityMember:
    member: PersonView
    strength: int  # best path of that member


@dataclass(frozen=True)
class Proximity:
    prospect_id: uuid.UUID
    score: int
    state: State
    path_count: int
    members: list[ProximityMember]
    paths: list[ProximityPath]  # the best SHOWN_PATHS
    formula_version: int
    max_hops: int


@dataclass(frozen=True)
class _Edge:
    other: Person
    link_id: uuid.UUID
    relation: str
    score: int


@dataclass(frozen=True)
class _RawPath:
    nodes: tuple[Person, ...]  # prospect first, member last
    edges: tuple[_Edge, ...]
    strength: float  # 0-1


def path_strength(edge_scores: list[int]) -> float:
    """0-1 strength of one path: product of its edge strengths times the hop factor."""
    value = HOP_FACTOR[len(edge_scores)]
    for score in edge_scores:
        value *= score / 100
    return value


def aggregate(strengths: list[float]) -> int:
    """0-100 score from path strengths (0-1): best path, then diminishing corroboration."""
    if not strengths:
        return 0
    ordered = sorted(strengths, reverse=True)
    remaining = 1 - ordered[0]
    for other in ordered[1 : 1 + CORROBORATION_PATHS]:
        remaining *= 1 - CORROBORATION * other
    return round(100 * (1 - remaining))


def _adjacency(session: Session) -> dict[Person, list[_Edge]]:
    adjacency: dict[Person, list[_Edge]] = {}
    links = session.scalars(
        select(PersonLink).where(PersonLink.score > 0).order_by(PersonLink.id).limit(LINK_LIMIT)
    )
    for link in links:
        first, second = sides(link)
        adjacency.setdefault(first, []).append(_Edge(second, link.id, link.relation, link.score))
        adjacency.setdefault(second, []).append(_Edge(first, link.id, link.relation, link.score))
    return adjacency


def _paths(start: Person, adjacency: dict[Person, list[_Edge]]) -> list[_RawPath]:
    found: list[_RawPath] = []

    def walk(nodes: list[Person], edges: list[_Edge]) -> None:
        if len(found) >= PATH_LIMIT:
            return
        for edge in sorted(
            adjacency.get(nodes[-1], []), key=lambda e: (e.other.token, str(e.link_id))
        ):
            if edge.other in nodes:
                continue
            step_nodes, step_edges = [*nodes, edge.other], [*edges, edge]
            if edge.other.kind == "member":
                strength = path_strength([e.score for e in step_edges])
                found.append(_RawPath(tuple(step_nodes), tuple(step_edges), strength))
            elif len(step_edges) < MAX_HOPS:
                walk(step_nodes, step_edges)

    walk([start], [])
    return found


def proximity_of_prospect(session: Session, prospect_id: uuid.UUID) -> Proximity:
    if session.get(Prospect, prospect_id) is None:
        raise NotFoundError("The prospect does not exist.")
    start = Person("prospect", prospect_id)
    adjacency = _adjacency(session)
    if not adjacency.get(start):
        return Proximity(prospect_id, 0, "empty", 0, [], [], FORMULA_VERSION, MAX_HOPS)
    raw = _paths(start, adjacency)
    if not raw:
        return Proximity(prospect_id, 0, "unreachable", 0, [], [], FORMULA_VERSION, MAX_HOPS)

    # Best first; ties broken by fewer hops then by tokens so the output is deterministic.
    raw.sort(key=lambda p: (-p.strength, len(p.edges), [n.token for n in p.nodes]))
    shown = raw[:SHOWN_PATHS]
    best_by_member: dict[Person, float] = {}
    for path in raw:
        best_by_member.setdefault(path.nodes[-1], path.strength)
    needed = {node for path in shown for node in path.nodes} | set(best_by_member)
    views = people_views(session, needed)

    def present(path: _RawPath) -> bool:
        return all(node in views for node in path.nodes)

    paths = [
        ProximityPath(
            member=views[path.nodes[-1]],
            hops=len(path.edges),
            strength=round(100 * path.strength),
            people=[views[node] for node in reversed(path.nodes)],
            edges=[
                PathEdge(views[path.nodes[-i - 1]], views[path.nodes[-i - 2]], e.relation, e.score)
                for i, e in enumerate(reversed(path.edges))
            ],
        )
        for path in shown
        if present(path)
    ]
    members = [
        ProximityMember(views[member], round(100 * strength))
        for member, strength in best_by_member.items()
        if member in views
    ]
    score = aggregate([p.strength for p in raw])
    logger.info("proximity.computed prospect=%s score=%s paths=%s", prospect_id, score, len(raw))
    return Proximity(
        prospect_id, score, "reachable", len(raw), members, paths, FORMULA_VERSION, MAX_HOPS
    )
