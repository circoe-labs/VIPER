"""Agent missions persistence (migration 0018): subjects, claims and the duplicate guards.

The three guards of `doc/architecture/agent-missions.md` are enforced by the database, not by the
service, so they hold whatever writes: one open thread per company, one open task per
(type, subject), one result awaiting review per task.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import AgentTask, AgentTaskResult, AgentThread, Company, Prospect
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    AgentThreadKind,
    AgentThreadStatus,
)
from tests.builders import add_company, add_prospect, rejected

DIGEST = "a" * 64
NOW = datetime(2026, 10, 29, 10, 0, tzinfo=UTC)


def add_thread(
    session: Session,
    company: Company | None = None,
    kind: AgentThreadKind = AgentThreadKind.COMPANY_REVIEW,
    status: AgentThreadStatus = AgentThreadStatus.OPEN,
    **fields: object,
) -> AgentThread:
    fields.setdefault("title", company.display_name if company else "Recherche de prospects")
    thread = AgentThread(
        kind=kind,
        company_id=company.id if company else None,
        status=status,
        created_by_type=ActorType.HUMAN,
        created_by_id="test-user",
        created_by_display="Opératrice Test",
        **fields,
    )
    session.add(thread)
    session.flush()
    return thread


def add_task(
    session: Session,
    thread: AgentThread,
    type: AgentTaskType,
    company: Company | None = None,
    prospect: Prospect | None = None,
    status: AgentTaskStatus = AgentTaskStatus.PENDING,
    **fields: object,
) -> AgentTask:
    task = AgentTask(
        thread_id=thread.id,
        type=type,
        company_id=company.id if company else None,
        prospect_id=prospect.id if prospect else None,
        status=status,
        **fields,
    )
    session.add(task)
    session.flush()
    return task


def add_result(
    session: Session,
    task: AgentTask,
    attempt: int = 1,
    status: AgentResultStatus = AgentResultStatus.PENDING_REVIEW,
    **fields: object,
) -> AgentTaskResult:
    fields.setdefault("decided_at", None)
    result = AgentTaskResult(
        task_id=task.id,
        attempt=attempt,
        submitted_by_label="claude-01",
        raw={"ok": True},
        digest=DIGEST,
        status=status,
        **fields,
    )
    session.add(result)
    session.flush()
    return result


def test_company_review_requires_a_company(db_session: Session) -> None:
    with rejected(db_session, "ck_agent_threads_kind_has_company"):
        add_thread(db_session, company=None)


def test_prospect_search_forbids_a_company(db_session: Session) -> None:
    company = add_company(db_session)

    with rejected(db_session, "ck_agent_threads_kind_has_company"):
        add_thread(db_session, company=company, kind=AgentThreadKind.PROSPECT_SEARCH)


def test_one_open_review_per_company(db_session: Session) -> None:
    company = add_company(db_session)
    add_thread(db_session, company=company)

    with rejected(db_session, "uq_agent_threads_open_company"):
        add_thread(db_session, company=company)


def test_a_closed_review_frees_the_company(db_session: Session) -> None:
    company = add_company(db_session)
    first = add_thread(db_session, company=company)
    first.status = AgentThreadStatus.DONE
    db_session.flush()

    add_thread(db_session, company=company)


def test_one_open_task_per_type_and_company(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)
    add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)

    with rejected(db_session, "uq_agent_tasks_open_company_task"):
        add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)

    # Another type on the same company is a different task, not a duplicate.
    add_task(db_session, thread, AgentTaskType.SURVEIL_SIGNALS, company=company)


def test_one_open_task_per_prospect(db_session: Session) -> None:
    company = add_company(db_session)
    prospect = add_prospect(db_session, company=company)
    thread = add_thread(db_session, company=company)
    add_task(db_session, thread, AgentTaskType.UPDATE_EMPLOYEE, company=company, prospect=prospect)

    with rejected(db_session, "uq_agent_tasks_open_prospect_task"):
        add_task(
            db_session,
            thread,
            AgentTaskType.UPDATE_EMPLOYEE,
            company=company,
            prospect=prospect,
        )


def test_a_decided_task_frees_its_subject(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)
    task = add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)
    task.status = AgentTaskStatus.ACCEPTED
    db_session.flush()

    add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)


def test_a_company_task_needs_its_company(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)

    with rejected(db_session, "ck_agent_tasks_subject_per_type"):
        add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY)


def test_find_prospects_has_no_subject(db_session: Session) -> None:
    thread = add_thread(db_session, company=None, kind=AgentThreadKind.PROSPECT_SEARCH)
    add_task(db_session, thread, AgentTaskType.FIND_PROSPECTS)

    with rejected(db_session, "uq_agent_tasks_open_thread_task"):
        add_task(db_session, thread, AgentTaskType.FIND_PROSPECTS)


def test_a_claim_is_all_or_nothing(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)

    # A claim without its id, then a claim id without its moment and agent: one CHECK each.
    with rejected(db_session, "ck_agent_tasks_claim_id_matches_status"):
        add_task(
            db_session,
            thread,
            AgentTaskType.UPDATE_COMPANY,
            company=company,
            status=AgentTaskStatus.CLAIMED,
            claimed_at=NOW,
            claimed_by_label="claude-01",
        )

    with rejected(db_session, "ck_agent_tasks_claim_is_complete"):
        add_task(
            db_session,
            thread,
            AgentTaskType.UPDATE_COMPANY,
            company=company,
            status=AgentTaskStatus.CLAIMED,
            claim_id=uuid.uuid7(),
        )


def test_one_result_awaits_review_per_task(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)
    task = add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)
    add_result(db_session, task)

    with rejected(db_session, "uq_agent_task_results_pending"):
        add_result(db_session, task, attempt=2)


def test_one_result_per_attempt(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)
    task = add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)
    add_result(db_session, task, status=AgentResultStatus.REJECTED, decided_at=NOW)

    with rejected(db_session, "uq_agent_task_results_attempt"):
        add_result(db_session, task, status=AgentResultStatus.REJECTED, decided_at=NOW)


def test_a_decision_carries_its_moment(db_session: Session) -> None:
    company = add_company(db_session)
    thread = add_thread(db_session, company=company)
    task = add_task(db_session, thread, AgentTaskType.UPDATE_COMPANY, company=company)

    with rejected(db_session, "ck_agent_task_results_decision_matches_status"):
        add_result(db_session, task, status=AgentResultStatus.ACCEPTED)
