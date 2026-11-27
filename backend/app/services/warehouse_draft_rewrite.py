"""Repeatable repair of existing warehouse drafts (user feedback 2026-11-27, item 1):
`python -m app.cli warehouse-drafts-rewrite [--apply]`.

Never touched: a draft being sent, uncertain or sent; a draft a person saved from the editor. Only
text the former template generated is replaced (`LEGACY_SUBJECTS`, `rewrite_body`), so a second run
changes nothing. A changed draft loses its validation and its programming, never its proposed date.
"""

import logging
from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import AuditLogEntry, ContactMessage, Warehouse, WarehouseDraft
from app.models.enums import ContactMessageStatus
from app.services import audit
from app.services.mail_generation.naming import fold
from app.services.warehouse_draft_text import LEGACY_SUBJECTS, draft_subject, rewrite_body

logger = logging.getLogger(__name__)

LOCKED_STATES = ("sending", "uncertain", "sent")


@dataclass(slots=True)
class RewriteReport:
    # One line per changed draft: id, what changes, former and new subject.
    changes: list[str] = field(default_factory=list)
    edited_by_hand: int = 0
    unchanged: int = 0
    validations_removed: int = 0
    # Unsent AI messages whose subject another message also uses: left to a person.
    duplicate_ai_subjects: int = 0

    def render(self, applied: bool) -> str:
        verb = "Rewritten" if applied else "Would rewrite (dry run, add --apply)"
        return "\n".join(
            [
                *self.changes,
                f"{verb}: {len(self.changes)} warehouse draft(s), of which "
                f"{self.validations_removed} lose their validation or programming.",
                f"Left untouched: {self.edited_by_hand} edited by hand, "
                f"{self.unchanged} with nothing to change.",
                "Unsent AI messages sharing a subject (not changed, regenerate them): "
                f"{self.duplicate_ai_subjects}.",
            ]
        )


def _duplicate_ai_subjects(session: Session) -> int:
    rows = session.execute(
        select(
            ContactMessage.subject, ContactMessage.status, ContactMessage.generation_model
        ).where(
            ContactMessage.status != ContactMessageStatus.CANCELLED, ContactMessage.subject != ""
        )
    ).all()
    uses = Counter(fold(subject) for subject, _, _ in rows)
    return sum(
        model is not None and status != ContactMessageStatus.SENT and uses[fold(subject)] > 1
        for subject, status, model in rows
    )


def rewrite(session: Session, actor: ActorContext, *, apply: bool) -> RewriteReport:
    """Report what would change; write it only with `apply`."""
    report = RewriteReport(duplicate_ai_subjects=_duplicate_ai_subjects(session))
    # The editor's save is the only `updated` event without a reason (automatic ones give one).
    edited = set(
        session.scalars(
            select(AuditLogEntry.entity_id).where(
                AuditLogEntry.entity_type == "warehouse_draft",
                AuditLogEntry.action == "warehouse_draft.updated",
                ~AuditLogEntry.context.has_key("reason"),
            )
        )
    )
    taken = set(session.scalars(select(WarehouseDraft.subject)))
    statement = (
        select(WarehouseDraft, Warehouse.city)
        .join(Warehouse, Warehouse.id == WarehouseDraft.warehouse_id)
        .where(
            WarehouseDraft.send_state.is_(None) | WarehouseDraft.send_state.not_in(LOCKED_STATES)
        )
        .order_by(WarehouseDraft.created_at, WarehouseDraft.id)
    )
    if apply:
        statement = statement.with_for_update(of=WarehouseDraft)
    for draft, city in session.execute(statement).all():
        if draft.id in edited:
            report.edited_by_hand += 1
            continue
        subject = draft.subject
        if subject in LEGACY_SUBJECTS:
            subject = draft_subject(
                draft.contact_role, draft.warehouse_name, draft.contact_name, taken, city
            )
            taken.add(subject)
        body = rewrite_body(draft.body, draft.warehouse_name, draft.contact_role)
        parts = [
            name
            for name, changed in (
                ("subject", subject != draft.subject),
                ("body", body != draft.body),
            )
            if changed
        ]
        if not parts:
            report.unchanged += 1
            continue
        report.changes.append(
            f"{draft.id} [{', '.join(parts)}] « {draft.subject} » -> « {subject} »"
        )
        report.validations_removed += (
            draft.human_validated
            or draft.validated_at is not None
            or draft.send_state == "scheduled"
        )
        if not apply:
            continue
        draft.subject = subject
        draft.body = body
        draft.human_validated = False
        draft.validated_at = None
        draft.validated_by = None
        if draft.send_state == "scheduled":
            draft.send_state = "planned"
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            audit.AuditAction.WAREHOUSE_DRAFT_REWRITTEN,
            entity_type="warehouse_draft",
            entity_id=draft.id,
            reason="Objet personnalisé, fonction et société simplifiées.",
        )
    logger.info(
        "warehouse_drafts.rewrite applied=%s changed=%s edited_by_hand=%s unchanged=%s",
        apply,
        len(report.changes),
        report.edited_by_hand,
        report.unchanged,
    )
    return report
