"""Prospect domain rules: creation with contact channels, durable contactability, company change.

Every operation receives the server-side `ActorContext`, annotates the audit event of each row it
changes (`app.services.audit`) and flushes; the caller owns the transaction and commits (see
overview, "Transaction boundaries").
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    OriginType,
    PhoneType,
    VerificationStatus,
)
from app.models.prospects import Email, Phone, Prospect
from app.repositories import companies as company_repository
from app.repositories import prospects as prospect_repository
from app.services import audit
from app.services.audit import AuditAction
from app.services.errors import DomainError, NotFoundError


@dataclass(frozen=True, slots=True)
class ChannelInput:
    """An e-mail address (normalized, lowercase) or a phone number (digits, optional `+`)."""

    value: str
    is_primary: bool = False
    phone_type: PhoneType | None = None  # phones only
    origin_type: OriginType = OriginType.MANUAL
    source_reference: str | None = None


@dataclass(frozen=True, slots=True)
class ProspectInput:
    first_name: str | None
    last_name: str | None
    civility: Civility | None = None
    company_id: uuid.UUID | None = None
    role_id: uuid.UUID | None = None
    exact_job_title: str | None = None
    activity_status: ActivityStatus = ActivityStatus.UNKNOWN
    emails: Sequence[ChannelInput] = ()
    phones: Sequence[ChannelInput] = ()


def get_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect:
    prospect = prospect_repository.get_prospect(session, prospect_id)
    if prospect is None:
        raise NotFoundError(f"Prospect {prospect_id} not found.")
    return prospect


def create_prospect(session: Session, actor: ActorContext, data: ProspectInput) -> Prospect:
    """A new contactable prospect with its e-mails and phones, in one flush. Channels start
    `unverified` and the employment context is not verified (NULL): nothing is verified by
    creating it. One audit event per row (`prospect.created`, `email.created`, `phone.created`)."""
    if not (data.first_name or "").strip() and not (data.last_name or "").strip():
        raise DomainError("A prospect needs a first or a last name.")
    prospect = Prospect(
        first_name=data.first_name,
        last_name=data.last_name,
        civility=data.civility,
        company_id=data.company_id,
        role_id=data.role_id,
        exact_job_title=data.exact_job_title,
        activity_status=data.activity_status,
    )
    audit.annotate(session, actor, prospect)
    session.add(prospect)
    for email in data.emails:
        _add_email(session, actor, prospect, email)
    for phone in data.phones:
        _add_phone(session, actor, prospect, phone)
    session.flush()
    return prospect


def _add_email(
    session: Session, actor: ActorContext, prospect: Prospect, data: ChannelInput
) -> Email:
    email = Email(
        address=data.value,
        is_primary=data.is_primary,
        origin_type=data.origin_type,
        verification_status=VerificationStatus.UNVERIFIED,
        source_reference=data.source_reference,
    )
    audit.annotate(session, actor, email)
    prospect.emails.append(email)
    return email


def _add_phone(
    session: Session, actor: ActorContext, prospect: Prospect, data: ChannelInput
) -> Phone:
    if data.phone_type is None:
        raise DomainError("A phone number needs its type.")
    phone = Phone(
        number=data.value,
        type=data.phone_type,
        is_primary=data.is_primary,
        origin_type=data.origin_type,
        verification_status=VerificationStatus.UNVERIFIED,
        source_reference=data.source_reference,
    )
    audit.annotate(session, actor, phone)
    prospect.phones.append(phone)
    return phone


def add_channels(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    *,
    emails: Sequence[ChannelInput] = (),
    phones: Sequence[ChannelInput] = (),
) -> tuple[list[Email], list[Phone]]:
    """Add the e-mails and phones the prospect does not have yet (same address/number, active or
    not, is kept as it is: a former channel is never silently reactivated). A new channel becomes
    primary only when the prospect has no active primary of that kind and it asks to be."""
    known_emails = {email.address for email in prospect.emails}
    known_phones = {phone.number for phone in prospect.phones}
    has_primary_email = any(email.is_primary for email in prospect.emails)
    has_primary_phone = any(phone.is_primary for phone in prospect.phones)
    added_emails = []
    for data in emails:
        if data.value in known_emails:
            continue
        primary = data.is_primary and not has_primary_email
        has_primary_email |= primary
        known_emails.add(data.value)
        added_emails.append(_add_email(session, actor, prospect, replace(data, is_primary=primary)))
    added_phones = []
    for data in phones:
        if data.value in known_phones:
            continue
        primary = data.is_primary and not has_primary_phone
        has_primary_phone |= primary
        known_phones.add(data.value)
        added_phones.append(_add_phone(session, actor, prospect, replace(data, is_primary=primary)))
    session.flush()
    return added_emails, added_phones


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
