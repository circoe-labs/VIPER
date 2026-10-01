"""Data-quality alerts (sequences rework, decisions D8-D9).

- `raise_alert`: a person, an import or the AI raises an alert on a prospect or a company. The
  source comes from the actor, never from the request: `human`, `import` or `ai` (an agent); a
  system job raises none (403 `human_actor_required`). Types: `email_error` and
  `function_to_check` are about a prospect, `company_to_check` about a company,
  `data_inconsistent` and `import_conflict` about either (422 `invalid`, reason
  `subject_type`). One open `email_error` per prospect and source (409 `alert_exists`, with its
  `alert_id`).
- `resolve_alert`: a person closes an open alert (409 `alert_resolved` if already closed; an agent
  or a job may not: 403).

An alert never changes a cohort, a sequence, a state or a contact channel — the AI can only
propose (D8, handoff §14). Its one effect is read elsewhere: an open `email_error` raised by a
person or an import takes the prospect out of the automatic actions (`contact_sequences`).
Audited `quality_alert.created` / `quality_alert.resolved` (subject: the prospect or the
company). Operations flush; the caller owns the transaction.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company, Prospect, QualityAlert
from app.models.enums import QualityAlertSource, QualityAlertType
from app.models.quality_alerts import NOTE_MAX_LENGTH
from app.services import audit
from app.services.audit import AuditAction
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    DomainError,
    InvalidFieldError,
    NotFoundError,
    translated_violations,
    violated_constraint,
)

T = QualityAlertType
SOURCES = {
    ActorType.HUMAN: QualityAlertSource.HUMAN,
    ActorType.IMPORT: QualityAlertSource.IMPORT,
    ActorType.AGENT: QualityAlertSource.AI,
}
PROSPECT_ONLY = (T.EMAIL_ERROR, T.FUNCTION_TO_CHECK)
COMPANY_ONLY = (T.COMPANY_TO_CHECK,)
UNIQUE_EMAIL_ERROR = "uq_quality_alerts_open_email_error"
LIST_MAX_LIMIT = 200


@dataclass(frozen=True, slots=True)
class AlertInput:
    type: QualityAlertType
    prospect_id: uuid.UUID | None = None
    company_id: uuid.UUID | None = None
    note: str | None = None
    # Structured, non-personal context (e.g. `{"field": "exact_job_title"}`).
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AlertFilters:
    prospect_id: uuid.UUID | None = None
    company_id: uuid.UUID | None = None
    type: QualityAlertType | None = None
    # True: open only; False: resolved only; None: both.
    open: bool | None = True


@dataclass(frozen=True, slots=True)
class AlertPage:
    items: list[QualityAlert]
    total: int


def _note(value: str | None, name: str = "note") -> str | None:
    text = (value or "").strip() or None
    if text is not None and len(text) > NOTE_MAX_LENGTH:
        raise InvalidFieldError(name, f"At most {NOTE_MAX_LENGTH} characters.", "too_long")
    return text


def _check_subject(session: Session, data: AlertInput) -> None:
    if (data.prospect_id is None) == (data.company_id is None):
        raise InvalidFieldError(
            "prospect_id", "An alert is about one prospect or one company.", "subject"
        )
    if data.prospect_id is not None:
        if data.type in COMPANY_ONLY:
            raise InvalidFieldError("type", "This alert is about a company.", "subject_type")
        if session.get(Prospect, data.prospect_id) is None:
            raise NotFoundError("Unknown prospect.")
    else:
        if data.type in PROSPECT_ONLY:
            raise InvalidFieldError("type", "This alert is about a prospect.", "subject_type")
        if session.get(Company, data.company_id) is None:
            raise NotFoundError("Unknown company.")


def _open_email_error(
    session: Session, prospect_id: uuid.UUID, source: QualityAlertSource
) -> QualityAlert | None:
    return session.scalar(
        select(QualityAlert).where(
            QualityAlert.prospect_id == prospect_id,
            QualityAlert.type == T.EMAIL_ERROR,
            QualityAlert.source == source,
            QualityAlert.resolved_at.is_(None),
        )
    )


def _exists(alert: QualityAlert | None) -> BusinessRuleError:
    return BusinessRuleError(
        "alert_exists",
        HTTPStatus.CONFLICT,
        "This prospect already has an open alert of this kind.",
        alert_id=str(alert.id) if alert else None,
    )


def raise_alert(session: Session, actor: ActorContext, data: AlertInput) -> QualityAlert:
    source = SOURCES.get(actor.type)
    if source is None:
        raise ActorNotAllowedError("An alert is raised by a person, an import or the AI.")
    _check_subject(session, data)
    note = _note(data.note)
    if data.type is T.EMAIL_ERROR and data.prospect_id is not None:
        existing = _open_email_error(session, data.prospect_id, source)
        if existing is not None:
            raise _exists(existing)
    alert = QualityAlert(
        prospect_id=data.prospect_id,
        company_id=data.company_id,
        type=data.type,
        source=source,
        note=note,
        detail=dict(data.detail),
        raised_by_type=actor.type,
        raised_by_id=actor.id,
        raised_by_display=actor.display,
    )
    audit.annotate(session, actor, alert)

    def duplicate(error: IntegrityError) -> DomainError | None:
        if violated_constraint(error) != UNIQUE_EMAIL_ERROR or data.prospect_id is None:
            return None
        return _exists(_open_email_error(session, data.prospect_id, source))

    with translated_violations(session, duplicate):
        session.add(alert)
    return alert


def get_alert(session: Session, alert_id: uuid.UUID, *, lock: bool = False) -> QualityAlert:
    statement = select(QualityAlert).where(QualityAlert.id == alert_id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    alert = session.scalar(statement)
    if alert is None:
        raise NotFoundError("Unknown alert.")
    return alert


def resolve_alert(
    session: Session,
    actor: ActorContext,
    alert_id: uuid.UUID,
    *,
    note: str | None = None,
    now: datetime | None = None,
) -> QualityAlert:
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("An alert is resolved by a person.")
    alert = get_alert(session, alert_id, lock=True)
    if not alert.is_open:
        raise BusinessRuleError(
            "alert_resolved", HTTPStatus.CONFLICT, "This alert is already resolved."
        )
    resolution = _note(note, "resolution_note")
    audit.annotate(session, actor, alert, AuditAction.QUALITY_ALERT_RESOLVED)
    alert.resolved_at = now or datetime.now(UTC)
    alert.resolved_by_id = actor.id
    alert.resolved_by_display = actor.display
    alert.resolution_note = resolution
    session.flush()
    return alert


def list_alerts(
    session: Session, filters: AlertFilters, *, limit: int = 50, offset: int = 0
) -> AlertPage:
    """Newest first."""
    conditions = []
    if filters.prospect_id is not None:
        conditions.append(QualityAlert.prospect_id == filters.prospect_id)
    if filters.company_id is not None:
        conditions.append(QualityAlert.company_id == filters.company_id)
    if filters.type is not None:
        conditions.append(QualityAlert.type == filters.type)
    if filters.open is not None:
        conditions.append(
            QualityAlert.resolved_at.is_(None)
            if filters.open
            else QualityAlert.resolved_at.is_not(None)
        )
    limit = max(1, min(limit, LIST_MAX_LIMIT))
    items = session.scalars(
        select(QualityAlert)
        .where(*conditions)
        .order_by(QualityAlert.created_at.desc(), QualityAlert.id.desc())
        .limit(limit)
        .offset(max(0, offset))
    ).all()
    total = session.scalar(select(func.count()).select_from(QualityAlert).where(*conditions))
    return AlertPage(items=list(items), total=total or 0)
