"""AuditService: attribution, one event per changed row, safe payloads, ordering, atomicity."""

import logging
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, insert, inspect, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.api import router as api_routers
from app.api.dependencies import CurrentActor, SessionDep, audit_source
from app.core import audit_policy
from app.core.actor import ActorContext, ActorType
from app.core.audit_policy import PersonalValues
from app.db.base import Base
from app.db.session import unit_of_work
from app.models import (
    ActivityCategory,
    AuditLogEntry,
    Company,
    ContactTracking,
    Prospect,
    User,
)
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import audit
from app.services import prospects as prospect_service
from app.services.audit import (
    AuditAction,
    AuditContext,
    AuditSource,
    UnattributedMutationError,
    attributed_unit_of_work,
)
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import (
    FIXTURE_ACTOR,
    OPERATOR,
    REQUEST_ID,
    add_company,
    add_email,
    add_prospect,
    add_user,
    audit_events,
    bind_operator,
    rejected,
)

EXPECTED_OPERATOR = (ActorType.HUMAN, OPERATOR.id, OPERATOR.display)


def actor_of(entry: AuditLogEntry) -> tuple[ActorType, str | None, str]:
    return (entry.actor_type, entry.actor_id, entry.actor_display)


@pytest.fixture
def probe_router(monkeypatch: pytest.MonkeyPatch) -> APIRouter:
    """A feature router added to `api_router` for this test only."""
    monkeypatch.setattr(api_routers.api_router, "routes", list(api_routers.api_router.routes))
    return APIRouter(prefix="/audit-probe")


# --- attribution -----------------------------------------------------------------------------


def test_http_mutations_are_attributed_to_the_signed_in_user_not_the_payload(
    probe_router: APIRouter, client: TestClient, pilot_user: User, db_session: Session
) -> None:
    @probe_router.post("/{prospect_id}", status_code=204)
    def edit(
        prospect_id: uuid.UUID, payload: dict[str, Any], session: SessionDep, actor: CurrentActor
    ) -> None:
        # A generic write (no annotation) and a service call, in one request.
        prospect_service.get_prospect(session, prospect_id).exact_job_title = "Gérant"
        prospect_service.mark_do_not_contact(session, actor, prospect_id, reason="Opposition")

    api_routers.api_router.include_router(probe_router)
    prospect_id = add_prospect(db_session).id
    forged = {"actor": {"type": "agent", "id": "forged-id", "display": "Forged Actor"}}

    assert client.post(f"/api/audit-probe/{prospect_id}", json=forged).status_code == 204

    updated, blocked = audit_events(db_session, entity_type="prospect")
    assert (updated.action, blocked.action) == (
        "prospect.updated",
        AuditAction.PROSPECT_DO_NOT_CONTACT_SET,
    )
    for entry in (updated, blocked):
        assert actor_of(entry) == (ActorType.HUMAN, str(pilot_user.id), "Pilote Test")
        assert entry.context["source"] == "ui"
    assert updated.context["request_id"] == blocked.context["request_id"]
    assert "forged" not in str(db_session.execute(select(AuditLogEntry.context)).all())


def test_a_router_can_record_its_writes_under_the_database_explorer_source(
    probe_router: APIRouter, client: TestClient, pilot_user: User, db_session: Session
) -> None:
    explorer = APIRouter(dependencies=[Depends(audit_source(AuditSource.DATABASE_EXPLORER))])

    @explorer.patch("/{prospect_id}", status_code=204)
    def edit_cell(prospect_id: uuid.UUID, session: SessionDep) -> None:
        prospect_service.get_prospect(session, prospect_id).first_name = "Jeanne"

    probe_router.include_router(explorer)
    api_routers.api_router.include_router(probe_router)
    prospect_id = add_prospect(db_session).id

    assert client.patch(f"/api/audit-probe/{prospect_id}").status_code == 204

    [entry] = audit_events(db_session, entity_type="prospect")
    assert actor_of(entry) == (ActorType.HUMAN, str(pilot_user.id), "Pilote Test")
    assert entry.context["source"] == "database_explorer"
    assert entry.changes == {"first_name": {"before": "Jean", "after": "Jeanne"}}


def test_annotated_writes_need_no_binding(session_factory: sessionmaker[Session]) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        prospect_id = add_prospect(session).id

    with unit_of_work(session_factory) as session:
        prospect_service.mark_do_not_contact(session, OPERATOR, prospect_id)

    with session_factory() as session:
        [entry] = audit_events(session)
    assert actor_of(entry) == EXPECTED_OPERATOR
    assert entry.context == {"source": "ui"}


def test_an_unattributed_write_to_an_audited_table_fails_and_rolls_back(
    session_factory: sessionmaker[Session],
) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        prospect_id = add_prospect(session).id

    with (
        pytest.raises(UnattributedMutationError) as updated,
        unit_of_work(session_factory) as session,
    ):
        session.get_one(Prospect, prospect_id).exact_job_title = "Gérant"
    with pytest.raises(UnattributedMutationError) as created, unit_of_work(session_factory) as s:
        add_company(s)

    assert str(updated.value).startswith(f"prospect {prospect_id} was updated without an actor")
    assert str(created.value).startswith("company ")
    assert " was created without an actor" in str(created.value)

    with session_factory() as session:
        assert session.get_one(Prospect, prospect_id).exact_job_title is None
        assert session.execute(select(Company)).first() is None
        assert audit_events(session) == []


def test_tables_outside_the_audit_accept_writes_without_an_actor(
    session_factory: sessionmaker[Session],
) -> None:
    with unit_of_work(session_factory) as session:
        add_user(session, email="autre.test@example.com")

    with session_factory() as session:
        assert session.execute(select(User.email)).scalar_one() == "autre.test@example.com"


def test_a_bound_system_actor_attributes_writes_outside_http(
    session_factory: sessionmaker[Session],
) -> None:
    job = ActorContext(type=ActorType.SYSTEM, display="Tâche de test", id="tests.job")

    with attributed_unit_of_work(session_factory, job) as session:
        company_id = add_company(session).id

    with session_factory() as session:
        [entry] = audit_events(session)
    assert (entry.action, entry.entity_id) == ("company.created", company_id)
    assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
        ActorType.SYSTEM,
        "tests.job",
        "Tâche de test",
    )
    assert entry.context == {"source": "cli"}


def test_fixture_writes_are_attributed_to_the_fixture_actor(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    entry = db_session.execute(select(AuditLogEntry)).scalar_one()
    assert (entry.action, entry.entity_id) == ("prospect.created", prospect.id)
    assert (entry.actor_type, entry.actor_id) == (ActorType.SYSTEM, FIXTURE_ACTOR.id)
    assert audit_events(db_session) == []


def test_every_table_is_either_audited_or_explicitly_not(engine: Engine) -> None:
    audited = {model.__tablename__ for model in audit.AUDITED_ENTITIES}
    not_audited = set(audit.NOT_AUDITED_TABLES)
    with engine.connect() as connection:
        database_tables = set(inspect(connection).get_table_names()) - {"alembic_version"}

    assert not audited & not_audited
    assert audited | not_audited == set(Base.metadata.tables) == database_tables


# --- one event per changed row -----------------------------------------------------------------


def test_generic_orm_changes_are_captured_once_with_only_changed_fields(
    db_session: Session,
) -> None:
    bind_operator(db_session)
    company = add_company(db_session)
    prospect = add_prospect(db_session, company, exact_job_title="Gérant")
    email = add_email(db_session, prospect, "jean.test@example.com")

    prospect.last_name = "Exemple"
    prospect.exact_job_title = "Gérant"  # same value: not a change
    db_session.flush()
    db_session.delete(email)
    db_session.flush()

    entries = audit_events(db_session)
    assert [(entry.action, entry.entity_id) for entry in entries] == [
        ("company.created", company.id),
        ("prospect.created", prospect.id),
        ("email.created", email.id),
        ("prospect.updated", prospect.id),
        ("email.deleted", email.id),
    ]
    created, updated, deleted = entries[1], entries[3], entries[4]
    assert created.changes == {
        "company_id": {"before": None, "after": str(company.id)},
        "first_name": {"before": None, "after": "Jean"},
        "last_name": {"before": None, "after": "Test"},
        "exact_job_title": {"before": None, "after": "Gérant"},
        "activity_status": {"before": None, "after": "unknown"},
        "contactability_status": {"before": None, "after": "contactable"},
    }
    assert updated.changes == {"last_name": {"before": "Test", "after": "Exemple"}}
    assert deleted.changes["address"] == {"before": "jean.test@example.com", "after": None}
    assert (deleted.subject_type, deleted.subject_id) == ("prospect", prospect.id)
    assert all(actor_of(entry) == EXPECTED_OPERATOR for entry in entries)
    assert all(entry.context == {"source": "ui", "request_id": REQUEST_ID} for entry in entries)


def test_the_previous_value_is_exact_even_when_it_was_not_loaded(db_session: Session) -> None:
    prospect = add_prospect(db_session, exact_job_title="Gérant")
    bind_operator(db_session)
    db_session.expire_all()

    prospect.exact_job_title = "Directeur"
    db_session.flush()

    [entry] = audit_events(db_session)
    assert entry.changes == {"exact_job_title": {"before": "Gérant", "after": "Directeur"}}


def test_many_to_many_changes_are_recorded_as_id_lists(db_session: Session) -> None:
    company = add_company(db_session)
    road, storage = (
        ActivityCategory(slug="route", label="Route"),
        ActivityCategory(slug="stockage", label="Stockage"),
    )
    company.activity_categories.append(road)
    db_session.flush()
    bind_operator(db_session)

    company.activity_categories.append(storage)
    db_session.flush()

    [entry] = audit_events(db_session, entity_type="company")
    assert entry.changes == {
        "activity_categories_ids": {
            "before": [str(road.id)],
            "after": sorted([str(road.id), str(storage.id)]),
        }
    }


def test_a_service_annotation_is_not_logged_twice_by_the_safety_net(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    bind_operator(db_session)

    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Opposition")

    [entry] = audit_events(db_session)
    assert entry.action == AuditAction.PROSPECT_DO_NOT_CONTACT_SET


def test_pending_generic_edits_keep_their_own_event_before_a_semantic_one(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session)
    bind_operator(db_session)

    prospect.exact_job_title = "Gérant"
    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id)

    updated, blocked = audit_events(db_session)
    assert (updated.action, updated.changes) == (
        "prospect.updated",
        {"exact_job_title": {"before": None, "after": "Gérant"}},
    )
    assert blocked.action == AuditAction.PROSPECT_DO_NOT_CONTACT_SET
    assert "exact_job_title" not in blocked.changes


def test_only_the_documented_vocabulary_is_accepted(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    with pytest.raises(ValueError, match="Unknown audit action"):
        audit.annotate(db_session, OPERATOR, prospect, "prospect.renamed")
    with pytest.raises(ValueError, match="Unknown audit action"):
        audit.record_event(
            db_session, OPERATOR, "something happened", entity_type="prospect", entity_id=None
        )
    with pytest.raises(ValueError, match="not an audited entity"):
        audit.annotate(db_session, OPERATOR, User(email="x@example.com", display_name="X"))


# --- safe payloads -----------------------------------------------------------------------------


def test_account_secrets_never_reach_the_audit_log(db_session: Session, pilot_user: User) -> None:
    bind_operator(db_session)
    user = db_session.get_one(User, pilot_user.id)
    old_hash = user.password_hash

    user.password_hash = "$argon2id$v=19$synthetic-new-hash"
    user.email = "autre.test@example.com"
    db_session.flush()
    audit.record_event(
        db_session,
        OPERATOR,
        AuditAction.AUTH_PASSWORD_RESET,
        entity_type="user",
        entity_id=user.id,
        changes={"password_hash": {"before": old_hash, "after": user.password_hash}},
    )
    audit.record_event(
        db_session,
        OPERATOR,
        "prospect.updated",
        entity_type="prospect",
        entity_id=None,
        changes={"token_hash": {"before": None, "after": "f" * 64}},
    )

    [reset, other] = audit_events(db_session)
    assert (reset.action, reset.changes, other.changes) == ("auth.password_reset", {}, {})
    stored = str(db_session.execute(select(AuditLogEntry.changes, AuditLogEntry.context)).all())
    for secret in (old_hash, "synthetic-new-hash", "f" * 64, "autre.test@example.com"):
        assert secret not in stored


def test_personal_values_in_stored_events_follow_the_policy_switch(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    email = add_email(db_session, add_prospect(db_session), "jean.test@example.com")
    bind_operator(db_session)

    email.address = "jean.nouveau@example.com"
    db_session.flush()
    monkeypatch.setattr(
        audit_policy, "POLICY", replace(audit_policy.POLICY, personal_values=PersonalValues.MASKED)
    )
    email.address = "jean.dernier@example.com"
    db_session.flush()

    full, masked = audit_events(db_session)
    assert full.changes["address"] == {
        "before": "jean.test@example.com",
        "after": "jean.nouveau@example.com",
    }
    assert masked.changes["address"] == {"before": "j•••@example.com", "after": "j•••@example.com"}


def test_audit_payloads_are_never_written_to_application_logs(
    db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    bind_operator(db_session)

    add_email(db_session, add_prospect(db_session), "jean.test@example.com")
    prospect_service.mark_do_not_contact(
        db_session, OPERATOR, add_prospect(db_session).id, reason="Raison synthétique"
    )

    assert len(audit_events(db_session)) == 4
    assert "jean.test@example.com" not in caplog.text
    assert "Raison synthétique" not in caplog.text


# --- storage: ordering, append-only, atomicity ---------------------------------------------------


def add_raw_entry(
    session: Session, entry_id: uuid.UUID, occurred_at: datetime, **fields: Any
) -> None:
    fields.setdefault("entity_type", "prospect")
    session.execute(
        insert(AuditLogEntry).values(
            id=entry_id,
            occurred_at=occurred_at,
            actor_type=ActorType.SYSTEM,
            actor_display="Test",
            action="prospect.updated",
            **fields,
        )
    )


def test_history_and_recent_activity_are_newest_first_with_a_deterministic_tiebreak(
    db_session: Session,
) -> None:
    prospect_id, other_id = uuid.uuid7(), uuid.uuid7()
    same_time = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)
    first, second, third, other = (uuid.uuid7() for _ in range(4))
    add_raw_entry(db_session, second, same_time, subject_type="prospect", subject_id=prospect_id)
    add_raw_entry(db_session, first, same_time, subject_type="prospect", subject_id=prospect_id)
    add_raw_entry(
        db_session,
        third,
        datetime(2026, 9, 10, 13, 0, tzinfo=UTC),
        entity_type="email",
        subject_type="prospect",
        subject_id=prospect_id,
    )
    add_raw_entry(
        db_session,
        other,
        datetime(2026, 9, 10, 11, 0, tzinfo=UTC),
        subject_type="company",
        subject_id=other_id,
    )

    history = audit.history(db_session, "prospect", prospect_id)
    recent = audit.recent_activity(db_session, limit=3)
    companies = audit.recent_activity(db_session, subject_types=["company"])

    assert [entry.id for entry in history] == [third, second, first]
    assert [entry.id for entry in recent] == [third, second, first]
    assert [entry.id for entry in companies] == [other]
    assert audit.history(db_session, "prospect", prospect_id, limit=1)[0].id == third


def test_events_written_by_the_service_cannot_be_altered_or_deleted(db_session: Session) -> None:
    prospect_service.mark_do_not_contact(db_session, OPERATOR, add_prospect(db_session).id)

    with rejected(db_session, "audit_log is append-only: UPDATE"):
        db_session.execute(update(AuditLogEntry).values(actor_display="Quelqu'un d'autre"))
    with rejected(db_session, "audit_log is append-only: DELETE"):
        db_session.execute(delete(AuditLogEntry))
    with rejected(db_session, "audit_log is append-only: TRUNCATE"):
        db_session.execute(text("TRUNCATE audit_log"))
    assert [entry.actor_display for entry in audit_events(db_session)] == [OPERATOR.display]


def test_a_failed_audited_mutation_rolls_back_its_events(
    session_factory: sessionmaker[Session],
) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        prospect_id = add_prospect(session).id

    with pytest.raises(IntegrityError), unit_of_work(session_factory) as session:
        bind_operator(session)
        prospect_service.mark_do_not_contact(session, OPERATOR, prospect_id, reason="Opposition")
        unknown_referent = ContactTrackingInput(
            status=ContactTrackingStatus.CONTACTED, referent_id=uuid.uuid4()
        )
        save_contact_tracking(session, OPERATOR, prospect_id, unknown_referent)

    with session_factory() as session:
        assert audit_events(session) == []
        prospect = session.get_one(Prospect, prospect_id)
        assert prospect.contactability_status is ContactabilityStatus.CONTACTABLE
        assert session.execute(select(ContactTracking)).first() is None


def test_bound_restores_the_previous_binding(db_session: Session) -> None:
    importer = ActorContext(type=ActorType.IMPORT, display="Import test.xlsx", id="batch")
    bind_operator(db_session)

    with audit.bound(db_session, importer, AuditContext(source=AuditSource.IMPORT)):
        assert audit.binding(db_session) == (importer, AuditContext(source=AuditSource.IMPORT))

    assert audit.binding(db_session) == (
        OPERATOR,
        AuditContext(source=AuditSource.UI, request_id=REQUEST_ID),
    )


# --- API ---------------------------------------------------------------------------------------


def test_recent_activity_api_lists_events_newest_first(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session)
    bind_operator(db_session)
    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Opposition")

    events = client.get("/api/audit/recent", params={"limit": 2}).json()

    # The prospect itself was created by the test fixture.
    assert [event["action"] for event in events] == [
        "prospect.do_not_contact.set",
        "prospect.created",
    ]
    assert events[0]["actor"] == {"type": "human", "id": OPERATOR.id, "display": OPERATOR.display}
    assert events[0]["subject_id"] == str(prospect.id)
    assert events[0]["context"] == {
        "source": "ui",
        "request_id": REQUEST_ID,
        "reason": "Opposition",
    }
    for limit in (0, 101):
        assert client.get("/api/audit/recent", params={"limit": limit}).status_code == 422
