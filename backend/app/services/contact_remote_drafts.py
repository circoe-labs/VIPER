"""Remote (Infomaniak) drafts of Contact messages through the CIRCOE Toolbox (S6, handoff Task 15).

A remote draft belongs to the **validated revision** of a message (docs/07 « Usage recommandé »):

- a validation (or a schedule of a message without one) creates it after the local commit —
  `sync_remote_draft`; nothing is created for an unvalidated draft or an AI generation;
- losing that validation (edit, AI redraft), a cancellation (by a person, a sequence-closing
  state, the opposition) or a draft created for a revision that changed meanwhile queue its id in
  `contact_message_remote_draft_cleanups` in the same transaction and detach it from the message
  (`detach_remote_draft`); a re-validation then creates a new one (the Toolbox has no update
  tool: « replace » = delete the old + create the new);
- the queue is drained after commit by `process_cleanups` (the API's worker or the CLI), with
  exponential backoff; deleting an already-gone draft counts as done.

Failure semantics of the creation (decided for S6): the human validation is the local truth and is
never rolled back by a Toolbox failure. The message stays validated without a remote draft, the
failure code is recorded on it (`last_error_code = toolbox_*`, audited
`contact_message.remote_draft_failed`) and shown in the editor with « Réessayer »
(`POST …/remote-draft`); scheduling tries again, and S7 recreates a missing draft before sending.
A Toolbox disabled or not connected creates nothing and records nothing (everything stays local).

The network call never runs inside a database transaction: the attach re-reads the message under
a row lock and only attaches to the same validated revision.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext
from app.db.session import unit_of_work
from app.models import ContactMessage, ContactMessageRemoteDraftCleanup
from app.models.enums import ContactMessageStatus
from app.services import audit
from app.services.audit import AuditAction
from app.services.errors import ToolboxError
from app.services.toolbox.mcp_client import DraftInput, MailToolbox

logger = logging.getLogger(__name__)

PROVIDER = "circoe_toolbox"
M = ContactMessageStatus
WITH_REMOTE_DRAFT = (M.VALIDATED, M.SCHEDULED)
TOOLBOX_ERROR_PREFIX = "toolbox_"
# `last_error_code` of a creation that timed out or got a 5xx: the draft may exist in Infomaniak.
OUTCOME_UNKNOWN = "toolbox_outcome_unknown"
# The batch stops on these: nothing is the draft's fault, the connection must be fixed first.
BLOCKING = frozenset({"toolbox_not_configured", "toolbox_not_connected", "toolbox_auth_expired"})
BACKOFF_BASE = timedelta(seconds=30)
BACKOFF_MAX = timedelta(hours=6)
# How long a claimed queue entry is left to the pass that claimed it (> the Toolbox timeout).
CLAIM_LEASE = timedelta(minutes=10)


def backoff(attempts: int) -> timedelta:
    """Wait before the next attempt: 30 s * 2^(attempts - 1), at most 6 h."""
    if attempts <= 0:
        return timedelta(0)
    wait: timedelta = BACKOFF_BASE * 2 ** min(attempts - 1, 20)
    return min(BACKOFF_MAX, wait)


# --- queueing (inside the caller's transaction) --------------------------------------------------


def detach_remote_draft(session: Session, message: ContactMessage, reason: str) -> bool:
    """Queue the message's remote draft for deletion (`edited` / `cancelled`) and detach it.
    True when there was one. Also forgets a remote-draft creation failure: it was about the
    validation that is being lost."""
    provider, draft_id = message.remote_provider, message.remote_draft_id
    message.remote_provider = None
    message.remote_draft_id = None
    if message.last_error_code and message.last_error_code.startswith(TOOLBOX_ERROR_PREFIX):
        message.last_error_code = None
        message.last_error_at = None
    if draft_id is None or provider is None:
        return False
    # The message's change is flushed by the caller, as one audited change.
    with session.no_autoflush:
        enqueue_cleanup(session, message.id, provider, draft_id, reason)
    return True


def enqueue_cleanup(
    session: Session,
    message_id: uuid.UUID | None,
    provider: str,
    draft_id: str,
    reason: str,
) -> None:
    """One queue row per remote draft (an id queued twice stays one row)."""
    session.execute(
        insert(ContactMessageRemoteDraftCleanup)
        .values(
            id=uuid.uuid7(),
            message_id=message_id,
            remote_provider=provider,
            remote_draft_id=draft_id,
            reason=reason,
        )
        .on_conflict_do_nothing(index_elements=["remote_provider", "remote_draft_id"])
    )
    # Identifiers only: the remote id is an opaque Infomaniak id, never an address.
    logger.info("remote_draft.cleanup_queued message=%s reason=%s", message_id, reason)


# --- creation (after the validation's commit) ----------------------------------------------------


@dataclass(frozen=True, slots=True)
class RemoteDraftSync:
    """`disabled` (Toolbox off or not configured), `not_connected`, `not_applicable` (not
    validated/scheduled), `already_present`, `created`, `stale` (the message changed during the
    call: the new draft is queued for deletion), `failed` (with the `toolbox_*` `code`)."""

    status: str
    code: str | None = None


@dataclass(frozen=True, slots=True)
class _Snapshot:
    id: uuid.UUID
    revision: int
    draft: DraftInput
    # The previous creation may have succeeded unseen (`toolbox_outcome_unknown`).
    outcome_unknown: bool = False


def _snapshot(session_factory: sessionmaker[Session], message_id: uuid.UUID) -> _Snapshot | str:
    with unit_of_work(session_factory) as session:
        message = session.get(ContactMessage, message_id)
        if message is None or message.status not in WITH_REMOTE_DRAFT:
            return "not_applicable"
        if message.remote_draft_id is not None:
            return "already_present"
        return _Snapshot(
            id=message.id,
            revision=message.revision,
            # No `from`: the Toolbox sends with the connection's default mailbox.
            draft=DraftInput(
                to=list(message.to_recipients),
                cc=list(message.cc_recipients),
                bcc=list(message.bcc_recipients),
                subject=message.subject,
                text=message.body_text,
            ),
            outcome_unknown=message.last_error_code == OUTCOME_UNKNOWN,
        )


def _current(session: Session, snapshot: _Snapshot) -> ContactMessage | None:
    """The message locked, if it still is the validated revision the draft was made from."""
    message = session.scalar(
        select(ContactMessage)
        .where(ContactMessage.id == snapshot.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        message is None
        or message.status not in WITH_REMOTE_DRAFT
        or message.revision != snapshot.revision
        or message.validated_revision != message.revision
        or message.remote_draft_id is not None
    ):
        return None
    return message


def sync_remote_draft(
    session_factory: sessionmaker[Session],
    toolbox: MailToolbox | None,
    message_id: uuid.UUID,
    actor: ActorContext,
    audit_context: audit.AuditContext | None = None,
    *,
    now: datetime | None = None,
) -> RemoteDraftSync:
    """Create the remote draft of a validated/scheduled message that has none (see the module
    docstring for the failure semantics). Never raises a `ToolboxError`: the outcome says it."""
    if toolbox is None:
        return RemoteDraftSync("disabled")
    found = _snapshot(session_factory, message_id)
    if isinstance(found, str):
        return RemoteDraftSync(found)
    try:
        recovered = (
            _find_unseen_draft(session_factory, toolbox, found.draft)
            if found.outcome_unknown
            else None
        )
        draft_id = recovered or toolbox.create_draft(found.draft)
    except ToolboxError as error:
        code = OUTCOME_UNKNOWN if error.outcome_unknown else error.code
        logger.warning(
            "remote_draft.create_failed message=%s code=%s upstream_status=%s",
            message_id,
            code,
            error.upstream_status,
        )
        _record_failure(session_factory, found, code, actor, audit_context, now)
        return RemoteDraftSync("failed", code)
    if recovered:
        logger.info("remote_draft.recovered message=%s", message_id)
    with unit_of_work(session_factory) as session:
        audit.bind(session, actor, audit_context)
        message = _current(session, found)
        if message is None:
            enqueue_cleanup(
                session,
                found.id if session.get(ContactMessage, found.id) else None,
                PROVIDER,
                draft_id,
                "replaced",
            )
            logger.info("remote_draft.stale message=%s", message_id)
            return RemoteDraftSync("stale")
        audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_REMOTE_DRAFT_CREATED)
        message.remote_provider = PROVIDER
        message.remote_draft_id = draft_id
        if message.last_error_code and message.last_error_code.startswith(TOOLBOX_ERROR_PREFIX):
            message.last_error_code = None
            message.last_error_at = None
        session.flush()
    logger.info("remote_draft.created message=%s", message_id)
    return RemoteDraftSync("recovered" if recovered else "created")


def _normalized(addresses: list[str]) -> list[str]:
    return sorted(address.strip().lower() for address in addresses if address.strip())


def _find_unseen_draft(
    session_factory: sessionmaker[Session], toolbox: MailToolbox, draft: DraftInput
) -> str | None:
    """After a creation whose outcome is unknown, the draft it may have left in Infomaniak:
    same subject and same `To`, attached to no message and not queued for deletion (the Toolbox
    returns no client reference and the reference adds no VIPER marker, so these two fields are
    the match). None when there is none (a new one is then created)."""
    candidates = [
        summary
        for summary in toolbox.list_drafts(100)
        if summary.subject.strip() == draft.subject.strip()
        and _normalized(summary.to) == _normalized(draft.to)
    ]
    if not candidates:
        return None
    ids = [candidate.draft_id for candidate in candidates]
    with unit_of_work(session_factory) as session:
        taken = set(
            session.scalars(
                select(ContactMessage.remote_draft_id).where(
                    ContactMessage.remote_provider == PROVIDER,
                    ContactMessage.remote_draft_id.in_(ids),
                )
            )
        ) | set(
            session.scalars(
                select(ContactMessageRemoteDraftCleanup.remote_draft_id).where(
                    ContactMessageRemoteDraftCleanup.remote_provider == PROVIDER,
                    ContactMessageRemoteDraftCleanup.remote_draft_id.in_(ids),
                )
            )
        )
    return next((draft_id for draft_id in ids if draft_id not in taken), None)


def _record_failure(
    session_factory: sessionmaker[Session],
    snapshot: _Snapshot,
    code: str,
    actor: ActorContext,
    audit_context: audit.AuditContext | None,
    now: datetime | None,
) -> None:
    with unit_of_work(session_factory) as session:
        audit.bind(session, actor, audit_context)
        message = _current(session, snapshot)
        if message is None:
            return  # the validation changed meanwhile: the failure is about nothing current
        audit.annotate(
            session, actor, message, AuditAction.CONTACT_MESSAGE_REMOTE_DRAFT_FAILED, reason=code
        )
        message.last_error_code = code
        message.last_error_at = now or datetime.now(UTC)
        session.flush()


# --- the deletion queue ---------------------------------------------------------------------------


@dataclass(slots=True)
class CleanupReport:
    processed: int = 0
    deleted: int = 0
    already_absent: int = 0
    failed: int = 0
    skipped: int = 0
    # The code that stopped the batch (connection to fix), else None.
    blocked: str | None = None


@dataclass(frozen=True, slots=True)
class QueueCounts:
    pending: int
    failing: int


def queue_counts(session: Session) -> QueueCounts:
    row = session.execute(
        select(
            func.count(),
            func.count().filter(ContactMessageRemoteDraftCleanup.last_error_code.is_not(None)),
        ).where(ContactMessageRemoteDraftCleanup.completed_at.is_(None))
    ).one()
    return QueueCounts(pending=row[0], failing=row[1])


def process_cleanups(
    session_factory: sessionmaker[Session],
    toolbox: MailToolbox,
    *,
    limit: int = 20,
    now: datetime | None = None,
) -> CleanupReport:
    """One pass over the due entries (oldest due first). Each entry is handled in its own short
    transaction holding only its queue row (`SKIP LOCKED`: the API's worker and a CLI pass never
    delete the same draft twice). A remote id attached to a message again is never deleted."""
    report = CleanupReport()
    moment = now or datetime.now(UTC)
    with unit_of_work(session_factory) as session:
        due = list(
            session.scalars(
                select(ContactMessageRemoteDraftCleanup.id)
                .where(
                    ContactMessageRemoteDraftCleanup.completed_at.is_(None),
                    ContactMessageRemoteDraftCleanup.remote_provider == PROVIDER,
                    ContactMessageRemoteDraftCleanup.next_attempt_at <= moment,
                )
                .order_by(ContactMessageRemoteDraftCleanup.next_attempt_at)
                .limit(limit)
            )
        )
    for entry_id in due:
        if not _process_one(session_factory, toolbox, entry_id, report, moment):
            break
    if report.processed or report.blocked or report.skipped:
        logger.info(
            "remote_draft.cleanup_pass processed=%s deleted=%s already_absent=%s failed=%s "
            "skipped=%s blocked=%s",
            report.processed,
            report.deleted,
            report.already_absent,
            report.failed,
            report.skipped,
            report.blocked,
        )
    return report


def _process_one(
    session_factory: sessionmaker[Session],
    toolbox: MailToolbox,
    entry_id: uuid.UUID,
    report: CleanupReport,
    moment: datetime,
) -> bool:
    """Handle one entry; False stops the batch (the connection must be fixed first).

    Claim → commit → network delete → record: no transaction or row lock is held during the
    Toolbox call. The claim pushes `next_attempt_at` one lease ahead, so another pass (API worker,
    CLI) does not take the entry meanwhile; a process that dies after the claim leaves it due again
    once the lease ends (the delete is idempotent)."""
    with unit_of_work(session_factory) as session:
        entry = session.scalar(
            select(ContactMessageRemoteDraftCleanup)
            .where(
                ContactMessageRemoteDraftCleanup.id == entry_id,
                ContactMessageRemoteDraftCleanup.completed_at.is_(None),
                ContactMessageRemoteDraftCleanup.next_attempt_at <= moment,
            )
            .with_for_update(skip_locked=True)
        )
        if entry is None:
            report.skipped += 1  # done, or claimed by another pass
            return True
        attached = session.scalar(
            select(ContactMessage.id).where(
                ContactMessage.remote_provider == entry.remote_provider,
                ContactMessage.remote_draft_id == entry.remote_draft_id,
            )
        )
        if attached is not None:
            _failed_attempt(entry, "still_attached", moment)
            report.skipped += 1
            return True
        draft_id = entry.remote_draft_id
        entry.attempts += 1
        entry.last_attempt_at = moment
        entry.next_attempt_at = moment + CLAIM_LEASE
    try:
        deleted = toolbox.delete_draft(draft_id)
    except ToolboxError as error:
        with unit_of_work(session_factory) as session:
            entry = session.get(ContactMessageRemoteDraftCleanup, entry_id, with_for_update=True)
            if entry is None:
                return True
            if error.code in BLOCKING:
                # Not the draft's fault: the claim is undone, the entry is due again.
                entry.attempts -= 1
                entry.next_attempt_at = moment
                report.blocked = error.code
                return False
            entry.last_error_code = error.code
            entry.next_attempt_at = moment + backoff(entry.attempts)
            attempts = entry.attempts
        report.processed += 1
        report.failed += 1
        logger.warning(
            "remote_draft.cleanup_failed entry=%s code=%s attempts=%s",
            entry_id,
            error.code,
            attempts,
        )
        return True
    with unit_of_work(session_factory) as session:
        entry = session.get(ContactMessageRemoteDraftCleanup, entry_id, with_for_update=True)
        if entry is not None and entry.completed_at is None:
            entry.last_error_code = None
            entry.completed_at = datetime.now(UTC)
            entry.outcome = "deleted" if deleted else "already_absent"
    report.processed += 1
    if deleted:
        report.deleted += 1
    else:
        report.already_absent += 1
    return True


def _failed_attempt(entry: ContactMessageRemoteDraftCleanup, code: str, moment: datetime) -> None:
    entry.attempts += 1
    entry.last_attempt_at = moment
    entry.last_error_code = code
    entry.next_attempt_at = moment + backoff(entry.attempts)
