"""Agent missions: claim, lease, submit, fail, release — and the payload/proposal contract.

The duplicate guard has three layers (agent-missions.md §7); this file exercises the second and
the third: a claimed task is not handed to another agent, and a submission needs the live claim.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import AgentTask, AgentTaskResult, AgentThread, AuditLogEntry, Company, Prospect
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    AgentThreadKind,
    AgentThreadStatus,
)
from app.services import agent_missions, audit
from app.services.audit import AuditSource
from app.services.errors import ActorNotAllowedError, ConflictError, InvalidFieldError
from tests.builders import add_company, add_email, add_phone, add_prospect, add_role

AGENT = ActorContext(type=ActorType.AGENT, id="claude-01", display="Agent claude-01")
OTHER_AGENT = ActorContext(type=ActorType.AGENT, id="claude-02", display="Agent claude-02")
NOW = datetime(2026, 10, 29, 10, 0, tzinfo=UTC)


@pytest.fixture
def session(db_session: Session) -> Session:
    """A session bound to an agent, as the MCP layer will bind it."""
    audit.bind(db_session, AGENT, audit.AuditContext(source=AuditSource.AGENT))
    return db_session


def add_thread(
    session: Session,
    company: Company | None,
    kind: AgentThreadKind = AgentThreadKind.COMPANY_REVIEW,
) -> AgentThread:
    thread = AgentThread(
        kind=kind,
        company_id=company.id if company else None,
        title=company.display_name if company else "Recherche",
        status=AgentThreadStatus.OPEN,
        created_by_type=ActorType.HUMAN,
        created_by_display="Opératrice Test",
    )
    session.add(thread)
    session.flush()
    return thread


def add_task(
    session: Session,
    thread: AgentThread,
    type: AgentTaskType = AgentTaskType.UPDATE_COMPANY,
    *,
    company: Company | None = None,
    prospect: Prospect | None = None,
    priority: int = 0,
    max_attempts: int = 3,
) -> AgentTask:
    task = AgentTask(
        thread_id=thread.id,
        type=type,
        company_id=company.id if company else None,
        prospect_id=prospect.id if prospect else None,
        status=AgentTaskStatus.PENDING,
        priority=priority,
        max_attempts=max_attempts,
    )
    session.add(task)
    session.flush()
    return task


def complete_employee(session: Session, company: Company) -> Prospect:
    """A prospect with nothing missing, so `open_company_review` does not queue a task for it."""
    role = add_role(session)
    prospect = add_prospect(session, company, role_id=role.id, employment_verified_at=NOW)
    add_email(session, prospect, "jean.test@example.com", is_primary=True, is_active=True)
    add_phone(session, prospect, "+33600000000", is_primary=True, is_active=True)
    return prospect


def test_claim_returns_a_task_and_its_payload(session: Session) -> None:
    company = add_company(session, website_url="https://2sn.fr")
    thread = add_thread(session, company)
    task = add_task(session, thread, company=company)

    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)

    assert claimed is not None
    assert claimed.task.id == task.id
    assert claimed.task.status is AgentTaskStatus.CLAIMED
    assert claimed.task.attempts == 1
    assert claimed.task.claimed_by_label == AGENT.display
    payload = claimed.payload
    assert payload["task_id"] == str(task.id)
    assert payload["task"] == "update_company"
    assert payload["company_data"]["website_url"] == "https://2sn.fr"
    assert "siren" in payload["missing_fields"]
    assert payload["output_schema"]["properties"]["siren"]
    assert payload["lease"]["expires_at"] is not None


def test_a_claimed_task_is_not_handed_out_twice(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)

    assert agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY]) is not None
    assert agent_missions.claim(session, OTHER_AGENT, types=[AgentTaskType.UPDATE_COMPANY]) is None


def test_the_queue_respects_priority_then_age(session: Session) -> None:
    # Two companies: the same company may not hold two open tasks of the same type.
    calm = add_company(session, display_name="Calme SARL")
    busy = add_company(session, display_name="Urgente SAS")
    add_task(session, add_thread(session, calm), company=calm, priority=10)
    urgent = add_task(session, add_thread(session, busy), company=busy, priority=80)

    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY])

    assert claimed is not None
    assert claimed.task.id == urgent.id


def test_an_expired_lease_returns_the_task_to_the_queue(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    task = add_task(session, thread, company=company)

    first = agent_missions.claim(
        session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], lease=timedelta(seconds=1), now=NOW
    )
    assert first is not None

    second = agent_missions.claim(
        session,
        OTHER_AGENT,
        types=[AgentTaskType.UPDATE_COMPANY],
        now=NOW + timedelta(minutes=1),
    )

    assert second is not None
    assert second.task.id == task.id
    assert second.task.attempts == 2
    assert second.task.claimed_by_id == OTHER_AGENT.id


def test_only_an_agent_claims(session: Session) -> None:
    human = ActorContext(type=ActorType.HUMAN, id="u1", display="Lucie")

    with pytest.raises(ActorNotAllowedError):
        agent_missions.claim(session, human, types=[AgentTaskType.UPDATE_COMPANY])


def test_heartbeat_extends_the_lease(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    expires = agent_missions.heartbeat(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        lease=timedelta(minutes=30),
        now=NOW + timedelta(minutes=5),
    )

    assert expires == NOW + timedelta(minutes=35)


def test_a_lost_claim_is_refused(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    with pytest.raises(ConflictError):
        agent_missions.heartbeat(
            session, AGENT, claimed.task.id, uuid.uuid7(), now=NOW + timedelta(minutes=1)
        )


def test_another_agent_cannot_report_a_claim(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    with pytest.raises(ActorNotAllowedError):
        agent_missions.fail(
            session, OTHER_AGENT, claimed.task.id, claimed.claim_id, "blocked", "nope"
        )


def test_submit_stores_a_proposal_without_writing_the_company(session: Session) -> None:
    company = add_company(session, display_name="2SN")
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    result = agent_missions.submit(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        {
            "legal_name": "2SN SAS",
            "siren": "732829320",
            "evidence": [
                {"field": "legal_name", "source": "https://2sn.fr/mentions", "quote": "2SN SAS"}
            ],
            "confidence": 80,
        },
        now=NOW,
    )

    assert result.status is AgentResultStatus.PENDING_REVIEW
    assert len(result.digest) == 64
    assert result.proposal["refused"] == []
    items = {item["field"]: item for item in result.proposal["items"]}
    assert items["legal_name"]["after"] == "2SN SAS"
    assert items["legal_name"]["status"] == "add"
    assert items["legal_name"]["source"] == "https://2sn.fr/mentions"
    assert items["siren"]["after"] == "732829320"
    assert claimed.task.status is AgentTaskStatus.SUBMITTED
    assert claimed.task.claim_id is None
    # The company itself is untouched until a person accepts.
    stored = session.get(Company, company.id)
    assert stored is not None
    assert stored.legal_name is None


def test_submit_reports_what_it_could_not_normalise(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    result = agent_missions.submit(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        {
            "siren": "123456789",
            "commercial_segment": "Segment inconnu",
            "legal_name": "2SN SAS",
            "confidence": 40,
        },
        now=NOW,
    )

    refused = {item["field"]: item["reason"] for item in result.proposal["refused"]}
    assert refused == {"siren": "checksum", "commercial_segment": "unknown"}
    assert [item["field"] for item in result.proposal["items"]] == ["legal_name"]


def test_an_invalid_schema_keeps_the_task_claimed(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    with pytest.raises(InvalidFieldError):
        agent_missions.submit(
            session, AGENT, claimed.task.id, claimed.claim_id, {"confidence": 120}, now=NOW
        )

    assert claimed.task.status is AgentTaskStatus.CLAIMED
    assert claimed.claim_id is not None


def test_fail_requeues_then_gives_up(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    task = add_task(session, thread, company=company, max_attempts=1)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    agent_missions.fail(
        session, AGENT, claimed.task.id, claimed.claim_id, "not_found", "No source.", now=NOW
    )

    assert task.status is AgentTaskStatus.FAILED
    assert task.failure_code == "not_found"


def test_release_puts_the_task_back(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    task = add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None

    agent_missions.release(session, AGENT, claimed.task.id, claimed.claim_id, now=NOW)

    assert task.status is AgentTaskStatus.PENDING
    assert task.claim_id is None


def test_open_company_review_creates_the_thread_and_its_tasks(session: Session) -> None:
    company = add_company(session, display_name="2SN")
    add_prospect(session, company, first_name="Marie", last_name="Dupont")
    complete_employee(session, company)
    audit.bind(session, AGENT, audit.AuditContext(source=AuditSource.AGENT))

    thread = agent_missions.open_company_review(session, AGENT, company.id)

    assert thread.company_id == company.id
    types = session.scalars(select(AgentTask.type).where(AgentTask.thread_id == thread.id)).all()
    # `update_employee` joins when its result schema exists: a queued type no agent can
    # complete would sit in the thread forever.
    assert sorted(types) == [AgentTaskType.UPDATE_COMPANY]


def test_open_company_review_is_idempotent(session: Session) -> None:
    company = add_company(session)
    add_prospect(session, company)

    first = agent_missions.open_company_review(session, AGENT, company.id)
    second = agent_missions.open_company_review(session, AGENT, company.id)

    assert first.id == second.id
    total = session.scalar(select(func.count()).select_from(AgentTask))
    assert total == 1


def test_every_step_is_audited(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    agent_missions.submit(
        session,
        AGENT,
        claimed.task.id,
        claimed.claim_id,
        {"legal_name": "2SN SAS", "confidence": 50},
        now=NOW,
    )

    actions = session.scalars(select(AuditLogEntry.action)).all()

    assert "agent_task.claimed" in actions
    assert "agent_task.submitted" in actions


def test_a_submission_results_in_a_single_pending_review(session: Session) -> None:
    company = add_company(session)
    thread = add_thread(session, company)
    add_task(session, thread, company=company)
    claimed = agent_missions.claim(session, AGENT, types=[AgentTaskType.UPDATE_COMPANY], now=NOW)
    assert claimed is not None
    agent_missions.submit(
        session, AGENT, claimed.task.id, claimed.claim_id, {"confidence": 50}, now=NOW
    )

    pending = session.scalars(
        select(AgentTaskResult).where(AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW)
    ).all()
    assert len(pending) == 1
