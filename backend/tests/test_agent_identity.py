"""Agent identity and lifecycle (Slice 03): numbered labels, the per-owner cap, « leave work ».

Contract: `doc/architecture/mcp-server.md` §4.9. The cap on identities is distinct from a token's
`max_concurrent`, and the 15-minute lease and the 3-hour session timeout stay independent.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AgentTask, MissionAgentSession
from app.models.enums import (
    AgentMode,
    AgentProvider,
    AgentTaskStatus,
    MissionAgentDisconnectReason,
    MissionAgentSessionStatus,
)
from app.models.mcp import McpToken
from app.services import (
    agent_identity,
    agent_lifecycle,
    agent_missions,
    mcp_tokens,
    mission_telemetry,
    oauth,
)
from app.services.errors import BusinessRuleError
from tests.builders import add_company
from tests.test_mcp_tools import body, call
from tests.test_mission_stop import claim, mission_with


def mint(
    session: Session,
    owner: str | None = "lucie@circoe.com",
    provider: AgentProvider = AgentProvider.CHATGPT,
    mode: AgentMode = AgentMode.WORKER,
    **fields: Any,
) -> tuple[str, McpToken]:
    token, record = mcp_tokens.mint(
        session,
        label="Conversation",
        scopes=["*"],
        owner_email=owner,
        provider=provider,
        mode=mode,
        **fields,
    )
    session.flush()
    return token, record


def test_three_conversations_of_one_owner_are_numbered_instances(db_session: Session) -> None:
    records = [mint(db_session)[1] for _ in range(3)]

    assert [record.instance_number for record in records] == [1, 2, 3]
    assert [agent_identity.identity_label(record) for record in records] == [
        "ChatGPT lucie #1",
        "ChatGPT lucie #2",
        "ChatGPT lucie #3",
    ]
    # The descriptive label survives next to the resolved identity.
    assert {record.label for record in records} == {"Conversation"}


def test_numbers_are_relative_to_owner_and_provider(db_session: Session) -> None:
    mint(db_session)
    other_provider = mint(db_session, provider=AgentProvider.CLAUDE)[1]
    other_owner = mint(db_session, owner="paul@circoe.com")[1]
    ownerless = mint(db_session, owner=None, provider=AgentProvider.OTHER)[1]

    assert other_provider.instance_number == 1
    assert other_owner.instance_number == 1
    assert agent_identity.identity_label(other_owner) == "ChatGPT paul #1"
    assert agent_identity.identity_label(ownerless) == "Agent #1"


def test_a_revoked_number_is_reused_deterministically_a_live_one_is_not(
    db_session: Session,
) -> None:
    first, second, third = (mint(db_session)[1] for _ in range(3))

    oauth.revoke_agent(db_session, second.id)
    reused = mint(db_session)[1]
    next_new = mint(db_session)[1]

    assert reused.instance_number == 2
    assert next_new.instance_number == 4
    # History keeps the number of the revoked token.
    assert second.instance_number == 2 and second.revoked_at is not None
    assert (first.instance_number, third.instance_number) == (1, 3)


def test_a_scheduled_agent_keeps_its_identity_while_idle(db_session: Session) -> None:
    _, scheduled = mint(db_session, mode=AgentMode.SCHEDULED)
    for _ in range(3):
        mint(db_session)
    scheduled_after = db_session.get(McpToken, scheduled.id)

    assert scheduled_after is not None and scheduled_after.instance_number == 1
    # Never handed to another conversation while the scheduled token lives.
    assert all(
        record.instance_number != 1
        for record in db_session.scalars(select(McpToken).where(McpToken.id != scheduled.id))
        if record.owner_email == "lucie@circoe.com"
    )


def test_the_unique_index_is_the_backstop_of_the_allocator(db_session: Session) -> None:
    _, record = mint(db_session)

    with pytest.raises(IntegrityError), db_session.begin_nested():
        db_session.add(
            McpToken(
                label="Dup",
                token_hash="f" * 64,
                owner_email=record.owner_email,
                provider=record.provider,
                instance_number=record.instance_number,
            )
        )
        db_session.flush()


def test_the_per_owner_cap_defaults_to_100_and_is_not_max_concurrent(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core.config import Settings

    assert Settings().mcp_max_agents_per_owner == 100
    monkeypatch.setattr(
        agent_identity, "get_settings", lambda: SimpleNamespace(mcp_max_agents_per_owner=3)
    )

    # max_concurrent=1 does not stop a person from holding several identities…
    for _ in range(3):
        mint(db_session, max_concurrent=1)
    # …the cap does, with its own error code, for that owner only.
    with pytest.raises(BusinessRuleError) as refused:
        mint(db_session)
    assert refused.value.code == agent_identity.AGENT_CAP_REACHED
    assert refused.value.http_status == 409
    assert "tasks" in str(refused.value)
    mint(db_session, owner="paul@circoe.com")
    # Revoking one frees a slot.
    first = db_session.scalars(select(McpToken).where(McpToken.owner_email == "lucie@circoe.com"))
    oauth.revoke_agent(db_session, first.first().id)  # type: ignore[union-attr]
    assert mint(db_session)[1].instance_number == 1


def test_whoami_reports_identity_and_task_concurrency(
    client: TestClient, db_session: Session
) -> None:
    token, _ = mint(db_session, owner=None, max_concurrent=2)

    who = body(call(client, token, "viper_whoami", {}))

    assert who["identity"] == "ChatGPT #1"
    assert who["instance_number"] == 1
    assert who["max_concurrent_tasks"] == 2


def test_the_claim_limit_speaks_of_tasks_not_tokens(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"), add_company(db_session, "A"))
    token, _ = mint(db_session, owner=None, max_concurrent=1)
    claim(client, token)

    refused = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})

    assert refused["isError"] is True
    assert "task concurrency limit" in str(refused["structuredContent"])


def held(session: Session, record: McpToken) -> list[AgentTask]:
    session.expire_all()
    return list(
        session.scalars(
            select(AgentTask).where(
                AgentTask.claimed_by_id == str(record.id),
                AgentTask.status == AgentTaskStatus.CLAIMED,
            )
        )
    )


def active_sessions(session: Session) -> list[MissionAgentSession]:
    session.expire_all()
    return list(
        session.scalars(
            select(MissionAgentSession).where(
                MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE
            )
        )
    )


def test_leave_work_releases_every_held_task_and_ends_the_session(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"), add_company(db_session, "A"))
    token, record = mint(db_session, owner=None)
    other_token, other = mint(db_session, owner=None)
    claim(client, token)
    claim(client, token)
    assert len(held(db_session, record)) == 2 and len(active_sessions(db_session)) == 1

    left = body(call(client, token, "viper_leave_work", {}))

    assert left == {"released_tasks": 2, "ended_sessions": 1, "scope": "all"}
    assert held(db_session, record) == [] and active_sessions(db_session) == []
    ended = db_session.scalars(select(MissionAgentSession)).one()
    assert ended.disconnect_reason is MissionAgentDisconnectReason.AGENT_ENDED
    # Idempotent, and the tasks are claimable again right away.
    again = body(call(client, token, "viper_leave_work", {}))
    assert again == {"released_tasks": 0, "ended_sessions": 0, "scope": "all"}
    assert body(call(client, other_token, "viper_leave_work", {}))["released_tasks"] == 0
    assert claim(client, other_token)["task_id"]
    assert len(held(db_session, other)) == 1


def test_leave_work_can_be_scoped_to_the_run_of_a_task(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"), add_company(db_session, "A"))
    token, record = mint(db_session, owner=None)
    first = claim(client, token)
    claim(client, token)

    left = body(call(client, token, "viper_leave_work", {"task_id": first["task_id"]}))

    assert left["scope"] == "run" and left["released_tasks"] == 2
    assert held(db_session, record) == []
    missing = call(
        client, token, "viper_leave_work", {"task_id": "00000000-0000-7000-8000-000000000000"}
    )
    assert missing["isError"] is True


def test_leave_work_is_refused_without_the_work_capability(
    client: TestClient, db_session: Session
) -> None:
    token, _ = mint(db_session, owner=None, capabilities=[])

    assert call(client, token, "viper_leave_work", {})["isError"] is True


def test_session_timeout_and_task_lease_are_independent(
    client: TestClient, db_session: Session
) -> None:
    mission_with(client, add_company(db_session, display_name="2SN"))
    token, record = mint(db_session, owner=None)
    claim(client, token)
    later = datetime.now(UTC) + mission_telemetry.SESSION_INACTIVITY_TIMEOUT + timedelta(minutes=1)

    # The 3 h timeout closes the silent session but never strands or releases the task…
    assert mission_telemetry.sweep_timed_out(db_session, later) == 1
    assert len(held(db_session, record)) == 1
    # …the (expired) lease sweep returns the task to the queue and never touches sessions.
    assert agent_missions.sweep_expired(db_session, later) == 1
    assert held(db_session, record) == []
    timed_out = db_session.scalars(select(MissionAgentSession)).one()
    assert timed_out.status is MissionAgentSessionStatus.TIMED_OUT
    # Leaving afterwards is a harmless no-op.
    actor = mcp_tokens.actor_for(record)
    assert agent_lifecycle.leave_work(db_session, actor)["released_tasks"] == 0


def test_the_agents_list_shows_the_resolved_identity(
    client: TestClient, db_session: Session
) -> None:
    mint(db_session, owner="admin@circoe.com")

    rows = client.get("/api/settings/mcp/agents").json()

    assert rows
    assert {"display_label", "instance_number", "max_concurrent"} <= set(rows[0])
