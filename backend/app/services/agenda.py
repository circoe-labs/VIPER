"""Agenda service: the meetings booked by prospects, and what people do about them.

Reads a business-day window; creates a manual meeting; applies a person's follow-up — a new date
(« Décalé »: the count of moves goes up and the meeting is scheduled again), « Effectué », « Ne
s'est pas présenté », « Annulé », the referent in charge, notes. Reminders list the scheduled
meetings of today and tomorrow, each with the last mail the prospect was really sent.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Final

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.business_time import business_day, start_of_day
from app.core.contact_steps import step_label
from app.models import Appointment, Company, ContactMessage, InternalReferent, Prospect
from app.models.enums import AppointmentSource, AppointmentStatus, ContactMessageStatus
from app.services.errors import InvalidFieldError, NotFoundError
from app.services.prospects import get_prospect

NOTES_MAX_LENGTH = 4000
DEFAULT_DURATION = timedelta(minutes=30)
MAX_WINDOW_DAYS = 62


class _Unset:
    """A field the caller did not send (distinct from null, which clears an optional one)."""


UNSET: Final = _Unset()


@dataclass(frozen=True, slots=True)
class AppointmentInput:
    invitee_name: str
    starts_at: datetime
    title: str | None = None
    invitee_email: str | None = None
    company_name: str | None = None
    ends_at: datetime | None = None
    referent_id: uuid.UUID | None = None
    prospect_id: uuid.UUID | None = None
    notes: str | None = None


@dataclass(frozen=True, slots=True)
class AppointmentPatch:
    status: AppointmentStatus | _Unset = UNSET
    starts_at: datetime | _Unset = UNSET
    ends_at: datetime | _Unset | None = UNSET
    referent_id: uuid.UUID | _Unset | None = UNSET
    prospect_id: uuid.UUID | _Unset | None = UNSET
    notes: str | _Unset | None = UNSET


@dataclass(frozen=True, slots=True)
class LastMail:
    step_label: str
    subject: str
    body_text: str
    sent_at: datetime


def get_appointment(session: Session, appointment_id: uuid.UUID) -> Appointment:
    appointment = session.get(Appointment, appointment_id)
    if appointment is None:
        raise NotFoundError(f"Appointment {appointment_id} not found.")
    return appointment


def list_appointments(session: Session, start: date, end: date) -> list[Appointment]:
    """The meetings starting on a business day of `start`..`end` (inclusive), earliest first."""
    if end < start:
        raise InvalidFieldError("end", "The end of the window is before its start.", "range")
    if (end - start).days > MAX_WINDOW_DAYS:
        raise InvalidFieldError("end", f"The window is limited to {MAX_WINDOW_DAYS} days.", "range")
    return list(
        session.scalars(
            select(Appointment)
            .where(
                Appointment.starts_at >= start_of_day(start),
                Appointment.starts_at < start_of_day(end + timedelta(days=1)),
            )
            .order_by(Appointment.starts_at, Appointment.created_at)
        )
    )


def reminders(session: Session, today: date) -> tuple[list[Appointment], list[Appointment]]:
    """The scheduled meetings of `today` and of the next day."""
    rows = list_appointments(session, today, today + timedelta(days=1))
    scheduled = [row for row in rows if row.status is AppointmentStatus.SCHEDULED]
    return (
        [row for row in scheduled if business_day(row.starts_at) == today],
        [row for row in scheduled if business_day(row.starts_at) != today],
    )


def last_mails(session: Session, prospect_ids: set[uuid.UUID]) -> dict[uuid.UUID, LastMail]:
    """The last mail really sent to each prospect (a sent message is immutable)."""
    found: dict[uuid.UUID, LastMail] = {}
    if not prospect_ids:
        return found
    rows = session.scalars(
        select(ContactMessage)
        .where(
            ContactMessage.prospect_id.in_(prospect_ids),
            ContactMessage.status == ContactMessageStatus.SENT,
            ContactMessage.sent_at.is_not(None),
        )
        .order_by(ContactMessage.sent_at.desc())
    )
    for message in rows:
        if message.prospect_id not in found and message.sent_at is not None:
            found[message.prospect_id] = LastMail(
                step_label=step_label(message.rank),
                subject=message.subject,
                body_text=message.body_text,
                sent_at=message.sent_at,
            )
    return found


def _clean(value: str | None, limit: int, field: str) -> str | None:
    text = (value or "").strip()
    if len(text) > limit:
        raise InvalidFieldError(field, f"At most {limit} characters.", "length")
    return text or None


def _check_links(
    session: Session, prospect_id: uuid.UUID | None, referent_id: uuid.UUID | None
) -> None:
    if prospect_id is not None:
        get_prospect(session, prospect_id)
    if referent_id is not None and session.get(InternalReferent, referent_id) is None:
        raise NotFoundError(f"Referent {referent_id} not found.")


def create_appointment(
    session: Session, actor: ActorContext, data: AppointmentInput
) -> Appointment:
    name = _clean(data.invitee_name, 300, "invitee_name")
    if name is None:
        raise InvalidFieldError("invitee_name", "Name the person.", "blank")
    ends = data.ends_at or data.starts_at + DEFAULT_DURATION
    if ends < data.starts_at:
        raise InvalidFieldError("ends_at", "The end is before the start.", "range")
    _check_links(session, data.prospect_id, data.referent_id)
    email = _clean(data.invitee_email, 320, "invitee_email")
    appointment = Appointment(
        source=AppointmentSource.MANUAL,
        title=_clean(data.title, 300, "title") or "Rendez-vous",
        invitee_name=name,
        invitee_email=email.lower() if email else None,
        company_name=_clean(data.company_name, 300, "company_name"),
        starts_at=data.starts_at,
        ends_at=ends,
        status=AppointmentStatus.SCHEDULED,
        reschedule_count=0,
        referent_id=data.referent_id,
        prospect_id=data.prospect_id,
        notes=_clean(data.notes, NOTES_MAX_LENGTH, "notes"),
    )
    if data.prospect_id is not None and appointment.company_name is None:
        prospect = get_prospect(session, data.prospect_id)
        company = session.get(Company, prospect.company_id) if prospect.company_id else None
        if company is not None:
            appointment.company_name = company.display_name[:300]
    session.add(appointment)
    session.flush()
    return appointment


def update_appointment(
    session: Session, actor: ActorContext, appointment_id: uuid.UUID, patch: AppointmentPatch
) -> Appointment:
    appointment = get_appointment(session, appointment_id)
    if not isinstance(patch.referent_id, _Unset) or not isinstance(patch.prospect_id, _Unset):
        _check_links(
            session,
            None if isinstance(patch.prospect_id, _Unset) else patch.prospect_id,
            None if isinstance(patch.referent_id, _Unset) else patch.referent_id,
        )
    if not isinstance(patch.starts_at, _Unset):
        # « Décalé »: a new date. The length is kept unless a new end comes with it; the meeting is
        # on again (a moved meeting is neither a no-show nor cancelled), and the move is counted.
        length = appointment.ends_at - appointment.starts_at
        appointment.starts_at = patch.starts_at
        new_end = None if isinstance(patch.ends_at, _Unset) else patch.ends_at
        appointment.ends_at = new_end or patch.starts_at + length
        if appointment.ends_at < appointment.starts_at:
            raise InvalidFieldError("ends_at", "The end is before the start.", "range")
        appointment.reschedule_count += 1
        appointment.status = AppointmentStatus.SCHEDULED
    if not isinstance(patch.status, _Unset):
        appointment.status = patch.status
    if not isinstance(patch.referent_id, _Unset):
        appointment.referent_id = patch.referent_id
    if not isinstance(patch.prospect_id, _Unset):
        appointment.prospect_id = patch.prospect_id
    if not isinstance(patch.notes, _Unset):
        appointment.notes = _clean(patch.notes, NOTES_MAX_LENGTH, "notes")
    session.flush()
    return appointment


def prospect_names(session: Session, prospect_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not prospect_ids:
        return {}
    names: dict[uuid.UUID, str] = {}
    for prospect in session.scalars(select(Prospect).where(Prospect.id.in_(prospect_ids))):
        names[prospect.id] = (
            " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
            or "Sans nom"
        )
    return names


def referent_labels(session: Session, referent_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not referent_ids:
        return {}
    return {
        referent.id: f"{referent.first_name} {referent.last_name}"
        for referent in session.scalars(
            select(InternalReferent).where(InternalReferent.id.in_(referent_ids))
        )
    }


def now_utc() -> datetime:
    return datetime.now(UTC)
