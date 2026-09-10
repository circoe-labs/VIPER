"""Explorer editability policy (who may write what) and delete diagnostics."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Prospect
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import audit
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.explorer.metadata import describe_table
from app.services.explorer.policy import DEFAULT_POLICY, EXPOSED_TABLES
from app.services.explorer.writes import CONSTRAINT_MESSAGES, LINK_TABLES
from tests.builders import FIXTURE_ACTOR, add_company, add_email, add_phone, add_prospect, add_role
from tests.explorer_helpers import API
from tests.test_explorer_metadata import columns_of


def table_of(client: TestClient, name: str) -> dict[str, Any]:
    response = client.get(f"{API}/{name}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def writable(name: str) -> bool:
    writes = EXPOSED_TABLES[name].writes
    return None in (writes.update, writes.insert, writes.delete)


# --- policy ----------------------------------------------------------------------------------


def test_tables_outside_the_audit_are_read_only_unless_written_through_an_audited_owner() -> None:
    audited_tables = {model.__tablename__ for model in audit.AUDITED_ENTITIES}
    for name in EXPOSED_TABLES:
        if not writable(name) or name in audited_tables:
            continue
        link = LINK_TABLES.get(name)
        assert link is not None, f"{name} is written by the explorer but not audited"
        assert link.owner in audit.AUDITED_ENTITIES
        assert name in audit.NOT_AUDITED_TABLES
    for name in ("audit_log", "import_row_metadata", "contact_tracking_status_history"):
        assert not writable(name)
    assert not writable("import_batches")


def test_structural_rules_keep_keys_timestamps_and_json_read_only() -> None:
    for name in EXPOSED_TABLES:
        for column in describe_table(DEFAULT_POLICY, name).columns:
            if column.name in ("created_at", "updated_at") or column.kind in ("json", "array"):
                assert not (column.updatable or column.insertable), (name, column.name)
                assert column.read_only_reason, (name, column.name)
            if column.primary_key:
                assert not column.updatable, (name, column.name)


def test_the_metadata_tells_the_grid_what_may_be_written(client: TestClient) -> None:
    prospects = table_of(client, "prospects")
    emails = columns_of(client, "emails")

    assert (prospects["update_refused"], prospects["delete_refused"]) == (None, None)
    assert "Prospection" in prospects["insert_refused"]
    assert (prospects["bulk_delete"], prospects["version_column"]) == (False, "updated_at")
    assert prospects["label_columns"] == ["first_name", "last_name"]
    opposition = next(c for c in prospects["columns"] if c["name"] == "contactability_status")
    assert (opposition["updatable"], opposition["insertable"]) == (False, False)
    assert "fiche prospect" in opposition["read_only_reason"]
    assert (emails["prospect_id"]["updatable"], emails["prospect_id"]["insertable"]) == (
        False,
        True,
    )
    assert "fixé à la création" in emails["prospect_id"]["read_only_reason"]
    assert {name for name, column in emails.items() if column["required_on_insert"]} == {
        "prospect_id",
        "address",
        "origin_type",
    }
    assert table_of(client, "emails")["bulk_delete"] is True
    audit_log = table_of(client, "audit_log")
    assert audit_log["update_refused"] == audit_log["insert_refused"] == audit_log["delete_refused"]
    assert audit_log["version_column"] is None


def test_a_taxonomy_slug_is_given_once_and_labels_stay_editable(client: TestClient) -> None:
    roles = columns_of(client, "roles")

    assert (roles["slug"]["updatable"], roles["slug"]["insertable"]) == (False, True)
    assert (roles["label"]["updatable"], roles["label"]["required_on_insert"]) == (True, True)
    assert roles["active"]["required_on_insert"] is False


def test_every_constraint_of_a_writable_table_has_a_french_message() -> None:
    for name in EXPOSED_TABLES:
        if not writable(name):
            continue
        table = Base.metadata.tables[name]
        enum_checks = {
            f"ck_{name}_{column.name}"
            for column in table.columns
            if isinstance(column.type, sa.Enum)
        }
        named = [
            constraint.name
            for constraint in table.constraints
            if isinstance(constraint, sa.UniqueConstraint | sa.CheckConstraint)
        ] + [index.name for index in table.indexes if index.unique]
        if name in LINK_TABLES:
            named.append(table.primary_key.name)
        for constraint in named:
            if constraint not in enum_checks:
                assert constraint in CONSTRAINT_MESSAGES, (name, constraint)


# --- delete diagnostics ----------------------------------------------------------------------


def check(client: TestClient, table: str, *keys: uuid.UUID) -> dict[str, Any]:
    params: list[tuple[str, str | int | float | bool | None]] = [
        ("key", json.dumps({"id": str(key)})) for key in keys
    ]
    response = client.get(f"{API}/{table}/delete-check", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def effects(body: dict[str, Any]) -> set[tuple[Any, ...]]:
    return {
        (effect["table"], effect["column"], effect["action"], effect["count"], effect["depth"])
        for effect in body["effects"]
    }


def test_deleting_a_prospect_lists_every_cascade(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_email(db_session, prospect, "a.test@example.com")
    add_email(db_session, prospect, "b.test@example.com")
    add_phone(db_session, prospect, "+33100000001")
    save_contact_tracking(
        db_session,
        FIXTURE_ACTOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.TO_CONTACT),
    )

    body = check(client, "prospects", prospect.id)

    assert (body["rows"], body["allowed"], body["blockers"]) == (1, True, [])
    assert effects(body) == {
        ("contact_tracking", "prospect_id", "cascade", 1, 1),
        ("contact_tracking_status_history", "contact_tracking_id", "cascade", 1, 2),
        ("emails", "prospect_id", "cascade", 2, 1),
        ("phones", "prospect_id", "cascade", 1, 1),
    }


def test_deleting_a_company_shows_what_blocks_and_what_follows(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company)

    body = check(client, "companies", company.id)

    assert body["allowed"] is False
    assert body["blockers"] == ["1 ligne(s) de prospects y font référence : suppression bloquée."]
    assert ("prospects", "company_id", "restrict", 1, 1) in effects(body)


def test_a_referenced_taxonomy_value_suggests_deactivation(
    client: TestClient, db_session: Session
) -> None:
    role = add_role(db_session)
    add_prospect(db_session, role_id=role.id)

    [blocker] = check(client, "roles", role.id)["blockers"]

    assert "Désactivez plutôt la ligne (active = false)." in blocker


def test_a_do_not_contact_prospect_is_a_domain_blocker(
    client: TestClient, db_session: Session
) -> None:
    blocked = add_prospect(
        db_session,
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime.now(UTC),
    )

    body = check(client, "prospects", blocked.id)

    assert body["allowed"] is False
    assert body["blockers"][0].startswith("Ce prospect est en opposition")


def test_several_rows_are_deleted_at_once_only_where_nothing_cascades(
    client: TestClient, db_session: Session
) -> None:
    prospects = [add_prospect(db_session, first_name=name) for name in ("Jean", "Marie")]
    roles = [add_role(db_session, f"role-{n}", f"Rôle {n}") for n in (1, 2)]

    grouped = check(client, "prospects", *(prospect.id for prospect in prospects))
    taxonomy = check(client, "roles", *(role.id for role in roles))

    assert grouped["allowed"] is False
    assert "Suppression groupée impossible" in grouped["blockers"][0]
    assert (taxonomy["rows"], taxonomy["allowed"], taxonomy["effects"]) == (2, True, [])


def test_missing_rows_and_refused_tables_are_reported(
    client: TestClient, db_session: Session
) -> None:
    missing = check(client, "roles", uuid.uuid4())
    audit_log = client.get(
        f"{API}/audit_log/delete-check", params={"key": json.dumps({"id": str(uuid.uuid4())})}
    ).json()

    assert (missing["rows"], missing["allowed"]) == (0, False)
    assert "n’existent plus" in missing["blockers"][0]
    assert audit_log["blockers"][0] == EXPOSED_TABLES["audit_log"].writes.delete


def test_delete_check_validates_keys_and_needs_a_session(
    client: TestClient, anonymous_client: TestClient
) -> None:
    url = f"{API}/roles/delete-check"

    assert client.get(url).status_code == 422
    assert client.get(url, params={"key": '{"id": "nope"}'}).status_code == 422
    assert client.get(f"{API}/users/delete-check", params={"key": "{}"}).status_code == 404
    assert anonymous_client.get(url, params={"key": "{}"}).status_code == 401


def test_the_diagnostics_delete_nothing(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session)
    add_email(db_session, prospect, "a.test@example.com")

    assert check(client, "prospects", prospect.id)["allowed"] is True

    db_session.expire_all()
    assert db_session.get(Prospect, prospect.id) is not None
    assert len(db_session.get_one(Prospect, prospect.id).emails) == 1
