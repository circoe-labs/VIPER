"""The owning company of a warehouse that has none (`doc/features/warehouses.md`).

`proposals` suggests, `attach` writes what **a person confirmed**; nothing is attached on a
suggestion alone. Sources of an existing company: the domain of the listing's addresses (a
company's own domain, or that of its prospects; never a webmail), the owner written on the
listing, and the company part of the warehouse name (`mail_generation/naming.organisations`).
A new company is only ever proposed from that name part, when nothing existing is alike. A name
holding several companies, a site or street label, or sources pointing at several companies get
no proposal (the look-alikes are listed for the person).

Attaching links the warehouse to a building of the company: the matching establishment, else a
new one carrying the warehouse's address. Operations flush; the caller owns the transaction.
Logs carry ids only.
"""

import logging
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from http import HTTPStatus
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company, Email, Establishment, Prospect, Warehouse
from app.services import audit, companies, warehouse_discovery, warehouse_people
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.imports.dedup import COMPANY_SIMILARITY
from app.services.imports.matching import company_key, similarity
from app.services.imports.rows import WEBMAIL_DOMAINS
from app.services.imports.text import fold
from app.services.mail_generation.naming import organisations

logger = logging.getLogger(__name__)

Source = Literal["domain", "owner", "name", "similar_name"]
Status = Literal["existing", "new", "ambiguous", "several", "none"]
SOURCE_ORDER: tuple[Source, ...] = ("domain", "owner", "name", "similar_name")
NAME_MAX = 255
# A name part starting with one of these, or holding a street word, labels a place.
_SITE_WORDS = """
    base batiment centre depot entrepot entrepots hangar local magasin parc plate plateforme quai
    site za zac zi zone
"""
_STREET_WORDS = "allee avenue boulevard chemin impasse route rue"
SITE_WORDS = frozenset(_SITE_WORDS.split())
STREET_WORDS = frozenset(_STREET_WORDS.split())


@dataclass(frozen=True, slots=True)
class Match:
    company_id: uuid.UUID
    company_name: str
    sources: tuple[Source, ...]


@dataclass(frozen=True, slots=True)
class Proposal:
    warehouse_id: uuid.UUID
    warehouse_name: str
    city: str | None
    people: int
    # existing / new: one proposal. ambiguous: several look-alikes. several: the name holds
    # several companies. none: nothing to go on.
    status: Status
    company_id: uuid.UUID | None = None
    company_name: str | None = None
    sources: tuple[Source, ...] = ()
    # Existing companies to choose from when nothing is proposed.
    candidates: tuple[Match, ...] = ()


def looks_like_company(part: str) -> bool:
    words = fold(part).split()
    return (
        bool(words)
        and words[0] not in SITE_WORDS
        and not words[0].isdigit()
        and not STREET_WORDS.intersection(words)
        and any(char.isalpha() for char in part)
    )


@dataclass(slots=True)
class _Base:
    """The companies indexed for comparison, read once."""

    names: dict[uuid.UUID, str]
    by_key: dict[str, set[uuid.UUID]]
    by_domain: dict[str, set[uuid.UUID]]

    @classmethod
    def load(cls, session: Session) -> _Base:
        names: dict[uuid.UUID, str] = {}
        by_key: dict[str, set[uuid.UUID]] = defaultdict(set)
        by_domain: dict[str, set[uuid.UUID]] = defaultdict(set)
        for found_id, display, legal, domain in session.execute(
            select(Company.id, Company.display_name, Company.legal_name, Company.email_domain)
        ).tuples():
            names[found_id] = display
            for text in (display, legal):
                if text:
                    by_key[company_key(text)].add(found_id)
            if domain:
                by_domain[domain].add(found_id)
        for address, employer in session.execute(
            select(Email.address, Prospect.company_id)
            .join(Prospect, Prospect.id == Email.prospect_id)
            .where(
                Email.is_active,
                Prospect.company_id.is_not(None),
                Prospect.member_user_id.is_(None),
            )
        ).tuples():
            domain = address.rpartition("@")[2]
            if domain not in WEBMAIL_DOMAINS and employer is not None:
                by_domain[domain].add(employer)
        return cls(names, by_key, by_domain)

    def propose(self, warehouse: Warehouse) -> Proposal:
        listed = warehouse_people.entries(warehouse)
        found: dict[uuid.UUID, set[Source]] = defaultdict(set)
        for entry in listed:
            for address in entry.addresses:
                domain = address.rpartition("@")[2]
                if domain not in WEBMAIL_DOMAINS:
                    for company_id in self.by_domain.get(domain, ()):
                        found[company_id].add("domain")
        for company_id in self._named(warehouse.owner_name):
            found[company_id].add("owner")
        parts = organisations(warehouse.name)
        for label in parts:
            for company_id in self._named(label):
                found[company_id].add("name")
        part = parts[0] if len(parts) == 1 and looks_like_company(parts[0]) else None
        if part is not None and not found:
            key = company_key(part)
            for other, ids in self.by_key.items():
                if similarity(key, other) >= COMPANY_SIMILARITY:
                    for company_id in ids:
                        found[company_id].add("similar_name")
        matches = tuple(
            sorted(
                (
                    Match(i, self.names[i], tuple(s for s in SOURCE_ORDER if s in why))
                    for i, why in found.items()
                ),
                key=lambda m: (m.company_name.casefold(), str(m.company_id)),
            )
        )

        def proposal(status: Status, **values: object) -> Proposal:
            return Proposal(
                warehouse.id,
                warehouse.name,
                warehouse.city,
                len(listed),
                status,
                **values,  # type: ignore[arg-type]
            )

        if len(parts) > 1:
            return proposal("several", candidates=matches)
        if len(matches) == 1 and matches[0].sources != ("similar_name",):
            only = matches[0]
            return proposal(
                "existing",
                company_id=only.company_id,
                company_name=only.company_name,
                sources=only.sources,
            )
        if matches:
            return proposal("ambiguous", candidates=matches)
        if part is not None and len(part) <= NAME_MAX:
            return proposal("new", company_name=part, sources=("name",))
        return proposal("none")

    def _named(self, label: str | None) -> set[uuid.UUID]:
        parts = organisations(label)
        if len(parts) != 1:
            return set()
        # The label as written too: « Name SAS » and « Name - Town » share the company's key.
        return self.by_key.get(company_key(parts[0]), set())


def propose(session: Session, warehouse: Warehouse) -> Proposal:
    return _Base.load(session).propose(warehouse)


def proposals(session: Session) -> list[Proposal]:
    """Every warehouse without a company that lists someone, by name."""
    rows: Sequence[Warehouse] = session.scalars(
        select(Warehouse)
        .where(Warehouse.establishment_id.is_(None))
        .order_by(Warehouse.name, Warehouse.id)
    ).all()
    listed = [row for row in rows if warehouse_people.entries(row)]
    if not listed:
        return []
    base = _Base.load(session)
    return [base.propose(row) for row in listed]


@dataclass(frozen=True, slots=True)
class Attached:
    company_id: uuid.UUID
    company_name: str
    created: bool


def attach(
    session: Session,
    actor: ActorContext,
    warehouse_id: uuid.UUID,
    *,
    company_id: uuid.UUID | None = None,
    new_name: str | None = None,
) -> Attached:
    """A person confirms the owning company: an existing one, or a new one by name (an existing
    company of the same name is used instead of a second one; several are refused, 409
    `company_ambiguous`). A warehouse already attached to another company is refused (409
    `already_attached`); a SIRET another company holds too (409 `siret_other_company`)."""
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A warehouse's company is confirmed by a person.")
    warehouse_people.serialize(session)
    warehouse = session.scalar(
        select(Warehouse).where(Warehouse.id == warehouse_id).with_for_update()
    )
    if warehouse is None:
        raise NotFoundError("Warehouse not found.")
    name = " ".join((new_name or "").split())
    if company_id is None and not name:
        raise InvalidFieldError("new_name", "Choose a company or name a new one.", "required")
    base = _Base.load(session)
    if company_id is None:
        same = base.by_key.get(company_key(name), set())
        if len(same) > 1:
            raise BusinessRuleError(
                "company_ambiguous",
                HTTPStatus.CONFLICT,
                "Several companies have this name: choose one.",
                company_ids=[str(i) for i in same],
            )
        company_id = next(iter(same), None)
    elif company_id not in base.names:
        raise InvalidFieldError("company_id", "Unknown company.", "unknown")
    if warehouse.establishment_id is not None:
        current = session.execute(
            select(Company.id, Company.display_name)
            .join(Establishment, Establishment.company_id == Company.id)
            .where(Establishment.id == warehouse.establishment_id)
        ).one()
        if current[0] == company_id:
            return Attached(current[0], current[1], created=False)
        raise BusinessRuleError(
            "already_attached",
            HTTPStatus.CONFLICT,
            "The warehouse is already attached to another company: reload it.",
        )
    created = company_id is None
    if company_id is None:
        company_id = companies.create_company(
            session, actor, companies.CompanyInput(display_name=name)
        ).id
    company_name = base.names.get(company_id, name)
    site = _building(session, actor, warehouse, company_id)
    audit.annotate(session, actor, warehouse)
    warehouse.establishment_id = site.id
    session.flush()
    logger.info(
        "warehouse_companies.attached warehouse=%s company=%s created=%s",
        warehouse.id,
        company_id,
        created,
    )
    return Attached(company_id, company_name, created)


def _building(
    session: Session, actor: ActorContext, warehouse: Warehouse, company_id: uuid.UUID
) -> Establishment:
    if warehouse.siret:
        holder = session.scalar(
            select(Establishment.company_id).where(Establishment.siret == warehouse.siret)
        )
        if holder is not None and holder != company_id:
            raise BusinessRuleError(
                "siret_other_company",
                HTTPStatus.CONFLICT,
                "Another company holds this warehouse's SIRET.",
                company_ids=[str(holder)],
            )
    building = companies.EstablishmentInput(
        name=warehouse.name[:NAME_MAX],
        siret=warehouse.siret,
        address_line1=" ".join((warehouse.address or "").split())[:NAME_MAX] or None,
        postal_code=warehouse.postal_code,
        city=warehouse.city,
        kind="Entrepôt",
    )
    found = warehouse_discovery.matching_site(session, company_id, asdict(building))
    if found is not None:
        return found
    return companies.add_establishment(session, actor, company_id, building)
