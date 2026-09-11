"""Safe operational reset before a fresh Excel import.

A reset removes current prospecting data that may be rebuilt from the workbook, while retaining
permanent opposition records, audit history, import history and settings/taxonomies.
"""

from dataclasses import dataclass

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.companies import Company
from app.models.enums import ContactabilityStatus
from app.models.prospects import Prospect
from app.services import audit


@dataclass(frozen=True, slots=True)
class ResetResult:
    prospects_deleted: int
    prospects_preserved: int
    companies_deleted: int


def reset_prospecting_data(session: Session, actor: ActorContext) -> ResetResult:
    """Delete rebuildable prospecting data but never erase durable do-not-contact records."""
    prospects = session.scalars(select(Prospect)).all()
    deletable = [
        prospect
        for prospect in prospects
        if prospect.contactability_status is not ContactabilityStatus.DO_NOT_CONTACT
    ]
    preserved = len(prospects) - len(deletable)

    for prospect in deletable:
        # Deletion is captured by the existing audit hook bound to the signed-in actor.
        session.delete(prospect)
    session.flush()

    orphan_companies = session.scalars(
        select(Company).where(
            ~exists(select(Prospect.id).where(Prospect.company_id == Company.id))
        )
    ).all()
    for company in orphan_companies:
        session.delete(company)
    session.flush()

    # Keep a compact bulk event as well; row-level deletions remain available in the audit log.
    audit.record_event(
        session,
        actor,
        "prospecting.reset",
        entity_type="prospecting_database",
        entity_id=None,
        changes={
            "prospects_deleted": {"before": None, "after": len(deletable)},
            "prospects_preserved_do_not_contact": {"before": None, "after": preserved},
            "companies_deleted": {"before": None, "after": len(orphan_companies)},
        },
    )
    return ResetResult(len(deletable), preserved, len(orphan_companies))
