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
    what the establishment has no column for (`opened_on`, `surface_m2`)."""
    existing = _existing_for(session, site.id)
    if existing is not None:
        return Outcome("exists", str(existing.id), existing.name)
    name = warehouse_name(site.name, company_name, site.city)
    address = ", ".join(filter(None, (site.address_line1, site.address_line2))) or None
    duplicate = find_duplicate(
        session,
        name=name,
        siret=site.siret,
        postal_code=site.postal_code,
        city=site.city,
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
            postal_code=site.postal_code,
            city=site.city,
            siret=site.siret,
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
        for site in store.get("establishments") or []:
            siret = site.get("siret")
            plan: dict[str, Any] = {"action": "none"}
            if siret and session.scalar(
                select(Establishment.id).where(Establishment.siret == siret)
            ):
                plan = {"action": "known_site"}
            elif is_warehouse_site(site.get("kind"), site.get("name")):
                duplicate = find_duplicate(
                    session,
                    name=warehouse_name(
                        site.get("name"), str(store.get("display_name", "")), site.get("city")
                    ),
                    siret=siret,
                    postal_code=site.get("postal_code"),
                    city=site.get("city"),
                    address=site.get("address_line1"),
                )
                plan = (
                    {"action": "duplicate", "existing_name": duplicate["name"]}
                    if duplicate
                    else {"action": "create"}
                )
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
                if site_id in exclude:
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
