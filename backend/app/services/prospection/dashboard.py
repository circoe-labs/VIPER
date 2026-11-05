"""Prospects dashboard: real sent messages across history and the existing data-quality score.

No per-record requests or loads of the entire base. Quality is aggregated in SQL; the same
expression enriches just the requested page. The interest score from notes is unrelated.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import ColumnElement, case, exists, func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.session import whole_base_plan
from app.models import Company, ContactMessage, Email, Phone, Prospect
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactMessageStatus,
    VerificationStatus,
)
from app.services.prospect_data_quality import DataQualityConfig, band_of
from app.services.prospection.segments import (
    Review,
    Segment,
    SegmentContext,
    join_segment_sources,
    predicate,
    review_predicate,
    verification_validated,
)

ServiceCode = Literal["iguard", "flexisme", "transepteur", "iadvice", "emailing"]
SERVICES = ("iguard", "flexisme", "transepteur", "iadvice", "emailing")


class DashboardOut(BaseModel):
    total: int
    reviews: dict[str, int]
    sends: dict[str, int]
    due: int
    average_quality: float | None
    scored_count: int


def sent_stage(rank: int) -> ColumnElement[bool]:
    """Reached this precise step in any sequence: validated/scheduled are never sent."""
    return exists().where(
        ContactMessage.prospect_id == Prospect.id,
        ContactMessage.status == ContactMessageStatus.SENT,
        ContactMessage.rank == rank,
    )


def quality_sql(now: datetime, config: DataQualityConfig) -> ColumnElement[int | None]:
    active_email = exists().where(Email.prospect_id == Prospect.id, Email.is_active)
    # Primary first, deterministic fallback by id, as in the canonical score service.
    verified_email = (
        select(Email.verification_status)
        .where(Email.prospect_id == Prospect.id, Email.is_active)
        .order_by(Email.is_primary.desc(), Email.id)
        .limit(1)
        .correlate(Prospect)
        .scalar_subquery()
    )
    active_phone = exists().where(Phone.prospect_id == Prospect.id, Phone.is_active)
    verified_phone = exists().where(
        Phone.prospect_id == Prospect.id,
        Phone.is_active,
        Phone.verification_status == VerificationStatus.VERIFIED,
    )
    employment = case((Prospect.employment_verified_at.is_(None), 0), else_=15)
    if config.stale_days is not None:
        employment = case(
            (Prospect.employment_verified_at.is_(None), 0),
            (Prospect.employment_verified_at < now - timedelta(days=config.stale_days), 8),
            else_=15,
        )
    total = (
        case((active_email, 20), else_=0)
        + case((verified_email == VerificationStatus.VERIFIED, 20), else_=0)
        + case((active_phone, 10), else_=0)
        + case((verified_phone, 5), else_=0)
        + employment
        + case((Prospect.activity_status != ActivityStatus.UNKNOWN, 5), else_=0)
        + case((Prospect.company_id.is_not(None), 10), else_=0)
        + case((Prospect.role_id.is_not(None), 10), else_=0)
        + case(
            (func.length(func.trim(func.coalesce(Prospect.exact_job_title, ""))) > 0, 5), else_=0
        )
    )
    return case(
        (Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT, None), else_=total
    )


def overview(session: Session, settings: Settings, *, validated_only: bool = False) -> DashboardOut:
    now = datetime.now(UTC)
    context = SegmentContext.at(now, settings.verification_stale_days)
    quality = quality_sql(now, DataQualityConfig.from_settings(settings))
    statement = join_segment_sources(
        select(
            func.count().label("total"),
            *(
                func.count().filter(review_predicate(review, context)).label(review.value)
                for review in Review
            ),
            *(
                func.count().filter(sent_stage(rank)).label(code)
                for rank, code in enumerate(("sent", "r1", "r2"))
            ),
            func.count().filter(predicate(Segment.DUE, context)).label("due"),
            func.avg(quality).label("average"),
            func.count(quality).label("scored"),
        )
    )
    if validated_only:
        statement = statement.where(verification_validated())
    with whole_base_plan(session):
        row = session.execute(statement).one()._mapping
    return DashboardOut(
        total=row["total"],
        reviews=(
            {"verified": row["total"], "to_verify": 0, "ignored": 0}
            if validated_only
            else {r.value: row[r.value] for r in Review}
        ),
        sends={code: row[code] for code in ("sent", "r1", "r2")},
        due=row["due"],
        average_quality=float(row["average"]) if row["average"] is not None else None,
        scored_count=row["scored"],
    )


def page_details(
    session: Session, ids: list[uuid.UUID], settings: Settings
) -> dict[uuid.UUID, dict[str, Any]]:
    if not ids:
        return {}
    config = DataQualityConfig.from_settings(settings)
    quality = quality_sql(datetime.now(UTC), config)
    rank = (
        select(func.max(ContactMessage.rank))
        .where(
            ContactMessage.prospect_id == Prospect.id,
            ContactMessage.status == ContactMessageStatus.SENT,
        )
        .correlate(Prospect)
        .scalar_subquery()
    )
    statement = (
        select(Prospect.id, Company.company_kind, Company.proposed_services, quality, rank)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .where(Prospect.id.in_(ids))
    )
    with whole_base_plan(session):
        rows = session.execute(statement).all()
    return {
        id_: {
            "company_kind": kind,
            "proposed_services": services or [],
            "quality_score": total,
            "quality_band": band_of(total, config).value if total is not None else None,
            "send_stage": None if highest is None else ("sent", "r1", "r2")[min(highest, 2)],
        }
        for id_, kind, services, total, highest in rows
    }
