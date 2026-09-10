"""Prospect domain rules: durable contactability and company change.

Every operation receives the server-side `ActorContext`; Task 05 emits audit events from here.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import ContactabilityStatus, VerificationStatus
from app.models.prospects import Prospect
from app.repositories import companies as company_repository
from app.repositories import prospects as prospect_repository
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
    prospect.contactability_status = ContactabilityStatus.DO_NOT_CONTACT
    prospect.do_not_contact_at = datetime.now(UTC)
    prospect.do_not_contact_reason = (reason or "").strip() or None
    session.commit()
    return prospect


def clear_do_not_contact(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, *, reason: str
) -> Prospect:
    """The only way to lift a do-not-contact restriction: explicit, with a mandatory reason.

    Imports, tracking updates and generic edits cannot do it (the database trigger rejects them).
    The reason is recorded by the audit event (Task 05).
    """
    if not reason.strip():
        raise DomainError("A reason is required to clear a do-not-contact restriction.")
    prospect = get_prospect(session, prospect_id)
    if prospect.contactability_status is ContactabilityStatus.CONTACTABLE:
        return prospect
    prospect_repository.write_cleared_contactability(session, prospect)
    session.commit()
    return prospect


def change_company(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, company_id: uuid.UUID
) -> Prospect:
    """Move the prospect to another company and flag what must be re-verified.

    Employment verification is cleared (NULL = current context not verified). Active emails and
    phones are treated as company-dependent in V1: `verified` ones go back to `unverified`, keeping
    `last_verified_at`; nothing is deleted or deactivated.
    """
    prospect = get_prospect(session, prospect_id)
    if prospect.company_id == company_id:
        return prospect
    if company_repository.get_company(session, company_id) is None:
        raise NotFoundError(f"Company {company_id} not found.")
    prospect.company_id = company_id
    prospect.employment_verified_at = None
    for channel in [*prospect.emails, *prospect.phones]:
        if channel.is_active and channel.verification_status is VerificationStatus.VERIFIED:
            channel.verification_status = VerificationStatus.UNVERIFIED
    session.commit()
    return prospect
