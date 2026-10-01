"""Scheduled sending of Contact messages (Contact port S7; handoff Task 16, decisions 10, 21-29).

VIPER owns the schedule (`scheduled_at`, chosen by a person); this dispatcher calls the CIRCOE
Toolbox's `infomaniak.mail.send_draft` on the message's Infomaniak draft once it is due. Port of
the reference `src/server/contactMessageDispatcher.ts` (an executable specification, not code to
copy). **Only the message's status changes** (`scheduled` → `sent`, or back to `validated` for a
person to review): the prospect's state never moves, and the cadence stays a suggestion (H-10,
H-11).

One pass (`run_pass`; never two at once in one process, `ContactDispatcher` in the API process or
`python -m app.cli contact-dispatch --once`):

1. **Stale claims** (`scheduled` with a `dispatch_claim_id` older than the claim TTL, not being
   sent by this process): a send that nobody finished (process killed, unknown outcome, `sent`
   not recorded). `list_drafts` decides — never a blind resend:
   - the draft is gone and the listing is complete → `sent` (« envoyé (déduit) »,
     `send_reconciled_draft_absent`);
   - the draft is still in the mailbox → if a send outcome was recorded (`send_outcome_unknown`,
     `send_reconcile_inconclusive`, `send_probably_sent`) the message goes **back to Validé**
     (`send_not_confirmed`: a person checks the sent items, then reschedules) — an unknown outcome
     is never retried automatically (decision C-25). Only a claim *without* a recorded outcome (the
     process died around `send_draft`) is released for a new attempt (`send_not_confirmed`,
     backoff, attempts and lateness still bound it);
   - the listing is full (100, truncated) or unreadable, or the message holds no draft id → the
     claim stays (`send_reconcile_inconclusive`); a person can settle it (below).
2. **Due messages** (`scheduled`, `scheduled_at <= now`, unclaimed), oldest first (Contact before
   R1 before R2 at the same moment). For each, under its row lock (`SKIP LOCKED`):
   - closed sequence (`response_received`, `appointment_obtained`, `ignored`, `do_not_contact`)
     → the prospect's unsent messages are cancelled (decision 29), nothing leaves;
   - more than `max_lateness` late (VIPER stopped, Toolbox disconnected) → back to Validé
     (`dispatch_overdue`): never a late send;
   - waiting for a backoff → next pass;
   - no recipient / a recipient outside `VIPER_INFOMANIAK_SEND_ALLOWLIST` → back to Validé
     (`send_missing_recipients` / `send_recipient_not_allowed`);
   - **step order** (decision C-24): R1 (R2) never leaves while the Contact (R1) message of the
     same prospect is prepared but not sent — it waits while that one is scheduled earlier (it
     leaves first), and goes back to Validé (`send_previous_step_pending`) when it is a draft, a
     validated message or scheduled later. An absent or cancelled previous message does not block
     (a first contact made outside VIPER, e.g. an imported « Contacté »);
   - no Infomaniak draft (validated while the Toolbox was off, creation failed) → it is created
     now (`sync_remote_draft`, with S6's `list_drafts` recovery after an unknown outcome); a
     certain failure is retried with backoff, then back to Validé (`send_draft_not_created`);
   - **claim**: in one short transaction, the prospect and its tracking share-locked **first**
     (the order of the closing writes and the opposition: no deadlock), then the message row
     locked, every condition checked again — still `scheduled`, due, unclaimed, the validation is
     the current revision, a draft attached, recipients and allowlist, step order — and the state
     and opposition read under those locks (a concurrent state change waits for the claim, then
     sees the message in flight); the claim id
     and moment are set, `dispatch_attempts` + 1, audited `contact_message.dispatch_claimed`,
     committed. Two passes (threads, processes) can never both claim: the row lock and the
     conditional checks let one win;
   - `send_draft` outside any transaction;
   - success → `sent` (`sent_at`; `remote_message_id` stays null: the Toolbox returns none),
     audited `contact_message.sent`;
   - certain failure (refused before anything left): transient (`unavailable`, `timeout`,
     connection) → claim released, `send_*` code, retry after backoff, at most `max_attempts`;
     definitive (`rejected`, `outbound_blocked`, `invalid_input`, `draft_not_found`) or attempts
     spent → back to Validé with the code; then, if the sequence closed meanwhile, the message is
     cancelled. A `draft_not_found` right after a `send_not_confirmed` retry means the earlier
     attempt probably sent it: the claim is kept (`send_probably_sent`) for the reconciliation or a
     person, never back to Validé;
   - unknown outcome (timeout or 5xx during `send_draft`, an unrecognised Toolbox error text, an
     unreadable answer, an unexpected error) → the claim is **kept** (`send_outcome_unknown`),
     reconciled after the TTL, never resent automatically.

A person can settle a message whose send is unconfirmed (claimed with an unknown outcome, or a
claim older than the TTL): **« Marquer envoyé »** (`mark_sent`, after checking the mailbox's sent
items) at any time, **« Remettre en Validé »** (`release`) only once the claim is older than the
TTL (the Toolbox's own Infomaniak call has no timeout: a send may still be finishing).

Exactly-once: a `send_draft` needs a claim won under the row lock; a claim is released for a new
attempt only after a *certain* failure, or by a reconciliation that still sees the draft of a
claim whose send outcome was never recorded; `sent` is
immutable (trigger). Every write is attributed to the system actor `DISPATCH_ACTOR`
(`AuditSource.DISPATCHER`); logs and audit carry ids, codes and statuses only — never a subject,
a body or an address.
"""

import logging
import uuid
from collections.abc import Callable, Collection
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.core.config import Settings, allowlist_permits
from app.models import ContactMessage, ContactTracking, Prospect
from app.models.enums import ContactabilityStatus, ContactMessageStatus, ContactMessageStep
from app.services import audit
from app.services.audit import AuditAction, AuditContext, AuditSource
from app.services.contact_message_cancellation import (
    DO_NOT_CONTACT_REASON,
    cancel_unsent_messages,
    state_cancel_reason,
)
from app.services.contact_remote_drafts import sync_remote_draft
from app.services.contact_workflow import SEQUENCE_CLOSING_STATES
from app.services.errors import ActorNotAllowedError, ContactMessageError, ToolboxError
from app.services.prospects import get_prospect
from app.services.toolbox.mcp_client import DraftSummary, MailToolbox

logger = logging.getLogger(__name__)

M = ContactMessageStatus
DISPATCH_ACTOR = ActorContext(
    type=ActorType.SYSTEM, display="Envoi programmé VIPER", id="contact-dispatcher"
)
DISPATCH_CONTEXT = AuditContext(source=AuditSource.DISPATCHER)
# `list_drafts` page size (the Toolbox maximum): a full page does not prove a draft is gone.
RECONCILE_LIST_LIMIT = 100
BACKOFF_MAX = timedelta(hours=1)

# `last_error_code` values written by the dispatcher (S6's `toolbox_*` codes belong to the
# remote-draft creation; a send failure is `send_<toolbox code without its prefix>`).
OVERDUE = "dispatch_overdue"
OUTCOME_UNKNOWN = "send_outcome_unknown"
RECONCILE_INCONCLUSIVE = "send_reconcile_inconclusive"
NOT_CONFIRMED = "send_not_confirmed"
RECONCILED_SENT = "send_reconciled_draft_absent"
MISSING_RECIPIENTS = "send_missing_recipients"
RECIPIENT_NOT_ALLOWED = "send_recipient_not_allowed"
PREVIOUS_STEP_PENDING = "send_previous_step_pending"
DRAFT_NOT_CREATED = "send_draft_not_created"
INTERNAL = "dispatch_internal_error"
MARKED_SENT = "send_marked_by_person"
# `draft_not_found` on a retry after `send_not_confirmed`: the earlier attempt probably sent it.
PROBABLY_SENT = "send_probably_sent"
# Scheduling withdrawn by the operator (`contact-dispatch --hold-scheduled`, e.g. after a restore).
HELD = "dispatch_held"
RELEASED = "send_released_by_person"
# A claim whose send call is over without a known outcome: a person may settle it at once.
UNCONFIRMED = frozenset({OUTCOME_UNKNOWN, RECONCILE_INCONCLUSIVE, PROBABLY_SENT})

# Certain refusals of `send_draft` (nothing left) that may resolve by themselves.
TRANSIENT = frozenset(
    {
        "toolbox_not_configured",
        "toolbox_not_connected",
        "toolbox_auth_expired",
        "toolbox_unavailable",
        "toolbox_timeout",
    }
)
# Certain and definitive refusals for this draft: a person reviews.
TERMINAL = frozenset(
    {
        "toolbox_rejected",
        "toolbox_outbound_blocked",
        "toolbox_invalid_input",
        "toolbox_draft_not_found",
    }
)


def send_code(toolbox_code: str) -> str:
    """`toolbox_unavailable` → `send_unavailable` (the UI never reads it as a draft failure)."""
    return f"send_{toolbox_code.removeprefix('toolbox_')}"


@dataclass(frozen=True, slots=True)
class DispatchConfig:
    interval: timedelta
    max_lateness: timedelta
    claim_ttl: timedelta
    max_attempts: int
    retry_base: timedelta
    # None = no VIPER-side restriction (the Toolbox keeps its own allowlist).
    allowlist: tuple[str, ...] | None = None
    batch_size: int = 100

    @classmethod
    def from_settings(cls, settings: Settings) -> DispatchConfig:
        return cls(
            interval=timedelta(milliseconds=settings.contact_dispatch_interval_ms),
            max_lateness=timedelta(milliseconds=settings.contact_dispatch_max_lateness_ms),
            claim_ttl=settings.contact_dispatch_claim_ttl,
            max_attempts=settings.contact_dispatch_max_attempts,
            retry_base=timedelta(milliseconds=settings.contact_dispatch_retry_base_ms),
            allowlist=settings.send_allowlist,
        )


def backoff(attempts: int, base: timedelta) -> timedelta:
    """Wait after the n-th failed attempt: base x 2^(n-1), at most 1 h."""
    if attempts <= 0:
        return timedelta(0)
    wait: timedelta = base * 2 ** min(attempts - 1, 20)
    return min(BACKOFF_MAX, wait)


@dataclass(frozen=True, slots=True)
class Outcome:
    kind: str  # `transient` | `terminal` | `uncertain`
    code: str


def classify_send_error(error: BaseException) -> Outcome:
    """Only a typed Toolbox refusal of a known code, without `outcome_unknown`, proves that nothing
    left. Everything else — a timeout or a 5xx during the call, an unreadable answer, an
    unexpected exception — is an unknown outcome."""
    if not isinstance(error, ToolboxError):
        return Outcome("uncertain", INTERNAL)
    if error.outcome_unknown:
        return Outcome("uncertain", OUTCOME_UNKNOWN)
    if error.code in TRANSIENT:
        return Outcome("transient", send_code(error.code))
    if error.code in TERMINAL:
        return Outcome("terminal", send_code(error.code))
    return Outcome("uncertain", OUTCOME_UNKNOWN)


@dataclass(slots=True)
class DispatchReport:
    sent: int = 0
    # Certain transient failures: a new attempt after the backoff.
    retrying: int = 0
    # Back to Validé (definitive failure, attempts spent, overdue, recipients, order).
    failed: int = 0
    overdue: int = 0
    # Unknown outcome or inconclusive reconciliation: the claim is kept.
    uncertain: int = 0
    reconciled_sent: int = 0
    reconciled_retry: int = 0
    # Messages cancelled because the prospect's sequence is closed.
    cancelled: int = 0
    # Left for a later pass (backoff, previous step pending, listing unavailable).
    deferred: int = 0

    @property
    def summary(self) -> str:
        return (
            f"sent={self.sent} retrying={self.retrying} failed={self.failed} "
            f"overdue={self.overdue} uncertain={self.uncertain} "
            f"reconciled_sent={self.reconciled_sent} reconciled_retry={self.reconciled_retry} "
            f"cancelled={self.cancelled} deferred={self.deferred}"
        )

    @property
    def busy(self) -> bool:
        return any(
            (
                self.sent,
                self.retrying,
                self.failed,
                self.uncertain,
                self.reconciled_sent,
                self.reconciled_retry,
                self.cancelled,
                self.deferred,
            )
        )


# --- reads and small writes (inside the caller's transaction) -------------------------------------


@dataclass(frozen=True, slots=True)
class _Sequence:
    closed: bool
    reason: str | None


def _sequence(session: Session, prospect_id: uuid.UUID, *, lock: bool) -> _Sequence:
    """The prospect's state and opposition, read again. `lock` takes share locks on both rows: a
    state change or an opposition being written meanwhile is waited for and then seen."""
    prospect_query = select(Prospect.contactability_status).where(Prospect.id == prospect_id)
    tracking_query = select(ContactTracking.status).where(
        ContactTracking.prospect_id == prospect_id
    )
    if lock:
        prospect_query = prospect_query.with_for_update(read=True)
        tracking_query = tracking_query.with_for_update(read=True)
    contactability = session.scalar(prospect_query)
    if contactability is None:
        return _Sequence(True, None)  # deleted meanwhile (its messages go with it)
    state = session.scalar(tracking_query)
    if state in SEQUENCE_CLOSING_STATES:
        return _Sequence(True, state_cancel_reason(state))
    if contactability is ContactabilityStatus.DO_NOT_CONTACT:
        return _Sequence(True, DO_NOT_CONTACT_REASON)
    return _Sequence(False, None)


def _cancel_if_closed(
    session: Session,
    prospect_id: uuid.UUID,
    now: datetime,
    actor: ActorContext = DISPATCH_ACTOR,
) -> int:
    """Decision 29 applied after the fact: the closed sequence's unclaimed messages. Called with a
    message row already locked, so the prospect is read without a share lock (taking one after
    the message would invert the lock order of the closing writes)."""
    sequence = _sequence(session, prospect_id, lock=False)
    if not sequence.closed or sequence.reason is None:
        return 0
    return cancel_unsent_messages(session, actor, prospect_id, sequence.reason, now=now).cancelled


# deadlock_detected, lock_not_available, serialization_failure.
LOCK_CONFLICTS = frozenset({"40P01", "55P03", "40001"})


def _is_lock_conflict(error: OperationalError) -> bool:
    return getattr(error.orig, "sqlstate", None) in LOCK_CONFLICTS


def _locked(
    session: Session, message_id: uuid.UUID, *, skip_locked: bool = True
) -> ContactMessage | None:
    query = (
        select(ContactMessage)
        .where(ContactMessage.id == message_id)
        .execution_options(populate_existing=True)
    )
    return session.scalar(query.with_for_update(skip_locked=skip_locked))


def _log(event: str, message: ContactMessage, **details: object) -> None:
    extra = " ".join(f"{key}={value}" for key, value in details.items())
    # Identifiers and codes only.
    logger.info(
        "contact_dispatch.%s message=%s prospect=%s step=%s %s",
        event,
        message.id,
        message.prospect_id,
        message.step.value,
        extra,
    )


def _back_to_validated(
    session: Session, message: ContactMessage, code: str, now: datetime, action: str
) -> None:
    """A scheduled message a person must review: the validation stays, the send moment and any
    claim go, the code says why."""
    audit.annotate(session, DISPATCH_ACTOR, message, action, reason=code)
    message.status = M.VALIDATED
    message.scheduled_at = None
    message.dispatch_claim_id = None
    message.dispatch_claimed_at = None
    message.last_error_code = code
    message.last_error_at = now
    session.flush()


def _release_for_retry(session: Session, message: ContactMessage, code: str, now: datetime) -> None:
    audit.annotate(
        session, DISPATCH_ACTOR, message, AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED, reason=code
    )
    message.dispatch_claim_id = None
    message.dispatch_claimed_at = None
    message.last_error_code = code
    message.last_error_at = now
    session.flush()


def _mark_sent(
    session: Session,
    message: ContactMessage,
    now: datetime,
    *,
    actor: ActorContext = DISPATCH_ACTOR,
    code: str | None = None,
    reason: str = "confirmed",
) -> None:
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SENT, reason=reason)
    message.status = M.SENT
    message.sent_at = now
    # The Toolbox returns no Message-ID (references/toolbox-capabilities.md).
    message.remote_message_id = None
    message.last_error_code = code
    message.last_error_at = now if code else None
    session.flush()


# --- the pass -------------------------------------------------------------------------------------


@dataclass
class _Claim:
    message_id: uuid.UUID
    claim_id: uuid.UUID
    draft_id: str
    step: ContactMessageStep


@dataclass
class Dispatcher:
    """One pass at a time per instance (the caller serializes: `ContactDispatcher`, the CLI).
    `active_claims` are the claims whose send this process is running: never reconciled."""

    session_factory: sessionmaker[Session]
    config: DispatchConfig
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    active_claims: set[uuid.UUID] = field(default_factory=set)

    def run_pass(self, toolbox: MailToolbox) -> DispatchReport:
        report = DispatchReport()
        self._reconcile(toolbox, report)
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            due = list(
                session.scalars(
                    select(ContactMessage.id)
                    .where(
                        ContactMessage.status == M.SCHEDULED,
                        ContactMessage.dispatch_claim_id.is_(None),
                        ContactMessage.scheduled_at <= self.now(),
                    )
                    .order_by(ContactMessage.scheduled_at, ContactMessage.step, ContactMessage.id)
                    .limit(self.config.batch_size)
                )
            )
        for message_id in due:
            try:
                self._dispatch_one(toolbox, message_id, report)
            except OperationalError as error:
                if not _is_lock_conflict(error):
                    raise
                # A concurrent person's write won a lock race (PostgreSQL aborted this side): the
                # message is left as it is and looked at again by the next pass.
                report.deferred += 1
                logger.warning(
                    "contact_dispatch.lock_conflict message=%s sqlstate=%s",
                    message_id,
                    getattr(error.orig, "sqlstate", None),
                )
            except Exception as error:
                # One message's unexpected failure must not stop the pass; if it struck after a
                # claim, the claim stays and the reconciliation settles it.
                logger.exception(
                    "contact_dispatch.message_failed message=%s error=%s",
                    message_id,
                    type(error).__name__,
                )
        if report.busy:
            logger.info("contact_dispatch.pass %s", report.summary)
        return report

    # --- one due message ---

    def _dispatch_one(
        self, toolbox: MailToolbox, message_id: uuid.UUID, report: DispatchReport
    ) -> None:
        verdict = self._check(message_id, report)
        if verdict == "create_draft":
            if not self._create_draft(toolbox, message_id, report):
                return
            verdict = self._check(message_id, report)
        if verdict != "claim":
            return
        claim = self._claim(message_id, report)
        if claim is None:
            return
        self.active_claims.add(claim.claim_id)
        try:
            self._send(toolbox, claim, report)
        finally:
            self.active_claims.discard(claim.claim_id)

    def _check(self, message_id: uuid.UUID, report: DispatchReport) -> str:
        """`claim`, `create_draft`, or `done` (handled or left for later)."""
        now = self.now()
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            message = _locked(session, message_id)
            if (
                message is None  # gone, or locked by a person's write: next pass
                or message.status is not M.SCHEDULED
                or message.dispatch_claim_id is not None
                or message.scheduled_at is None
                or message.scheduled_at > now
            ):
                return "done"
            if _sequence(session, message.prospect_id, lock=False).closed:
                report.cancelled += _cancel_if_closed(session, message.prospect_id, now)
                return "done"
            if now - message.scheduled_at > self.config.max_lateness:
                _back_to_validated(
                    session, message, OVERDUE, now, AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED
                )
                _log("overdue", message)
                report.overdue += 1
                report.failed += 1
                return "done"
            if message.last_error_at is not None and now - message.last_error_at < backoff(
                message.dispatch_attempts, self.config.retry_base
            ):
                report.deferred += 1
                return "done"
            refusal = self._recipients_refusal(message)
            if refusal is None:
                order = self._order(session, message)
                if order == "wait":
                    report.deferred += 1
                    return "done"
                refusal = order
            if refusal is not None:
                _back_to_validated(
                    session, message, refusal, now, AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED
                )
                _log("refused", message, code=refusal)
                report.failed += 1
                return "done"
            return "create_draft" if message.remote_draft_id is None else "claim"

    def _recipients_refusal(self, message: ContactMessage) -> str | None:
        if not message.to_recipients:
            return MISSING_RECIPIENTS
        recipients = [*message.to_recipients, *message.cc_recipients, *message.bcc_recipients]
        if not allowlist_permits(self.config.allowlist, recipients):
            return RECIPIENT_NOT_ALLOWED
        return None

    @staticmethod
    def _order(session: Session, message: ContactMessage) -> str | None:
        """Decision C-24: `wait`, the refusal code, or None (free to leave)."""
        steps = list(ContactMessageStep)
        position = steps.index(message.step)
        if position == 0:
            return None
        previous = session.scalar(
            select(ContactMessage).where(
                ContactMessage.prospect_id == message.prospect_id,
                ContactMessage.step == steps[position - 1],
            )
        )
        if previous is None or previous.status in (M.SENT, M.CANCELLED):
            return None
        if previous.status is M.SCHEDULED and (
            previous.scheduled_at is not None
            and message.scheduled_at is not None
            and previous.scheduled_at <= message.scheduled_at
        ):
            return "wait"
        return PREVIOUS_STEP_PENDING

    def _create_draft(
        self, toolbox: MailToolbox, message_id: uuid.UUID, report: DispatchReport
    ) -> bool:
        """The missing Infomaniak draft, created before the send (S6's rules: an unknown outcome
        is looked for first). False when it could not be (the attempt is recorded)."""
        sync = sync_remote_draft(
            self.session_factory,
            toolbox,
            message_id,
            DISPATCH_ACTOR,
            DISPATCH_CONTEXT,
            now=self.now(),
        )
        if sync.status in ("created", "recovered", "already_present"):
            return True
        if sync.status != "failed":
            report.deferred += 1  # stale (changed meanwhile) or not applicable any more
            return False
        now = self.now()
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            message = _locked(session, message_id)
            if (
                message is None
                or message.status is not M.SCHEDULED
                or message.dispatch_claim_id is not None
            ):
                return False
            terminal = (
                sync.code in TERMINAL or message.dispatch_attempts + 1 >= self.config.max_attempts
            )
            message.dispatch_attempts += 1
            if terminal:
                _back_to_validated(
                    session,
                    message,
                    DRAFT_NOT_CREATED,
                    now,
                    AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                )
                report.failed += 1
            else:
                # The `toolbox_*` code recorded by the creation stays: the editor says it.
                audit.annotate(
                    session,
                    DISPATCH_ACTOR,
                    message,
                    AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                    reason=sync.code,
                )
                message.last_error_at = now
                session.flush()
                report.retrying += 1
            _log("draft_not_created", message, code=sync.code, terminal=terminal)
        return False

    def _claim(self, message_id: uuid.UUID, report: DispatchReport) -> _Claim | None:
        now = self.now()
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            prospect_id = session.scalar(
                select(ContactMessage.prospect_id).where(ContactMessage.id == message_id)
            )
            if prospect_id is None:
                return None
            # Lock order of the closing writes (state change, opposition): prospect and tracking
            # first (share locks: the state and opposition read now hold until the claim commits),
            # then the message row.
            sequence = _sequence(session, prospect_id, lock=True)
            message = _locked(session, message_id)
            if (
                message is None
                or message.status is not M.SCHEDULED
                or message.dispatch_claim_id is not None
                or message.validated_revision != message.revision
                or message.remote_draft_id is None
                or message.scheduled_at is None
                or message.scheduled_at > now
                or not message.to_recipients
            ):
                return None
            if sequence.closed:
                report.cancelled += _cancel_if_closed(session, message.prospect_id, now)
                return None
            # Recipients, allowlist and step order, checked again right before the send.
            if (
                self._recipients_refusal(message) is not None
                or self._order(session, message) is not None
            ):
                report.deferred += 1
                return None
            claim_id = uuid.uuid4()
            audit.annotate(
                session, DISPATCH_ACTOR, message, AuditAction.CONTACT_MESSAGE_DISPATCH_CLAIMED
            )
            message.dispatch_claim_id = claim_id
            message.dispatch_claimed_at = now
            message.dispatch_attempts += 1
            session.flush()
            _log("claimed", message, attempt=message.dispatch_attempts)
            return _Claim(message.id, claim_id, message.remote_draft_id, message.step)

    def _send(self, toolbox: MailToolbox, claim: _Claim, report: DispatchReport) -> None:
        try:
            toolbox.send_draft(claim.draft_id)
        except Exception as error:
            # A failure of the send itself is classified below (never a silent retry).
            self._failed(claim, classify_send_error(error), report, error)
            return
        try:
            with audit.attributed_unit_of_work(
                self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
            ) as session:
                message = _locked(session, claim.message_id, skip_locked=False)
                if message is None or message.dispatch_claim_id != claim.claim_id:
                    report.uncertain += 1
                    return
                _mark_sent(session, message, self.now())
                _log("sent", message)
        except Exception:
            # It left, but `sent` could not be recorded (database down…): the claim stays and the
            # reconciliation concludes from the draft's absence, without resending.
            logger.exception("contact_dispatch.sent_not_recorded message=%s", claim.message_id)
            report.uncertain += 1
            return
        report.sent += 1

    def _failed(
        self, claim: _Claim, outcome: Outcome, report: DispatchReport, error: BaseException
    ) -> None:
        upstream = error.upstream_status if isinstance(error, ToolboxError) else None
        logger.warning(
            "contact_dispatch.send_failed message=%s step=%s kind=%s code=%s upstream_status=%s "
            "error=%s",
            claim.message_id,
            claim.step.value,
            outcome.kind,
            outcome.code,
            upstream,
            type(error).__name__,
        )
        now = self.now()
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            message = _locked(session, claim.message_id, skip_locked=False)
            if (
                message is None
                or message.status is not M.SCHEDULED
                or message.dispatch_claim_id != claim.claim_id
            ):
                report.uncertain += 1
                return
            if outcome.kind == "uncertain":
                # The claim stays: reconciled after the TTL, never resent.
                audit.annotate(
                    session,
                    DISPATCH_ACTOR,
                    message,
                    AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                    reason=outcome.code,
                )
                message.last_error_code = OUTCOME_UNKNOWN
                message.last_error_at = now
                session.flush()
                report.uncertain += 1
                return
            if (
                outcome.code == send_code("toolbox_draft_not_found")
                and message.last_error_code == NOT_CONFIRMED
            ):
                # Retried after a claim whose send was never recorded, and the draft is gone now:
                # that earlier attempt probably sent it. Kept for the reconciliation (draft gone:
                # deduced sent) or a person, never back to Validé where it could be resent.
                audit.annotate(
                    session,
                    DISPATCH_ACTOR,
                    message,
                    AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                    reason=PROBABLY_SENT,
                )
                message.last_error_code = PROBABLY_SENT
                message.last_error_at = now
                session.flush()
                report.uncertain += 1
                return
            terminal = (
                outcome.kind == "terminal" or message.dispatch_attempts >= self.config.max_attempts
            )
            if outcome.code == send_code("toolbox_draft_not_found"):
                # Gone from the mailbox (deleted, or sent from the webmail): nothing to clean up.
                message.remote_provider = None
                message.remote_draft_id = None
            if terminal:
                _back_to_validated(
                    session,
                    message,
                    outcome.code,
                    now,
                    AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                )
                report.failed += 1
            else:
                _release_for_retry(session, message, outcome.code, now)
                report.retrying += 1
            # A state change during the call left the message to us (`in_flight`): cancel it now.
            report.cancelled += _cancel_if_closed(session, message.prospect_id, now)

    # --- stale claims ---

    def _reconcile(self, toolbox: MailToolbox, report: DispatchReport) -> None:
        cutoff = self.now() - self.config.claim_ttl
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            stale = [
                (message_id, claim_id)
                for message_id, claim_id in session.execute(
                    select(ContactMessage.id, ContactMessage.dispatch_claim_id).where(
                        ContactMessage.status == M.SCHEDULED,
                        ContactMessage.dispatch_claim_id.is_not(None),
                        ContactMessage.dispatch_claimed_at <= cutoff,
                    )
                ).tuples()
                if claim_id not in self.active_claims
            ]
        if not stale:
            return
        try:
            drafts = toolbox.list_drafts(RECONCILE_LIST_LIMIT)
        except ToolboxError as error:
            report.deferred += len(stale)
            logger.warning(
                "contact_dispatch.reconcile_deferred stale=%s code=%s", len(stale), error.code
            )
            self._mark_inconclusive(stale)
            return
        for message_id, claim_id in stale:
            self._reconcile_one(message_id, claim_id, drafts, report)

    def _reconcile_one(
        self,
        message_id: uuid.UUID,
        claim_id: uuid.UUID | None,
        drafts: Collection[DraftSummary],
        report: DispatchReport,
    ) -> None:
        now = self.now()
        with audit.attributed_unit_of_work(
            self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
        ) as session:
            message = _locked(session, message_id)
            if (
                message is None
                or message.status is not M.SCHEDULED
                or message.dispatch_claim_id != claim_id
                or claim_id in self.active_claims
            ):
                return
            draft_id = message.remote_draft_id
            present = draft_id is not None and any(d.draft_id == draft_id for d in drafts)
            if present:
                # Still in the mailbox. A recorded unknown outcome is never retried automatically
                # (C-25): back to Validé, a person checks the sent items and reschedules. A claim
                # without a recorded outcome (its process died) is retried: backoff, attempts and
                # lateness still bound it.
                if (
                    message.last_error_code in UNCONFIRMED
                    or message.dispatch_attempts >= self.config.max_attempts
                ):
                    _back_to_validated(
                        session,
                        message,
                        NOT_CONFIRMED,
                        now,
                        AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
                    )
                    report.failed += 1
                else:
                    _release_for_retry(session, message, NOT_CONFIRMED, now)
                report.reconciled_retry += 1
                report.cancelled += _cancel_if_closed(session, message.prospect_id, now)
                _log("reconciled_not_sent", message)
                return
            if draft_id is None or len(drafts) >= RECONCILE_LIST_LIMIT:
                # A full page proves nothing: the claim stays, a person may settle it.
                self._inconclusive(session, message, now)
                report.uncertain += 1
                return
            _mark_sent(session, message, now, code=RECONCILED_SENT, reason="reconciled")
            report.reconciled_sent += 1
            _log("reconciled_sent", message)

    def _mark_inconclusive(self, stale: list[tuple[uuid.UUID, uuid.UUID | None]]) -> None:
        now = self.now()
        for message_id, claim_id in stale:
            with audit.attributed_unit_of_work(
                self.session_factory, DISPATCH_ACTOR, DISPATCH_CONTEXT
            ) as session:
                message = _locked(session, message_id)
                if message is not None and message.dispatch_claim_id == claim_id:
                    self._inconclusive(session, message, now)

    @staticmethod
    def _inconclusive(session: Session, message: ContactMessage, now: datetime) -> None:
        """Said once (the code), so a person sees why the send stays locked."""
        if message.last_error_code in UNCONFIRMED:
            return
        audit.annotate(
            session,
            DISPATCH_ACTOR,
            message,
            AuditAction.CONTACT_MESSAGE_DISPATCH_FAILED,
            reason=RECONCILE_INCONCLUSIVE,
        )
        message.last_error_code = RECONCILE_INCONCLUSIVE
        message.last_error_at = now
        session.flush()


# --- a person settles an unconfirmed send ---------------------------------------------------------


def is_unconfirmed(message: ContactMessage, now: datetime, claim_ttl: timedelta) -> bool:
    """Claimed, and the send call is over without a known outcome (or the claim is older than the
    TTL: its process died). A send still running is never settled by a person."""
    if message.status is not M.SCHEDULED or message.dispatch_claim_id is None:
        return False
    if message.last_error_code in UNCONFIRMED:
        return True
    claimed_at = message.dispatch_claimed_at
    return claimed_at is not None and now - claimed_at >= claim_ttl


def _settle_target(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    expected_revision: int,
    now: datetime,
    claim_ttl: timedelta,
) -> ContactMessage:
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("An unconfirmed send is settled by a person.")
    get_prospect(session, prospect_id)  # 404 `not_found` for an unknown prospect
    message = session.scalar(
        select(ContactMessage)
        .where(ContactMessage.prospect_id == prospect_id, ContactMessage.step == step)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if message is None:
        raise ContactMessageError(
            "message_not_found", HTTPStatus.NOT_FOUND, "No message for this step yet."
        )
    if message.revision != expected_revision:
        raise ContactMessageError(
            "revision_conflict",
            HTTPStatus.CONFLICT,
            "The message changed since it was read: reload it before going on.",
        )
    if message.status is not M.SCHEDULED:
        raise ContactMessageError(
            "invalid_transition",
            HTTPStatus.CONFLICT,
            f"Cannot settle the send of a message in status {message.status.value}.",
            status=message.status.value,
        )
    if not is_unconfirmed(message, now, claim_ttl):
        raise ContactMessageError(
            "dispatch_not_unconfirmed",
            HTTPStatus.CONFLICT,
            "This message's send is not waiting for a person: it is not claimed, or still running.",
        )
    return message


def mark_sent(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    expected_revision: int,
    *,
    claim_ttl: timedelta,
    now: datetime | None = None,
) -> ContactMessage:
    """« Marquer envoyé »: the person found the mail in the mailbox's sent items."""
    moment = now or datetime.now(UTC)
    message = _settle_target(
        session, actor, prospect_id, step, expected_revision, moment, claim_ttl
    )
    _mark_sent(session, message, moment, actor=actor, code=MARKED_SENT, reason="person")
    _log("marked_sent", message, actor=actor.type.value)
    return message


def release(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    expected_revision: int,
    *,
    claim_ttl: timedelta,
    now: datetime | None = None,
) -> ContactMessage:
    """« Remettre en Validé »: the person checked that the mail did not leave. Only once the claim
    is older than the TTL: the Toolbox's own call to Infomaniak has no timeout, so a send VIPER
    gave up on may still be finishing (409 `dispatch_release_too_early` with `available_at`).
    The validation and the Infomaniak draft stay; a closed sequence then cancels it (decision
    29)."""
    moment = now or datetime.now(UTC)
    message = _settle_target(
        session, actor, prospect_id, step, expected_revision, moment, claim_ttl
    )
    claimed_at = message.dispatch_claimed_at
    if claimed_at is not None and moment - claimed_at < claim_ttl:
        available_at = claimed_at + claim_ttl
        raise ContactMessageError(
            "dispatch_release_too_early",
            HTTPStatus.CONFLICT,
            "The send may still be finishing on the Toolbox's side: put it back to Validé only "
            "after the claim's delay (or mark it sent if it is in the sent items).",
            available_at=available_at.isoformat(),
        )
    audit.annotate(
        session, actor, message, AuditAction.CONTACT_MESSAGE_DISPATCH_RELEASED, reason=RELEASED
    )
    message.status = M.VALIDATED
    message.scheduled_at = None
    message.dispatch_claim_id = None
    message.dispatch_claimed_at = None
    message.dispatch_attempts = 0
    message.last_error_code = RELEASED
    message.last_error_at = moment
    session.flush()
    _cancel_if_closed(session, message.prospect_id, moment, actor)
    _log("released", message, actor=actor.type.value)
    return message


# --- pending counts (Settings > Connexions) -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DispatchCounts:
    scheduled: int
    # Claimed without a known outcome: a person may have to settle them.
    unconfirmed: int


def dispatch_counts(
    session: Session, *, claim_ttl: timedelta, now: datetime | None = None
) -> DispatchCounts:
    """`unconfirmed` = claimed with an unknown outcome, or a claim older than the TTL (the same
    rule as `is_unconfirmed`)."""
    stale_before = (now or datetime.now(UTC)) - claim_ttl
    row = session.execute(
        select(
            func.count(),
            func.count().filter(
                ContactMessage.dispatch_claim_id.is_not(None),
                ContactMessage.last_error_code.in_(tuple(UNCONFIRMED))
                | (ContactMessage.dispatch_claimed_at <= stale_before),
            ),
        ).where(ContactMessage.status == M.SCHEDULED)
    ).one()
    return DispatchCounts(scheduled=row[0], unconfirmed=row[1])


# --- the operator's safeguard (after a database restore, before maintenance) ---------------------


@dataclass(frozen=True, slots=True)
class Hold:
    held: int
    # Claimed (a send running or unconfirmed): left as they are, a person settles them.
    claimed: int


def hold_scheduled(session: Session, actor: ActorContext, now: datetime | None = None) -> Hold:
    """Every unclaimed scheduled message back to Validé (`dispatch_held`): a restored backup
    taken before a send would otherwise send it again (handoff FINAL_REPORT recommendation 4).
    People then schedule again what must leave."""
    moment = now or datetime.now(UTC)
    rows = session.scalars(
        select(ContactMessage)
        .where(ContactMessage.status == M.SCHEDULED)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    held = claimed = 0
    for message in rows:
        if message.dispatch_claim_id is not None:
            claimed += 1
            continue
        audit.annotate(
            session, actor, message, AuditAction.CONTACT_MESSAGE_UNSCHEDULED, reason=HELD
        )
        message.status = M.VALIDATED
        message.scheduled_at = None
        message.last_error_code = HELD
        message.last_error_at = moment
        held += 1
    session.flush()
    logger.info("contact_dispatch.held held=%s claimed=%s", held, claimed)
    return Hold(held, claimed)
