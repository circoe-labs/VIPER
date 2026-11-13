"""Mission supervision read API (Slice 05): overview, sessions, activity, results, statistics.

Contract: `doc/architecture/mission-telemetry.md` §8. Every route is read-only, organization-scoped
through the mission (404 for another organization's), and answers from SQL aggregates: an empty
mission yields zeros and nulls, never fabricated data.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import AgentTask, AgentTaskResult, Mission, MissionAgentSession
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    MissionAgentSessionStatus,
    MissionRunStatus,
)
from app.models.missions import MissionRun
from app.models.organizations import Organization
from app.services import mission_scheduler, mission_supervision, mission_telemetry, missions
from tests.test_mission_telemetry import add_mission, add_run, add_task

AGENT = ActorContext(type=ActorType.AGENT, id="agent-a", display="Agent A")
OTHER = ActorContext(type=ActorType.AGENT, id="agent-b", display="Agent B")
T0 = datetime(2026, 11, 10, 9, 30, tzinfo=UTC)

ROUTES = ("overview", "sessions", "activity", "results", "statistics")


def url(mission: Mission, route: str) -> str:
    return f"/api/missions/{mission.id}/{route}"


def log(
    db: Session,
    task: AgentTask,
    at: datetime,
    event: str = "observation",
    who: ActorContext = AGENT,
) -> None:
    mission_telemetry.append_log(db, who, task, event, f"Fait {event} {at:%H:%M}.", now=at)


def add_result(
    db: Session,
    task: AgentTask,
    status: AgentResultStatus = AgentResultStatus.PENDING_REVIEW,
    *,
    at: datetime = T0,
    who: ActorContext = AGENT,
    proposal: dict[str, Any] | None = None,
    raw: dict[str, Any] | None = None,
    decided_after: timedelta | None = None,
) -> AgentTaskResult:
    pending = status is AgentResultStatus.PENDING_REVIEW
    result = AgentTaskResult(
        task_id=task.id,
        submitted_by_id=who.id,
        submitted_by_label=who.display,
        submitted_at=at,
        raw=raw if raw is not None else {},
        proposal=proposal if proposal is not None else {},
        digest="a" * 64,
        status=status,
        decided_at=None if pending else at + (decided_after or timedelta(minutes=30)),
        decided_by_display=None if pending else "Opératrice Test",
    )
    db.add(result)
    db.flush()
    return result


@pytest.fixture
def mission(db_session: Session) -> Mission:
    return add_mission(db_session)


@pytest.fixture
def seeded(db_session: Session, mission: Mission) -> dict[str, Any]:
    """One run, three tasks, two agents; results: accepted (A), rejected (B), pending (A)."""
    run = add_run(db_session, mission)
    tasks = [add_task(db_session, run) for _ in range(3)]
    log(db_session, tasks[0], T0, "search")
    log(db_session, tasks[0], T0 + timedelta(minutes=1), "source_opened")
    log(db_session, tasks[1], T0 + timedelta(minutes=2), "warning", OTHER)
    # Sessions of A and B were opened by the logs.
    accepted = add_result(
        db_session,
        tasks[0],
        AgentResultStatus.ACCEPTED,
        at=T0,
        proposal={
            "kind": "company_update",
            "confidence": 88,
            "notes": "Société confirmée sur deux sources.",
            "items": [
                {"key": "a", "source": "https://a.fr", "confidence": 90},
                {"key": "b", "source": "https://a.fr"},
                {"key": "c", "source": "https://b.fr"},
                {"key": "d"},
            ],
            "refused": [{"field": "x"}],
        },
        decided_after=timedelta(minutes=10),
    )
    rejected = add_result(
        db_session,
        tasks[1],
        AgentResultStatus.REJECTED,
        at=T0 + timedelta(hours=1),
        who=OTHER,
        proposal={"items": [], "confidence": 30},
        decided_after=timedelta(minutes=30),
    )
    pending = add_result(
        db_session,
        tasks[2],
        at=T0 + timedelta(days=1),
        proposal={"items": [{"key": "k", "source": "https://c.fr"}], "confidence": 70},
    )
    tasks[0].status = AgentTaskStatus.ACCEPTED
    tasks[1].status = AgentTaskStatus.ACCEPTED
    tasks[2].status = AgentTaskStatus.SUBMITTED
    db_session.flush()
    return {
        "run": run,
        "tasks": tasks,
        "accepted": accepted,
        "rejected": rejected,
        "pending": pending,
    }


# --- authorization and organization isolation --------------------------------------------------


@pytest.mark.parametrize("route", ROUTES)
def test_anonymous_callers_are_refused(
    anonymous_client: TestClient, mission: Mission, route: str
) -> None:
    assert anonymous_client.get(url(mission, route)).status_code == 401


@pytest.mark.parametrize("route", ROUTES)
def test_another_organizations_mission_is_a_404_everywhere(
    client: TestClient, db_session: Session, route: str
) -> None:
    other = Organization(name="Autre SAS", email_domain="autre.fr")
    db_session.add(other)
    db_session.flush()
    foreign = add_mission(db_session, organization_id=other.id)
    run = add_run(db_session, foreign)
    log(db_session, add_task(db_session, run), T0)

    response = client.get(url(foreign, route))
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_found"
    assert client.get(f"/api/missions/{uuid.uuid4()}/{route}").status_code == 404


def test_the_existing_mission_detail_is_untouched(client: TestClient, mission: Mission) -> None:
    body = client.get(f"/api/missions/{mission.id}").json()
    assert set(body) == {
        "card",
        "targets",
        "sources",
        "runs",
        "tasks",
        "prompt",
        "result_kind",
        "result_limit",
        "rule",
        "sources",
        "inheritance",
        "skills",
        "objective_progress",
    }


# --- empty states (nothing is fabricated) ------------------------------------------------------


def test_an_empty_mission_answers_zeros_and_nulls(client: TestClient, mission: Mission) -> None:
    overview = client.get(url(mission, "overview")).json()
    assert overview["current_run"] is None
    assert (overview["active_sessions"], overview["active_agents"], overview["agents"]) == (
        0,
        0,
        [],
    )
    assert overview["last_activity_at"] is None
    assert overview["pending_reviews"] == 0 and overview["warnings"] == []
    assert overview["tasks"]["total"] == 0 and overview["tasks"]["finished"] == 0

    assert client.get(url(mission, "sessions")).json() == {
        "items": [],
        "total": 0,
        "limit": 25,
        "offset": 0,
    }
    assert client.get(url(mission, "activity")).json() == {"items": [], "next_cursor": None}
    results = client.get(url(mission, "results")).json()
    assert results["items"] == [] and results["total"] == 0
    assert set(results["status_counts"].values()) == {0}

    stats = client.get(url(mission, "statistics")).json()
    assert stats["acceptance_rate"] is None and stats["avg_review_seconds"] is None
    assert stats["decided_count"] == 0 and stats["agents"] == []
    assert {point["count"] for point in stats["logs_series"]} == {0}
    assert all(point["accepted"] == 0 for point in stats["results_series"])


# --- overview ----------------------------------------------------------------------------------


def test_overview_reports_live_state_progress_and_warnings(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    run, tasks = seeded["run"], seeded["tasks"]
    # B goes silent for 4 h: its session times out; A keeps working.
    mission_telemetry.touch_session(db_session, AGENT, tasks[0], T0 + timedelta(hours=4))
    mission_telemetry.sweep_timed_out(db_session, T0 + timedelta(hours=4))
    failed = add_task(db_session, run, AgentTaskStatus.FAILED)
    db_session.flush()

    body = client.get(url(mission, "overview")).json()
    assert body["status"] == "active" and body["name"] == mission.name
    assert body["current_run"]["id"] == str(run.id)
    assert body["current_run"]["status"] == "running"
    assert (body["active_sessions"], body["active_agents"]) == (1, 1)
    assert (
        body["agents"][0]["agent_id"] == "agent-a" and body["agents"][0]["agent_label"] == "Agent A"
    )
    assert body["agents"][0]["last_seen_at"].startswith("2026-11-10T13:30")
    assert body["last_activity_at"].startswith("2026-11-11")  # the pending result, newest signal
    assert body["pending_reviews"] == 1
    assert body["tasks"]["total"] == 4 and failed.status is AgentTaskStatus.FAILED
    assert body["tasks"]["by_status"]["accepted"] == 2 and body["tasks"]["finished"] == 3
    codes = {warning["code"]: warning["count"] for warning in body["warnings"]}
    assert codes == {"sessions_timed_out": 1, "tasks_failed": 1}


def test_overview_warns_when_tasks_wait_and_nobody_is_active(
    client: TestClient, db_session: Session, mission: Mission
) -> None:
    add_task(db_session, add_run(db_session, mission))
    body = client.get(url(mission, "overview")).json()
    assert [warning["code"] for warning in body["warnings"]] == ["no_active_agent"]


def test_overview_is_a_handful_of_queries_and_reads_nothing_in_python_loops(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    statements: list[str] = []
    engine = db_session.get_bind()

    def count(_c: Any, _cur: Any, statement: str, *_a: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        assert client.get(url(mission, "overview")).status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", count)
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    # Mission, run, live sessions, 3 recency probes, task counts, reviews, timed-out (+auth).
    assert len(selects) <= 16, selects


# --- sessions and activity ---------------------------------------------------------------------


def test_sessions_are_paginated_filtered_and_carry_their_logs_count(
    client: TestClient, mission: Mission, seeded: dict[str, Any]
) -> None:
    page = client.get(url(mission, "sessions"), params={"limit": 1}).json()
    assert (page["total"], page["limit"], page["offset"], len(page["items"])) == (2, 1, 0, 1)
    second = client.get(url(mission, "sessions"), params={"limit": 1, "offset": 1}).json()
    assert second["items"][0]["id"] != page["items"][0]["id"]
    by_agent = client.get(url(mission, "sessions"), params={"agent_id": "agent-a"}).json()
    assert by_agent["total"] == 1
    assert by_agent["items"][0]["logs_count"] == 2
    assert by_agent["items"][0]["status"] == "active"
    assert by_agent["items"][0]["disconnect_reason"] is None
    assert client.get(url(mission, "sessions"), params={"status": "timed_out"}).json()["total"] == 0
    both = client.get(
        url(mission, "sessions"), params=[("status", "active"), ("status", "ended")]
    ).json()
    assert both["total"] == 2
    assert client.get(url(mission, "sessions"), params={"status": "nope"}).status_code == 422
    assert client.get(url(mission, "sessions"), params={"limit": 101}).status_code == 422
    assert client.get(url(mission, "sessions"), params={"offset": -1}).status_code == 422


def test_activity_streams_newest_first_with_cursor_and_filters(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    first = client.get(url(mission, "activity"), params={"limit": 2}).json()
    assert [item["event_type"] for item in first["items"]] == ["warning", "source_opened"]
    assert first["next_cursor"] == first["items"][-1]["id"]
    newest = first["items"][0]
    assert newest["agent_label"] == "Agent B" and newest["session_status"] == "active"
    assert newest["task_id"] == str(seeded["tasks"][1].id) and newest["metadata"] == {}

    older = client.get(
        url(mission, "activity"), params={"limit": 2, "before": first["next_cursor"]}
    ).json()
    assert [item["event_type"] for item in older["items"]] == ["search"]
    assert older["next_cursor"] is None

    by_type = client.get(
        url(mission, "activity"), params=[("event_type", "search"), ("event_type", "warning")]
    ).json()
    assert {item["event_type"] for item in by_type["items"]} == {"search", "warning"}
    by_agent = client.get(url(mission, "activity"), params={"agent_id": "agent-b"}).json()
    assert len(by_agent["items"]) == 1
    by_task = client.get(url(mission, "activity"), params={"task_id": str(seeded["tasks"][0].id)})
    assert len(by_task.json()["items"]) == 2
    by_run = client.get(url(mission, "activity"), params={"run_id": str(seeded["run"].id)})
    assert len(by_run.json()["items"]) == 3
    session_id = first["items"][0]["session_id"]
    by_session = client.get(url(mission, "activity"), params={"session_id": session_id}).json()
    assert len(by_session["items"]) == 1
    since = (T0 + timedelta(minutes=1)).isoformat()
    assert len(client.get(url(mission, "activity"), params={"since": since}).json()["items"]) == 2


def test_activity_refuses_bad_filters_naming_the_problem(
    client: TestClient, mission: Mission
) -> None:
    assert (
        client.get(url(mission, "activity"), params={"event_type": "thinking"}).status_code == 422
    )
    unknown = client.get(url(mission, "activity"), params={"before": str(uuid.uuid4())})
    assert unknown.status_code == 422 and unknown.json()["detail"]["field"] == "before"


def test_reading_never_touches_a_session(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    before = {
        row.id: row.last_seen_at for row in db_session.scalars(select(MissionAgentSession)).all()
    }
    for route in ROUTES:
        assert client.get(url(mission, route)).status_code == 200
    db_session.expire_all()
    after = {
        row.id: row.last_seen_at for row in db_session.scalars(select(MissionAgentSession)).all()
    }
    assert before == after


# --- results -----------------------------------------------------------------------------------


def test_result_cards_carry_summary_confidence_and_counts(
    client: TestClient, mission: Mission, seeded: dict[str, Any]
) -> None:
    body = client.get(url(mission, "results")).json()
    assert body["total"] == 3 and (body["limit"], body["offset"]) == (25, 0)
    assert [card["status"] for card in body["items"]] == [
        "pending_review",
        "rejected",
        "accepted",
    ]
    assert body["status_counts"] == {
        "pending_review": 1,
        "accepted": 1,
        "rejected": 1,
        "superseded": 0,
    }
    accepted = body["items"][2]
    assert accepted["id"] == str(seeded["accepted"].id)
    assert accepted["summary"] == "Société confirmée sur deux sources."
    assert accepted["confidence"] == 88
    assert (accepted["items_count"], accepted["refused_count"], accepted["sources_count"]) == (
        4,
        1,
        2,
    )
    assert accepted["agent_id"] == "agent-a" and accepted["agent_label"] == "Agent A"
    assert accepted["task_type"] == "update_company" and accepted["subject_label"]
    assert accepted["decided_by"] == "Opératrice Test" and accepted["decided_at"]
    assert accepted["run_id"] == str(seeded["run"].id)
    assert body["items"][0]["decided_at"] is None


def test_results_pagination_and_filters(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    first = client.get(url(mission, "results"), params={"limit": 2}).json()
    assert (first["total"], len(first["items"])) == (3, 2)
    rest = client.get(url(mission, "results"), params={"limit": 2, "offset": 2}).json()
    assert [card["id"] for card in rest["items"]] == [str(seeded["accepted"].id)]
    assert client.get(url(mission, "results"), params={"offset": 5}).json()["items"] == []

    only = client.get(url(mission, "results"), params={"status": "pending_review"}).json()
    assert only["total"] == 1 and only["status_counts"]["accepted"] == 1
    two = client.get(
        url(mission, "results"), params=[("status", "accepted"), ("status", "rejected")]
    ).json()
    assert two["total"] == 2
    agent_b = client.get(url(mission, "results"), params={"agent_id": "agent-b"}).json()
    assert [card["status"] for card in agent_b["items"]] == ["rejected"]
    other_run = add_run(db_session, db_session.get(Mission, mission.id))  # type: ignore[arg-type]
    assert (
        client.get(url(mission, "results"), params={"run_id": str(other_run.id)}).json()["total"]
        == 0
    )
    assert (
        client.get(url(mission, "results"), params={"run_id": str(seeded["run"].id)}).json()[
            "total"
        ]
        == 3
    )
    assert client.get(url(mission, "results"), params={"status": "nope"}).status_code == 422


def test_results_of_another_mission_and_tool_mode_results_never_leak(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    other = add_mission(db_session, name="Autre mission")
    add_result(db_session, add_task(db_session, add_run(db_session, other)))
    tool_mode = AgentTask(type=seeded["tasks"][0].type, company_id=seeded["tasks"][0].company_id)
    db_session.add(tool_mode)
    db_session.flush()
    add_result(db_session, tool_mode)
    assert client.get(url(mission, "results")).json()["total"] == 3
    assert client.get(url(other, "results")).json()["total"] == 1


def test_historical_results_without_the_new_fields_read_as_unknown(
    client: TestClient, db_session: Session, mission: Mission
) -> None:
    run = add_run(db_session, mission)
    # Pre-S2 shape: no per-item confidence/dates; and a staged-actions shape without a global one.
    old = add_result(
        db_session,
        add_task(db_session, run),
        proposal={"kind": "company_update", "items": [{"key": "a", "source": "https://a.fr"}]},
        raw={"confidence": 61},
        at=T0,
    )
    bare = add_result(
        db_session, add_task(db_session, run), proposal={}, raw={}, at=T0 - timedelta(days=1)
    )
    odd = add_result(
        db_session,
        add_task(db_session, run),
        proposal={"items": "nope", "refused": None, "notes": "  ", "confidence": "high"},
        at=T0 - timedelta(days=2),
    )
    cards = {card["id"]: card for card in client.get(url(mission, "results")).json()["items"]}
    assert cards[str(old.id)]["confidence"] == 61  # global confidence falls back to the raw payload
    assert (cards[str(old.id)]["items_count"], cards[str(old.id)]["sources_count"]) == (1, 1)
    for result in (bare, odd):
        card = cards[str(result.id)]
        assert card["confidence"] is None and card["summary"] is None
        assert (card["items_count"], card["refused_count"], card["sources_count"]) == (0, 0, 0)


def test_a_long_summary_is_shortened(
    client: TestClient, db_session: Session, mission: Mission
) -> None:
    add_result(
        db_session,
        add_task(db_session, add_run(db_session, mission)),
        proposal={"notes": "mot " * 200, "items": []},
    )
    summary = client.get(url(mission, "results")).json()["items"][0]["summary"]
    assert len(summary) <= mission_supervision.SUMMARY_MAX_LENGTH and summary.endswith("…")


# --- statistics --------------------------------------------------------------------------------


def test_statistics_aggregate_with_seeded_data(
    db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    now = T0 + timedelta(days=2, hours=3)
    stats = mission_supervision.statistics(db_session, mission, bucket="day", days=3, now=now)

    assert stats.results_by_status == {
        "pending_review": 1,
        "accepted": 1,
        "rejected": 1,
        "superseded": 0,
    }
    assert stats.tasks_by_status["accepted"] == 2 and stats.tasks_by_status["submitted"] == 1
    assert stats.sessions_by_status == {"active": 2, "ended": 0, "timed_out": 0}
    assert stats.logs_by_event_type["search"] == 1 and stats.logs_by_event_type["warning"] == 1
    assert stats.decided_count == 2 and stats.acceptance_rate == 0.5
    assert stats.avg_review_seconds == pytest.approx((10 * 60 + 30 * 60) / 2)

    days = [point.bucket.date().isoformat() for point in stats.results_series]
    assert days == ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]
    by_day = {point.bucket.date().isoformat(): point for point in stats.results_series}
    assert (by_day["2026-11-10"].accepted, by_day["2026-11-10"].rejected) == (1, 1)
    assert by_day["2026-11-11"].pending_review == 1
    assert by_day["2026-11-09"].accepted == 0 and by_day["2026-11-12"].pending_review == 0
    assert {p.bucket.date().isoformat(): p.count for p in stats.logs_series} == {
        "2026-11-09": 0,
        "2026-11-10": 3,
        "2026-11-11": 0,
        "2026-11-12": 0,
    }
    assert sum(point.count for point in stats.sessions_series) == 2

    by_agent = {agent.agent_id: agent for agent in stats.agents}
    a, b = by_agent["agent-a"], by_agent["agent-b"]
    assert (a.sessions, a.logs, a.results, a.accepted, a.rejected, a.pending_review) == (
        1,
        2,
        2,
        1,
        0,
        1,
    )
    assert (b.sessions, b.logs, b.results, b.accepted, b.rejected) == (1, 1, 1, 0, 1)
    assert a.agent_label == "Agent A"


def test_statistics_hourly_buckets_and_bounds(
    client: TestClient, db_session: Session, mission: Mission, seeded: dict[str, Any]
) -> None:
    stats = mission_supervision.statistics(
        db_session, mission, bucket="hour", days=1, now=T0 + timedelta(hours=2)
    )
    hours = {p.bucket.isoformat(): p.count for p in stats.logs_series}
    assert hours["2026-11-10T09:00:00+00:00"] == 3
    assert len(stats.logs_series) == 25  # 24 h back, floored to the hour, up to now

    ok = client.get(url(mission, "statistics"), params={"bucket": "hour", "days": 7})
    assert ok.status_code == 200 and len(ok.json()["logs_series"]) <= 169
    too_long = client.get(url(mission, "statistics"), params={"bucket": "hour", "days": 8})
    assert too_long.status_code == 422 and too_long.json()["detail"]["field"] == "days"
    assert client.get(url(mission, "statistics"), params={"days": 91}).status_code == 422
    assert client.get(url(mission, "statistics"), params={"days": 0}).status_code == 422
    assert client.get(url(mission, "statistics"), params={"bucket": "week"}).status_code == 422
    shaped = client.get(url(mission, "statistics")).json()
    assert shaped["bucket"] == "day" and shaped["days"] == 14 and len(shaped["logs_series"]) >= 14
    assert set(shaped["agents"][0]) >= {"agent_id", "agent_label", "sessions", "logs", "results"}


# --- run finished without anyone opening the card (S3 caveat) ----------------------------------


def test_the_scheduler_pass_settles_a_finished_run_and_ends_its_sessions(
    db_session: Session, session_factory: Any, mission: Mission
) -> None:
    run = add_run(db_session, mission)
    task = add_task(db_session, run)
    mission_telemetry.touch_session(db_session, AGENT, task, T0)
    task.status = AgentTaskStatus.ACCEPTED  # the review closed the last task
    db_session.flush()
    assert db_session.get(MissionRun, run.id).status is MissionRunStatus.RUNNING  # type: ignore[union-attr]

    assert missions.refresh_open_runs(db_session) == 1
    row = db_session.scalar(select(MissionAgentSession).where(MissionAgentSession.run_id == run.id))
    assert row is not None and row.status is MissionAgentSessionStatus.ENDED
    assert row.disconnect_reason is not None and row.disconnect_reason.value == "run_finished"
    assert db_session.get(MissionRun, run.id).status is MissionRunStatus.DONE  # type: ignore[union-attr]
    assert missions.refresh_open_runs(db_session) == 0  # idempotent

    scheduler = mission_scheduler.MissionScheduler(session_factory)
    assert scheduler.run_once() == []
