"""Mission telemetry persistence (Slice 03): sessions, append-only logs, the 3 h timeout.

Contract: `doc/architecture/mission-telemetry.md`. The two clocks stay apart: the task lease
(15 min) is never touched by the session timeout (3 h), and vice versa.
"""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest
from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.db.session import create_session_factory
from app.models import AgentTask, AuditLogEntry, Mission, MissionAgentLog, MissionAgentSession
from app.models.enums import (
    AgentTaskStatus,
    AgentTaskType,
    MissionAgentDisconnectReason,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
    MissionResultKind,
    MissionRunStatus,
    MissionStatus,
    MissionType,
)
from app.models.missions import MissionRun
from app.models.organizations import Organization
from app.services import agent_missions, audit, mission_scheduler, mission_telemetry, missions
from app.services.audit import AuditSource
from app.services.errors import ActorNotAllowedError, InvalidFieldError, NotFoundError
from tests.builders import OPERATOR, add_company, audit_events, rejected

AGENT = ActorContext(type=ActorType.AGENT, id="agent-a", display="Agent A")
OTHER = ActorContext(type=ActorType.AGENT, id="agent-b", display="Agent B")
NOW = datetime(2026, 11, 12, 10, 0, tzinfo=UTC)
TIMEOUT = mission_telemetry.SESSION_INACTIVITY_TIMEOUT


@pytest.fixture
def session(db_session: Session) -> Session:
    audit.bind(db_session, AGENT, audit.AuditContext(source=AuditSource.AGENT))
    return db_session


def add_mission(session: Session, **fields: object) -> Mission:
    fields.setdefault("name", "Mission télémétrie")
    mission = Mission(
        type=MissionType.ENRICHMENT,
        prompt="Compléter les fiches.",
        result_kind=MissionResultKind.ENRICHMENT,
        created_by_type=ActorType.HUMAN,
        created_by_display="Opératrice Test",
        **fields,
    )
    session.add(mission)
    session.flush()
    return mission


def add_run(session: Session, mission: Mission) -> MissionRun:
    run = MissionRun(mission_id=mission.id, status=MissionRunStatus.RUNNING)
    session.add(run)
    session.flush()
    return run


def add_task(
    session: Session, run: MissionRun, status: AgentTaskStatus = AgentTaskStatus.PENDING
) -> AgentTask:
    company = add_company(session, display_name=f"Société {uuid.uuid4().hex[:6]}")
    task = AgentTask(
        run_id=run.id, type=AgentTaskType.UPDATE_COMPANY, company_id=company.id, status=status
    )
    session.add(task)
    session.flush()
    return task


@pytest.fixture
def work(session: Session) -> tuple[Mission, MissionRun, AgentTask]:
    mission = add_mission(session)
    run = add_run(session, mission)
    return mission, run, add_task(session, run)


def sessions_of(session: Session, run: MissionRun) -> list[MissionAgentSession]:
    session.expire_all()
    return list(
        session.scalars(
            select(MissionAgentSession)
            .where(MissionAgentSession.run_id == run.id)
            .order_by(MissionAgentSession.started_at, MissionAgentSession.id)
        )
    )


# --- touch: get-or-open ------------------------------------------------------------------------


def test_touch_opens_then_reuses_the_active_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    first = mission_telemetry.touch_session(session, AGENT, task, NOW)
    assert first is not None
    assert first.status is MissionAgentSessionStatus.ACTIVE
    assert (first.mission_id, first.run_id, first.agent_id) == (mission.id, run.id, "agent-a")
    assert first.agent_label == "Agent A"
    assert first.started_at == first.last_seen_at == NOW
    assert first.ended_at is None and first.disconnect_reason is None

    again = mission_telemetry.touch_session(session, AGENT, task, NOW + timedelta(minutes=5))
    assert again is not None and again.id == first.id
    assert again.last_seen_at == NOW + timedelta(minutes=5)
    assert len(sessions_of(session, run)) == 1


def test_touch_only_moves_last_seen_forward(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, _, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    row = mission_telemetry.touch_session(session, AGENT, task, NOW - timedelta(hours=1))
    assert row is not None and row.last_seen_at == NOW


def test_each_agent_has_its_own_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    one = mission_telemetry.touch_session(session, AGENT, task, NOW)
    two = mission_telemetry.touch_session(session, OTHER, task, NOW)
    assert one is not None and two is not None and one.id != two.id
    assert len(sessions_of(session, run)) == 2


def test_a_task_without_a_run_has_no_session(session: Session) -> None:
    company = add_company(session)
    task = AgentTask(
        type=AgentTaskType.UPDATE_COMPANY, company_id=company.id, status=AgentTaskStatus.PENDING
    )
    session.add(task)
    session.flush()
    assert mission_telemetry.touch_session(session, AGENT, task, NOW) is None
    assert session.scalar(select(func.count()).select_from(MissionAgentSession)) == 0


def test_only_an_agent_has_a_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, _, task = work
    human = ActorContext(type=ActorType.HUMAN, id="u", display="Personne")
    with pytest.raises(ActorNotAllowedError):
        mission_telemetry.touch_session(session, human, task, NOW)


def test_opening_is_audited_once_without_log_content(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, _, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    mission_telemetry.touch_session(session, AGENT, task, NOW + timedelta(minutes=1))
    events = audit_events(session, action=audit.AuditAction.MISSION_AGENT_SESSION_OPENED)
    assert len(events) == 1
    assert events[0].actor_id == "agent-a"
    assert (events[0].subject_type, events[0].subject_id) == ("mission", mission.id)


# --- explicit end, run finish, mission cancel --------------------------------------------------


def test_end_is_idempotent_and_a_later_touch_opens_a_new_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    opened = mission_telemetry.touch_session(session, AGENT, task, NOW)
    assert opened is not None
    ended = mission_telemetry.end_session(session, AGENT, run.id, NOW + timedelta(minutes=2))
    assert ended.id == opened.id
    assert ended.status is MissionAgentSessionStatus.ENDED
    assert ended.disconnect_reason is MissionAgentDisconnectReason.AGENT_ENDED
    assert ended.ended_at == NOW + timedelta(minutes=2)

    again = mission_telemetry.end_session(session, AGENT, run.id, NOW + timedelta(hours=1))
    assert again.ended_at == NOW + timedelta(minutes=2)
    assert len(audit_events(session, action=audit.AuditAction.MISSION_AGENT_SESSION_ENDED)) == 1

    reopened = mission_telemetry.touch_session(session, AGENT, task, NOW + timedelta(hours=2))
    assert reopened is not None and reopened.id != opened.id
    assert reopened.status is MissionAgentSessionStatus.ACTIVE
    assert [row.status.value for row in sessions_of(session, run)] == ["ended", "active"]


def test_an_agent_ends_only_its_own_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    with pytest.raises(NotFoundError):
        mission_telemetry.end_session(session, OTHER, run.id, NOW)
    assert sessions_of(session, run)[0].status is MissionAgentSessionStatus.ACTIVE


def test_ending_a_session_leaves_the_task_alone(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    lease = claimed.task.lease_expires_at
    mission_telemetry.end_session(session, AGENT, run.id, NOW + timedelta(minutes=1))
    assert claimed.task.status is AgentTaskStatus.CLAIMED
    assert claimed.task.lease_expires_at == lease


def test_a_finished_run_ends_its_sessions(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    task.status = AgentTaskStatus.ACCEPTED
    session.flush()
    missions.refresh_run(session, run)
    (row,) = sessions_of(session, run)
    assert row.status is MissionAgentSessionStatus.ENDED
    assert row.disconnect_reason is MissionAgentDisconnectReason.RUN_FINISHED
    ended = audit_events(session, action=audit.AuditAction.MISSION_AGENT_SESSION_ENDED)
    assert [event.actor_id for event in ended] == ["sessions"]


def test_cancelling_the_mission_ends_its_sessions(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    missions.set_status(session, OPERATOR, mission.id, MissionStatus.CANCELLED, NOW)
    (row,) = sessions_of(session, run)
    assert row.status is MissionAgentSessionStatus.ENDED
    assert row.disconnect_reason is MissionAgentDisconnectReason.MISSION_CANCELLED
    assert row.ended_at == NOW


# --- claim / heartbeat / submit integration, lease semantics unchanged -------------------------


def test_claim_opens_a_session_and_every_lease_call_touches_it(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    assert claimed.lease_seconds == 15 * 60
    assert claimed.task.lease_expires_at == NOW + timedelta(minutes=15)
    (row,) = sessions_of(session, run)
    assert (row.agent_id, row.status) == ("agent-a", MissionAgentSessionStatus.ACTIVE)

    later = NOW + timedelta(minutes=10)
    expiry = agent_missions.heartbeat(session, AGENT, claimed.task.id, claimed.claim_id, now=later)
    assert expiry == later + timedelta(minutes=15)  # lease semantics unchanged
    assert sessions_of(session, run)[0].last_seen_at == later

    result = agent_missions.submit(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        {"legal_name": "2SN SAS", "confidence": 80},
        later + timedelta(minutes=1),
    )
    assert result.status.value == "pending_review"
    (row,) = sessions_of(session, run)
    assert row.last_seen_at == later + timedelta(minutes=1)
    assert row.status is MissionAgentSessionStatus.ACTIVE  # submit does not end the session
    assert len(sessions_of(session, run)) == 1


def test_fail_and_release_touch_the_session(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    agent_missions.release(
        session, AGENT, claimed.task.id, claimed.claim_id, NOW + timedelta(minutes=3)
    )
    assert sessions_of(session, run)[0].last_seen_at == NOW + timedelta(minutes=3)
    again = agent_missions.claim(
        session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW + timedelta(minutes=4)
    )
    assert again is not None
    agent_missions.fail(
        session, AGENT, again.task.id, again.claim_id, "blocked", "x", NOW + timedelta(minutes=6)
    )
    (row,) = sessions_of(session, run)
    assert row.last_seen_at == NOW + timedelta(minutes=6)


def test_heartbeat_after_a_timeout_opens_a_new_session_without_refusing(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    # The session times out while the lease was renewed elsewhere: the task is still held.
    sessions_of(session, run)[0].last_seen_at = NOW - TIMEOUT - timedelta(minutes=1)
    session.flush()
    assert mission_telemetry.sweep_timed_out(session, NOW) == 1
    soon = NOW + timedelta(minutes=5)
    agent_missions.heartbeat(session, AGENT, claimed.task.id, claimed.claim_id, now=soon)
    states = [row.status.value for row in sessions_of(session, run)]
    assert states == ["timed_out", "active"]


def test_the_lease_sweep_and_the_session_timeout_are_independent(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    # Lease expired (15 min) -> task back in the queue, session untouched and still active.
    assert agent_missions.sweep_expired(session, NOW + timedelta(minutes=16)) == 1
    assert claimed.task.status is AgentTaskStatus.PENDING
    assert sessions_of(session, run)[0].status is MissionAgentSessionStatus.ACTIVE

    # Re-claimed: the session timeout leaves the lease and the task alone.
    again = agent_missions.claim(
        session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW + timedelta(hours=2)
    )
    assert again is not None
    lease = again.task.lease_expires_at
    sessions_of(session, run)[0].last_seen_at = NOW - timedelta(minutes=1)
    session.flush()
    far = NOW + TIMEOUT
    assert mission_telemetry.sweep_timed_out(session, far) == 1
    assert again.task.status is AgentTaskStatus.CLAIMED
    assert again.task.lease_expires_at == lease


# --- timeout -----------------------------------------------------------------------------------


def test_timeout_after_three_hours_records_status_reason_warning_and_audit(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    just_before = NOW + TIMEOUT
    assert mission_telemetry.sweep_timed_out(session, just_before) == 0  # exactly 3 h: not yet
    sweep_at = NOW + TIMEOUT + timedelta(minutes=7)
    assert mission_telemetry.sweep_timed_out(session, sweep_at) == 1

    (row,) = sessions_of(session, run)
    assert row.status is MissionAgentSessionStatus.TIMED_OUT
    assert row.disconnect_reason is MissionAgentDisconnectReason.INACTIVITY_TIMEOUT
    assert row.ended_at == NOW + TIMEOUT  # last_seen + 3 h, not the sweep time

    (log,) = session.scalars(select(MissionAgentLog).where(MissionAgentLog.session_id == row.id))
    assert log.event_type is MissionAgentLogEvent.WARNING
    assert log.task_id is None and log.created_at == row.ended_at
    assert log.message == "Session expirée après 3 h d'inactivité."
    assert log.details == {
        "reason": "inactivity_timeout",
        "last_seen_at": NOW.isoformat(),
        "timeout_seconds": 10800,
    }
    (event,) = audit_events(session, action=audit.AuditAction.MISSION_AGENT_SESSION_TIMED_OUT)
    assert (event.actor_id, event.subject_id) == ("sessions", mission.id)

    # Idempotent: a second pass finds nothing and writes nothing.
    assert mission_telemetry.sweep_timed_out(session, sweep_at + timedelta(hours=1)) == 0
    assert session.scalar(select(func.count()).select_from(MissionAgentLog)) == 1


def test_activity_within_three_hours_keeps_the_session_alive(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    mission_telemetry.touch_session(session, AGENT, task, NOW + timedelta(hours=2, minutes=50))
    assert mission_telemetry.sweep_timed_out(session, NOW + timedelta(hours=5)) == 0
    assert mission_telemetry.sweep_timed_out(session, NOW + timedelta(hours=6)) == 1
    assert len(sessions_of(session, run)) == 1


def test_the_scheduler_pass_runs_the_sweep(
    session: Session,
    session_factory: sessionmaker[Session],
    work: tuple[Mission, MissionRun, AgentTask],
) -> None:
    _, run, task = work
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    session.commit()
    mission_scheduler.MissionScheduler(session_factory).run_once(
        NOW + TIMEOUT + timedelta(minutes=1)
    )
    (row,) = sessions_of(session, run)
    assert row.status is MissionAgentSessionStatus.TIMED_OUT


# --- logs --------------------------------------------------------------------------------------


def log(
    session: Session, task: AgentTask, message: str = "Site officiel ouvert.", **fields: object
) -> MissionAgentLog:
    return mission_telemetry.append_log(
        session,
        AGENT,
        task,
        str(fields.pop("event_type", "source_opened")),
        message,
        now=NOW,
        **fields,  # type: ignore[arg-type]
    )


def test_a_log_derives_its_session_run_mission_and_agent_and_touches(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    entry = log(
        session,
        task,
        source_url="https://exemple.fr/a-propos",
        source_published_at=NOW - timedelta(days=30),
        metadata={"query": "SIREN 123", "results_count": 3},
    )
    (row,) = sessions_of(session, run)
    assert (entry.session_id, entry.mission_id, entry.run_id) == (row.id, mission.id, run.id)
    assert (entry.task_id, entry.agent_id) == (task.id, "agent-a")
    assert entry.event_type is MissionAgentLogEvent.SOURCE_OPENED
    assert entry.created_at == NOW and row.last_seen_at == NOW
    assert entry.details == {"query": "SIREN 123", "results_count": 3}
    assert entry.source_published_at == NOW - timedelta(days=30)


@pytest.mark.parametrize(
    ("fields", "field"),
    [
        ({"event_type": "thinking"}, "event_type"),
        ({"message": "   "}, "message"),
        ({"message": "x" * 1001}, "message"),
        ({"message": "<b>gras</b>"}, "message"),
        ({"source_url": "ftp://exemple.fr"}, "source_url"),
        ({"source_url": "javascript:alert(1)"}, "source_url"),
        ({"source_url": "https://" + "a" * 2050}, "source_url"),
        ({"source_published_at": NOW + timedelta(days=2)}, "source_published_at"),
        ({"metadata": {"reasoning": "parce que"}}, "metadata"),
        ({"metadata": {"a": {"Chain_Of_Thought": 1}}}, "metadata"),
        ({"metadata": {"scratchpad_note": "x"}}, "metadata"),
        ({"metadata": {"a": {"b": {"c": {"d": 1}}}}}, "metadata"),
        ({"metadata": {"k": "x" * 501}}, "metadata"),
        ({"metadata": {f"k{i}": "x" * 400 for i in range(12)}}, "metadata"),
    ],
)
def test_invalid_logs_are_refused_naming_the_field(
    session: Session,
    work: tuple[Mission, MissionRun, AgentTask],
    fields: dict[str, object],
    field: str,
) -> None:
    _, _, task = work
    arguments: dict[str, object] = {"event_type": "observation", "message": "Un fait."}
    arguments.update(fields)
    with pytest.raises(InvalidFieldError) as caught:
        mission_telemetry.append_log(
            session,
            AGENT,
            task,
            arguments.pop("event_type"),  # type: ignore[arg-type]
            arguments.pop("message"),  # type: ignore[arg-type]
            now=NOW,
            **arguments,  # type: ignore[arg-type]
        )
    assert caught.value.field == field
    assert session.scalar(select(func.count()).select_from(MissionAgentLog)) == 0
    assert session.scalar(select(func.count()).select_from(MissionAgentSession)) == 0


def test_log_activity_needs_the_live_claim_and_leaves_the_lease_alone(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, _ = work
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    entry = agent_missions.log_activity(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        "progress",
        "1 société sur 20 traitée.",
        metadata={"done": 1, "total": 20},
        now=NOW + timedelta(minutes=2),
    )
    assert entry.session_id == sessions_of(session, run)[0].id
    assert claimed.task.lease_expires_at == NOW + timedelta(minutes=15)  # no renewal

    with pytest.raises(Exception, match="claim is lost"):
        agent_missions.log_activity(
            session, AGENT, claimed.task.id, uuid.uuid4(), "progress", "x", now=NOW
        )
    with pytest.raises(ActorNotAllowedError):
        agent_missions.log_activity(
            session, OTHER, claimed.task.id, claimed.claim_id, "progress", "x", now=NOW
        )


# --- append-only, cascade, set null ------------------------------------------------------------


def test_logs_are_append_only(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, _, task = work
    entry = log(session, task)
    with rejected(session, "append-only"):
        session.execute(
            text("UPDATE mission_agent_logs SET message = 'x' WHERE id = :id"), {"id": entry.id}
        )
    with rejected(session, "append-only"):
        session.execute(text("DELETE FROM mission_agent_logs WHERE id = :id"), {"id": entry.id})
    with rejected(session, "append-only"):
        session.execute(text("TRUNCATE mission_agent_logs"))
    with rejected(session, "append-only"):
        session.execute(
            text("UPDATE mission_agent_logs SET task_id = NULL, message = 'x' WHERE id = :id"),
            {"id": entry.id},
        )
    session.expire_all()
    assert session.get(MissionAgentLog, entry.id) is not None


def test_deleting_the_task_nulls_the_log_task_id(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, _, task = work
    entry = log(session, task)
    session.execute(text("DELETE FROM agent_tasks WHERE id = :id"), {"id": task.id})
    session.expire_all()
    kept = session.get(MissionAgentLog, entry.id)
    assert kept is not None and kept.task_id is None and kept.message == "Site officiel ouvert."


def test_deleting_the_mission_cascades_sessions_and_logs(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, _, task = work
    log(session, task)
    mission_telemetry.touch_session(session, OTHER, task, NOW)
    # An unrelated mission keeps its telemetry.
    other_mission = add_mission(session, name="Autre")
    other_task = add_task(session, add_run(session, other_mission))
    kept = log(session, other_task)
    session.commit()

    missions.delete(session, OPERATOR, mission.id)
    session.expire_all()
    assert session.scalar(select(func.count()).select_from(MissionAgentSession)) == 1
    assert session.scalars(select(MissionAgentLog.id)).all() == [kept.id]
    assert [event.action for event in audit_events(session, action="mission.deleted")]


def test_deleting_a_run_cascades_its_sessions_and_logs(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    _, run, task = work
    log(session, task)
    session.execute(text("DELETE FROM mission_runs WHERE id = :id"), {"id": run.id})
    assert session.scalar(select(func.count()).select_from(MissionAgentLog)) == 0
    assert session.scalar(select(func.count()).select_from(MissionAgentSession)) == 0


# --- database constraints ----------------------------------------------------------------------


def test_the_database_refuses_a_second_active_session_and_inconsistent_ends(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    opened = mission_telemetry.touch_session(session, AGENT, task, NOW)
    assert opened is not None

    def raw(**overrides: object) -> None:
        fields: dict[str, object] = {
            "mission_id": mission.id,
            "run_id": run.id,
            "agent_id": "agent-a",
            "agent_label": "Agent A",
            "started_at": NOW,
            "last_seen_at": NOW,
            "status": MissionAgentSessionStatus.ACTIVE,
        }
        fields.update(overrides)
        session.add(MissionAgentSession(**fields))

    with rejected(session, "uq_mission_agent_sessions_active"):
        raw()
    with rejected(session, "ck_mission_agent_sessions_end_matches_status"):
        raw(agent_id="agent-c", ended_at=NOW)
    with rejected(session, "ck_mission_agent_sessions_end_matches_status"):
        raw(agent_id="agent-c", status=MissionAgentSessionStatus.ENDED)
    # A terminal row never blocks a new active one.
    raw(
        agent_id="agent-d",
        status=MissionAgentSessionStatus.ENDED,
        ended_at=NOW,
        disconnect_reason=MissionAgentDisconnectReason.AGENT_ENDED,
    )
    raw(agent_id="agent-d")
    session.flush()


# --- reads: organization isolation and pagination ----------------------------------------------


def test_reads_are_scoped_through_the_mission_organization(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, _, task = work
    log(session, task)
    own = mission.organization_id
    other = Organization(name="Autre SAS", email_domain="autre.fr")
    session.add(other)
    session.flush()

    assert len(mission_telemetry.list_logs(session, own, mission.id).items) == 1
    assert mission_telemetry.list_logs(session, other.id, mission.id).items == []
    assert mission_telemetry.list_sessions(session, own, mission.id).total == 1
    foreign = mission_telemetry.list_sessions(session, other.id, mission.id)
    assert (foreign.items, foreign.total) == ([], 0)


def test_the_activity_stream_is_newest_first_with_a_stable_cursor_and_filters(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    org = mission.organization_id
    for index in range(5):
        mission_telemetry.append_log(
            session,
            AGENT,
            task,
            "search" if index % 2 else "observation",
            f"Fait {index}",
            now=NOW + timedelta(seconds=index),
        )
    mission_telemetry.append_log(session, OTHER, task, "progress", "Autre agent", now=NOW)

    first = mission_telemetry.list_logs(session, org, mission.id, limit=2)
    assert [item.message for item in first.items] == ["Fait 4", "Fait 3"]
    assert first.next_cursor == first.items[-1].id
    second = mission_telemetry.list_logs(
        session, org, mission.id, limit=2, before=first.next_cursor
    )
    assert [item.message for item in second.items] == ["Fait 2", "Fait 1"]
    # A new log arriving meanwhile does not shift the next page.
    mission_telemetry.append_log(
        session, AGENT, task, "progress", "Nouveau", now=NOW + timedelta(minutes=1)
    )
    third = mission_telemetry.list_logs(
        session, org, mission.id, limit=2, before=second.next_cursor
    )
    assert sorted(item.message for item in third.items) == ["Autre agent", "Fait 0"]
    assert third.next_cursor is None

    only_search = mission_telemetry.list_logs(
        session, org, mission.id, event_types=[MissionAgentLogEvent.SEARCH]
    )
    assert [item.message for item in only_search.items] == ["Fait 3", "Fait 1"]
    by_agent = mission_telemetry.list_logs(session, org, mission.id, agent_id="agent-b")
    assert [item.message for item in by_agent.items] == ["Autre agent"]
    assert mission_telemetry.list_logs(session, org, mission.id, run_id=uuid.uuid4()).items == []
    since = mission_telemetry.list_logs(
        session, org, mission.id, since=NOW + timedelta(seconds=3), run_id=run.id
    )
    assert {item.message for item in since.items} == {"Fait 3", "Fait 4", "Nouveau"}
    with pytest.raises(InvalidFieldError):
        mission_telemetry.list_logs(session, org, mission.id, before=uuid.uuid4())


def test_sessions_are_listed_newest_first_with_offset_and_total(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, run, task = work
    org = mission.organization_id
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    mission_telemetry.touch_session(session, OTHER, task, NOW + timedelta(minutes=1))
    mission_telemetry.end_session(session, OTHER, run.id, NOW + timedelta(minutes=2))

    page = mission_telemetry.list_sessions(session, org, mission.id, limit=1)
    assert (page.total, [row.agent_id for row in page.items]) == (2, ["agent-b"])
    rest = mission_telemetry.list_sessions(session, org, mission.id, limit=1, offset=1)
    assert [row.agent_id for row in rest.items] == ["agent-a"]
    active = mission_telemetry.list_sessions(
        session, org, mission.id, statuses=[MissionAgentSessionStatus.ACTIVE]
    )
    assert [row.agent_id for row in active.items] == ["agent-a"]


def test_the_mission_stream_query_uses_its_index(
    session: Session, work: tuple[Mission, MissionRun, AgentTask]
) -> None:
    mission, _, _ = work
    session.execute(text("SET LOCAL enable_seqscan = off"))
    plan = "\n".join(
        row[0]
        for row in session.execute(
            text(
                "EXPLAIN SELECT id FROM mission_agent_logs WHERE mission_id = :m "
                "ORDER BY created_at DESC, id DESC LIMIT 50"
            ),
            {"m": mission.id},
        )
    )
    assert "ix_mission_agent_logs_mission_created" in plan


# --- concurrency (real commits, own connections) -----------------------------------------------


def test_concurrent_claims_never_create_two_active_sessions(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Session lifecycle audit is covered above; skipped here so committed test data leaves no
    # audit rows behind (the audit log is append-only).
    monkeypatch.setattr(mission_telemetry, "_session_event", lambda *args, **kwargs: None)
    factory = create_session_factory(engine)
    with factory.begin() as setup:
        mission = add_mission(setup, name="Concurrence")
        run = add_run(setup, mission)
        mission_id, run_id = mission.id, run.id
    threads = 8
    barrier = Barrier(threads)

    def open_session(index: int) -> uuid.UUID:
        barrier.wait(timeout=10)
        with factory.begin() as worker:
            task = AgentTask(run_id=run_id)  # only the run matters: nothing is persisted
            row = mission_telemetry.touch_session(
                worker, AGENT, task, NOW + timedelta(seconds=index)
            )
            assert row is not None
            return row.id

    try:
        with ThreadPoolExecutor(max_workers=threads) as pool:
            ids = list(pool.map(open_session, range(threads)))
        with factory() as check:
            rows = check.scalars(
                select(MissionAgentSession).where(MissionAgentSession.run_id == run_id)
            ).all()
        assert len(set(ids)) == 1
        assert len(rows) == 1 and rows[0].status is MissionAgentSessionStatus.ACTIVE
        # The upsert kept the greatest activity time.
        assert rows[0].last_seen_at == NOW + timedelta(seconds=threads - 1)
    finally:
        with factory.begin() as cleanup:
            cleanup.execute(text("DELETE FROM missions WHERE id = :id"), {"id": mission_id})


def test_audit_trail_survives_the_mission(session: Session) -> None:
    mission = add_mission(session)
    task = add_task(session, add_run(session, mission))
    mission_telemetry.touch_session(session, AGENT, task, NOW)
    missions.delete(session, OPERATOR, mission.id)
    opened = session.scalars(
        select(AuditLogEntry).where(
            AuditLogEntry.action == audit.AuditAction.MISSION_AGENT_SESSION_OPENED
        )
    ).all()
    assert len(opened) == 1
