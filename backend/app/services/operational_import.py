"""Operational reconciliation for the current Circoe prospecting workbook.

The generic import engine remains lossless and conservative. After its atomic commit has built the
entities, this service applies the business meaning explicitly carried by ``Statut_verification``
and the resolved contact week:

- Validé -> employment checked, active, imported e-mail verified;
- Inactif -> employment checked, inactive, imported e-mail invalid;
- Inconnus -> employment checked, outcome unknown, imported e-mail unknown;
- blank/unrecognised -> no verification claim.

The former contact-week rule (« semaine passée → contacté », decision P7) is gone with the
sequences rework (D7, D10): a state is never derived from a week, and the cohorts, imported sends
and Défaillant rows of the workbook are the import redesign of Slice S2.
TODO(S2): D10 also stops ``Statut_verification`` from touching e-mail verification.

All changes happen in the same request transaction as the normal import and are audited.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.business_time import BUSINESS_TIMEZONE
from app.models.enums import OriginType, VerificationStatus
from app.models.imports import ImportRowMetadata
from app.models.prospects import Prospect
from app.services import audit, import_commit, prospects
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
