"""Cohorts (`Sxx`, decision D5): the prospecting sessions and their real start dates.

- a code is normalized to `S<n>` (case, spaces, `sem`/`semaine` prefixes and leading zeros
  ignored: « s 037 » → `S37`); anything else is refused (422 `invalid`, reason `cohort_code`);
- every cohort but `S0` has its real start date, entered by a person — never derived from an ISO
  week; `S0` (validated, out of campaign) has none, cannot be renamed, re-dated nor deleted
  (409 `cohort_s0_fixed`);
- codes are unique (409 `duplicate`, with the existing cohort): reusing `S37` next year means
  renaming the old one first;
- confirming a date or a code clears `needs_review` (cohorts created by migration 0012);
- a cohort in use by a sequence (current or past) cannot be deleted (409 `in_use`).

Only a person writes cohorts (403 `human_actor_required`). Audited through the flush hook
(`cohort.created|updated|deleted`). Operations flush; the caller owns the transaction.
"""

import uuid
from dataclasses import dataclass
from datetime import date
from http import HTTPStatus

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.cohort_codes import OUT_OF_CAMPAIGN_CODE
from app.core.cohort_codes import normalize_code as normalize_code  # the service's code rule
from app.models import Cohort, ContactSequence
from app.services import audit
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    DomainError,
    DuplicateValueError,
    ExistingValue,
    InUseError,
    InvalidFieldError,
    NotFoundError,
    translated_violations,
    violated_constraint,
)

UNIQUE_CODE = "uq_cohorts_code"


@dataclass(frozen=True, slots=True)
class CohortView:
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool
    # Prospects whose current sequence is in this cohort, and every sequence ever in it.
    current_count: int
    sequence_count: int


def _code(raw: str) -> str:
    code = normalize_code(raw)
    if code is None:
        raise InvalidFieldError("code", "Expected a cohort code such as S37.", "cohort_code")
    return code


def _require_writer(actor: ActorContext) -> None:
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A cohort is created and dated by a person.")


def _s0_fixed() -> BusinessRuleError:
    return BusinessRuleError(
        "cohort_s0_fixed", HTTPStatus.CONFLICT, "S0 is the fixed out-of-campaign cohort."
    )


def _duplicate(error: IntegrityError, session: Session, code: str) -> DomainError | None:
    if violated_constraint(error) != UNIQUE_CODE:
        return None
    existing = session.scalar(select(Cohort).where(Cohort.code == code))
    return DuplicateValueError(
        "code", ExistingValue(existing.id, existing.code, True) if existing else None
    )


def _checked_date(code: str, starts_on: date | None) -> date | None:
    if code == OUT_OF_CAMPAIGN_CODE:
        if starts_on is not None:
            raise InvalidFieldError("starts_on", "S0 has no date.", "s0_without_date")
        return None
    if starts_on is None:
        raise InvalidFieldError("starts_on", "A cohort needs its real start date.", "required")
    return starts_on


def list_cohorts(session: Session, cohort_id: uuid.UUID | None = None) -> list[CohortView]:
    """Every cohort (or one) with its usage, S0 first then by start date and code."""
    current = func.count().filter(ContactSequence.is_current)
    statement = select(Cohort, current, func.count(ContactSequence.id))
    if cohort_id is not None:
        statement = statement.where(Cohort.id == cohort_id)
    rows = session.execute(
        statement.outerjoin(ContactSequence, ContactSequence.cohort_id == Cohort.id)
        .group_by(Cohort.id)
        .order_by(
            (Cohort.code != OUT_OF_CAMPAIGN_CODE).asc(),
            Cohort.starts_on.asc().nulls_first(),
            Cohort.code,
        )
    ).all()
    return [_view(cohort, current_count, total) for cohort, current_count, total in rows]


def _view(cohort: Cohort, current_count: int, sequence_count: int) -> CohortView:
    return CohortView(
        id=cohort.id,
        code=cohort.code,
        starts_on=cohort.starts_on,
        out_of_campaign=cohort.out_of_campaign,
        needs_review=cohort.needs_review,
        current_count=current_count,
        sequence_count=sequence_count,
    )


def get_cohort(session: Session, cohort_id: uuid.UUID) -> Cohort:
    cohort = session.get(Cohort, cohort_id)
    if cohort is None:
        raise NotFoundError("Unknown cohort.")
    return cohort


def get_view(session: Session, cohort_id: uuid.UUID) -> CohortView:
    views = list_cohorts(session, cohort_id)
    if not views:
        raise NotFoundError("Unknown cohort.")
    return views[0]


def find_by_code(session: Session, raw: str) -> Cohort | None:
    code = normalize_code(raw)
    return session.scalar(select(Cohort).where(Cohort.code == code)) if code else None


def create_cohort(
    session: Session, actor: ActorContext, code: str, starts_on: date | None
) -> Cohort:
    _require_writer(actor)
    normalized = _code(code)
    cohort = Cohort(code=normalized, starts_on=_checked_date(normalized, starts_on))
    audit.annotate(session, actor, cohort)
    with translated_violations(session, lambda error: _duplicate(error, session, normalized)):
        session.add(cohort)
    return cohort


def update_cohort(
    session: Session,
    actor: ActorContext,
    cohort_id: uuid.UUID,
    *,
    code: str | None = None,
    starts_on: date | None = None,
) -> Cohort:
    """Rename and/or re-date; either confirms the cohort (`needs_review` cleared)."""
    _require_writer(actor)
    cohort = get_cohort(session, cohort_id)
    if cohort.out_of_campaign:
        raise _s0_fixed()
    normalized = _code(code) if code is not None else cohort.code
    if normalized == OUT_OF_CAMPAIGN_CODE:
        raise _s0_fixed()
    day = _checked_date(normalized, starts_on if starts_on is not None else cohort.starts_on)
    audit.annotate(session, actor, cohort)
    with translated_violations(session, lambda error: _duplicate(error, session, normalized)):
        cohort.code = normalized
        cohort.starts_on = day
        cohort.needs_review = False
    return cohort


def delete_cohort(session: Session, actor: ActorContext, cohort_id: uuid.UUID) -> None:
    _require_writer(actor)
    cohort = get_cohort(session, cohort_id)
    if cohort.out_of_campaign:
        raise _s0_fixed()
    used = session.scalar(
        select(func.count())
        .select_from(ContactSequence)
        .where(ContactSequence.cohort_id == cohort.id)
    )
    if used:
        raise InUseError({"sequences": used or 0})
    audit.annotate(session, actor, cohort)
    session.delete(cohort)
    session.flush()
