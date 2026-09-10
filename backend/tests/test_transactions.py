"""Transaction boundaries: services flush, the unit of work (or the request) commits once."""

import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import SessionDep
from app.core.config import Settings
from app.db.session import unit_of_work
from app.main import create_app
from app.models import ContactTracking, Prospect, Role
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.repositories.prospects import CONTACTABILITY_CLEAR_SETTING
from app.services import audit
from app.services import prospects as prospect_service
from app.services.audit import attributed_unit_of_work
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import (
    DNC_GUARD_MESSAGE,
    FIXTURE_ACTOR,
    OPERATOR,
    add_company,
    add_prospect,
    rejected,
)

RESET_ALL_CONTACTABILITY = text(
    "UPDATE prospects SET contactability_status = 'contactable', "
    "do_not_contact_at = NULL, do_not_contact_reason = NULL"
)


def clear_flag(session: Session) -> str | None:
    value: str | None = session.execute(
        select(text(f"current_setting('{CONTACTABILITY_CLEAR_SETTING}', true)"))
    ).scalar_one()
    return value


def contactability(session: Session, prospect_id: uuid.UUID) -> ContactabilityStatus:
    return session.execute(
        select(Prospect.contactability_status).where(Prospect.id == prospect_id)
    ).scalar_one()


def test_unit_of_work_commits_on_success(session_factory: sessionmaker[Session]) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        prospect_id = add_prospect(session).id

    with session_factory() as session:
        assert session.get(Prospect, prospect_id) is not None


def test_service_calls_in_one_unit_of_work_are_atomic(
    session_factory: sessionmaker[Session],
) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        prospect_id = add_prospect(session).id

    with pytest.raises(IntegrityError), unit_of_work(session_factory) as session:
        prospect_service.mark_do_not_contact(session, OPERATOR, prospect_id, reason="Opposition")
        unknown_referent = ContactTrackingInput(
            status=ContactTrackingStatus.CONTACTED, referent_id=uuid.uuid4()
        )
        save_contact_tracking(session, OPERATOR, prospect_id, unknown_referent)

    with session_factory() as session:
        assert contactability(session, prospect_id) is ContactabilityStatus.CONTACTABLE
        assert session.execute(select(ContactTracking)).first() is None


def test_clear_inside_a_larger_transaction_keeps_later_statements_guarded(
    session_factory: sessionmaker[Session],
) -> None:
    with attributed_unit_of_work(session_factory, FIXTURE_ACTOR) as session:
        cleared_id = add_prospect(session).id
        blocked_id = add_prospect(session, first_name="Marie").id
        for prospect_id in (cleared_id, blocked_id):
            prospect_service.mark_do_not_contact(session, OPERATOR, prospect_id)

        prospect_service.clear_do_not_contact(
            session, OPERATOR, cleared_id, reason="Consentement écrit reçu"
        )
        assert clear_flag(session) == "off"
        with rejected(session, DNC_GUARD_MESSAGE):
            session.execute(RESET_ALL_CONTACTABILITY)
        prospect_service.change_company(session, OPERATOR, cleared_id, add_company(session).id)

    with session_factory() as session:
        assert contactability(session, cleared_id) is ContactabilityStatus.CONTACTABLE
        assert contactability(session, blocked_id) is ContactabilityStatus.DO_NOT_CONTACT


def test_clear_flag_does_not_outlive_a_failed_clear(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id)
    db_session.execute(
        text(
            "CREATE FUNCTION inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "RAISE EXCEPTION 'injected failure' USING ERRCODE = 'check_violation'; END $$"
        )
    )
    db_session.execute(
        text(
            "CREATE TRIGGER inject_failure BEFORE UPDATE ON prospects "
            "FOR EACH ROW EXECUTE FUNCTION inject_failure()"
        )
    )

    with pytest.raises(IntegrityError, match="injected failure"), db_session.begin_nested():
        prospect_service.clear_do_not_contact(db_session, OPERATOR, prospect.id, reason="Test")

    db_session.execute(text("DROP TRIGGER inject_failure ON prospects"))
    assert clear_flag(db_session) != "on"
    with rejected(db_session, DNC_GUARD_MESSAGE):
        db_session.execute(RESET_ALL_CONTACTABILITY)


def test_request_commits_on_success_and_rolls_back_on_error(
    test_database_url: str, session_factory: sessionmaker[Session]
) -> None:
    app = create_app(Settings(database_url=test_database_url))
    app.state.session_factory = session_factory

    @app.post("/api/test-roles/{slug}")
    def create_role(slug: str, session: SessionDep, fail: bool = False) -> None:
        # An unauthenticated route has no bound actor: attribute the write explicitly.
        audit.bind(session, FIXTURE_ACTOR)
        session.add(Role(slug=slug, label=slug))
        session.flush()
        if fail:
            raise HTTPException(status_code=409)

    with TestClient(app) as client:
        assert client.post("/api/test-roles/kept").status_code == 200
        assert client.post("/api/test-roles/dropped", params={"fail": True}).status_code == 409

    with session_factory() as session:
        assert list(session.scalars(select(Role.slug))) == ["kept"]
