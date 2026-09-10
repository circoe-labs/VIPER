"""Explorer staged writes: change-set validation, all-or-nothing application, audit, errors."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.models import (
    ActivityCategory,
    Company,
    ContactTracking,
    ContactTrackingStatusHistory,
    Email,
    Prospect,
    User,
)
from app.models.enums import ContactabilityStatus, ContactTrackingStatus, VerificationStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import (
    FIXTURE_ACTOR,
    add_company,
    add_email,
    add_prospect,
    add_role,
    audit_events,
)
from tests.explorer_helpers import API

MISSING = str(uuid.uuid4())


def save(
    client: TestClient,
    table: str,
    *,
    updates: list[dict[str, Any]] | None = None,
    inserts: list[dict[str, Any]] | None = None,
    deletes: list[dict[str, Any]] | None = None,
) -> Any:
    body = {"updates": updates or [], "inserts": inserts or [], "deletes": deletes or []}
    return client.post(f"{API}/{table}/changes", json=body)


def update(row: Any, **values: Any) -> dict[str, Any]:
    return {"key": {"id": str(row.id)}, "version": row.updated_at.isoformat(), "values": values}


def delete(row: Any) -> dict[str, Any]:
    return {"key": {"id": str(row.id)}, "version": row.updated_at.isoformat()}


def errors_of(response: Any) -> list[dict[str, Any]]:
    assert response.status_code in (409, 422), response.text
    errors: list[dict[str, Any]] = response.json()["detail"]["errors"]
    return errors


def only_error(response: Any) -> dict[str, Any]:
    [error] = errors_of(response)
    return error


@pytest.fixture
def company(db_session: Session) -> Company:
    return add_company(db_session, siren="000000001")


@pytest.fixture
def prospect(db_session: Session, company: Company) -> Prospect:
    return add_prospect(db_session, company, exact_job_title="Gérant")


def explorer_events(session: Session, entity_type: str) -> list[Any]:
    return audit_events(session, entity_type=entity_type)


# --- valid writes and audit ------------------------------------------------------------------


def test_an_update_is_applied_and_audited_as_a_database_explorer_edit(
    client: TestClient, db_session: Session, pilot_user: User, prospect: Prospect
) -> None:
    response = save(client, "prospects", updates=[update(prospect, exact_job_title="Directeur")])

    assert response.status_code == 200, response.text
    assert response.json() == {"updated": 1, "inserted": 0, "deleted": 0, "inserted_keys": []}
    db_session.refresh(prospect)
    assert prospect.exact_job_title == "Directeur"
    [event] = explorer_events(db_session, "prospect")
    assert event.action == "prospect.updated"
    assert (event.actor_type, event.actor_id, event.actor_display) == (
        ActorType.HUMAN,
        str(pilot_user.id),
        "Pilote Test",
    )
    assert event.context["source"] == "database_explorer"
    assert event.changes == {"exact_job_title": {"before": "Gérant", "after": "Directeur"}}


def test_an_insert_returns_the_new_key_and_is_audited(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    values = {"prospect_id": str(prospect.id), "address": "jean.test@example.com"}
    response = save(client, "emails", inserts=[{"values": values | {"origin_type": "manual"}}])

    assert response.status_code == 200, response.text
    [key] = response.json()["inserted_keys"]
    email = db_session.get_one(Email, uuid.UUID(key["id"]))
    assert (email.address, email.is_primary, email.prospect_id) == (
        "jean.test@example.com",
        False,
        prospect.id,
    )
    [event] = explorer_events(db_session, "email")
    assert (event.action, event.subject_id, event.context["source"]) == (
        "email.created",
        prospect.id,
        "database_explorer",
    )


def test_a_delete_is_applied_and_audited(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    email = add_email(db_session, prospect, "jean.test@example.com")

    assert save(client, "emails", deletes=[delete(email)]).status_code == 200

    assert db_session.scalar(select(func.count()).select_from(Email)) == 0
    [event] = explorer_events(db_session, "email")
    assert event.action == "email.deleted"
    assert event.changes["address"] == {"before": "jean.test@example.com", "after": None}


def test_swapping_the_primary_email_succeeds_whatever_the_order_of_the_edits(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    first = add_email(db_session, prospect, "a.test@example.com", is_primary=True)
    second = add_email(db_session, prospect, "b.test@example.com")

    # Setting the new primary first would break the one-primary index: it is retried after.
    response = save(
        client, "emails", updates=[update(second, is_primary=True), update(first, is_primary=False)]
    )

    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert (first.is_primary, second.is_primary) == (False, True)


# --- domain rules owned by services ----------------------------------------------------------


def test_a_company_change_applies_the_company_change_rule(
    client: TestClient, db_session: Session, company: Company
) -> None:
    prospect = add_prospect(db_session, company, employment_verified_at=datetime.now(UTC))
    email = add_email(
        db_session,
        prospect,
        "jean.test@example.com",
        verification_status=VerificationStatus.VERIFIED,
    )
    other = add_company(db_session, "Logistique Exemple SAS")

    response = save(client, "prospects", updates=[update(prospect, company_id=str(other.id))])

    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert (prospect.company_id, prospect.employment_verified_at) == (other.id, None)
    assert email.verification_status is VerificationStatus.UNVERIFIED
    [event] = explorer_events(db_session, "prospect")
    assert event.action == "prospect.company_changed"
    assert event.changes["company_id"]["after_label"] == "Logistique Exemple SAS"
    assert event.context["source"] == "database_explorer"


def test_a_prospect_cannot_be_detached_from_its_company(
    client: TestClient, prospect: Prospect
) -> None:
    error = only_error(save(client, "prospects", updates=[update(prospect, company_id=None)]))

    assert (error["code"], error["column"]) == ("invalid_value", "company_id")


def test_a_tracking_stage_change_keeps_the_status_history(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    tracking = save_contact_tracking(
        db_session,
        FIXTURE_ACTOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.TO_CONTACT),
    )

    response = save(client, "contact_tracking", updates=[update(tracking, status="contacted")])

    assert response.status_code == 200, response.text
    history = db_session.scalars(
        select(ContactTrackingStatusHistory.to_status).order_by(
            ContactTrackingStatusHistory.changed_at
        )
    ).all()
    assert history == [ContactTrackingStatus.TO_CONTACT, ContactTrackingStatus.CONTACTED]
    [event] = explorer_events(db_session, "contact_tracking")
    assert event.action == "contact_tracking.status_changed"


def test_a_second_tracking_row_for_a_prospect_is_refused(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    insert = {"values": {"prospect_id": str(prospect.id)}}
    assert save(client, "contact_tracking", inserts=[insert]).status_code == 200

    error = only_error(save(client, "contact_tracking", inserts=[insert]))

    assert error == {
        "operation": "insert",
        "index": 0,
        "column": "prospect_id",
        "code": "unique_violation",
        "message": "Ce prospect a déjà un suivi de contact.",
    }
    assert db_session.scalar(select(func.count()).select_from(ContactTracking)) == 1


def test_category_links_are_written_through_the_audited_company(
    client: TestClient, db_session: Session, company: Company
) -> None:
    category = ActivityCategory(slug="fret-test", label="Fret test")
    db_session.add(category)
    db_session.flush()
    link = {"company_id": str(company.id), "activity_category_id": str(category.id)}

    assert (
        save(client, "company_activity_categories", inserts=[{"values": link}]).status_code == 200
    )
    duplicate = only_error(save(client, "company_activity_categories", inserts=[{"values": link}]))
    refused = only_error(
        save(client, "company_activity_categories", updates=[{"key": link, "values": link}])
    )
    removed = save(client, "company_activity_categories", deletes=[{"key": link}])

    assert duplicate["code"] == "unique_violation"
    assert refused["code"] == "not_allowed"
    assert removed.status_code == 200, removed.text
    added_event, removed_event = explorer_events(db_session, "company")
    assert added_event.action == removed_event.action == "company.updated"
    assert added_event.changes == {
        "activity_categories_ids": {"before": [], "after": [str(category.id)]}
    }
    assert removed_event.changes["activity_categories_ids"]["after"] == []


# --- validation errors -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("values", "column", "message"),
    [
        ({"is_primary": "oui"}, "is_primary", "Vrai ou faux attendu."),
        ({"last_verified_at": "2026-09-10T10:00:00"}, "last_verified_at", "fuseau"),
        ({"verification_status": "peut-être"}, "verification_status", "Valeurs possibles"),
        ({"address": "x" * 321}, "address", "320 caractères au maximum."),
        ({"address": None}, "address", "Valeur obligatoire"),
    ],
)
def test_values_are_checked_against_the_column_type(
    client: TestClient,
    db_session: Session,
    prospect: Prospect,
    values: dict[str, Any],
    column: str,
    message: str,
) -> None:
    email = add_email(db_session, prospect, "jean.test@example.com")

    error = only_error(save(client, "emails", updates=[update(email, **values)]))

    assert error["column"] == column
    assert message in error["message"]


def test_required_columns_of_a_new_row_are_reported_one_by_one(
    client: TestClient, prospect: Prospect
) -> None:
    errors = errors_of(
        save(client, "emails", inserts=[{"values": {"prospect_id": str(prospect.id)}}])
    )

    assert {(error["column"], error["code"]) for error in errors} == {
        ("address", "required"),
        ("origin_type", "required"),
    }


def test_read_only_columns_are_refused_with_their_reason(
    client: TestClient, prospect: Prospect
) -> None:
    response = save(
        client,
        "prospects",
        updates=[
            update(
                prospect,
                contactability_status="do_not_contact",
                created_at="2026-01-01T00:00:00+00:00",
                id=MISSING,
                nope="x",
            )
        ],
    )

    errors = {error["column"]: error for error in errors_of(response)}
    assert "fiche prospect" in errors["contactability_status"]["message"]
    assert errors["created_at"]["message"] == "Horodatage géré par la base de données."
    assert errors["id"]["message"] == "Clé primaire générée à la création."
    assert errors["nope"]["code"] == "unknown_column"
    assert {error["code"] for error in errors.values()} == {"read_only", "unknown_column"}


def test_a_parent_key_is_fixed_after_creation(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    email = add_email(db_session, prospect, "jean.test@example.com")
    other = add_prospect(db_session, first_name="Marie")

    error = only_error(save(client, "emails", updates=[update(email, prospect_id=str(other.id))]))

    assert (error["code"], error["column"]) == ("read_only", "prospect_id")
    assert "fixé à la création" in error["message"]


@pytest.mark.parametrize(
    ("table", "values"),
    [
        ("audit_log", {"action": "prospect.updated"}),
        ("import_row_metadata", {"source_sheet": "Feuille"}),
        ("contact_tracking_status_history", {"to_status": "won"}),
        ("import_batches", {"filename": "autre.xlsx"}),
    ],
)
def test_tables_outside_the_audit_and_import_traces_accept_no_write(
    client: TestClient, table: str, values: dict[str, Any]
) -> None:
    key = {"id": MISSING}
    response = save(
        client,
        table,
        updates=[{"key": key, "version": "2026-01-01T00:00:00+00:00", "values": values}],
        inserts=[{"values": values}],
        deletes=[{"key": key, "version": "2026-01-01T00:00:00+00:00"}],
    )

    assert {(error["operation"], error["code"]) for error in errors_of(response)} == {
        ("update", "not_allowed"),
        ("insert", "not_allowed"),
        ("delete", "not_allowed"),
    }


def test_prospects_are_not_created_from_the_explorer(client: TestClient) -> None:
    error = only_error(save(client, "prospects", inserts=[{"values": {"first_name": "Jean"}}]))

    assert error["code"] == "not_allowed"
    assert "Prospection" in error["message"]


def test_a_row_listed_twice_is_refused(client: TestClient, prospect: Prospect) -> None:
    response = save(
        client,
        "prospects",
        updates=[update(prospect, first_name="Jeanne")],
        deletes=[delete(prospect)],
    )

    assert only_error(response)["code"] == "duplicate"


def test_malformed_change_sets_are_rejected(client: TestClient) -> None:
    assert save(client, "prospects").status_code == 422
    assert save(client, "users", inserts=[{"values": {}}]).status_code == 404
    bad_body: dict[str, Any] = {"updates": [{"key": {}, "values": {}}]}
    assert client.post(f"{API}/prospects/changes", json=bad_body).status_code == 422


# --- database refusals in French -------------------------------------------------------------


def test_a_check_violation_names_the_rule(client: TestClient, company: Company) -> None:
    error = only_error(save(client, "companies", updates=[update(company, siren="12AB")]))

    assert error == {
        "operation": "update",
        "index": 0,
        "column": "siren",
        "code": "check_violation",
        "message": "Le SIREN compte exactement 9 chiffres.",
    }


def test_a_unique_violation_says_which_rule_in_words(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    add_email(db_session, prospect, "a.test@example.com", is_primary=True)
    second = add_email(db_session, prospect, "b.test@example.com")

    error = only_error(save(client, "emails", updates=[update(second, is_primary=True)]))

    assert (error["code"], error["column"]) == ("unique_violation", "is_primary")
    assert error["message"] == "Un e-mail principal actif existe déjà pour ce prospect."


def test_a_missing_reference_target_is_reported_on_its_column(
    client: TestClient, prospect: Prospect
) -> None:
    error = only_error(save(client, "prospects", updates=[update(prospect, role_id=MISSING)]))

    assert (error["code"], error["column"]) == ("reference_not_found", "role_id")
    assert error["message"] == "Aucune ligne de roles ne porte cet identifiant."


def test_an_existing_reference_target_is_accepted(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    role = add_role(db_session)

    assert (
        save(client, "prospects", updates=[update(prospect, role_id=str(role.id))]).status_code
        == 200
    )
    db_session.refresh(prospect)
    assert prospect.role_id == role.id


def test_deleting_a_referenced_row_is_blocked(
    client: TestClient, db_session: Session, company: Company
) -> None:
    role = add_role(db_session)
    add_prospect(db_session, company, role_id=role.id)

    error = only_error(save(client, "roles", deletes=[delete(role)]))

    assert error["code"] == "foreign_key_violation"
    assert "prospects" in error["message"]


def test_a_do_not_contact_prospect_cannot_be_deleted(
    client: TestClient, db_session: Session, company: Company
) -> None:
    blocked = add_prospect(
        db_session,
        company,
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime.now(UTC),
    )

    error = only_error(save(client, "prospects", deletes=[delete(blocked)]))

    assert error["code"] == "do_not_contact"
    assert error["message"].startswith("Ce prospect est en opposition : utilisez la fiche prospect")
    assert db_session.get(Prospect, blocked.id) is not None


# --- concurrency and atomicity ---------------------------------------------------------------


def test_a_row_changed_meanwhile_is_a_conflict(
    client: TestClient, db_session: Session, prospect: Prospect
) -> None:
    # The client read the row before another transaction's update bumped `updated_at`. (Within
    # this test's single transaction the trigger's now() does not move, so the stale version the
    # client holds is simulated.)
    stale = update(prospect, first_name="Jeanne")
    stale["version"] = (prospect.updated_at - timedelta(seconds=1)).isoformat()

    response = save(client, "prospects", updates=[stale])

    assert response.status_code == 409
    error = only_error(response)
    assert (error["code"], error["column"]) == ("conflict", None)
    assert error["message"].startswith("Ligne modifiée entre-temps")
    db_session.refresh(prospect)
    assert prospect.first_name == "Jean"


def test_a_version_is_required_where_the_table_has_one(
    client: TestClient, prospect: Prospect
) -> None:
    unversioned = {"key": {"id": str(prospect.id)}, "values": {"first_name": "Jeanne"}}

    assert only_error(save(client, "prospects", updates=[unversioned]))["code"] == "invalid_key"


def test_a_deleted_row_is_reported_not_found(client: TestClient, prospect: Prospect) -> None:
    gone = update(prospect, first_name="Jeanne") | {"key": {"id": MISSING}}

    assert only_error(save(client, "prospects", updates=[gone]))["code"] == "not_found"


def test_one_failing_change_keeps_every_other_change_out(
    client: TestClient, db_session: Session, prospect: Prospect, company: Company
) -> None:
    other = add_company(db_session, "Logistique Exemple SAS", siren="000000002")

    response = save(
        client,
        "companies",
        updates=[update(company, legal_name="Nouveau nom"), update(other, siren="000000001")],
        inserts=[{"values": {"display_name": "Messagerie Démo SA"}}],
    )

    error = only_error(response)
    assert (error["operation"], error["index"], error["column"]) == ("update", 1, "siren")
    db_session.expire_all()
    assert company.legal_name is None
    assert db_session.scalar(select(func.count()).select_from(Company)) == 2
    assert explorer_events(db_session, "company") == []


def test_writes_need_a_session_and_the_csrf_token(
    client: TestClient, anonymous_client: TestClient, prospect: Prospect
) -> None:
    body = {"updates": [update(prospect, first_name="Jeanne")]}
    url = f"{API}/prospects/changes"

    assert anonymous_client.post(url, json=body).status_code == 401
    del client.headers[CSRF_HEADER]
    assert client.post(url, json=body).status_code == 403
