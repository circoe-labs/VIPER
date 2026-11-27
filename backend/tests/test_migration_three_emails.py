"""Migration 0062: three e-mails per sequence. The unsent messages beyond R2 are cancelled with
their reason (remote draft queued for deletion, a send moment kept in the trace), the sends and a
claimed message are left alone, and « max relances » above 2 is lowered."""

from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.services import contact_send_state
from tests.support import alembic_config, reset_database
from tests.test_migration_remote_draft_cleanups import in_a_sequence


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def _message(
    connection: Connection, prospect: object, sequence: object, rank: int, status: str
) -> object:
    columns = ["prospect_id", "sequence_id", "rank", "status"]
    values = [":p", ":s", ":rank", ":status"]
    extra: dict[str, str] = {}
    if status in ("validated", "scheduled", "claimed"):
        extra = {
            "validated_revision": "1",
            "validated_at": "now()",
            "validated_by_actor_id": "'test'",
            "remote_provider": "'circoe_toolbox'",
            "remote_draft_id": f"'draft-{rank}'",
        }
    if status in ("scheduled", "claimed"):
        extra["scheduled_at"] = "'2026-12-01T08:00:00+00:00'"
    if status == "claimed":
        extra |= {"dispatch_claim_id": "gen_random_uuid()", "dispatch_claimed_at": "now()"}
        status = "scheduled"
    if status == "sent":
        extra = {"sent_at": "now()", "sent_source": "'manual'"}
    return connection.execute(
        text(
            f"INSERT INTO contact_messages ({', '.join([*columns, *extra])}) "
            f"VALUES ({', '.join([*values, *extra.values()])}) RETURNING id"
        ),
        {"p": prospect, "s": sequence, "rank": rank, "status": status},
    ).scalar_one()


def test_0062_cancels_the_unsent_steps_beyond_r2(engine: Engine, migration_database: str) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0061")
    ids: dict[str, object] = {}
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO app_settings (key, value) VALUES ('contact.max_follow_ups', '4')")
        )
        for name, ranks in (
            ("Alpha", {"r2": (2, "scheduled"), "r3": (3, "scheduled"), "r4": (4, "draft")}),
            ("Bravo", {"old_send": (3, "sent"), "validated": (4, "validated")}),
            ("Charlie", {"claimed": (3, "claimed")}),
        ):
            prospect = connection.execute(
                text("INSERT INTO prospects (last_name) VALUES (:n) RETURNING id"), {"n": name}
            ).scalar_one()
            sequence = in_a_sequence(connection, prospect)
            ids[f"{name}.prospect"] = prospect
            for key, (rank, status) in ranks.items():
                # One remote draft per message.
                ids[key] = _message(connection, prospect, sequence, rank, status)
                connection.execute(
                    text(
                        "UPDATE contact_messages SET remote_draft_id = :d "
                        "WHERE id = :i AND remote_draft_id IS NOT NULL"
                    ),
                    {"d": f"draft-{key}", "i": ids[key]},
                )

    command.upgrade(config, "head")

    with engine.connect() as connection:
        rows = {
            row.id: row for row in connection.execute(text("SELECT * FROM contact_messages")).all()
        }
        queued = {
            row.remote_draft_id: row.reason
            for row in connection.execute(
                text("SELECT * FROM contact_message_remote_draft_cleanups")
            )
        }
        audited = connection.execute(
            text(
                "SELECT entity_id FROM audit_log WHERE actor_id = '0062_three_emails' "
                "AND action = 'contact_message.cancelled'"
            )
        ).all()
        setting = connection.execute(
            text("SELECT value FROM app_settings WHERE key = 'contact.max_follow_ups'")
        ).scalar_one()
    assert setting == 2
    for key in ("r3", "r4", "validated"):
        row = rows[ids[key]]
        assert (row.status, row.cancel_reason, row.remote_draft_id) == (
            "cancelled",
            "sequence_limit",
            None,
        ), key
    assert rows[ids["r3"]].missed_reason == "sequence_limit"
    assert rows[ids["r3"]].missed_scheduled_at == rows[ids["r3"]].scheduled_at
    assert rows[ids["r4"]].missed_reason is None
    assert (rows[ids["r2"]].status, rows[ids["r2"]].remote_draft_id) == ("scheduled", "draft-r2")
    assert rows[ids["old_send"]].status == "sent"
    assert rows[ids["claimed"]].status == "scheduled"
    assert queued == {"draft-r3": "cancelled", "draft-validated": "cancelled"}
    assert {row.entity_id for row in audited} == {ids["r3"], ids["r4"], ids["validated"]}
    # The lists say it: a cancelled scheduled R3 is « annulé » with its reason.
    with Session(engine) as session:
        sent_state = contact_send_state.send_situations(session, [ids["Bravo.prospect"]])
        assert sent_state == {}
        situation = contact_send_state.send_situations(session, [ids["Alpha.prospect"]])
    assert situation[ids["Alpha.prospect"]].state == "scheduled"  # the R2 comes first
