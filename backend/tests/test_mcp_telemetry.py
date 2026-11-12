"""MCP mission telemetry tools (Slice 04): log, end and read the own session, plus the guidance.
Sent with a claimed mission task.

Contract: `doc/architecture/mission-telemetry.md` §5.6, §6, §11. A session is opened by the claim
(no register call), an agent writes into its **own** session only (derived from task_id + claim_id
and the bearer token), 120 logs per minute per token, and no tool asks an agent to explain itself.
"""

import json
import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import mcp, mcp_telemetry
from app.core.actor import ActorContext, ActorType
from app.models import Company, MissionAgentLog, MissionAgentSession
from app.models.enums import MissionAgentLogEvent, MissionAgentSessionStatus
from app.models.mcp import McpCall, McpToken
from app.services import agent_missions, agent_payloads, mcp_tokens, mission_telemetry
from app.services.errors import BusinessRuleError
from tests.builders import add_company
from tests.test_mcp_missions import READ, WRITE, refused
from tests.test_mcp_tools import body, call
from tests.test_mission_stop import claim, mission_with, set_status

TELEMETRY_TOOLS = (
    "viper_log_mission_activity",
    "viper_end_mission_session",
    "viper_get_mission_session",
)
FORBIDDEN = re.compile("|".join(mission_telemetry.FORBIDDEN_METADATA_KEYS), re.IGNORECASE)


def worker(session: Session, label: str) -> tuple[str, McpToken]:
    token, record = mcp_tokens.mint(session, label=label, scopes=["*"])
    session.flush()
    return token, record


def log(client: TestClient, token: str, claimed: dict[str, Any], **fields: Any) -> dict[str, Any]:
    arguments = {
        "task_id": claimed["task_id"],
        "claim_id": claimed["claim_id"],
        "event_type": "search",
        "message": "Recherche du SIREN sur le registre.",
        **fields,
    }
    return call(client, token, "viper_log_mission_activity", arguments)


def two_agents(
    client: TestClient, session: Session
) -> tuple[tuple[str, McpToken, dict[str, Any]], tuple[str, McpToken, dict[str, Any]]]:
    """Agent A and agent B, each holding one task of the same mission run."""
    mission_with(client, add_company(session, display_name="2SN"), add_company(session, "Acme"))
    token_a, record_a = worker(session, "Agent A")
    token_b, record_b = worker(session, "Agent B")
    return (
        (token_a, record_a, claim(client, token_a)),
        (token_b, record_b, claim(client, token_b)),
    )


def sessions(session: Session) -> list[MissionAgentSession]:
    session.expire_all()
    return list(session.scalars(select(MissionAgentSession).order_by(MissionAgentSession.id)))


def logs(session: Session) -> list[MissionAgentLog]:
    session.expire_all()
    return list(session.scalars(select(MissionAgentLog).order_by(MissionAgentLog.id)))


# --- catalogue and guidance ----------------------------------------------------------------------


def test_the_tools_are_listed_and_never_ask_an_agent_to_explain_itself(
    client: TestClient, db_session: Session
) -> None:
    token, _ = worker(db_session, "Agent A")
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {token}"},
    )
    listed = {tool["name"]: tool for tool in response.json()["result"]["tools"]}

    assert set(TELEMETRY_TOOLS) <= set(listed)
    assert listed["viper_log_mission_activity"]["annotations"] == WRITE
    assert listed["viper_end_mission_session"]["annotations"] == WRITE
    assert listed["viper_get_mission_session"]["annotations"] == READ
    # There is no register / log-off, and no tool reads other agents' logs.
    assert not [
        name for name in listed if re.search(r"register|logoff|start_mission_session", name)
    ]
    schema = listed["viper_log_mission_activity"]["inputSchema"]
    assert schema["properties"]["event_type"]["enum"] == [e.value for e in MissionAgentLogEvent]
    assert schema["required"] == ["task_id", "claim_id", "event_type", "message"]
    # No client-supplied identity: the session, run and agent come from the claim and the token.
    for name in ("session_id", "run_id", "mission_id", "agent_id"):
        assert name not in schema["properties"]


def test_no_tool_or_guidance_text_requests_private_reasoning() -> None:
    """§6 conformance: names, properties and descriptions of the tools that carry telemetry
    guidance, and the guidance sent with a claim, never use the forbidden vocabulary."""
    texts: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                texts.append(str(key))
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            texts.append(node)

    carriers = [*TELEMETRY_TOOLS, "viper_claim_task", "viper_heartbeat_task"]
    carriers.append("viper_submit_task_result")
    for tool in mcp.TOOLS:
        if tool["name"] in carriers:
            walk({k: v for k, v in tool.items() if k != "_meta"})
    walk(agent_payloads.TELEMETRY_GUIDANCE)
    walk(mcp_telemetry.TOOLS)
    assert texts
    assert [text for text in texts if FORBIDDEN.search(text)] == []


def test_claim_opens_the_session_and_delivers_the_logging_guidance(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, record = worker(db_session, "Agent A")

    claimed = claim(client, token)

    (row,) = sessions(db_session)
    assert row.agent_id == str(record.id)
    assert row.status is MissionAgentSessionStatus.ACTIVE
    guidance = claimed["telemetry"]
    assert guidance["log_tool"] == "viper_log_mission_activity"
    assert "automatically" in guidance["session"]
    assert set(guidance["event_types"]) == {e.value for e in MissionAgentLogEvent}
    assert any("notes" in rule for rule in guidance["rules"])
    assert guidance["rate_limit_per_minute"] == mission_telemetry.LOG_RATE_LIMIT_PER_MINUTE


def test_a_thread_task_has_no_telemetry_guidance(client: TestClient, db_session: Session) -> None:
    from tests.test_mcp import open_review

    open_review(client, db_session)
    token, _ = worker(db_session, "Agent A")

    claimed = body(call(client, token, "viper_claim_task", {"task_types": ["update_company"]}))

    assert "telemetry" not in claimed
    assert sessions(db_session) == []


# --- writing a log -------------------------------------------------------------------------------


def test_a_log_lands_in_the_agents_own_session_and_touches_it(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, record = worker(db_session, "Agent A")
    claimed = claim(client, token)
    (opened,) = sessions(db_session)
    before = opened.last_seen_at
    lease_before = db_session.scalar(select(func.max(MissionAgentSession.last_seen_at)))
    assert lease_before is not None

    answer = body(
        log(
            client,
            token,
            claimed,
            event_type="source_opened",
            message="Page ouverte : mentions légales.",
            source_url="https://2sn.fr/mentions",
            source_published_at="2026-10-01",
            metadata={"engine": "web"},
        )
    )

    (row,) = logs(db_session)
    assert answer["log_id"] == str(row.id)
    assert answer["session_id"] == str(opened.id) == str(row.session_id)
    assert row.agent_id == str(record.id)
    assert str(row.task_id) == claimed["task_id"]
    assert row.event_type is MissionAgentLogEvent.SOURCE_OPENED
    assert row.source_url == "https://2sn.fr/mentions"
    assert row.source_published_at == datetime(2026, 10, 1, tzinfo=UTC)
    assert row.details == {"engine": "web"}
    assert len(sessions(db_session)) == 1
    assert sessions(db_session)[0].last_seen_at >= before


def test_a_client_cannot_name_a_session_or_an_agent(
    client: TestClient, db_session: Session
) -> None:
    (token_a, record_a, claimed_a), (_, record_b, _) = two_agents(client, db_session)
    session_b = next(row for row in sessions(db_session) if row.agent_id == str(record_b.id))

    # Spoofed identity fields are not part of the contract: they are ignored, never honoured.
    body(
        log(
            client,
            token_a,
            claimed_a,
            session_id=str(session_b.id),
            agent_id=str(record_b.id),
            run_id=str(uuid.uuid4()),
        )
    )

    (row,) = logs(db_session)
    assert row.agent_id == str(record_a.id)
    assert row.session_id != session_b.id


def test_log_refused_without_the_capability(client: TestClient, db_session: Session) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)
    limited, _ = mcp_tokens.mint(
        db_session, label="Lecteur", scopes=["*"], capabilities=["records.read"]
    )

    for name in TELEMETRY_TOOLS:
        answer = call(
            client,
            limited,
            name,
            {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"]},
        )
        assert refused(answer, "capability_denied")["capability"] == "tasks.work"
    assert logs(db_session) == []


def test_an_unauthenticated_call_is_refused(client: TestClient) -> None:
    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "viper_log_mission_activity", "arguments": {}},
        },
        headers={"Authorization": "Bearer viper_nope"},
    )

    assert response.status_code == 401


def test_a_wrong_claim_id_is_refused_and_nothing_is_stored(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)

    answer = log(client, token, {**claimed, "claim_id": str(uuid.uuid7())})

    refused(answer, "conflict")
    assert logs(db_session) == []


def test_another_agents_task_is_refused(client: TestClient, db_session: Session) -> None:
    (_, _, claimed_a), (token_b, _, claimed_b) = two_agents(client, db_session)

    # B with A's task and A's claim id (a leaked pair): refused, nothing written.
    refused(log(client, token_b, claimed_a), "not_allowed")
    # B with A's task and its own claim id: the claim does not match.
    refused(log(client, token_b, {**claimed_a, "claim_id": claimed_b["claim_id"]}), "conflict")
    assert logs(db_session) == []
    # A's task id only resolves the run: B reaches its own session there, never A's.
    own = body(
        call(client, token_b, "viper_get_mission_session", {"task_id": claimed_a["task_id"]})
    )
    assert own["status"] == "active"
    row_b = next(row for row in sessions(db_session) if str(row.id) == own["session_id"])
    assert row_b.agent_label == "Agent B"


def test_a_cancelled_mission_refuses_the_log(client: TestClient, db_session: Session) -> None:
    mission_id = mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)

    set_status(client, mission_id, "cancelled")

    refused(log(client, token, claimed), "task_cancelled")
    assert logs(db_session) == []


def test_field_caps_and_the_closed_taxonomy(client: TestClient, db_session: Session) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)

    cases: list[tuple[dict[str, Any], str]] = [
        ({"event_type": "thought"}, "event_type"),
        ({"message": "x" * 1001}, "message"),
        ({"message": "  "}, "message"),
        ({"message": "<b>gras</b>"}, "message"),
        ({"message": 12}, "message"),
        ({"source_url": "javascript:alert(1)"}, "source_url"),
        ({"source_published_at": "pas une date"}, "source_published_at"),
        (
            {"source_published_at": (datetime.now(UTC) + timedelta(days=30)).isoformat()},
            "source_published_at",
        ),
        ({"metadata": {"reasoning": "..."}}, "metadata"),
        ({"metadata": {"note": "y" * 600}}, "metadata"),
        ({"metadata": {"blob": "z" * 5000}}, "metadata"),
        ({"metadata": "texte"}, "metadata"),
    ]
    for extra, field in cases:
        content = refused_any(log(client, token, claimed, **extra))
        assert content["field"] == field, (extra, content)
    assert logs(db_session) == []

    body(log(client, token, claimed, message="x" * 1000))
    assert len(logs(db_session)) == 1


def refused_any(answer: dict[str, Any]) -> dict[str, Any]:
    assert answer["isError"] is True, answer
    content: dict[str, Any] = answer["structuredContent"]
    return content


# --- rate limit ----------------------------------------------------------------------------------


def test_a_token_is_limited_to_120_logs_a_minute(client: TestClient, db_session: Session) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"), add_company(db_session, "B"))
    token_a, record_a = worker(db_session, "Agent A")
    token_b, _ = worker(db_session, "Agent B")
    claimed_a, claimed_b = claim(client, token_a), claim(client, token_b)
    actor = ActorContext(type=ActorType.AGENT, id=str(record_a.id), display="Agent A")
    now = datetime.now(UTC)
    for _ in range(mission_telemetry.LOG_RATE_LIMIT_PER_MINUTE):
        agent_missions.log_activity(
            db_session,
            actor,
            uuid.UUID(claimed_a["task_id"]),
            uuid.UUID(claimed_a["claim_id"]),
            "progress",
            "Étape terminée.",
            now=now,
        )

    answer = log(client, token_a, claimed_a)

    content = refused(answer, "rate_limited")
    assert content["limit"] == 120
    assert len(logs(db_session)) == 120
    # The limit is per token, and a refused log does not stop the work (heartbeat still works).
    body(log(client, token_b, claimed_b))
    body(call(client, token_a, "viper_heartbeat_task", claimed_a_args(claimed_a)))
    # The call is kept in the history as refused.
    outcome = db_session.scalars(
        select(McpCall.outcome).where(
            McpCall.tool == "viper_log_mission_activity", McpCall.error_code == "rate_limited"
        )
    ).all()
    assert outcome == ["refused"]
    # A minute later the window has moved on.
    agent_missions.log_activity(
        db_session,
        actor,
        uuid.UUID(claimed_a["task_id"]),
        uuid.UUID(claimed_a["claim_id"]),
        "progress",
        "Étape suivante.",
        now=now + timedelta(seconds=61),
    )


def claimed_a_args(claimed: dict[str, Any]) -> dict[str, Any]:
    return {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"]}


def test_the_rate_check_refuses_with_a_stable_code(client: TestClient, db_session: Session) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, record = worker(db_session, "Agent A")
    claimed = claim(client, token)
    actor = ActorContext(type=ActorType.AGENT, id=str(record.id), display="Agent A")
    now = datetime.now(UTC)
    for _ in range(mission_telemetry.LOG_RATE_LIMIT_PER_MINUTE):
        agent_missions.log_activity(
            db_session,
            actor,
            uuid.UUID(claimed["task_id"]),
            uuid.UUID(claimed["claim_id"]),
            "progress",
            "Étape terminée.",
            now=now,
        )

    try:
        mission_telemetry.check_log_rate(db_session, actor, now)
    except BusinessRuleError as error:
        assert (error.code, error.http_status) == ("rate_limited", 429)
    else:  # pragma: no cover
        raise AssertionError("the 121st log in a minute must be refused")


# --- reading and ending the session --------------------------------------------------------------


def test_get_session_is_read_only_and_ending_is_idempotent(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)
    body(log(client, token, claimed))
    (row,) = sessions(db_session)
    seen = row.last_seen_at
    arguments = {"task_id": claimed["task_id"]}

    current = body(call(client, token, "viper_get_mission_session", arguments))

    assert current["status"] == "active"
    assert current["logs_count"] == 1
    assert current["ended_at"] is None and current["disconnect_reason"] is None
    assert sessions(db_session)[0].last_seen_at == seen

    ended = body(call(client, token, "viper_end_mission_session", arguments))
    again = body(call(client, token, "viper_end_mission_session", arguments))

    assert ended["status"] == "ended" and ended["ended_at"]
    assert again == ended
    (closed,) = sessions(db_session)
    assert closed.disconnect_reason is not None
    assert closed.disconnect_reason.value == "agent_ended"
    # Ending releases and fails nothing: the claim still works, and the next activity opens a new
    # session (the ended row is never reactivated).
    body(call(client, token, "viper_heartbeat_task", claimed_a_args(claimed)))
    rows = sessions(db_session)
    assert [r.status.value for r in rows] == ["ended", "active"]


def test_session_tools_see_only_the_callers_session(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token_a, _ = worker(db_session, "Agent A")
    token_b, _ = worker(db_session, "Agent B")
    claimed = claim(client, token_a)

    # B holds nothing in this run: no session to read or end, and nothing is revealed about A's.
    for name in ("viper_get_mission_session", "viper_end_mission_session"):
        refused(call(client, token_b, name, {"task_id": claimed["task_id"]}), "not_found")
        refused(call(client, token_b, name, {"task_id": str(uuid.uuid4())}), "not_found")
    assert [row.status.value for row in sessions(db_session)] == ["active"]


def test_the_work_flow_keeps_one_session_and_submit_semantics(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent A")
    claimed = claim(client, token)

    body(log(client, token, claimed, event_type="observation", message="SIREN lu sur la page."))
    body(call(client, token, "viper_heartbeat_task", claimed_a_args(claimed)))
    submitted = body(
        call(
            client,
            token,
            "viper_submit_task_result",
            {
                **claimed_a_args(claimed),
                "result": {"legal_name": "2SN SAS", "confidence": 80, "notes": "Rapport."},
            },
        )
    )

    assert submitted["status"] == "pending_review"
    (row,) = sessions(db_session)
    assert row.status is MissionAgentSessionStatus.ACTIVE
    assert len(logs(db_session)) == 1
    # A submitted task no longer holds a claim: logging is refused, the result is untouched.
    refused(log(client, token, claimed), "conflict")
    assert db_session.scalar(select(func.count()).select_from(Company)) == 1


# --- agent trace ---------------------------------------------------------------------------------


def test_agent_trace_claim_log_heartbeat_submit(client: TestClient, db_session: Session) -> None:
    """The whole worker flow on the real endpoint. With `VIPER_TRACE_OUT=<file>` the JSON-RPC
    requests and answers are written there (Slice 04 trace evidence); the assertions hold either
    way: one session, no register call, logs in order, the result still a proposal."""
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, _ = worker(db_session, "Agent trace")
    trace: list[dict[str, Any]] = []

    def step(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        answer = call(client, token, name, arguments)
        trace.append({"request": {"name": name, "arguments": arguments}, "response": answer})
        db_session.expire_all()
        trace[-1]["sessions"] = [
            f"{row.status.value}:{row.agent_label}" for row in sessions(db_session)
        ]
        trace[-1]["logs_count"] = len(logs(db_session))
        return answer

    claimed = body(step("viper_claim_task", {"task_types": ["update_company"]}))
    ids = {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"]}
    for event_type, message, extra in (
        ("search", "Recherche du site officiel de 2SN.", {"metadata": {"engine": "web"}}),
        (
            "source_opened",
            "Page ouverte : mentions légales de 2sn.fr.",
            {"source_url": "https://2sn.fr/mentions"},
        ),
        (
            "observation",
            "SIREN 123 456 789 lu dans les mentions légales.",
            {"source_url": "https://2sn.fr/mentions"},
        ),
        (
            "verification",
            "SIREN confirmé sur l'annuaire officiel.",
            {"metadata": {"field": "siren", "outcome": "confirmed"}},
        ),
    ):
        body(
            step(
                "viper_log_mission_activity",
                {**ids, "event_type": event_type, "message": message, **extra},
            )
        )
    body(step("viper_heartbeat_task", ids))
    body(step("viper_get_mission_session", {"task_id": ids["task_id"]}))
    body(
        step(
            "viper_log_mission_activity",
            {
                **ids,
                "event_type": "progress",
                "message": "1 société sur 1 traitée.",
                "metadata": {"done": 1, "total": 1},
            },
        )
    )
    result = {"legal_name": "2SN SAS", "confidence": 80, "notes": "Site et annuaire consultés."}
    body(step("viper_submit_task_result", {**ids, "result": result}))
    body(step("viper_end_mission_session", {"task_id": ids["task_id"]}))

    assert [entry["request"]["name"] for entry in trace].count("viper_claim_task") == 1
    assert not [e for e in trace if "register" in e["request"]["name"]]
    (row,) = sessions(db_session)
    assert row.status is MissionAgentSessionStatus.ENDED
    assert [entry.event_type.value for entry in logs(db_session)] == [
        "search",
        "source_opened",
        "observation",
        "verification",
        "progress",
    ]
    out = os.environ.get("VIPER_TRACE_OUT")
    if out:
        trace[0]["response"]["structuredContent"]["output_schema"] = "<omitted>"
        Path(out).write_text(json.dumps(trace, ensure_ascii=False, indent=1), encoding="utf-8")
