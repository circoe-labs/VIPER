"""AuditService: append-only "who changed what, when" (ADR-0006, `audit-and-provenance.md`).

How a mutation gets audited — services never write audit rows for row changes themselves:

1. The caller binds the server-side actor and context to the session: every protected HTTP
   request does it in `require_session`; imports use `import_batches.importing`; CLI, seed, jobs
   and agents open `attributed_unit_of_work(session_factory, actor)`.
2. A service that changes an audited row calls `annotate(session, actor, row, action, reason=…)`
   *before* the flush that writes the change, to say who does it and what it means.
3. At flush, one hook writes exactly one event per changed audited row, in the same transaction:
   the annotated action, or `<entity>.created|updated|deleted` with the bound actor when nobody
   annotated the row (the safety net for generic writes such as Database Explorer edits). It
   fails closed: an audited row changed with neither an annotation nor a binding raises
   `UnattributedMutationError` and the transaction rolls back.

Events that are not row changes (sign-in, bulk inserts) use `record_event`. Change sets hold only
changed fields and pass through the payload policy (`app.core.audit_policy`) before storage.
"""

import re
import uuid
from collections.abc import Collection, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session, SessionTransaction, UOWTransaction, sessionmaker
from sqlalchemy.orm.attributes import instance_state

from app.core import audit_policy
from app.core.actor import ActorContext, ActorType
from app.db.session import unit_of_work
from app.models import (
    ActivityCategory,
    CommercialSegment,
    Company,
    ContactTracking,
    Email,
    Establishment,
    ImportBatch,
    InternalReferent,
    Phone,
    Prospect,
    ProspectSource,
    Role,
)
from app.models.audit import AuditLogEntry
from app.repositories import audit as audit_repository
from app.services.audit_changes import (
    ChangeSet,
    created_changes,
    deleted_changes,
    pending_changes,
    to_json,
)


class AuditSource(StrEnum):
    """Where the mutation came from (`context.source`)."""

    UI = "ui"
    IMPORT = "import"
    DATABASE_EXPLORER = "database_explorer"
    CLI = "cli"
    AGENT = "agent"


class Lifecycle(StrEnum):
    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"


class AuditAction(StrEnum):
    """Actions with a meaning of their own. Every audited entity also has the generic
    `<entity_type>.created|updated|deleted` (see `lifecycle_action`). Extend sparingly."""

    PROSPECT_COMPANY_CHANGED = "prospect.company_changed"
    PROSPECT_DO_NOT_CONTACT_SET = "prospect.do_not_contact.set"
    PROSPECT_DO_NOT_CONTACT_CLEARED = "prospect.do_not_contact.cleared"
    CONTACT_TRACKING_STATUS_CHANGED = "contact_tracking.status_changed"
    IMPORT_BATCH_STARTED = "import_batch.started"
    IMPORT_BATCH_COMMITTED = "import_batch.committed"
    IMPORT_BATCH_FAILED = "import_batch.failed"
    IMPORT_BATCH_CANCELLED = "import_batch.cancelled"
    AUTH_LOGIN = "auth.login"
    AUTH_LOGOUT = "auth.logout"
    AUTH_USER_CREATED = "auth.user_created"
    AUTH_PASSWORD_RESET = "auth.password_reset"


@dataclass(frozen=True, slots=True)
class AuditContext:
    source: AuditSource
    # Correlates the events of one HTTP request (one save).
    request_id: str | None = None
    import_batch_id: uuid.UUID | None = None
    # The human who started or approved an automated actor's work (import, future agent).
    on_behalf_of: ActorContext | None = None


# Context used when nothing is bound (e.g. a service called outside a request).
DEFAULT_SOURCES = {
    ActorType.HUMAN: AuditSource.UI,
    ActorType.IMPORT: AuditSource.IMPORT,
    ActorType.SYSTEM: AuditSource.CLI,
    ActorType.AGENT: AuditSource.AGENT,
}


@dataclass(frozen=True, slots=True)
class AuditedEntity:
    entity_type: str
    # Whose history shows the event, and the attribute holding that record's id.
    subject_type: str
    subject_key: str = "id"


# The audited tables, in the order events of one flush are written (parents first). A change to
# one of them needs an actor (annotation or binding), else the flush fails. Every other table is
# listed in NOT_AUDITED_TABLES with its reason; a test requires each table to be in one of the two.
AUDITED_ENTITIES: dict[type[Any], AuditedEntity] = {
    Company: AuditedEntity("company", "company"),
    Establishment: AuditedEntity("establishment", "company", "company_id"),
    Prospect: AuditedEntity("prospect", "prospect"),
    Email: AuditedEntity("email", "prospect", "prospect_id"),
    Phone: AuditedEntity("phone", "prospect", "prospect_id"),
    ContactTracking: AuditedEntity("contact_tracking", "prospect", "prospect_id"),
    ProspectSource: AuditedEntity("prospect_source", "prospect", "prospect_id"),
    Role: AuditedEntity("role", "role"),
    CommercialSegment: AuditedEntity("commercial_segment", "commercial_segment"),
    ActivityCategory: AuditedEntity("activity_category", "activity_category"),
    InternalReferent: AuditedEntity("internal_referent", "internal_referent"),
    ImportBatch: AuditedEntity("import_batch", "import_batch"),
}
ENTITY_ORDER = {model: position for position, model in enumerate(AUDITED_ENTITIES)}
NOT_AUDITED_TABLES = {
    "users": "login accounts hold secrets; auth.* events are recorded instead",
    "user_sessions": "session tokens; auth.login/auth.logout are recorded instead",
    "import_row_metadata": "write-once import trace; legacy values stay out of the log (I-29)",
    "contact_tracking_status_history": "derived from the audited contact_tracking change",
    "company_activity_categories": "link table; recorded on the company as activity_categories_ids",
    "audit_log": "the audit log itself",
}


class UnattributedMutationError(RuntimeError):
    """An audited row changed with no actor: nobody annotated it and the session has no binding.

    Bind one (`require_session` does it for HTTP; `attributed_unit_of_work` or `bound` elsewhere)
    or annotate the row. The flush fails, so the transaction rolls back.
    """


def lifecycle_action(entity_type: str, lifecycle: Lifecycle) -> str:
    return f"{entity_type}.{lifecycle}"


class SettingsChange(StrEnum):
    """Semantic changes of Settings values (Task 06): `<entity_type>.<change>`. Taxonomies are
    renamed; taxonomies and referents are deactivated/reactivated (never deleted while in use)."""

    RENAMED = "renamed"
    DEACTIVATED = "deactivated"
    REACTIVATED = "reactivated"


TAXONOMY_ENTITY_TYPES = ("role", "commercial_segment", "activity_category")
SETTINGS_ENTITY_TYPES = (*TAXONOMY_ENTITY_TYPES, "internal_referent")


def settings_action(entity_type: str, change: SettingsChange) -> str:
    return f"{entity_type}.{change}"


ACTIONS = (
    frozenset(AuditAction)
    | {
        lifecycle_action(entity.entity_type, lifecycle)
        for entity in AUDITED_ENTITIES.values()
        for lifecycle in Lifecycle
    }
    | {settings_action(taxonomy, SettingsChange.RENAMED) for taxonomy in TAXONOMY_ENTITY_TYPES}
    | {
        settings_action(entity_type, change)
        for entity_type in SETTINGS_ENTITY_TYPES
        for change in (SettingsChange.DEACTIVATED, SettingsChange.REACTIVATED)
    }
)
ACTION_FORMAT = re.compile(r"[a-z_]+(\.[a-z_]+)+")


def _checked_action(action: str) -> str:
    if action not in ACTIONS or not ACTION_FORMAT.fullmatch(action):
        raise ValueError(f"Unknown audit action {action!r}: add it to AuditAction first.")
    return action


# --- binding and annotations (per session) ---------------------------------------------------


@dataclass(frozen=True, slots=True)
class Annotation:
    actor: ActorContext
    action: str | None
    reason: str | None
    labels: Mapping[str, tuple[str | None, str | None]]


@dataclass
class _SessionAudit:
    binding: tuple[ActorContext, AuditContext] | None = None
    # Keyed by ORM instance (identity), consumed by the flush that writes the instance's change.
    annotations: dict[object, Annotation] = field(default_factory=dict)


_INFO_KEY = "viper.audit"


def _session_audit(session: Session) -> _SessionAudit:
    state: _SessionAudit = session.info.setdefault(_INFO_KEY, _SessionAudit())
    return state


def _default_context(actor: ActorContext) -> AuditContext:
    return AuditContext(source=DEFAULT_SOURCES[actor.type])


def bind(session: Session, actor: ActorContext, context: AuditContext | None = None) -> None:
    """Attribute every audited change of this session to `actor` unless annotated otherwise.

    The context defaults from the actor type (e.g. a system actor → `source=cli`).
    """
    _session_audit(session).binding = (actor, context or _default_context(actor))


def binding(session: Session) -> tuple[ActorContext, AuditContext] | None:
    return _session_audit(session).binding


@contextmanager
def bound(
    session: Session, actor: ActorContext, context: AuditContext | None = None
) -> Iterator[None]:
    """`bind` for the duration of the block, then restore the previous binding."""
    state = _session_audit(session)
    previous = state.binding
    bind(session, actor, context)
    try:
        yield
    finally:
        state.binding = previous


@contextmanager
def attributed_unit_of_work(
    session_factory: sessionmaker[Session],
    actor: ActorContext,
    context: AuditContext | None = None,
) -> Iterator[Session]:
    """`unit_of_work` for code outside HTTP requests (CLI, seed, jobs, future agents): every
    audited write inside is attributed to `actor`, e.g. a `SYSTEM` actor naming the command."""
    with unit_of_work(session_factory) as session:
        bind(session, actor, context)
        yield session


def annotate(
    session: Session,
    actor: ActorContext,
    instance: object,
    action: str | None = None,
    *,
    reason: str | None = None,
    labels: Mapping[str, tuple[str | None, str | None]] | None = None,
) -> None:
    """Declare who makes the next change to `instance` and, optionally, what it means.

    Call it before changing the row (always before the flush that writes it). Changes of `instance`
    still pending are flushed first so they keep their own attribution. `action` defaults to the
    generic lifecycle action; `reason` goes to `context.reason` (never masked: write reasons
    without unnecessary personal detail); `labels` add readable `before_label`/`after_label` to
    reference fields, e.g. `{"company_id": ("Ancien SARL", "Nouveau SAS")}`.
    """
    if type(instance) not in AUDITED_ENTITIES:
        raise ValueError(f"{type(instance).__name__} is not an audited entity.")
    if action is not None:
        _checked_action(action)
    if instance_state(instance).persistent and session.is_modified(instance):
        session.flush()
    _session_audit(session).annotations[instance] = Annotation(
        actor, action, (reason or "").strip() or None, labels or {}
    )


def record_event(
    session: Session,
    actor: ActorContext,
    action: str,
    *,
    entity_type: str,
    entity_id: uuid.UUID | None,
    subject: tuple[str, uuid.UUID] | None = None,
    changes: ChangeSet | None = None,
    reason: str | None = None,
    context: AuditContext | None = None,
) -> None:
    """Write an event that is not a row change seen by the ORM (sign-in, bulk insert…).

    Pending row changes are flushed first, so events stay in the order things happened. The
    subject defaults to the entity itself; the context to the bound one.
    """
    session.flush()
    subject_type, subject_id = subject or (entity_type, entity_id)
    audit_repository.insert_entries(
        session,
        [
            _row(
                actor,
                context or _context_for(session, actor),
                _checked_action(action),
                entity_type,
                entity_id,
                subject_type,
                subject_id,
                changes or {},
                (reason or "").strip() or None,
            )
        ],
    )


def _context_for(session: Session, actor: ActorContext) -> AuditContext:
    current = binding(session)
    return current[1] if current else _default_context(actor)


def _actor_json(actor: ActorContext) -> dict[str, Any]:
    return {"type": actor.type.value, "id": actor.id, "display": actor.display}


def _row(
    actor: ActorContext,
    context: AuditContext,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    subject_type: str | None,
    subject_id: uuid.UUID | None,
    changes: ChangeSet,
    reason: str | None,
) -> dict[str, Any]:
    context_data = {
        "source": context.source.value,
        "request_id": context.request_id,
        "import_batch_id": to_json(context.import_batch_id),
        "on_behalf_of": _actor_json(context.on_behalf_of) if context.on_behalf_of else None,
        "reason": reason,
    }
    return {
        "actor_type": actor.type,
        "actor_id": actor.id,
        "actor_display": actor.display,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "subject_type": subject_type,
        "subject_id": subject_id,
        "action": action,
        "changes": audit_policy.sanitize_changes(entity_type, changes, audit_policy.POLICY),
        "context": {key: value for key, value in context_data.items() if value is not None},
    }


# --- flush hook ------------------------------------------------------------------------------

CAPTURE = {
    Lifecycle.CREATED: created_changes,
    Lifecycle.UPDATED: pending_changes,
    Lifecycle.DELETED: deleted_changes,
}


def _audited_in(instances: Iterable[object]) -> list[object]:
    audited = [instance for instance in instances if type(instance) in AUDITED_ENTITIES]
    return sorted(
        audited, key=lambda i: (ENTITY_ORDER[type(i)], str(instance_state(i).dict.get("id")))
    )


def _with_labels(changes: ChangeSet, annotation: Annotation | None) -> ChangeSet:
    for name, (before_label, after_label) in (annotation.labels if annotation else {}).items():
        if name in changes:
            changes[name] |= {"before_label": before_label, "after_label": after_label}
    return changes


@event.listens_for(Session, "after_flush")
def _record_flushed_changes(session: Session, _: UOWTransaction) -> None:
    """One event per changed audited row; runs with the flush's history still available.

    Fails closed: a changed audited row without an actor raises `UnattributedMutationError`,
    which aborts the flush and its transaction.
    """
    state: _SessionAudit = session.info.get(_INFO_KEY) or _SessionAudit()
    rows = []
    groups = (
        (Lifecycle.CREATED, session.new),
        (Lifecycle.UPDATED, session.dirty),
        (Lifecycle.DELETED, session.deleted),
    )
    for lifecycle, instances in groups:
        for instance in _audited_in(instances):
            changes = CAPTURE[lifecycle](instance)
            if not changes:
                continue
            entity = AUDITED_ENTITIES[type(instance)]
            values = instance_state(instance).dict
            annotation = state.annotations.pop(instance, None)
            if annotation is not None:
                actor = annotation.actor
            elif state.binding is not None:
                actor = state.binding[0]
            else:
                raise UnattributedMutationError(
                    f"{entity.entity_type} {values.get('id')} was {lifecycle} without an actor: "
                    "bind one (attributed_unit_of_work / bound) or annotate the row."
                )
            action = annotation.action if annotation else None
            rows.append(
                _row(
                    actor,
                    _context_for(session, actor),
                    action or lifecycle_action(entity.entity_type, lifecycle),
                    entity.entity_type,
                    values.get("id"),
                    entity.subject_type,
                    values.get(entity.subject_key),
                    _with_labels(changes, annotation),
                    annotation.reason if annotation else None,
                )
            )
    audit_repository.insert_entries(session, rows)


@event.listens_for(Session, "after_transaction_end")
def _forget_annotations(session: Session, transaction: SessionTransaction) -> None:
    state: _SessionAudit | None = session.info.get(_INFO_KEY)
    if state is not None and transaction.parent is None:
        state.annotations.clear()


def _load_previous_value(target: object, value: Any, oldvalue: Any, initiator: Any) -> None:
    """No-op; registering it with `active_history` makes "before" values exact."""


for _model in AUDITED_ENTITIES:
    for _attribute in inspect(_model).column_attrs:
        event.listen(
            getattr(_model, _attribute.key), "set", _load_previous_value, active_history=True
        )


# --- reads (Task 19 history, Task 16 activity) -----------------------------------------------


def history(
    session: Session, subject_type: str, subject_id: uuid.UUID, *, limit: int = 50
) -> list[AuditLogEntry]:
    """Newest first: events whose subject is this prospect/company/…, child rows included."""
    return audit_repository.subject_history(session, subject_type, subject_id, limit=limit)


def recent_activity(
    session: Session, *, limit: int = 50, subject_types: Collection[str] | None = None
) -> list[AuditLogEntry]:
    """Newest first, across the whole application (optionally limited to some subject types)."""
    return audit_repository.recent(session, limit=limit, subject_types=subject_types)
