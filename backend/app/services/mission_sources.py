"""External source library, category default sources and evidence effectiveness.

Task `viper_mission_agent_configuration_v2`, Slice 02. Contract:
`doc/architecture/missions.md` § « Bibliothèque de sources, contexte interne et preuves ».

**Library.** A `MissionSource` is a reusable external research source: a *root* (LinkedIn) or one
level of *sub-source* under it (LinkedIn > Jobs). Its `domain` / `path_prefix` (normalised from the
saved URL) are what a cited URL is matched against: a concrete URL never becomes a library row, it
rolls up to the most specific entry that covers it (`resolve_source`) and stays stored as evidence.

**Defaults and inheritance.** A category offers default sources (`mission_category_sources`); a
mission follows them until `sources` is in `Mission.overridden_fields`, when its own links
(`mission_source_links`) win. Same mechanism as skills (`mission_categories.apply_inheritance`).

**Effectiveness.** A source's counter measures *successful contribution*, never visits: when a
person accepts a result item, every library source that one of the item's cited URLs rolls up to
is credited **once** for that (result, item) event. `mission_source_contributions` holds the events
under a unique key and `MissionSource.successful_uses` is recomputed from it, so resubmission,
rebuild or a second call cannot inflate it. Internal context references are not evidence and never
count (they live in `mission_context`).

Operations flush; the caller owns the transaction.
"""

import logging
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from urllib.parse import urlsplit

from pydantic import ValidationError
from sqlalchemy import delete as sql_delete
from sqlalchemy import distinct, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.enums import AgentTaskType
from app.models.mission_categories import MissionCategory
from app.models.mission_sources import (
    CITATION_ITEM_KEY_MAX_LENGTH,
    CITATION_QUOTE_MAX_LENGTH,
    CITATION_URL_MAX_LENGTH,
    MissionCategorySource,
    MissionEvidenceCitation,
    MissionSourceContribution,
)
from app.models.missions import (
    SOURCE_DESCRIPTION_MAX_LENGTH,
    SOURCE_DOMAIN_MAX_LENGTH,
    SOURCE_LABEL_MAX_LENGTH,
    SOURCE_PATH_MAX_LENGTH,
    SOURCE_URL_MAX_LENGTH,
    Mission,
    MissionRun,
    MissionSource,
    MissionSourceLink,
)
from app.services.agent_payloads import Evidence
from app.services.errors import InUseError, InvalidFieldError, NotFoundError
from app.services.mission_output import LIST_FIELDS

logger = logging.getLogger(__name__)

SOURCES_FIELD = "sources"
SORT_ORDERS = ("recent", "name", "uses")
# Keys of proposal items that come from a list of the raw result (`person:2:…`, `company:0:…`).
_INDEXED_KEY = re.compile(r"^(?:person|company|signal):(\d+):")


@dataclass(frozen=True, slots=True)
class SourceRef:
    """What a mission or a category shows of a source: enough to display and to brief an agent."""

    id: uuid.UUID
    url: str
    label: str | None


@dataclass(frozen=True, slots=True)
class SourceRow:
    id: uuid.UUID
    url: str
    label: str | None
    description: str | None
    domain: str
    path_prefix: str
    # NULL = a root. `is_root` and `children_count` let the UI nest a flat list.
    parent_id: uuid.UUID | None
    children_count: int
    # Successful contributions of this very source / of this source and its sub-sources (distinct
    # accepted items).
    successful_uses: int
    rolled_up_uses: int
    # Missions linking this source or a sub-source (own list only, not inherited defaults).
    missions_count: int
    categories_count: int
    created_at: datetime

    @property
    def is_root(self) -> bool:
        return self.parent_id is None


@dataclass(frozen=True, slots=True)
class CitationRow:
    id: uuid.UUID
    url: str
    item_key: str
    field: str | None
    quote: str | None
    confidence: int | None
    source_published_at: date | None
    source_checked_at: datetime | None
    source_id: uuid.UUID | None
    result_id: uuid.UUID
    mission_id: uuid.UUID | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class CreditSummary:
    """What accepting one result recorded: citations stored and sources credited (each once)."""

    citations: int
    credited_sources: int


# --- URL normalisation --------------------------------------------------------------------------


def normalize_source_url(raw: str) -> str:
    """A library URL must be an absolute http(s) address; surrounding spaces are dropped."""
    url = raw.strip()
    if len(url) > SOURCE_URL_MAX_LENGTH:
        raise InvalidFieldError("url", f"At most {SOURCE_URL_MAX_LENGTH} characters.", "too_long")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc or " " in url:
        raise InvalidFieldError(
            "url", "Enter a full link starting with http:// or https://.", "invalid"
        )
    if not parts.hostname:
        raise InvalidFieldError("url", "Enter a full link with a host name.", "invalid")
    return url


def split_url(url: str) -> tuple[str, str]:
    """`(domain, path_prefix)`: host lower-cased without `www.` / port, path without a trailing
    slash (query and fragment never identify a source). `linkedin.com`, `/jobs`."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    domain = host[4:] if host.startswith("www.") else host
    return domain[:SOURCE_DOMAIN_MAX_LENGTH], parts.path.rstrip("/")[:SOURCE_PATH_MAX_LENGTH]


def _covers(source: MissionSource, host: str, path: str) -> bool:
    """Does the library entry cover this cited host/path? Subdomains and deeper paths do."""
    if host != source.domain and not host.endswith(f".{source.domain}"):
        return False
    prefix = source.path_prefix
    return prefix == "" or path == prefix or path.startswith(f"{prefix}/")


def _best_match(library: Sequence[MissionSource], url: str) -> MissionSource | None:
    """The most specific entry covering `url` (longest domain, then longest path prefix)."""
    domain, path = split_url(url)
    covering = [source for source in library if _covers(source, domain, path)]
    if not covering:
        return None
    return max(
        covering, key=lambda source: (len(source.domain), len(source.path_prefix), str(source.id))
    )


def resolve_source(session: Session, url: str) -> MissionSource | None:
    """The library source a concrete URL rolls up to, or None (an unknown site)."""
    clean = (url or "").strip()
    if not clean:
        return None
    return _best_match(list(session.scalars(select(MissionSource))), clean)


# --- library ------------------------------------------------------------------------------------


def _optional_text(field: str, value: str | None, max_length: int) -> str | None:
    cleaned = (value or "").strip()
    if len(cleaned) > max_length:
        raise InvalidFieldError(field, f"At most {max_length} characters.", "too_long")
    return cleaned or None


def _source(session: Session, source_id: uuid.UUID) -> MissionSource:
    source = session.get(MissionSource, source_id)
    if source is None:
        raise NotFoundError("Unknown source.")
    return source


def _family_ids(
    session: Session, root_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """`root id -> [root id, *sub-source ids]`."""
    family = {root_id: [root_id] for root_id in root_ids}
    if root_ids:
        for child_id, parent_id in session.execute(
            select(MissionSource.id, MissionSource.parent_id).where(
                MissionSource.parent_id.in_(list(root_ids))
            )
        ):
            family[parent_id].append(child_id)
    return family


def _rows(session: Session, sources: Sequence[MissionSource]) -> list[SourceRow]:
    """Read models for `sources`, with their roll-ups, in a handful of statements."""
    if not sources:
        return []
    root_ids = [source.id for source in sources if source.parent_id is None]
    family = _family_ids(session, root_ids)
    for source in sources:
        family.setdefault(source.id, [source.id])
    every_id = {member for members in family.values() for member in members}

    mission_pairs = session.execute(
        select(MissionSourceLink.source_id, MissionSourceLink.mission_id).where(
            MissionSourceLink.source_id.in_(every_id)
        )
    ).all()
    category_pairs = session.execute(
        select(MissionCategorySource.source_id, MissionCategorySource.category_id).where(
            MissionCategorySource.source_id.in_(every_id)
        )
    ).all()
    uses = {
        root_id: count
        for root_id, count in session.execute(
            select(
                func.coalesce(MissionSource.parent_id, MissionSource.id),
                func.count(
                    distinct(
                        tuple_(
                            MissionSourceContribution.result_id,
                            MissionSourceContribution.item_key,
                        )
                    )
                ),
            )
            .join(MissionSource, MissionSource.id == MissionSourceContribution.source_id)
            .where(MissionSourceContribution.source_id.in_(every_id))
            .group_by(func.coalesce(MissionSource.parent_id, MissionSource.id))
        )
    }

    rows: list[SourceRow] = []
    for source in sources:
        members = set(family[source.id])
        rows.append(
            SourceRow(
                id=source.id,
                url=source.url,
                label=source.label,
                description=source.description,
                domain=source.domain,
                path_prefix=source.path_prefix,
                parent_id=source.parent_id,
                children_count=len(members) - 1,
                successful_uses=source.successful_uses,
                # A sub-source has no children: its roll-up is itself.
                rolled_up_uses=(
                    uses.get(source.id, 0) if source.parent_id is None else source.successful_uses
                ),
                missions_count=len({mission for src, mission in mission_pairs if src in members}),
                categories_count=len(
                    {category for src, category in category_pairs if src in members}
                ),
                created_at=source.created_at,
            )
        )
    return rows


def list_sources(
    session: Session,
    *,
    q: str | None = None,
    parent_id: uuid.UUID | None = None,
    roots_only: bool = False,
    min_successful_uses: int | None = None,
    order: str = "recent",
) -> list[SourceRow]:
    """The library, filtered. `q` matches label, URL, domain and description; `parent_id` lists one
    root's sub-sources; `roots_only` hides sub-sources; `min_successful_uses` filters on the
    roll-up (successful use of the source or its sub-sources); `order`: `recent` (default), `name`
    or `uses` (roll-up, highest first)."""
    if order not in SORT_ORDERS:
        raise InvalidFieldError("order", f"One of {', '.join(SORT_ORDERS)}.", "unknown")
    statement = select(MissionSource)
    if parent_id is not None:
        statement = statement.where(MissionSource.parent_id == parent_id)
    elif roots_only:
        statement = statement.where(MissionSource.parent_id.is_(None))
    if q is not None and q.strip():
        needle = q.strip()
        statement = statement.where(
            MissionSource.label.icontains(needle, autoescape=True)
            | MissionSource.url.icontains(needle, autoescape=True)
            | MissionSource.domain.icontains(needle, autoescape=True)
            | MissionSource.description.icontains(needle, autoescape=True)
        )
    rows = _rows(
        session, list(session.scalars(statement.order_by(MissionSource.created_at.desc())))
    )
    if min_successful_uses is not None:
        rows = [row for row in rows if row.rolled_up_uses >= min_successful_uses]
    if order == "name":
        rows.sort(key=lambda row: (row.label or row.domain).casefold())
    elif order == "uses":
        rows.sort(key=lambda row: row.rolled_up_uses, reverse=True)
    return rows


def get_source(session: Session, source_id: uuid.UUID) -> SourceRow:
    return _rows(session, [_source(session, source_id)])[0]


def _check_parent(
    session: Session, domain: str, parent_id: uuid.UUID, *, source_id: uuid.UUID | None = None
) -> None:
    """A sub-source's parent must be a root of the same site; a root that already has
    sub-sources cannot itself become one (one level only). `source_id` is None for a new one."""
    parent = session.get(MissionSource, parent_id)
    if parent is None:
        raise InvalidFieldError("parent_id", "Unknown source.", "not_found")
    if parent.parent_id is not None:
        raise InvalidFieldError("parent_id", "A sub-source cannot have sub-sources.", "too_deep")
    if source_id is not None:
        if parent.id == source_id:
            raise InvalidFieldError("parent_id", "A source cannot be its own parent.", "invalid")
        has_children = session.scalar(
            select(func.count())
            .select_from(MissionSource)
            .where(MissionSource.parent_id == source_id)
        )
        if has_children:
            raise InvalidFieldError(
                "parent_id", "This source has sub-sources: it stays a root.", "has_children"
            )
    if domain != parent.domain and not domain.endswith(f".{parent.domain}"):
        raise InvalidFieldError("parent_id", "A sub-source belongs to the same site.", "domain")


def _auto_parent(session: Session, domain: str, path_prefix: str) -> MissionSource | None:
    """The existing root a new URL naturally files under (same site, covering path), if any."""
    roots = session.scalars(select(MissionSource).where(MissionSource.parent_id.is_(None))).all()
    covering = [
        root
        for root in roots
        if _covers(root, domain, path_prefix) and root.path_prefix != path_prefix
    ]
    if not covering:
        return None
    return max(covering, key=lambda root: (len(root.domain), len(root.path_prefix)))


def _adopt_orphans(session: Session, root: MissionSource) -> int:
    """A new root takes the childless top-level sources of its site that it covers (so adding
    `linkedin.com` after `linkedin.com/jobs` files the latter under it). Returns the count."""
    adopted = 0
    candidates = session.scalars(
        select(MissionSource).where(MissionSource.parent_id.is_(None), MissionSource.id != root.id)
    ).all()
    for candidate in candidates:
        if not _covers(root, candidate.domain, candidate.path_prefix):
            continue
        if candidate.path_prefix == root.path_prefix and candidate.domain == root.domain:
            continue
        has_children = session.scalar(
            select(func.count())
            .select_from(MissionSource)
            .where(MissionSource.parent_id == candidate.id)
        )
        if has_children:
            continue
        candidate.parent_id = root.id
        adopted += 1
    if adopted:
        session.flush()
    return adopted


def add_source(
    session: Session,
    actor: ActorContext,
    url: str,
    label: str | None,
    *,
    description: str | None = None,
    parent_id: uuid.UUID | None = None,
) -> SourceRow:
    """Save a source once; saving the same URL again returns it (a blank label / description is
    filled). With no `parent_id` a URL filed under an existing root of its site becomes its
    sub-source; otherwise it is a root (and adopts the lone sources it covers)."""
    clean_url = normalize_source_url(url)
    clean_label = _optional_text("label", label, SOURCE_LABEL_MAX_LENGTH)
    clean_description = _optional_text("description", description, SOURCE_DESCRIPTION_MAX_LENGTH)
    source = session.scalar(select(MissionSource).where(MissionSource.url == clean_url))
    if source is not None:
        if source.label is None and clean_label is not None:
            source.label = clean_label
        if source.description is None and clean_description is not None:
            source.description = clean_description
        session.flush()
        return _rows(session, [source])[0]
    domain, path_prefix = split_url(clean_url)
    source = MissionSource(
        url=clean_url,
        label=clean_label,
        description=clean_description,
        domain=domain,
        path_prefix=path_prefix,
        created_by_display=actor.display,
    )
    if parent_id is not None:
        _check_parent(session, domain, parent_id)
        source.parent_id = parent_id
    else:
        parent = _auto_parent(session, domain, path_prefix)
        source.parent_id = parent.id if parent is not None else None
    session.add(source)
    session.flush()
    if source.parent_id is None:
        _adopt_orphans(session, source)
    logger.info(
        "mission source added: id=%s domain=%s parent=%s", source.id, domain, source.parent_id
    )
    return _rows(session, [source])[0]


def update_source(
    session: Session,
    source_id: uuid.UUID,
    *,
    fields: Mapping[str, Any],
) -> SourceRow:
    """Edit label, description and place in the hierarchy. `fields` holds only what the request
    sent: `label`, `description`, `parent_id` (a root's id to file under it, None to make it a
    root). The URL is the identity and never changes."""
    source = _source(session, source_id)
    if "label" in fields:
        source.label = _optional_text("label", fields["label"], SOURCE_LABEL_MAX_LENGTH)
    if "description" in fields:
        source.description = _optional_text(
            "description", fields["description"], SOURCE_DESCRIPTION_MAX_LENGTH
        )
    if "parent_id" in fields:
        new_parent: uuid.UUID | None = fields["parent_id"]
        if new_parent is not None:
            _check_parent(session, source.domain, new_parent, source_id=source.id)
        source.parent_id = new_parent
    session.flush()
    return _rows(session, [source])[0]


def delete_source(session: Session, source_id: uuid.UUID) -> None:
    """Forget a source: the missions and categories that used it simply lose it (FK cascade), its
    contributions go with it, its citations keep their URL (`source_id` set to NULL). A root that
    still has sub-sources is refused (409 `in_use`): move or delete them first."""
    source = _source(session, source_id)
    children = session.scalar(
        select(func.count()).select_from(MissionSource).where(MissionSource.parent_id == source.id)
    )
    if children:
        raise InUseError({"sub_sources": children})
    session.delete(source)
    session.flush()
    logger.info("mission source deleted: id=%s", source_id)


# --- category defaults and mission links --------------------------------------------------------


def _sources_by_ids(session: Session, source_ids: Sequence[uuid.UUID]) -> list[MissionSource]:
    """The sources in the order given, without duplicates; an unknown id is a 404."""
    ordered = list(dict.fromkeys(source_ids))
    found = {
        source.id: source
        for source in session.scalars(select(MissionSource).where(MissionSource.id.in_(ordered)))
    }
    for source_id in ordered:
        if source_id not in found:
            raise NotFoundError("Unknown source.")
    return [found[source_id] for source_id in ordered]


def category_sources(session: Session, category_id: uuid.UUID) -> list[MissionSource]:
    return list(
        session.scalars(
            select(MissionSource)
            .join(MissionCategorySource, MissionCategorySource.source_id == MissionSource.id)
            .where(MissionCategorySource.category_id == category_id)
            .order_by(MissionCategorySource.position, MissionSource.created_at)
        )
    )


def to_ref(source: MissionSource) -> SourceRef:
    return SourceRef(id=source.id, url=source.url, label=source.label)


def category_source_refs(session: Session, category_id: uuid.UUID) -> list[SourceRef]:
    return [to_ref(source) for source in category_sources(session, category_id)]


def set_category_sources(
    session: Session, category: MissionCategory, source_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    """Replace the category's default sources (ordered). Returns the ids now stored."""
    sources = _sources_by_ids(session, source_ids)
    session.execute(
        sql_delete(MissionCategorySource).where(MissionCategorySource.category_id == category.id)
    )
    session.flush()
    for position, source in enumerate(sources):
        session.add(
            MissionCategorySource(category_id=category.id, source_id=source.id, position=position)
        )
    session.flush()
    return [source.id for source in sources]


def mission_sources(session: Session, mission_id: uuid.UUID) -> list[MissionSource]:
    """A mission's own links (its override list), oldest first."""
    return list(
        session.scalars(
            select(MissionSource)
            .join(MissionSourceLink, MissionSourceLink.source_id == MissionSource.id)
            .where(MissionSourceLink.mission_id == mission_id)
            .order_by(MissionSource.created_at)
        )
    )


def effective_sources(session: Session, mission: Mission) -> list[MissionSource]:
    """The external sources a mission works with: its own list when it overrides `sources`, else
    the current defaults of its category. Read-only context for the agent; never a write path."""
    if SOURCES_FIELD in (mission.overridden_fields or []):
        return mission_sources(session, mission.id)
    if mission.category_id is None:
        return []
    return category_sources(session, mission.category_id)


def effective_source_rows(session: Session, mission: Mission) -> list[SourceRow]:
    return _rows(session, effective_sources(session, mission))


def set_mission_sources(
    session: Session, mission: Mission, source_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    """Replace the mission's own links (each must be a library source)."""
    sources = _sources_by_ids(session, source_ids)
    session.execute(sql_delete(MissionSourceLink).where(MissionSourceLink.mission_id == mission.id))
    session.flush()
    for source in sources:
        session.add(MissionSourceLink(mission_id=mission.id, source_id=source.id))
    session.flush()
    session.expire(mission, ["sources"])
    return [source.id for source in sources]


def clear_mission_sources(session: Session, mission: Mission) -> None:
    """Drop the mission's own links (it goes back to following its category)."""
    session.execute(sql_delete(MissionSourceLink).where(MissionSourceLink.mission_id == mission.id))
    session.flush()
    session.expire(mission, ["sources"])


# --- evidence and effectiveness -----------------------------------------------------------------


def _citation_url(source: object) -> str | None:
    """The cited address when it is a real http(s) URL; free text (« Registre INPI ») is not one."""
    if not isinstance(source, str):
        return None
    url = source.strip()
    parts = urlsplit(url)
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or " " in url
        or len(url) > CITATION_URL_MAX_LENGTH
    ):
        return None
    return url


def _evidence_entries(
    task_type: AgentTaskType, raw: Mapping[str, Any], item: Mapping[str, Any]
) -> list[Evidence]:
    """The `Evidence` (Slice 04 shape) the agent gave for one proposal item.

    - `update_company` / `update_employee`: the `evidence` entries whose `field` is the item's;
    - `find_employees` / `find_prospects`: the `evidence` of the person / company at the item's
      index in the raw list;
    - `surveil_signals`: the signal's single `source` (with its freshness dates).
    """
    entries: list[Any] = []
    key = str(item.get("key", ""))
    if task_type in (AgentTaskType.UPDATE_COMPANY, AgentTaskType.UPDATE_EMPLOYEE):
        entries = [
            entry
            for entry in raw.get("evidence") or []
            if isinstance(entry, dict) and entry.get("field") == item.get("field")
        ]
    else:
        indexed = _INDEXED_KEY.match(key)
        list_field = LIST_FIELDS.get(task_type)
        records = raw.get(list_field) if list_field else None
        if indexed is None or not isinstance(records, list):
            return []
        position = int(indexed.group(1))
        if position >= len(records) or not isinstance(records[position], dict):
            return []
        record: dict[str, Any] = records[position]
        if task_type is AgentTaskType.SURVEIL_SIGNALS:
            entries = [
                {
                    "field": str(item.get("field") or "signal"),
                    "source": record.get("source"),
                    "quote": None,
                    "confidence": record.get("confidence"),
                    "source_published_at": record.get("source_published_at"),
                    "source_checked_at": record.get("source_checked_at"),
                }
            ]
        else:
            entries = list(record.get("evidence") or [])
    found: list[Evidence] = []
    for entry in entries:
        try:
            found.append(Evidence.model_validate(entry))
        except ValidationError:
            logger.warning("evidence skipped: item=%s is not a valid Evidence", key)
    return found


def _as_date(value: date | datetime | None) -> date | None:
    return value.date() if isinstance(value, datetime) else value


def _task_mission_id(session: Session, task: AgentTask) -> uuid.UUID | None:
    if task.run_id is None:
        return None
    return session.scalar(select(MissionRun.mission_id).where(MissionRun.id == task.run_id))


def _register_cited_site(
    session: Session, actor: ActorContext, url: str, library: list[MissionSource]
) -> MissionSource | None:
    """Add the site root of a cited URL to the library; `library` is extended in place."""
    parts = urlsplit(url)
    domain, _ = split_url(url)
    try:
        row = add_source(session, actor, f"{parts.scheme}://{parts.netloc}", domain)
    except InvalidFieldError:
        logger.warning("cited site not added to the library: %s", domain)
        return None
    source = session.get(MissionSource, row.id)
    if source is not None:
        library.append(source)
    return source


def credit_accepted_result(
    session: Session,
    result: AgentTaskResult,
    task: AgentTask,
    accepted_keys: Sequence[str],
    actor: ActorContext | None = None,
) -> CreditSummary:
    """Record the evidence of the accepted items of `result` and credit their sources.

    Called by `agent_review.accept` once the person decided: only an accepted item is a *successful
    contribution*; a visit (`source_opened` telemetry), an attachment or a rejected / pending item
    never counts. For each accepted item, each distinct URL it cites is stored as a citation and
    resolved to its library source; each distinct resolved source is credited once for the
    (result, item). Re-running it, or rebuilding the result, stores nothing twice.

    A cited site the library does not know yet is **added to it** (its site root, e.g.
    `https://societe.com`) when `actor` is given: validating a result is what makes its sources
    part of the Sources tab. The concrete URL stays stored as the citation.
    """
    proposal = result.proposal or {}
    if proposal.get("kind") == "actions":
        return CreditSummary(0, 0)
    wanted = set(accepted_keys)
    library = list(session.scalars(select(MissionSource)))
    mission_id = _task_mission_id(session, task)
    citation_rows: list[dict[str, Any]] = []
    contribution_rows: dict[tuple[uuid.UUID, str], dict[str, Any]] = {}
    for item in proposal.get("items", []):
        key = str(item.get("key", ""))[:CITATION_ITEM_KEY_MAX_LENGTH]
        if key not in wanted:
            continue
        seen_urls: set[str] = set()
        for evidence in _evidence_entries(task.type, result.raw, item):
            url = _citation_url(evidence.source)
            if url is None or url in seen_urls:
                continue
            seen_urls.add(url)
            matched = _best_match(library, url)
            if matched is None and actor is not None:
                matched = _register_cited_site(session, actor, url, library)
            citation_rows.append(
                {
                    "result_id": result.id,
                    "item_key": key,
                    "field": evidence.field[:100],
                    "url": url,
                    "quote": evidence.quote[:CITATION_QUOTE_MAX_LENGTH] if evidence.quote else None,
                    "confidence": evidence.confidence,
                    "source_published_at": _as_date(evidence.source_published_at),
                    "source_checked_at": evidence.source_checked_at,
                    "source_id": matched.id if matched is not None else None,
                    "mission_id": mission_id,
                }
            )
            if matched is not None:
                contribution_rows[(matched.id, key)] = {
                    "source_id": matched.id,
                    "result_id": result.id,
                    "item_key": key,
                    "mission_id": mission_id,
                }
    if citation_rows:
        session.execute(
            pg_insert(MissionEvidenceCitation)
            .values(citation_rows)
            .on_conflict_do_nothing(index_elements=["result_id", "item_key", "url"])
        )
    if contribution_rows:
        session.execute(
            pg_insert(MissionSourceContribution)
            .values(list(contribution_rows.values()))
            .on_conflict_do_nothing(index_elements=["source_id", "result_id", "item_key"])
        )
        refresh_counters(session, {source_id for source_id, _ in contribution_rows})
    session.flush()
    logger.info(
        "source evidence recorded: result=%s citations=%d contributions=%d",
        result.id,
        len(citation_rows),
        len(contribution_rows),
    )
    return CreditSummary(len(citation_rows), len(contribution_rows))


def refresh_counters(session: Session, source_ids: set[uuid.UUID] | None = None) -> None:
    """Recompute `successful_uses` from the ledger (all sources when `source_ids` is None). The
    counter is derived, so it can be rebuilt at any time and cannot drift."""
    counted = (
        select(func.count())
        .select_from(MissionSourceContribution)
        .where(MissionSourceContribution.source_id == MissionSource.id)
        .scalar_subquery()
    )
    statement = update(MissionSource).values(successful_uses=counted)
    if source_ids is not None:
        statement = statement.where(MissionSource.id.in_(source_ids))
    session.execute(statement.execution_options(synchronize_session="fetch"))


def list_citations(
    session: Session, source_id: uuid.UUID, *, include_sub_sources: bool = True, limit: int = 50
) -> list[CitationRow]:
    """The concrete evidence behind a source (and its sub-sources), newest first."""
    source = _source(session, source_id)
    ids = [source.id]
    if include_sub_sources and source.parent_id is None:
        ids = _family_ids(session, [source.id])[source.id]
    rows = session.scalars(
        select(MissionEvidenceCitation)
        .where(MissionEvidenceCitation.source_id.in_(ids))
        .order_by(MissionEvidenceCitation.created_at.desc(), MissionEvidenceCitation.id)
        .limit(limit)
    ).all()
    return [
        CitationRow(
            id=row.id,
            url=row.url,
            item_key=row.item_key,
            field=row.field,
            quote=row.quote,
            confidence=row.confidence,
            source_published_at=row.source_published_at,
            source_checked_at=row.source_checked_at,
            source_id=row.source_id,
            result_id=row.result_id,
            mission_id=row.mission_id,
            created_at=row.created_at,
        )
        for row in rows
    ]
