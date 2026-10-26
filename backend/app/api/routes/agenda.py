"""Agenda API: the meetings booked by prospects and their follow-up.

- `GET   /api/agenda/appointments?start=&end=` — the meetings of a window of business days;
- `POST  /api/agenda/appointments` — a meeting added by hand;
- `PATCH /api/agenda/appointments/{id}` — follow-up: `status` (effectué, absent, annulé, rétabli),
  `starts_at` (« Décalé »: the new date, the move is counted), the referent, the prospect, notes;
- `POST  /api/agenda/sync` — reads Calendly now (the worker does it regularly), answers what changed
  or, when Calendly cannot be read, a stable `code` (`calendly_not_configured`,
  `calendly_unauthorized`, `calendly_rate_limited`, `calendly_unreachable`);
- `GET   /api/agenda/reminders` — the scheduled meetings of today and tomorrow, each with the last
  mail really sent to the prospect.

Refusals: `app.api.errors` (404 `not_found`, 422 `invalid`).
"""

import uuid
from datetime import date, datetime
from typing import Any

import httpx2
from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.core.business_time import business_day
from app.models import Appointment
from app.models.enums import AppointmentSource, AppointmentStatus
from app.services import agenda
from app.services.agenda import UNSET, AppointmentInput, AppointmentPatch, LastMail
from app.services.calendly import CalendlyClient, CalendlyError, sync_appointments

router = APIRouter(prefix="/agenda", tags=["agenda"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProspectRef(BaseModel):
    id: uuid.UUID
    name: str


class ReferentRef(BaseModel):
    id: uuid.UUID
    label: str


class LastMailOut(BaseModel):
    step_label: str
    subject: str
    body_text: str
    sent_at: datetime


class AppointmentOut(BaseModel):
    id: uuid.UUID
    source: AppointmentSource
    title: str
    invitee_name: str
    invitee_email: str | None
    company_name: str | None
    host_name: str | None
    host_email: str | None
    starts_at: datetime
    ends_at: datetime
    location: str | None
    status: AppointmentStatus
    reschedule_count: int
    notes: str | None
    prospect: ProspectRef | None
    referent: ReferentRef | None
    last_mail: LastMailOut | None


class AppointmentsOut(BaseModel):
    items: list[AppointmentOut]


class RemindersOut(BaseModel):
    today: list[AppointmentOut]
    tomorrow: list[AppointmentOut]


class SyncOut(BaseModel):
    ok: bool
    code: str | None = None
    created: int = 0
    updated: int = 0
    cancelled: int = 0


class AppointmentIn(StrictModel):
    invitee_name: str
    starts_at: datetime
    title: str | None = None
    invitee_email: str | None = None
    company_name: str | None = None
    ends_at: datetime | None = None
    referent_id: uuid.UUID | None = None
    prospect_id: uuid.UUID | None = None
    notes: str | None = None


class AppointmentPatchIn(StrictModel):
    status: AppointmentStatus | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    referent_id: uuid.UUID | None = None
    prospect_id: uuid.UUID | None = None
    notes: str | None = None


def appointments_out(
    session: Any, rows: list[Appointment], *, with_mail: bool = False
) -> list[AppointmentOut]:
    prospects = agenda.prospect_names(session, {r.prospect_id for r in rows if r.prospect_id})
    referents = agenda.referent_labels(session, {r.referent_id for r in rows if r.referent_id})
    mails: dict[uuid.UUID, LastMail] = (
        agenda.last_mails(session, {r.prospect_id for r in rows if r.prospect_id})
        if with_mail
        else {}
    )
    return [
        AppointmentOut(
            id=row.id,
            source=row.source,
            title=row.title,
            invitee_name=row.invitee_name,
            invitee_email=row.invitee_email,
            company_name=row.company_name,
            host_name=row.host_name,
            host_email=row.host_email,
            starts_at=row.starts_at,
            ends_at=row.ends_at,
            location=row.location,
            status=row.status,
            reschedule_count=row.reschedule_count,
            notes=row.notes,
            prospect=ProspectRef(id=row.prospect_id, name=prospects.get(row.prospect_id, ""))
            if row.prospect_id
            else None,
            referent=ReferentRef(id=row.referent_id, label=referents.get(row.referent_id, ""))
            if row.referent_id
            else None,
            last_mail=LastMailOut(**vars_of(mails[row.prospect_id]))
            if row.prospect_id in mails
            else None,
        )
        for row in rows
    ]


def vars_of(mail: LastMail) -> dict[str, Any]:
    return {
        "step_label": mail.step_label,
        "subject": mail.subject,
        "body_text": mail.body_text,
        "sent_at": mail.sent_at,
    }


@router.get("/appointments")
def list_appointments(session: SessionDep, start: date, end: date) -> AppointmentsOut:
    with business_errors():
        rows = agenda.list_appointments(session, start, end)
        # The mail recap is shown in the detail, so the grid carries it too (a few rows at most).
        return AppointmentsOut(items=appointments_out(session, rows, with_mail=True))


@router.post("/appointments", status_code=status.HTTP_201_CREATED)
def create_appointment(
    payload: AppointmentIn, session: SessionDep, actor: CurrentActor
) -> AppointmentOut:
    with business_errors():
        row = agenda.create_appointment(session, actor, AppointmentInput(**payload.model_dump()))
        return appointments_out(session, [row], with_mail=True)[0]


@router.patch("/appointments/{appointment_id}")
def update_appointment(
    appointment_id: uuid.UUID,
    payload: AppointmentPatchIn,
    session: SessionDep,
    actor: CurrentActor,
) -> AppointmentOut:
    sent = payload.model_fields_set
    patch = AppointmentPatch(
        **{
            name: getattr(payload, name)
            if name in sent and (name != "status" or payload.status)
            else UNSET
            for name in AppointmentPatchIn.model_fields
        }
    )
    with business_errors():
        row = agenda.update_appointment(session, actor, appointment_id, patch)
        return appointments_out(session, [row], with_mail=True)[0]


@router.get("/reminders")
def reminders(session: SessionDep) -> RemindersOut:
    today = business_day(agenda.now_utc())
    with business_errors():
        todays, tomorrows = agenda.reminders(session, today)
        return RemindersOut(
            today=appointments_out(session, todays, with_mail=True),
            tomorrow=appointments_out(session, tomorrows, with_mail=True),
        )


def calendly_client(request: Request, settings: SettingsDep) -> CalendlyClient | None:
    token = settings.calendly_api_token
    if token is None:
        return None
    transport: httpx2.BaseTransport | None = getattr(request.app.state, "calendly_transport", None)
    return CalendlyClient(token.get_secret_value(), transport=transport)


@router.post("/sync")
def sync(
    request: Request, session: SessionDep, settings: SettingsDep, actor: CurrentActor
) -> SyncOut:
    client = calendly_client(request, settings)
    if client is None:
        return SyncOut(ok=False, code="calendly_not_configured")
    try:
        report = sync_appointments(session, client)
    except CalendlyError as error:
        return SyncOut(ok=False, code=error.code)
    return SyncOut(
        ok=True, created=report.created, updated=report.updated, cancelled=report.cancelled
    )
