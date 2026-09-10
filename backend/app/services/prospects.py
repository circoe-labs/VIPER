"""Prospect domain rules: durable contactability and company change.

Every operation receives the server-side `ActorContext`, annotates the audit event of each row it
changes (`app.services.audit`) and flushes; the caller owns the transaction and commits (see
overview, "Transaction boundaries").
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import ContactabilityStatus, VerificationStatus
from app.models.prospects import Prospect
from app.repositories import companies as company_repository
from app.repositories import prospects as prospect_repository
from app.services import audit
from app.services.audit import AuditAction
from app.services.errors import DomainError, NotFoundError


def get_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect:
    prospect = prospect_repository.get_prospect(session, prospect_id)
    if prospect is None:
        raise NotFoundError(f"Prospect {prospect_id} not found.")
    return prospect


def mark_do_not_contact(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, *, reason: str | None = None
) -> Prospect:
    """Block the prospect durably. Idempotent: an existing restriction keeps its original date."""
    prospect = get_prospect(session, prospect_id)
    if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
        return prospect
    reason = (reason or "").strip() or None
    audit.annotate(session, actor, prospect, AuditAction.PROSPECT_DO_NOT_CONTACT_SET, reason=reason)
    prospect.contactability_status = ContactabilityStatus.DO_NOT_CONTACT
    prospect.do_not_contact_at = datetime.now(UTC)
    prospect.do_not_contact_reason = reason
    session.flush()
    return prospect


def clear_do_not_contact(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, *, reason: str
) -> Prospect:
    """The only way to lift a do-not-contact restriction: explicit, with a mandatory reason.

    Imports, tracking updates and generic edits cannot do it (the database trigger rejects them).
    The prospect row cannot keep the reason (it only describes an active restriction), so the
    audit event does: `context.reason` of `prospect.do_not_contact.cleared` (decision I-28).
    """
    if not reason.strip():
        raise DomainError("A reason is required to clear a do-not-contact restriction.")
    prospect = get_prospect(session, prospect_id)
    if prospect.contactability_status is ContactabilityStatus.CONTACTABLE:
        return prospect
    audit.annotate(
        session, actor, prospect, AuditAction.PROSPECT_DO_NOT_CONTACT_CLEARED, reason=reason
    )
    prospect_repository.write_cleared_contactability(session, prospect)
    return prospect


def change_company(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, company_id: uuid.UUID
) -> Prospect:
    """Move the prospect to another company and flag what must be re-verified.

    Employment verification is cleared (NULL = current context not verified). Active emails and
    phones are treated as company-dependent in V1: `verified` ones go back to `unverified`, keeping
    `last_verified_at`; nothing is deleted or deactivated. The audit event keeps both company ids
    and names; each re-verified channel gets its own `email/phone.updated` event.
    """
    prospect = get_prospect(session, prospect_id)
    if prospect.company_id == company_id:
        return prospect
    company = company_repository.get_company(session, company_id)
    if company is None:
        raise NotFoundError(f"Company {company_id} not found.")
    previous = (
        company_repository.get_company(session, prospect.company_id)
        if prospect.company_id
        else None
    )
    audit.annotate(
        session,
        actor,
        prospect,
        AuditAction.PROSPECT_COMPANY_CHANGED,
        labels={"company_id": (previous.display_name if previous else None, company.display_name)},
    )
    prospect.company_id = company_id
    prospect.employment_verified_at = None
    for channel in [*prospect.emails, *prospect.phones]:
        if channel.is_active and channel.verification_status is VerificationStatus.VERIFIED:
            audit.annotate(session, actor, channel)
            channel.verification_status = VerificationStatus.UNVERIFIED
    session.flush()
    return prospect
