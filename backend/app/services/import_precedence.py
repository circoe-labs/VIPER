"""Human precedence over an Excel import (decision D11, handoff §3 and §16).

For every prospect or company field an import could write:

- VIPER empty, file filled → the import fills it;
- same value → nothing;
- different value → VIPER's value stays and a visible `import_conflict` alert is raised on the
  prospect or the company (field, VIPER value, file value, batch and row);
- a field **a person set or emptied** is never filled nor changed by an import: when it is empty
  and the file has a value, the same alert says so (`reason = human_cleared`).

« Set by a person » is derived from the append-only audit log, which already records, for every
change of an audited row, its actor and the fields it touched (`audit_log.changes` keys): a field
counts as human when a `human` event of the prospect or company touched it — except a creation that
left it empty (the editor's untouched default is no decision). No per-field marker is stored: the
audit trail is the provenance, written for every path (editor, Database Explorer, dedicated
endpoints), and an import or a job never writes a `human` event. Channels (e-mails, phones) are
rows of their own: a person who added, changed or deleted one of the prospect's e-mails (or
phones) owns that list. A contact state is human when a person wrote one of its history rows.

Alerts are raised once: an alert of the same subject, type, field and values — open or resolved —
is not raised again, so re-importing a file adds nothing, and a conflict a person settled does not
come back while the values stay the same.
"""

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import ContactTracking, QualityAlert
from app.models.audit import AuditLogEntry
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import ActivityStatus, QualityAlertType
from app.services import quality_alerts

# Values that mean « nothing known » for a field (its empty value).
EMPTY_VALUES: dict[str, frozenset[object]] = {
    "activity_status": frozenset({None, "", ActivityStatus.UNKNOWN.value}),
}
DEFAULT_EMPTY: frozenset[object] = frozenset({None, ""})
# Labels of the fields an import conflict names (alert notes, French).
FIELD_LABELS = {
    "civility": "Civilité",
    "first_name": "Prénom",
    "last_name": "Nom",
    "exact_job_title": "Fonction",
    "activity_status": "Statut d'activité",
    "company_id": "Entreprise",
    "emails": "E-mail",
    "phones": "Téléphone",
    "referent_id": "Référent",
    "contact_state": "État commercial",
    "cohort": "Cohorte",
    "commercial_segment_id": "Segment commercial",
    "activity_category_ids": "Catégories d'activité",
    "address": "Adresse",
    "project_done_with_circoe": "Projet déjà réalisé avec l'entreprise",
    "project_type": "Type de projet",
    "circoe_references": "Références CIRCOE",
    "client_approach": "Approche client",
}


class Reason:
    DIFFERENT = "different"  # VIPER holds another value
    HUMAN_CLEARED = "human_cleared"  # a person emptied the field (or owns the empty list)
    NOT_A_COHORT = "not_a_cohort"  # the cohort cell holds something else (`retraité`)


def is_empty(name: str, value: object) -> bool:
    return value in EMPTY_VALUES.get(name, DEFAULT_EMPTY)


def same_text(left: object, right: object) -> bool:
    """Equal once case and spacing are ignored (a re-typed value is the same value)."""
    if isinstance(left, str) and isinstance(right, str):
        return " ".join(left.split()).casefold() == " ".join(right.split()).casefold()
    return left == right


def human_fields(session: Session, entity_type: str, entity_id: uuid.UUID) -> frozenset[str]:
    """Fields of the row a person set, changed or emptied (from the audit log)."""
    rows = session.execute(
        select(AuditLogEntry.action, AuditLogEntry.changes).where(
            AuditLogEntry.entity_type == entity_type,
            AuditLogEntry.entity_id == entity_id,
            AuditLogEntry.actor_type == ActorType.HUMAN,
        )
    ).all()
    found: set[str] = set()
    for action, changes in rows:
        created = action.endswith(".created")
        for name, change in (changes or {}).items():
            after = change.get("after") if isinstance(change, Mapping) else None
            if created and is_empty(name, after):
                continue
            found.add(name)
    return frozenset(found)


def human_children(
    session: Session, subject_type: str, subject_id: uuid.UUID, entity_types: tuple[str, ...]
) -> frozenset[str]:
    """Which of the subject's child rows (`email`/`phone` of a prospect, `establishment` of a
    company) a person added, changed or deleted: that list is then theirs."""
    kinds = session.scalars(
        select(AuditLogEntry.entity_type)
        .where(
            AuditLogEntry.subject_type == subject_type,
            AuditLogEntry.subject_id == subject_id,
            AuditLogEntry.entity_type.in_(entity_types),
            AuditLogEntry.actor_type == ActorType.HUMAN,
        )
        .distinct()
    ).all()
    return frozenset(kinds)


def human_state(session: Session, prospect_id: uuid.UUID) -> bool:
    """A person chose (one of) the prospect's contact states."""
    return bool(
        session.scalar(
            select(
                exists()
                .where(ContactTracking.prospect_id == prospect_id)
                .where(ContactTrackingStatusHistory.contact_tracking_id == ContactTracking.id)
                .where(ContactTrackingStatusHistory.actor_type == ActorType.HUMAN)
            )
        )
    )


@dataclass(frozen=True, slots=True)
class RowRef:
    """Where an imported value comes from (alert detail, never a personal value)."""

    batch_id: uuid.UUID
    file_name: str
    sheet: str
    row: int


@dataclass
class AlertRecorder:
    """Raises the import's alerts once each (see the module docstring), as the import actor."""

    session: Session
    actor: ActorContext
    raised: int = 0
    skipped: int = 0
    _seen: set[tuple[object, ...]] = field(default_factory=set)

    def conflict(
        self,
        ref: RowRef,
        name: str,
        viper_value: object,
        file_value: object,
        *,
        prospect_id: uuid.UUID | None = None,
        company_id: uuid.UUID | None = None,
        reason: str = Reason.DIFFERENT,
    ) -> None:
        label = FIELD_LABELS.get(name, name)
        note = (
            f"Import : « {label} » a été vidé ou fixé par une personne dans VIPER ; la valeur du"
            " fichier n'est pas appliquée."
            if reason == Reason.HUMAN_CLEARED
            else f"Import : « {label} » diffère entre VIPER et le fichier ; la valeur de VIPER est"
            " conservée."
        )
        self.raise_once(
            QualityAlertType.IMPORT_CONFLICT,
            ref,
            name,
            viper_value,
            file_value,
            reason,
            note,
            prospect_id=prospect_id,
            company_id=company_id,
        )

    def not_a_cohort(self, ref: RowRef, prospect_id: uuid.UUID, file_value: object) -> None:
        self.raise_once(
            QualityAlertType.DATA_INCONSISTENT,
            ref,
            "cohort",
            None,
            file_value,
            Reason.NOT_A_COHORT,
            "Import : la colonne de cohorte contient une valeur qui n'est pas un Sxx ; aucune"
            " cohorte n'est appliquée.",
            prospect_id=prospect_id,
        )

    def raise_once(
        self,
        type_: QualityAlertType,
        ref: RowRef,
        name: str,
        viper_value: object,
        file_value: object,
        reason: str,
        note: str,
        *,
        prospect_id: uuid.UUID | None = None,
        company_id: uuid.UUID | None = None,
    ) -> None:
        key = {
            "field": name,
            "viper_value": _json(viper_value),
            "file_value": _json(file_value),
            "reason": reason,
        }
        subject = (prospect_id, company_id, type_, json.dumps(key, sort_keys=True))
        if subject in self._seen or self._exists(type_, key, prospect_id, company_id):
            self._seen.add(subject)
            self.skipped += 1
            return
        self._seen.add(subject)
        detail = key | {
            "import_batch_id": str(ref.batch_id),
            "file": ref.file_name,
            "sheet": ref.sheet,
            "row": ref.row,
        }
        quality_alerts.raise_alert(
            self.session,
            self.actor,
            quality_alerts.AlertInput(
                type=type_,
                prospect_id=prospect_id,
                company_id=company_id,
                note=note,
                detail=detail,
            ),
        )
        self.raised += 1

    def _exists(
        self,
        type_: QualityAlertType,
        key: dict[str, Any],
        prospect_id: uuid.UUID | None,
        company_id: uuid.UUID | None,
    ) -> bool:
        subject = (
            QualityAlert.prospect_id == prospect_id
            if prospect_id is not None
            else QualityAlert.company_id == company_id
        )
        # Containment narrows by field and reason; the values are compared exactly (JSONB
        # containment of arrays would also match a superset).
        narrowed = {"field": key["field"], "reason": key["reason"]}
        details = self.session.scalars(
            select(QualityAlert.detail).where(
                subject, QualityAlert.type == type_, QualityAlert.detail.contains(narrowed)
            )
        )
        return any(
            detail.get("viper_value") == key["viper_value"]
            and detail.get("file_value") == key["file_value"]
            for detail in details
        )


def _json(value: object) -> object:
    """A value as stored in the alert detail (ids and enums as text)."""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, list | tuple | frozenset | set):
        return sorted(str(item) for item in value)
    return str(value)
