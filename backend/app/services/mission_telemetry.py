"""Mission telemetry: agent sessions, activity logs and the 3 h inactivity timeout.

Contract: `doc/architecture/mission-telemetry.md`. Telemetry **observes** agent work: it never
renews, shortens or releases a task lease (`agent_missions.DEFAULT_LEASE`, 15 min) and never touches
`agent_tasks`. There is no register / log-off: `touch_session` is get-or-open and rides on the
transaction of the call that proves activity (claim, heartbeat, log write, submit, fail, release).
Nothing here flushes outside the caller's transaction; the scheduler and the request commit it.
"""

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, func, literal_column, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql.dml import ReturningInsert

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask
from app.models.enums import (
    MissionAgentDisconnectReason,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
)
from app.models.mission_telemetry import (
    LOG_MESSAGE_MAX_LENGTH,
    LOG_SOURCE_URL_MAX_LENGTH,
    MissionAgentLog,
    MissionAgentSession,
)
from app.models.missions import Mission, MissionRun
from app.services import audit
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    InvalidFieldError,
    NotFoundError,
)

# Distinct from, and never derived from, the task lease (§2).
SESSION_INACTIVITY_TIMEOUT = timedelta(hours=3)
# §5.6: at most this many log writes per token in any rolling minute (`rate_limited` beyond).
LOG_RATE_LIMIT_PER_MINUTE = 120
LOG_RATE_WINDOW = timedelta(minutes=1)
RATE_LIMITED = "rate_limited"
SWEEP_BATCH_SIZE = 200

# Log limits (§5.4, §5.1).
METADATA_MAX_BYTES = 4096
METADATA_MAX_DEPTH = 3
METADATA_STRING_MAX_LENGTH = 500
# A key containing one of these is refused: telemetry never stores reasoning (§6).
FORBIDDEN_METADATA_KEYS = (
    "thought",
    "thinking",
    "reasoning",
    "chain_of_thought",
    "scratchpad",
    "cot",
)
SOURCE_PUBLISHED_MAX_FUTURE = timedelta(days=1)

TIMEOUT_MESSAGE = "Session expirée après 3 h d'inactivité."

# Reads (§8): `limit` bounds, shared with the Slice 05 routes.
ACTIVITY_DEFAULT_LIMIT = 50
SESSIONS_DEFAULT_LIMIT = 25
PAGE_MAX_LIMIT = 100

SYSTEM_ACTOR = ActorContext(
    type=ActorType.SYSTEM, display="VIPER — supervision des missions", id="sessions"
)


def _moment(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


def _agent_id(actor: ActorContext) -> str:
    if actor.type is not ActorType.AGENT or not actor.id:
        raise ActorNotAllowedError("Only a registered agent has a mission session.")
    return actor.id


def _session_event(
    session: Session,
    actor: ActorContext,
    action: str,
    row: MissionAgentSession,
    reason: str | None = None,
) -> None:
    """One audited lifecycle event; subject = the mission, payload carries no log content."""
    audit.record_event(
        session,
        actor,
        action,
        entity_type="mission_agent_session",
        entity_id=row.id,
        subject=("mission", row.mission_id),
        changes={
            "status": {"before": None, "after": row.status.value},
            "agent_label": {"before": None, "after": row.agent_label},
        },
        reason=reason,
    )


# --- sessions -----------------------------------------------------------------------------------


def touch_session(
    session: Session, actor: ActorContext, task: AgentTask, now: datetime | None = None
) -> MissionAgentSession | None:
    """Get-or-open the active session of (task's run, agent) and move `last_seen_at` forward.

    Returns None for a task without a run (legacy « Analyse » and tool-mode tasks have no session).
    Concurrent callers converge on one row: `INSERT … ON CONFLICT` on the partial unique index
    (`uq_mission_agent_sessions_active`) either inserts or updates the existing active row. A
    session that ended or timed out is never reactivated: the agent gets a new one (§3.2).
    """
    if task.run_id is None:
        return None
    agent_id = _agent_id(actor)
    moment = _moment(now)
    mission_id = session.scalar(select(MissionRun.mission_id).where(MissionRun.id == task.run_id))
    if mission_id is None:
        return None
    upsert: ReturningInsert[Any] = (
        pg_insert(MissionAgentSession)
        .values(
            id=uuid.uuid7(),
            mission_id=mission_id,
            run_id=task.run_id,
            agent_id=agent_id,
            agent_label=actor.display[:255],
            started_at=moment,
            last_seen_at=moment,
            status=MissionAgentSessionStatus.ACTIVE,
        )
        .on_conflict_do_update(
            index_elements=["run_id", "agent_id"],
            index_where=text("status = 'active'"),
            set_={"last_seen_at": func.greatest(MissionAgentSession.last_seen_at, moment)},
        )
        # `xmax = 0` is true only for a row this statement inserted (not for the upsert's update).
        .returning(MissionAgentSession.id, literal_column("(xmax = 0)").label("inserted"))
    )
    row_id, inserted = session.execute(upsert).one()
    row = session.get(MissionAgentSession, row_id, populate_existing=True)
    if row is None:  # pragma: no cover - the statement just returned its id
        raise RuntimeError("The mission agent session vanished inside its own transaction.")
    if inserted:
        _session_event(session, actor, audit.AuditAction.MISSION_AGENT_SESSION_OPENED, row)
    return row


def active_session(
    session: Session, run_id: uuid.UUID, agent_id: str
) -> MissionAgentSession | None:
    return session.scalar(
        select(MissionAgentSession).where(
            MissionAgentSession.run_id == run_id,
            MissionAgentSession.agent_id == agent_id,
            MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE,
        )
    )


def _close(
    session: Session,
    row: MissionAgentSession,
    status: MissionAgentSessionStatus,
    reason: MissionAgentDisconnectReason,
    ended_at: datetime,
    actor: ActorContext,
    action: str,
) -> None:
    row.status = status
    row.disconnect_reason = reason
    row.ended_at = ended_at
    session.flush()
    audit.record_event(
        session,
        actor,
        action,
        entity_type="mission_agent_session",
        entity_id=row.id,
        subject=("mission", row.mission_id),
        changes={
            "status": {"before": "active", "after": status.value},
            "disconnect_reason": {"before": None, "after": reason.value},
        },
        reason=reason.value,
    )


def _latest_own_session(
    session: Session, actor: ActorContext, run_id: uuid.UUID, *, lock: bool = False
) -> MissionAgentSession:
    """The most recent session of the calling agent in `run_id`; `NotFoundError` when it has none
    (the same answer for an unknown run and for another agent's run: nothing is revealed)."""
    statement = (
        select(MissionAgentSession)
        .where(
            MissionAgentSession.run_id == run_id,
            MissionAgentSession.agent_id == _agent_id(actor),
        )
        .order_by(MissionAgentSession.started_at.desc(), MissionAgentSession.id.desc())
        .limit(1)
    )
    row = session.scalar(statement.with_for_update() if lock else statement)
    if row is None:
        raise NotFoundError("This agent has no session in this run.")
    return row


def _task_run_id(session: Session, task_id: uuid.UUID) -> uuid.UUID:
    run_id = session.scalar(select(AgentTask.run_id).where(AgentTask.id == task_id))
    if run_id is None:
        # Unknown task or a task without a run (legacy thread): no session can exist for it.
        raise NotFoundError("This agent has no session for this task.")
    return run_id


def own_session_of_task(
    session: Session, actor: ActorContext, task_id: uuid.UUID
) -> tuple[MissionAgentSession, int]:
    """Read-only: the calling agent's latest session in the run of `task_id`, with its logs count.
    Never touches the session (§3.3) and never shows another agent's (§7.1)."""
    row = _latest_own_session(session, actor, _task_run_id(session, task_id))
    count = session.scalar(
        select(func.count(MissionAgentLog.id)).where(MissionAgentLog.session_id == row.id)
    )
    return row, count or 0


def end_own_session(
    session: Session, actor: ActorContext, task_id: uuid.UUID, now: datetime | None = None
) -> MissionAgentSession:
    """`end_session` for the run of `task_id` (the task need not still be claimed)."""
    return end_session(session, actor, _task_run_id(session, task_id), now)


def check_log_rate(session: Session, actor: ActorContext, now: datetime | None = None) -> None:
    """Refuse (`rate_limited`, 429) the log write of a token that already wrote
    `LOG_RATE_LIMIT_PER_MINUTE` logs in the last minute (§5.6). Counted in the database, so every
    API worker sees the same figure; a refused log is non-fatal for the agent's work.

    Only sessions seen within the window can hold such logs (every log write touches its session),
    which keeps the count on the small table and the `(session_id, created_at)` stream index.
    """
    moment = _moment(now)
    cutoff = moment - LOG_RATE_WINDOW
    recent = (
        select(MissionAgentSession.id)
        .where(
            MissionAgentSession.agent_id == _agent_id(actor),
            MissionAgentSession.last_seen_at >= cutoff,
        )
        .scalar_subquery()
    )
    written = session.scalar(
        select(func.count(MissionAgentLog.id)).where(
            MissionAgentLog.session_id.in_(recent), MissionAgentLog.created_at >= cutoff
        )
    )
    if (written or 0) >= LOG_RATE_LIMIT_PER_MINUTE:
        raise BusinessRuleError(
            RATE_LIMITED,
            429,
            f"At most {LOG_RATE_LIMIT_PER_MINUTE} logs per minute: keep working, log less often.",
            limit=LOG_RATE_LIMIT_PER_MINUTE,
            window_seconds=int(LOG_RATE_WINDOW.total_seconds()),
        )


def end_session(
    session: Session, actor: ActorContext, run_id: uuid.UUID, now: datetime | None = None
) -> MissionAgentSession:
    """The agent ends **its own** session of a run (courtesy, never required; idempotent).

    Resolved from the token, never from a client-supplied session id. Releases and fails nothing.
    An already terminal session is returned unchanged (the most recent one of the agent in the run).
    """
    row = _latest_own_session(session, actor, run_id, lock=True)
    if row.status is MissionAgentSessionStatus.ACTIVE:
        _close(
            session,
            row,
            MissionAgentSessionStatus.ENDED,
            MissionAgentDisconnectReason.AGENT_ENDED,
            _moment(now),
            actor,
            audit.AuditAction.MISSION_AGENT_SESSION_ENDED,
        )
    return row


def end_own_active_sessions(
    session: Session,
    actor: ActorContext,
    run_ids: Sequence[uuid.UUID] | None = None,
    now: datetime | None = None,
) -> int:
    """The agent ends **all its own active** sessions (those of `run_ids` when given); idempotent.

    Same closing as `end_session` (`agent_ended`), for the « leave work » contract
    (`agent_lifecycle.leave_work`). Returns how many sessions were closed; none is not an error.
    """
    statement = (
        select(MissionAgentSession)
        .where(
            MissionAgentSession.agent_id == _agent_id(actor),
            MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE,
        )
        .order_by(MissionAgentSession.id)
        .with_for_update()
    )
    if run_ids is not None:
        statement = statement.where(MissionAgentSession.run_id.in_(list(run_ids)))
    moment = _moment(now)
    rows = session.scalars(statement).all()
    for row in rows:
        _close(
            session,
            row,
            MissionAgentSessionStatus.ENDED,
            MissionAgentDisconnectReason.AGENT_ENDED,
            moment,
            actor,
            audit.AuditAction.MISSION_AGENT_SESSION_ENDED,
        )
    return len(rows)


def end_run_sessions(
    session: Session,
    run_ids: Sequence[uuid.UUID],
    reason: MissionAgentDisconnectReason,
    now: datetime | None = None,
) -> int:
    """Close the active sessions of runs that finished or were cancelled (`system` actor).

    Called from `missions.refresh_run` (`run_finished`) and `missions.set_status`
    (`mission_cancelled`) in their own transaction. Returns how many sessions were closed.
    """
    if not run_ids:
        return 0
    moment = _moment(now)
    rows = session.scalars(
        select(MissionAgentSession)
        .where(
            MissionAgentSession.run_id.in_(list(run_ids)),
            MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE,
        )
        .order_by(MissionAgentSession.id)
        .with_for_update()
    ).all()
    for row in rows:
        _close(
            session,
            row,
            MissionAgentSessionStatus.ENDED,
            reason,
            moment,
            SYSTEM_ACTOR,
            audit.AuditAction.MISSION_AGENT_SESSION_ENDED,
        )
    return len(rows)


def sweep_timed_out(session: Session, now: datetime | None = None) -> int:
    """Time out the active sessions silent for 3 h (§4). Never touches a task or a lease.

    Rows are locked `SKIP LOCKED` (two workers never double-process) and the status predicate makes
    a re-run idempotent. `ended_at = last_seen_at + 3 h`, independent of sweep latency. Each session
    gets one `warning` log and one `mission_agent_session.timed_out` audit event. Returns the count.
    """
    moment = _moment(now)
    rows = session.scalars(
        select(MissionAgentSession)
        .where(
            MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE,
            MissionAgentSession.last_seen_at < moment - SESSION_INACTIVITY_TIMEOUT,
        )
        .order_by(MissionAgentSession.last_seen_at)
        .limit(SWEEP_BATCH_SIZE)
        .with_for_update(skip_locked=True)
    ).all()
    for row in rows:
        ended_at = row.last_seen_at + SESSION_INACTIVITY_TIMEOUT
        last_seen = row.last_seen_at
        _close(
            session,
            row,
            MissionAgentSessionStatus.TIMED_OUT,
            MissionAgentDisconnectReason.INACTIVITY_TIMEOUT,
            ended_at,
            SYSTEM_ACTOR,
            audit.AuditAction.MISSION_AGENT_SESSION_TIMED_OUT,
        )
        session.add(
            MissionAgentLog(
                session_id=row.id,
                mission_id=row.mission_id,
                run_id=row.run_id,
                task_id=None,
                agent_id=row.agent_id,
                event_type=MissionAgentLogEvent.WARNING,
                message=TIMEOUT_MESSAGE,
                created_at=ended_at,
                details={
                    "reason": MissionAgentDisconnectReason.INACTIVITY_TIMEOUT.value,
                    "last_seen_at": last_seen.isoformat(),
                    "timeout_seconds": int(SESSION_INACTIVITY_TIMEOUT.total_seconds()),
                },
            )
        )
    session.flush()
    return len(rows)


# --- logs ---------------------------------------------------------------------------------------


def _check_message(message: str) -> str:
    text_ = message.strip()
    if not text_:
        raise InvalidFieldError("message", "A log message is required.", "required")
    if len(text_) > LOG_MESSAGE_MAX_LENGTH:
        raise InvalidFieldError(
            "message", f"At most {LOG_MESSAGE_MAX_LENGTH} characters.", "too_long"
        )
    if "<" in text_ and ">" in text_:
        raise InvalidFieldError("message", "Plain text only: no HTML.", "html")
    return text_


def _check_url(url: str | None) -> str | None:
    if url is None:
        return None
    candidate = url.strip()
    parts = urlsplit(candidate)
    if (
        len(candidate) > LOG_SOURCE_URL_MAX_LENGTH
        or parts.scheme not in ("http", "https")
        or not parts.netloc
    ):
        raise InvalidFieldError("source_url", "A public http(s) URL is required.", "format")
    return candidate


def _check_published(value: datetime | None, now: datetime) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    if value > now + SOURCE_PUBLISHED_MAX_FUTURE:
        raise InvalidFieldError(
            "source_published_at", "The publication date cannot be in the future.", "future"
        )
    return value


def _check_metadata_value(value: Any, depth: int) -> None:
    if isinstance(value, dict):
        if depth > METADATA_MAX_DEPTH:
            raise InvalidFieldError("metadata", "Nested too deeply.", "depth")
        for key, item in value.items():
            lowered = str(key).lower()
            if any(word in lowered for word in FORBIDDEN_METADATA_KEYS):
                raise InvalidFieldError(
                    "metadata", f"The key {key!r} is not allowed: log facts, not reasoning.", "key"
                )
            _check_metadata_value(item, depth + 1)
    elif isinstance(value, list):
        if depth > METADATA_MAX_DEPTH:
            raise InvalidFieldError("metadata", "Nested too deeply.", "depth")
        for item in value:
            _check_metadata_value(item, depth + 1)
    elif isinstance(value, str) and len(value) > METADATA_STRING_MAX_LENGTH:
        raise InvalidFieldError(
            "metadata", f"Strings are limited to {METADATA_STRING_MAX_LENGTH} characters.", "length"
        )


def _check_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise InvalidFieldError("metadata", "A JSON object is required.", "type")
    _check_metadata_value(metadata, 1)
    try:
        size = len(json.dumps(metadata, ensure_ascii=False).encode())
    except (TypeError, ValueError) as error:
        raise InvalidFieldError("metadata", "Must be JSON-serialisable.", "type") from error
    if size > METADATA_MAX_BYTES:
        raise InvalidFieldError("metadata", f"At most {METADATA_MAX_BYTES} bytes.", "size")
    return metadata


def append_log(
    session: Session,
    actor: ActorContext,
    task: AgentTask,
    event_type: MissionAgentLogEvent | str,
    message: str,
    *,
    source_url: str | None = None,
    source_published_at: datetime | None = None,
    metadata: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> MissionAgentLog:
    """Append one factual log to the agent's **own** session (§5.6).

    The caller has already proved the live claim (`agent_missions.log_activity`); run, mission,
    agent and session are derived here from the task and the actor, never from client input.
    Validation names the failing field (`InvalidFieldError`). The write touches the session.
    """
    moment = _moment(now)
    try:
        event = MissionAgentLogEvent(event_type)
    except ValueError as error:
        raise InvalidFieldError("event_type", "Unknown event type.", "enum") from error
    clean_message = _check_message(message)
    clean_url = _check_url(source_url)
    published = _check_published(source_published_at, moment)
    clean_metadata = _check_metadata(metadata)
    row = touch_session(session, actor, task, moment)
    if row is None:
        raise InvalidFieldError("task_id", "Only a mission task can be logged against.", "no_run")
    log = MissionAgentLog(
        session_id=row.id,
        mission_id=row.mission_id,
        run_id=row.run_id,
        task_id=task.id,
        agent_id=row.agent_id,
        event_type=event,
        message=clean_message,
        source_url=clean_url,
        source_published_at=published,
        created_at=moment,
        details=clean_metadata,
    )
    session.add(log)
    session.flush()
    return log


# --- reads (cursor and offset pagination helpers, §8; routes arrive with Slice 05) ---------------


@dataclass(frozen=True, slots=True)
class LogPage:
    items: list[MissionAgentLog]
    next_cursor: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class SessionPage:
    items: list[MissionAgentSession]
    total: int


def _limit(limit: int, maximum: int = PAGE_MAX_LIMIT) -> int:
    return max(1, min(limit, maximum))


def _mission_in_organization(mission_id: uuid.UUID, organization_id: uuid.UUID) -> Any:
    return (
        select(Mission.id)
        .where(Mission.id == mission_id, Mission.organization_id == organization_id)
        .exists()
    )


def list_logs(
    session: Session,
    organization_id: uuid.UUID,
    mission_id: uuid.UUID,
    *,
    run_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    agent_id: str | None = None,
    task_id: uuid.UUID | None = None,
    event_types: Sequence[MissionAgentLogEvent] = (),
    since: datetime | None = None,
    before: uuid.UUID | None = None,
    limit: int = ACTIVITY_DEFAULT_LIMIT,
) -> LogPage:
    """The mission's log stream, newest first (`created_at`, then `id`), cursor-paginated.

    `before` is the id of the last log of the previous page. Scoped through the mission's
    organization: another organization's mission yields an empty page. Read-only; never touches a
    session (§3.3).
    """
    size = _limit(limit)
    statement = select(MissionAgentLog).where(
        MissionAgentLog.mission_id == mission_id,
        _mission_in_organization(mission_id, organization_id),
    )
    if run_id is not None:
        statement = statement.where(MissionAgentLog.run_id == run_id)
    if session_id is not None:
        statement = statement.where(MissionAgentLog.session_id == session_id)
    if agent_id is not None:
        statement = statement.where(MissionAgentLog.agent_id == agent_id)
    if task_id is not None:
        statement = statement.where(MissionAgentLog.task_id == task_id)
    if event_types:
        statement = statement.where(MissionAgentLog.event_type.in_(list(event_types)))
    if since is not None:
        statement = statement.where(MissionAgentLog.created_at >= since)
    if before is not None:
        anchor = session.scalar(
            select(MissionAgentLog.created_at).where(
                MissionAgentLog.id == before, MissionAgentLog.mission_id == mission_id
            )
        )
        if anchor is None:
            raise InvalidFieldError("before", "Unknown cursor.", "cursor")
        statement = statement.where(
            or_(
                MissionAgentLog.created_at < anchor,
                and_(MissionAgentLog.created_at == anchor, MissionAgentLog.id < before),
            )
        )
    rows = list(
        session.scalars(
            statement.order_by(MissionAgentLog.created_at.desc(), MissionAgentLog.id.desc()).limit(
                size + 1
            )
        )
    )
    more = len(rows) > size
    items = rows[:size]
    return LogPage(items=items, next_cursor=items[-1].id if more else None)


def list_sessions(
    session: Session,
    organization_id: uuid.UUID,
    mission_id: uuid.UUID,
    *,
    run_id: uuid.UUID | None = None,
    statuses: Sequence[MissionAgentSessionStatus] = (),
    agent_id: str | None = None,
    limit: int = SESSIONS_DEFAULT_LIMIT,
    offset: int = 0,
) -> SessionPage:
    """The mission's sessions, `started_at` descending, offset-paginated with a total."""
    statement = select(MissionAgentSession).where(
        MissionAgentSession.mission_id == mission_id,
        _mission_in_organization(mission_id, organization_id),
    )
    if run_id is not None:
        statement = statement.where(MissionAgentSession.run_id == run_id)
    if statuses:
        statement = statement.where(MissionAgentSession.status.in_(list(statuses)))
    if agent_id is not None:
        statement = statement.where(MissionAgentSession.agent_id == agent_id)
    total = session.scalar(select(func.count()).select_from(statement.subquery())) or 0
    items = session.scalars(
        statement.order_by(MissionAgentSession.started_at.desc(), MissionAgentSession.id.desc())
        .limit(_limit(limit))
        .offset(max(0, offset))
    ).all()
    return SessionPage(items=list(items), total=total)
