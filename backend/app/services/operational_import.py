"""Operational reconciliation for the current Circoe prospecting workbook.

The generic import engine remains lossless and conservative. After its atomic commit has built the
entities, this service applies the business meaning explicitly carried by ``Statut_verification``
and the resolved contact week:

- Validé -> employment checked, active, imported e-mail verified;
- Inactif -> employment checked, inactive, imported e-mail invalid;
- Inconnus -> employment checked, outcome unknown, imported e-mail unknown;
- blank/unrecognised -> no verification claim;
- the row's own contact week in the past -> ``contacted`` when the tracking is still ``neutral``,
  with the next action moved to the default cadence (that week + 2 weeks, its Monday: the R1
  week, decision P7) instead of the past week;
- the row's referent is not assigned while the prospect stays ``neutral`` (not contacted); a
  referent already on the tracking (e.g. set by hand) is never removed.

Only values that come from the file for that row are read (``CommitResult.file_tracking``): a week
or referent set earlier, by hand or by another import, is left alone.

All changes happen in the same request transaction as the normal import and are audited.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.business_time import BUSINESS_TIMEZONE, business_day
from app.models.enums import ContactTrackingStatus, OriginType, VerificationStatus
from app.models.imports import ImportRowMetadata
from app.models.prospects import Prospect
from app.services import audit, import_commit, prospects
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.contact_workflow import next_action_at, suggest_next_action
from app.services.imports.decisions import ImportDecisions
from app.services.imports.fields import ImportField
from app.services.imports.preview import ImportFile
from app.services.imports.verification import (
    ExcelVerificationOutcome,
    activity_status,
    email_verification_status,
    verification_value,
    was_checked,
)
from app.services.imports.workbook import ImportLimits


def commit_import(
    session: Session,
    actor: ActorContext,
    file: ImportFile,
    decisions: ImportDecisions,
    limits: ImportLimits,
) -> import_commit.CommitResult:
    """Run the generic import then reconcile operational workbook semantics."""
    result = import_commit.commit_import(session, actor, file, decisions, limits)
    reconcile_batch(session, actor, result)
    return result


def reconcile_batch(
    session: Session, actor: ActorContext, result: import_commit.CommitResult
) -> None:
    metadata = session.scalars(
        select(ImportRowMetadata)
        .where(ImportRowMetadata.import_batch_id == result.batch.id)
        .order_by(ImportRowMetadata.source_row_number)
    ).all()
    checked_at = datetime.now(BUSINESS_TIMEZONE)
    today = checked_at.date()

    for trace in metadata:
        if trace.prospect_id is None:
            continue
        prospect = prospects.get_prospect(session, trace.prospect_id)
        raw = trace.legacy_metadata.get(ImportField.VERIFICATION_STATUS.value)
        raw_value = raw.get("value") if isinstance(raw, dict) else None
        outcome = verification_value(raw_value)

        if was_checked(outcome):
            audit.annotate(session, actor, prospect)
            prospect.activity_status = activity_status(outcome)
            prospect.employment_verified_at = checked_at
            _apply_imported_email_verification(session, actor, prospect, outcome, checked_at)
            session.flush()

        tracking = prospect.contact_tracking
        from_file = result.file_tracking.get(prospect.id)
        if tracking is None or from_file is None:
            continue

        next_status = tracking.status
        next_action = tracking.planned_contact_at
        week = from_file.planned_contact_at
        if (
            week is not None
            and tracking.planned_contact_at == week
            and business_day(week) < today
            and tracking.status is ContactTrackingStatus.NEUTRAL
        ):
            next_status = ContactTrackingStatus.CONTACTED
            follow_up = suggest_next_action(next_status, business_day(week))
            assert follow_up is not None  # `contacted` always has a cadence
            next_action = next_action_at(follow_up)

        next_referent = tracking.referent_id
        if next_status is ContactTrackingStatus.NEUTRAL and from_file.referent_written:
            next_referent = None
        if (next_status, next_action, next_referent) != (
            tracking.status,
            tracking.planned_contact_at,
            tracking.referent_id,
        ):
            save_contact_tracking(
                session,
                actor,
                prospect.id,
                ContactTrackingInput(
                    status=next_status,
                    planned_contact_at=next_action,
                    referent_id=next_referent,
                    response_received_at=tracking.response_received_at,
                    appointment_at=tracking.appointment_at,
                ),
            )


def _apply_imported_email_verification(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    outcome: ExcelVerificationOutcome,
    checked_at: datetime,
) -> None:
    wanted = email_verification_status(outcome)
    for email in prospect.emails:
        if email.origin_type is not OriginType.IMPORTED:
            continue
        if email.verification_status is wanted:
            continue
        if (
            email.verification_status is VerificationStatus.VERIFIED
            and wanted is not VerificationStatus.VERIFIED
        ):
            continue
        audit.annotate(session, actor, email)
        email.verification_status = wanted
        email.last_verified_at = checked_at if wanted is VerificationStatus.VERIFIED else None
