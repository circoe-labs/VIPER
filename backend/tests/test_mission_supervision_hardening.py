"""Mission supervision hardening (Slice 10): several agents on one run, with real commits and real
concurrency, and the 3 h silence timeout end to end through the scheduler pass.

Contract: `doc/architecture/mission-telemetry.md` §3 (one active session per (run, agent), distinct
sessions per agent) and §4 (the 3 h timeout, independent of the 15 min task lease).
"""

import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.db.session import create_session_factory
from app.models import AgentTask, MissionAgentLog, MissionAgentSession
from app.models.enums import (
    AgentTaskStatus,
    AgentTaskType,
    MissionAgentDisconnectReason,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
)
from app.services import agent_missions, audit, mission_scheduler, mission_telemetry
from app.services.audit import AuditSource
from tests.builders import OPERATOR, add_company
from tests.test_mcp_telemetry import worker
from tests.test_mcp_tools import body, call
from tests.test_mission_stop import claim, mission_with
from tests.test_mission_telemetry import NOW, TIMEOUT, add_mission, add_run, add_task

TYPES = [AgentTaskType.UPDATE_COMPANY]


def agent(index: int) -> ActorContext:
    return ActorContext(type=ActorType.AGENT, id=f"agent-{index}", display=f"Agent {index}")


def test_agents_claiming_one_run_at_once_get_distinct_tasks_and_sessions(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The audit trail of claims and sessions is covered by their own tests; skipped here so the
    # committed test data leaves no (append-only) audit rows behind.
    monkeypatch.setattr(mission_telemetry, "_session_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(agent_missions, "_event", lambda *args, **kwargs: None)
    factory = create_session_factory(engine)
    agents, tasks_per_agent, total = 4, 3, 12
    with factory.begin() as setup:
        mission = add_mission(setup, name="Concurrence agents")
        run = add_run(setup, mission)
        # One company only: the audit log is append-only, one creation event is all that stays.
        audit.bind(setup, OPERATOR)
        company = add_company(setup, display_name="Société concurrence")
        setup.add_all(
            AgentTask(run_id=run.id, type=TYPES[0], company_id=company.id) for _ in range(total)
        )
        setup.flush()
        mission_id, run_id, company_id = mission.id, run.id, company.id
    barrier = Barrier(agents)

    def work(index: int) -> list[uuid.UUID]:
        barrier.wait(timeout=10)
        taken: list[uuid.UUID] = []
        for _ in range(tasks_per_agent):
            # One claim per transaction, like one MCP call.
            with factory.begin() as worker:
                audit.bind(worker, agent(index), audit.AuditContext(source=AuditSource.AGENT))
                claimed = agent_missions.claim(worker, agent(index), types=TYPES)
                assert claimed is not None
                taken.append(claimed.task.id)
        return taken

    try:
        with ThreadPoolExecutor(max_workers=agents) as pool:
            taken = list(pool.map(work, range(agents)))
        with factory() as check:
            rows = check.scalars(
                select(MissionAgentSession).where(MissionAgentSession.run_id == run_id)
            ).all()
            claimed_by = {
                task_id: owner
                for task_id, owner in check.execute(
                    select(AgentTask.id, AgentTask.claimed_by_id).where(
                        AgentTask.run_id == run_id, AgentTask.status == AgentTaskStatus.CLAIMED
                    )
                )
            }
        everything = [task_id for per_agent in taken for task_id in per_agent]
        # Every task went to exactly one agent: none twice, none lost.
        assert len(everything) == len(set(everything)) == total
        assert set(claimed_by) == set(everything)
        for index, per_agent in enumerate(taken):
            assert {claimed_by[task_id] for task_id in per_agent} == {f"agent-{index}"}
        # One active session per (run, agent), a distinct one for each agent, however many tasks.
        assert len(rows) == agents
        assert {row.agent_id for row in rows} == {f"agent-{index}" for index in range(agents)}
        assert len({row.id for row in rows}) == agents
        assert all(row.status is MissionAgentSessionStatus.ACTIVE for row in rows)
    finally:
        with factory.begin() as cleanup:
            cleanup.execute(text("DELETE FROM agent_tasks WHERE run_id = :id"), {"id": run_id})
            cleanup.execute(text("DELETE FROM missions WHERE id = :id"), {"id": mission_id})
            cleanup.execute(text("DELETE FROM companies WHERE id = :id"), {"id": company_id})


def test_silence_for_three_hours_times_a_session_out_through_the_scheduler_pass(
    db_session: Session, session_factory: sessionmaker[Session]
) -> None:
    actor_a, actor_b = agent(1), agent(2)
    audit.bind(db_session, actor_a, audit.AuditContext(source=AuditSource.AGENT))
    mission = add_mission(db_session)
    run = add_run(db_session, mission)
    add_task(db_session, run)
    add_task(db_session, run)
    claim_a = agent_missions.claim(db_session, actor_a, types=TYPES, now=NOW)
    claim_b = agent_missions.claim(db_session, actor_b, types=TYPES, now=NOW)
    assert claim_a is not None and claim_b is not None
    # B keeps working (a log renews the session, not the lease); A goes silent.
    mission_telemetry.append_log(
        db_session,
        actor_b,
        claim_b.task,
        "progress",
        "1 société sur 2 traitée.",
        now=NOW + timedelta(hours=2, minutes=50),
    )
    db_session.commit()

    passes_at = NOW + TIMEOUT + timedelta(minutes=1)
    mission_scheduler.MissionScheduler(session_factory).run_once(passes_at)

    db_session.expire_all()
    by_agent = {
        row.agent_id: row
        for row in db_session.scalars(
            select(MissionAgentSession).where(MissionAgentSession.run_id == run.id)
        )
    }
    timed_out = by_agent["agent-1"]
    assert timed_out.status is MissionAgentSessionStatus.TIMED_OUT
    assert timed_out.disconnect_reason is MissionAgentDisconnectReason.INACTIVITY_TIMEOUT
    assert timed_out.ended_at == NOW + TIMEOUT
    assert by_agent["agent-2"].status is MissionAgentSessionStatus.ACTIVE
    warning = db_session.scalars(
        select(MissionAgentLog).where(MissionAgentLog.session_id == timed_out.id)
    ).one()
    assert warning.event_type is MissionAgentLogEvent.WARNING

    # The sweep is idempotent, and the lease clock is a different one: the task is untouched.
    mission_scheduler.MissionScheduler(session_factory).run_once(passes_at + timedelta(minutes=1))
    db_session.expire_all()
    assert claim_a.task.status is AgentTaskStatus.CLAIMED
    assert claim_a.task.claimed_by_id == "agent-1"

    # A comes back before the lease sweep took the task: a new session, the old one stays timed out.
    mission_telemetry.touch_session(db_session, actor_a, claim_a.task, passes_at)
    db_session.expire_all()
    rows_a = db_session.scalars(
        select(MissionAgentSession).where(
            MissionAgentSession.run_id == run.id, MissionAgentSession.agent_id == "agent-1"
        )
    ).all()
    assert sorted(row.status.value for row in rows_a) == ["active", "timed_out"]


def test_telemetry_never_writes_what_agents_say_to_the_application_log(
    client: TestClient, db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    """An agent's message is business data (stored, org-scoped, reviewed in the UI): it must not
    reach the process log, nor be echoed back in a refusal, nor leak the bearer token."""
    marker = "MARQUEUR-CONFIDENTIEL-9137"
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent journal")
    with caplog.at_level(logging.DEBUG):
        claimed = claim(client, token)
        base = {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"]}
        body(
            call(
                client,
                token,
                "viper_log_mission_activity",
                {**base, "event_type": "observation", "message": f"Constat {marker}."},
            )
        )
        refusals = [
            call(
                client,
                token,
                "viper_log_mission_activity",
                {**base, "event_type": marker, "message": "x"},
            ),
            call(
                client,
                token,
                "viper_log_mission_activity",
                {**base, "event_type": "search", "message": marker * 100},
            ),
            call(
                client,
                token,
                "viper_log_mission_activity",
                {
                    **base,
                    "event_type": "search",
                    "message": "ok",
                    "source_url": f"javascript:{marker}",
                },
            ),
        ]
    for answer in refusals:
        assert answer["isError"] is True
        assert marker not in json.dumps(answer["structuredContent"])
    assert marker not in caplog.text
    assert token not in caplog.text
