"""Warehouses found by a discovery mission: which proposed sites become a warehouse record, and
the creation of that record under the company that owns the site.

Shared by the acceptance (`agent_review`), the review preview and the backfill of results accepted
before warehouses were created (`python -m app.cli backfill-warehouses`).
Contract: `doc/features/warehouses.md`.
"""

import hashlib
import logging
import re
import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import Company, Establishment, Warehouse
from app.models.agent_missions import AgentTaskResult
from app.models.enums import AgentResultStatus
from app.services.imports.matching import company_key
from app.services.mcp_duplicates import check_warehouse
from app.services.taxonomy_matching import fold
from app.services.warehouses import WarehouseInput, save_warehouse

logger = logging.getLogger(__name__)

# Matched on folded text (lowercase, no accents, punctuation as spaces).
_WAREHOUSE = (
    r"\b(entrepots?|entreposage|warehouses?|depots?|hangars?|logistique|logistics?"
    r"|plate ?formes? logistiques?)\b"
)
# A site's kind is a deliberate label: « plateforme » alone is a logistics platform there, while
# in a free name it could be anything.
_WAREHOUSE_KIND = re.compile(_WAREHOUSE + r"|\bplate ?formes?\b")
_WAREHOUSE_NAME = re.compile(r"\b(entrepots?|warehouses?|plate ?formes? logistiques?)\b")
# A head office stays a head office, even for a logistics company (« siège logistique »).
_NOT_A_WAREHOUSE = re.compile(r"\b(siege|bureaux?|agence)\b")
# From this confidence of `check_warehouse` (same SIRET, same name and place, same address and a
# close name) the warehouse is already recorded.
_DUPLICATE = 0.9


def is_warehouse_site(kind: str | None, name: str | None) -> bool:
    """The kind decides when given; a site without kind is judged on its name."""
    label = fold(kind or "")
    if label:
        if _NOT_A_WAREHOUSE.search(label) and not re.search(r"\bentrepots?\b", label):
            return False
        return _WAREHOUSE_KIND.search(label) is not None
    return _WAREHOUSE_NAME.search(fold(name or "")) is not None


def warehouse_name(site_name: str | None, company_name: str, city: str | None) -> str:
    name = (site_name or "").strip() or " — ".join(filter(None, (company_name, city)))
    return name[:500]


def find_duplicate(
    session: Session,
    *,
    name: str,
    siret: str | None,
    postal_code: str | None,
    city: str | None,
    address: str | None,
) -> dict[str, Any] | None:
    """The recorded warehouse this site already is, if any (`{"id", "name", "reasons"}`)."""
    if not (company_key(name) or siret):
        return None
    found = check_warehouse(
        session, name=name, siret=siret, postal_code=postal_code, city=city, address=address
    )["candidates"]
    if not found or found[0]["confidence"] < _DUPLICATE:
        return None
    best = found[0]
    return {"id": best["id"], "name": best["display_name"], "reasons": best["reasons"]}


def _place(city: Any, name: Any) -> tuple[str, str] | None:
    pair = (fold(str(city or "")), fold(str(name or "")))
    return pair if all(pair) else None


def matching_site(
    session: Session, company_id: uuid.UUID, site: Mapping[str, Any]
) -> Establishment | None:
    """The company's establishment a proposed site is: same SIRET, same city and name, or same
    street address in the same postal code or city. Two different SIRETs are two sites."""
    siret = site.get("siret")
    address = fold(str(site.get("address_line1") or ""))
    rows = session.scalars(
        select(Establishment)
        .where(Establishment.company_id == company_id)
        .order_by(Establishment.id)
    ).all()
    for row in rows:
        if siret and row.siret:
            if row.siret == siret:
                return row
            continue
        place = _place(site.get("city"), site.get("name"))
        if place is not None and place == _place(row.city, row.name):
            return row
        if address and address == fold(row.address_line1 or ""):
            postal = site.get("postal_code")
            town = fold(str(site.get("city") or ""))
            if (postal and postal == row.postal_code) or (town and town == fold(row.city or "")):
                return row
    return None


@dataclass(frozen=True, slots=True)
class SitePlan:
    """What accepting one proposed site would do: `create` a warehouse (on `establishment` when
    the company already has the site), nothing because it is not a warehouse (`none`), because the
    warehouse is recorded (`duplicate`) or because another record holds the SIRET (`known_site`).
    """

    action: str
    existing_name: str | None = None
    establishment: Establishment | None = None


def plan_site(
    session: Session,
    site: Mapping[str, Any],
    company_name: str,
    company_id: uuid.UUID | None = None,
) -> SitePlan:
    """`company_id`: the existing company the site is proposed for; None for a new company."""
    siret = site.get("siret")
    if siret:
        holder = session.scalar(
            select(Establishment.company_id).where(Establishment.siret == siret)
        )
        if holder is not None and holder != company_id:
            return SitePlan("known_site")
    if not is_warehouse_site(site.get("kind"), site.get("name")):
        return SitePlan("none")
    row = matching_site(session, company_id, site) if company_id else None
    readings: list[Mapping[str, Any]] = [site]
    if row is not None:
        linked = _existing_for(session, row.id)
        if linked is not None:
            return SitePlan("duplicate", linked.name, row)
        readings.append(_site_values(row, site))
    for values in readings:
        duplicate = find_duplicate(
            session,
            name=warehouse_name(values.get("name"), company_name, values.get("city")),
            siret=values.get("siret"),
            postal_code=values.get("postal_code"),
            city=values.get("city"),
            address=values.get("address_line1"),
        )
        if duplicate is not None:
            return SitePlan("duplicate", duplicate["name"], row)
    return SitePlan("create", establishment=row)


def _site_values(site: Establishment, facts: Mapping[str, Any]) -> dict[str, Any]:
    """The establishment's own values, completed by the proposed ones where it has none."""
    return {
        key: getattr(site, key) or facts.get(key)
        for key in ("name", "siret", "address_line1", "postal_code", "city")
    }


def _source_key(establishment_id: uuid.UUID) -> str:
    return hashlib.sha256(f"agent-site:{establishment_id}".encode()).hexdigest()


def _existing_for(session: Session, establishment_id: uuid.UUID) -> Warehouse | None:
    return session.scalar(
        select(Warehouse)
        .where(
            (Warehouse.establishment_id == establishment_id)
            | (Warehouse.source_key == _source_key(establishment_id))
        )
        .limit(1)
    )


def _notes(facts: Mapping[str, Any], signal: str | None) -> str | None:
    lines = []
    if signal:
        lines.append(signal)
    if facts.get("opened_on"):
        lines.append(f"Ouverture : {facts['opened_on']}")
    if facts.get("surface_m2"):
        lines.append(f"Surface : {facts['surface_m2']} m²")
    return "\n".join(lines) or None


@dataclass(frozen=True, slots=True)
class Outcome:
    """What happened to one site: `created`, `exists` (already linked) or `duplicate`."""

    status: str
    warehouse_id: str
    warehouse_name: str


def create_for_site(
    session: Session,
    actor: ActorContext,
    site: Establishment,
    company_name: str,
    facts: Mapping[str, Any],
    *,
    source: str | None,
    signal: str | None = None,
) -> Outcome:
    """The warehouse record of one company site, unless it is already recorded. `facts` carries
    what the establishment has no column for (`opened_on`, `surface_m2`) and, for a site the
    company already had, the proposed values that fill its blanks (the site is not modified)."""
    existing = _existing_for(session, site.id)
    if existing is not None:
        return Outcome("exists", str(existing.id), existing.name)
    values = _site_values(site, facts)
    name = warehouse_name(values["name"], company_name, values["city"])
    address = ", ".join(filter(None, (values["address_line1"], site.address_line2))) or None
    duplicate = find_duplicate(
        session,
        name=name,
        siret=values["siret"],
        postal_code=values["postal_code"],
        city=values["city"],
        address=address,
    )
    if duplicate is not None:
        logger.info(
            "discovery warehouse skipped: establishment=%s duplicate_of=%s",
            site.id,
            duplicate["id"],
        )
        return Outcome("duplicate", duplicate["id"], duplicate["name"])
    view = save_warehouse(
        session,
        actor,
        WarehouseInput(
            name=name,
            address=address,
            postal_code=values["postal_code"],
            city=values["city"],
            siret=values["siret"],
            notes=_notes(facts, signal),
            establishment_id=site.id,
        ),
        source_reference=source,
        source_key=_source_key(site.id),
    )
    logger.info("discovery warehouse created: warehouse=%s establishment=%s", view.id, site.id)
    return Outcome("created", str(view.id), view.name)


def preview(session: Session, proposal: Mapping[str, Any]) -> dict[str, Any]:
    """The proposal with, on each discovered company, what accepting it would do about
    warehouses: `store["warehouses_to_create"]`, and on each of its sites `site["warehouse"]`,
    `{"action": "create" | "duplicate" | "none" | "known_site"}`. Computed on read, so it
    follows the base and covers proposals stored earlier. Nothing is written."""
    items = []
    for item in proposal.get("items", []):
        store = item.get("store") or {}
        if not isinstance(store, dict) or "display_name" not in store:  # not a company
            items.append(item)
            continue
        annotated = []
        owner = store.get("existing_company_id")
        for site in store.get("establishments") or []:
            found = plan_site(
                session,
                site,
                str(store.get("display_name", "")),
                uuid.UUID(str(owner)) if owner else None,
            )
            plan = {"action": found.action}
            if found.existing_name:
                plan["existing_name"] = found.existing_name
            annotated.append({**site, "warehouse": plan})
        to_create = sum(site["warehouse"]["action"] == "create" for site in annotated)
        items.append(
            {
                **item,
                "store": {**store, "establishments": annotated, "warehouses_to_create": to_create},
            }
        )
    return {**proposal, "items": items}


# --- backfill -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BackfillLine:
    """`created`, `exists`, `duplicate`, `not_warehouse`, `excluded`, `deleted_site` or
    `no_site` (a company accepted without any site: nothing to create it from)."""

    status: str
    result_id: uuid.UUID
    company_name: str
    establishment_id: str | None = None
    site: str | None = None
    warehouse: str | None = None


def _company_records(applied: Mapping[str, Any]) -> Sequence[Mapping[str, Any]]:
    """The accepted companies of a result, direct or staged (`{"actions": [...]}`)."""
    groups = applied.get("actions") or [applied]
    records: list[Mapping[str, Any]] = []
    for group in groups:
        if "companies" in group:
            records.extend(group["companies"])
        elif "created" in group and "company_id" not in group:
            # Accepted before results recorded their sites.
            records.extend({"company_id": value} for value in group["created"])
    return records


def backfill(
    session: Session,
    actor: ActorContext,
    *,
    include: Collection[uuid.UUID] = (),
    exclude: Collection[uuid.UUID] = (),
) -> list[BackfillLine]:
    """Create the missing warehouses of every accepted discovery result. Idempotent; the caller
    owns the transaction (a dry run rolls it back). `include` forces sites whose kind does not
    name a warehouse; `exclude` leaves sites out."""
    results = session.scalars(
        select(AgentTaskResult)
        .where(AgentTaskResult.status == AgentResultStatus.ACCEPTED)
        .order_by(AgentTaskResult.decided_at, AgentTaskResult.id)
    ).all()
    lines: list[BackfillLine] = []
    for result in results:
        for record in _company_records(result.applied or {}):
            company = session.get(Company, uuid.UUID(str(record["company_id"])))
            company_name = company.display_name if company else "(société supprimée)"
            sites = record.get("establishments") or []
            if not sites:
                lines.append(BackfillLine("no_site", result.id, company_name))
            for facts in sites:
                site_id = uuid.UUID(str(facts["id"]))
                site = session.get(Establishment, site_id)
                if site is None:
                    lines.append(
                        BackfillLine(
                            "deleted_site",
                            result.id,
                            company_name,
                            str(site_id),
                            facts.get("name"),
                        )
                    )
                    continue
                label = " · ".join(
                    filter(None, (site.name, site.kind, site.postal_code, site.city))
                )
                warehouse = None
                linked = _existing_for(session, site_id)
                if linked is not None:
                    status, warehouse = "exists", linked.name
                elif site_id in exclude:
                    status = "excluded"
                elif site_id not in include and not is_warehouse_site(site.kind, site.name):
                    status = "not_warehouse"
                else:
                    owner = session.get(Company, site.company_id)
                    outcome = create_for_site(
                        session,
                        actor,
                        site,
                        owner.display_name if owner else company_name,
                        facts,
                        source=facts.get("source") or record.get("source"),
                    )
                    status, warehouse = outcome.status, outcome.warehouse_name
                lines.append(
                    BackfillLine(status, result.id, company_name, str(site_id), label, warehouse)
                )
    return lines
