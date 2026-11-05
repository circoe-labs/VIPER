"""Contact page: real distribution by latest recorded send and separate chart annotations.

One prospect appears in exactly one bar. The fifth bar includes R4 and any later follow-up.
Chart dates are human annotations, never schedules or message send dates.
"""

import uuid
from datetime import date

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.contact_steps import level_keys, level_label
from app.db.session import whole_base_plan
from app.models import AppSetting, ContactMessage, Prospect
from app.models.app_settings import CONTACT_CHART_DATE_KEYS
from app.models.companies import Company
from app.models.enums import ContactMessageStatus, ContactTrackingStatus
from app.services import app_settings, audit
from app.services.contact_dashboard import (
    ContactClock,
    ContactFilters,
    contacted_sql,
    list_conditions,
)
from app.services.errors import ActorNotAllowedError
from app.services.prospection.segments import join_segment_sources


class ChartBar(BaseModel):
    slot: int
    label: str
    count: int
    send_date: date | None


class CompanyChoice(BaseModel):
    id: uuid.UUID
    label: str


class StatusChoice(BaseModel):
    value: str
    label: str


class Overview(BaseModel):
    today: date
    total: int
    bars: list[ChartBar]
    companies: list[CompanyChoice]
    statuses: list[StatusChoice]


STATE_LABELS = {
    ContactTrackingStatus.NEUTRAL: "En séquence",
    ContactTrackingStatus.RESPONSE_RECEIVED: "Réponse reçue",
    ContactTrackingStatus.APPOINTMENT_OBTAINED: "RDV pris",
    ContactTrackingStatus.NOT_INTERESTED: "Non intéressé",
    ContactTrackingStatus.IGNORED: "Ignoré",
    ContactTrackingStatus.DISQUALIFIED: "Défaillant",
}


def overview(session: Session, filters: ContactFilters, clock: ContactClock) -> Overview:
    sends = (
        select(
            ContactMessage.prospect_id,
            ContactMessage.rank,
            func.row_number()
            .over(
                partition_by=ContactMessage.prospect_id,
                order_by=(ContactMessage.sent_at.desc(), ContactMessage.id.desc()),
            )
            .label("position"),
        )
        .where(ContactMessage.status == ContactMessageStatus.SENT)
        .subquery("recorded_sends")
    )
    slot = func.least(sends.c.rank, 4)
    statement = (
        join_segment_sources(select(slot, func.count()))
        .join(sends, sends.c.prospect_id == Prospect.id)
        .where(sends.c.position == 1, *list_conditions(filters, clock.window()))
        .group_by(slot)
    )
    with whole_base_plan(session):
        counts = dict(session.execute(statement).tuples().all())
    dates = dict(
        session.execute(
            select(AppSetting.key, AppSetting.value).where(
                AppSetting.key.in_(CONTACT_CHART_DATE_KEYS)
            )
        )
        .tuples()
        .all()
    )
    companies = (
        session.execute(
            select(Company.id, Company.display_name)
            .join(Prospect, Prospect.company_id == Company.id)
            .where(contacted_sql())
            .distinct()
            .order_by(Company.display_name, Company.id)
        )
        .tuples()
        .all()
    )
    return Overview(
        today=clock.today,
        total=sum(counts.values()),
        bars=[
            ChartBar(
                slot=index,
                label="Contact" if index == 0 else "R4 et suivantes" if index == 4 else f"R{index}",
                count=counts.get(index, 0),
                send_date=dates.get(key),
            )
            for index, key in enumerate(CONTACT_CHART_DATE_KEYS)
        ],
        companies=[CompanyChoice(id=id_, label=label) for id_, label in companies],
        statuses=[
            StatusChoice(value=f"state:{state.value}", label=label)
            for state, label in STATE_LABELS.items()
        ]
        + [
            StatusChoice(value=f"level:{key}", label=level_label(key))
            for key in level_keys(app_settings.max_follow_ups(session))
        ],
    )


def save_date(session: Session, actor: ActorContext, slot: int, value: date | None) -> date | None:
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A chart date is changed by a person.")
    key = CONTACT_CHART_DATE_KEYS[slot]
    # Serialize initial creation as well as updates, with a different lock for each bar.
    session.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(key, 0))))
    row = session.scalar(select(AppSetting).where(AppSetting.key == key).with_for_update())
    stored = value.isoformat() if value is not None else None
    if row is None:
        row = AppSetting(key=key, value=stored)
        session.add(row)
        audit.annotate(session, actor, row)
    elif row.value != stored:
        audit.annotate(session, actor, row)
        row.value = stored
    session.flush()
    return value
