"""ProspectQueryService (Task 14): the Prospection counters and people list, read-only.

Counters and list share one FROM (`segments.join_segment_sources`), the same filter conditions and
the canonical segment predicates, so a counter always equals the total of the list it opens. The
counters are one aggregate statement (`count(*) FILTER (WHERE …)` per segment); a list page is two
(rows with every joined label, then the total) whatever its size — no per-row query.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Any, Literal

from sqlalchemy import (
    ColumnElement,
    Select,
    SQLColumnExpression,
    and_,
    exists,
    false,
    func,
    or_,
    select,
)
from sqlalchemy.orm import Session, aliased

from app.core.business_time import BUSINESS_TIMEZONE
from app.models import (
    Company,
    ContactTracking,
    Email,
    InternalReferent,
    Phone,
    Prospect,
    ProspectSource,
    Role,
)
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    PhoneType,
    VerificationStatus,
)
from app.repositories.taxonomies import label_key
from app.services.prospection.segments import (
    EmailState,
    Segment,
    SegmentContext,
    VerificationState,
    email_state,
    join_segment_sources,
    predicate,
    primary_email,
    segment_counts,
    verification_state,
)

LIST_MAX_LIMIT = 200
# Phone search needs this many digits, so a short number in a name query matches no phone.
PHONE_SEARCH_MIN_DIGITS = 4
# "No value" of the role, referent and tracking-status filters (no role, referent or tracking).
NONE: Literal["none"] = "none"

primary_phone = aliased(Phone, name="primary_phone")


class ProspectSort(StrEnum):
    NAME = "name"  # last name, first name
    COMPANY = "company"  # company name, then person
    PLANNED_CONTACT = "planned_contact"  # soonest planned contact first, none last
    VERIFICATION = "verification"  # never verified first, then oldest verification
    UPDATED = "updated"  # most recently changed first


@dataclass(frozen=True, slots=True)
class ProspectFilters:
    """Criteria applied to both the counters and the list (the segment only to the list)."""

    search: str | None = None
    role: uuid.UUID | Literal["none"] | None = None
    activity: ActivityStatus | None = None
    referent: uuid.UUID | Literal["none"] | None = None
    tracking_status: ContactTrackingStatus | Literal["none"] | None = None
    company_id: uuid.UUID | None = None
    import_batch_id: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class SegmentCounts:
    counts: dict[Segment, int]
    today: date
    stale_threshold_days: int | None


@dataclass(frozen=True, slots=True)
class ProspectRow:
    """One person of the Prospection list (a view model: labels resolved, states derived)."""

    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    role_label: str | None
    exact_job_title: str | None
    company_id: uuid.UUID | None
    company_name: str | None
    activity_status: ActivityStatus
    employment_verified_at: datetime | None
    verification_state: VerificationState
    primary_email: str | None
    primary_email_status: VerificationStatus | None
    email_state: EmailState
    primary_phone: str | None
    primary_phone_type: PhoneType | None
    tracking_status: ContactTrackingStatus | None
    planned_contact_at: datetime | None
    # In the `due` segment: to contact, planned no later than today.
    due: bool
    # ISO 8601 week of the planned contact in business time, e.g. `2026-W38`.
    planned_contact_week: str | None
    response_received_at: datetime | None
    appointment_at: datetime | None
    referent_id: uuid.UUID | None
    referent_name: str | None
    contactability_status: ContactabilityStatus
    do_not_contact_at: datetime | None
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ProspectPage:
    items: list[ProspectRow]
    total: int
    limit: int
    offset: int


# --- conditions --------------------------------------------------------------------------------


def _phone_needle(search: str) -> str | None:
    """Digits of a number-like query (`06 12 34`, `+33 6…`), in the stored `+33…` form's terms:
    a national leading 0 is dropped so it matches inside `+336…`."""
    if not all(char.isdigit() or char in " +.-()" for char in search):
        return None
    digits = "".join(char for char in search if char.isdigit())
    if len(digits) < PHONE_SEARCH_MIN_DIGITS:
        return None
    return digits[1:] if digits.startswith("0") else digits


def search_condition(search: str) -> ColumnElement[bool]:
    """Every word in the person's names or company names (case/accents ignored) or in one of their
    e-mail addresses; a number-like query also matches one of their phone numbers."""
    names = func.concat_ws(
        " ", Prospect.first_name, Prospect.last_name, Company.display_name, Company.legal_name
    )
    words = [
        or_(
            func.strpos(label_key(names), label_key(word)) > 0,
            exists().where(
                Email.prospect_id == Prospect.id,
                Email.address.contains(word.lower(), autoescape=True),
            ),
        )
        for word in search.split()
    ]
    condition: ColumnElement[bool] = and_(*words)
    needle = _phone_needle(search)
    if needle is not None:
        condition = or_(
            condition,
            exists().where(
                Phone.prospect_id == Prospect.id, Phone.number.contains(needle, autoescape=True)
            ),
        )
    return condition


def _optional_ref(
    column: SQLColumnExpression[uuid.UUID | None], value: uuid.UUID | str | None
) -> list[ColumnElement[bool]]:
    if value is None:
        return []
    return [column.is_(None) if value == NONE else column == value]


def filter_conditions(filters: ProspectFilters) -> list[ColumnElement[bool]]:
    """WHERE conditions over `join_segment_sources` rows, shared by counters and list."""
    conditions: list[ColumnElement[bool]] = []
    search = (filters.search or "").strip()
    if search:
        conditions.append(search_condition(search))
    conditions += _optional_ref(Prospect.role_id, filters.role)
    if filters.activity is not None:
        conditions.append(Prospect.activity_status == filters.activity)
    conditions += _optional_ref(ContactTracking.referent_id, filters.referent)
    if filters.tracking_status == NONE:
        conditions.append(ContactTracking.id.is_(None))
    elif filters.tracking_status is not None:
        conditions.append(ContactTracking.status == filters.tracking_status)
    if filters.company_id is not None:
        conditions.append(Prospect.company_id == filters.company_id)
    if filters.import_batch_id is not None:
        conditions.append(
            exists().where(
                ProspectSource.prospect_id == Prospect.id,
                ProspectSource.import_batch_id == filters.import_batch_id,
            )
        )
    return conditions


def _order_by(sort: ProspectSort) -> list[SQLColumnExpression[Any]]:
    keys: list[ColumnElement[Any]]
    person: list[ColumnElement[Any]] = [
        label_key(Prospect.last_name).nulls_last(),
        label_key(Prospect.first_name).nulls_last(),
    ]
    match sort:
        case ProspectSort.NAME:
            keys = person
        case ProspectSort.COMPANY:
            keys = [label_key(Company.display_name).nulls_last(), *person]
        case ProspectSort.PLANNED_CONTACT:
            keys = [ContactTracking.planned_contact_at.asc().nulls_last(), *person]
        case ProspectSort.VERIFICATION:
            keys = [Prospect.employment_verified_at.asc().nulls_first(), *person]
        case ProspectSort.UPDATED:
            keys = [Prospect.updated_at.desc()]
    # The id makes every order total, so pages never overlap or skip rows.
    return [*keys, Prospect.id]


# --- service -----------------------------------------------------------------------------------


def count_segments(
    session: Session, filters: ProspectFilters, context: SegmentContext
) -> SegmentCounts:
    """Every segment's size under `filters`, in one aggregate query."""
    statement = join_segment_sources(select(*segment_counts(context))).where(
        *filter_conditions(filters)
    )
    row = session.execute(statement).one()._mapping
    return SegmentCounts(
        counts={segment: row[segment.value] for segment in Segment},
        today=context.today,
        stale_threshold_days=context.stale_days,
    )


def _page_statement(context: SegmentContext) -> Select[Any]:
    referent_name = func.concat_ws(" ", InternalReferent.first_name, InternalReferent.last_name)
    return (
        join_segment_sources(
            select(
                Prospect,
                Role.label,
                Company.display_name,
                verification_state(context),
                primary_email.address,
                primary_email.verification_status,
                email_state(),
                primary_phone.number,
                primary_phone.type,
                ContactTracking,
                referent_name,
                func.coalesce(predicate(Segment.DUE, context), false()),
            )
        )
        .outerjoin(Role, Role.id == Prospect.role_id)
        .outerjoin(InternalReferent, InternalReferent.id == ContactTracking.referent_id)
        .outerjoin(
            primary_phone,
            and_(primary_phone.prospect_id == Prospect.id, primary_phone.is_primary),
        )
    )


def iso_week(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    year, week, _ = moment.astimezone(BUSINESS_TIMEZONE).isocalendar()
    return f"{year}-W{week:02d}"


def list_prospects(
    session: Session,
    filters: ProspectFilters,
    context: SegmentContext,
    *,
    segment: Segment = Segment.ALL,
    sort: ProspectSort = ProspectSort.NAME,
    limit: int = 50,
    offset: int = 0,
) -> ProspectPage:
    """One page of the prospects in `segment` under `filters`, and their total."""
    limit = max(1, min(limit, LIST_MAX_LIMIT))
    offset = max(0, offset)
    where = [*filter_conditions(filters), predicate(segment, context)]
    rows = session.execute(
        _page_statement(context)
        .where(*where)
        .order_by(*_order_by(sort))
        .limit(limit)
        .offset(offset)
    ).tuples()
    items = []
    for (
        prospect,
        role_label,
        company_name,
        verification,
        email,
        email_status,
        email_kind,
        phone,
        phone_type,
        tracking,
        referent,
        due,
    ) in rows:
        items.append(
            ProspectRow(
                id=prospect.id,
                civility=prospect.civility,
                first_name=prospect.first_name,
                last_name=prospect.last_name,
                role_label=role_label,
                exact_job_title=prospect.exact_job_title,
                company_id=prospect.company_id,
                company_name=company_name,
                activity_status=prospect.activity_status,
                employment_verified_at=prospect.employment_verified_at,
                verification_state=VerificationState(verification),
                primary_email=email,
                primary_email_status=email_status,
                email_state=EmailState(email_kind),
                primary_phone=phone,
                primary_phone_type=phone_type,
                tracking_status=tracking.status if tracking else None,
                planned_contact_at=tracking.planned_contact_at if tracking else None,
                due=due,
                planned_contact_week=iso_week(tracking.planned_contact_at if tracking else None),
                response_received_at=tracking.response_received_at if tracking else None,
                appointment_at=tracking.appointment_at if tracking else None,
                referent_id=tracking.referent_id if tracking else None,
                referent_name=referent or None,
                contactability_status=prospect.contactability_status,
                do_not_contact_at=prospect.do_not_contact_at,
                updated_at=prospect.updated_at,
            )
        )
    total = session.execute(join_segment_sources(select(func.count())).where(*where)).scalar_one()
    return ProspectPage(items=items, total=total, limit=limit, offset=offset)


def prospect_verification_state(
    session: Session, prospect_id: uuid.UUID, context: SegmentContext
) -> VerificationState | None:
    """One prospect's employment verification state, from the list's own expression (the Prospect
    editor shows the same state as the Prospection card). None when the prospect does not exist."""
    state = session.execute(
        join_segment_sources(select(verification_state(context))).where(Prospect.id == prospect_id)
    ).scalar_one_or_none()
    return VerificationState(state) if state is not None else None
