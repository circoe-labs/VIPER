"""Contact states (Contact port, Slice S1): the 10-stage taxonomy becomes the 8 Contact states.

`contact_tracking.status` now allows `neutral, contacted, r1, r2, response_received,
appointment_obtained, failure, ignored` (default `neutral`). Existing rows are converted with the
mapping of the Contact handoff (`docs/06-data-model.md` §2, decision P2):

    to_contact -> neutral           follow_up_1 -> r1          follow_up_2 -> r2
    quote_sent / quote_follow_up / won -> appointment_obtained (post-appointment is out of scope)
    not_interested -> ignored when the prospect is do_not_contact, else failure
    contacted / response_received / appointment_obtained: unchanged

History is never rewritten. Old `contact_tracking_status_history` rows keep their legacy codes, so
the history CHECKs accept the legacy codes as well as the new ones (read-only compatibility,
`TrackingHistoryStatus`): mapping old rows instead would erase what really happened (a quote sent
is not an appointment) and blur the monthly progress read from history. Each converted row gets
one appended history row `legacy -> new` by the actor `system` / `0008_contact_states`. An
`ignored` row gets no next action (the state is terminal): its `planned_contact_at` is cleared.

Audit: the ORM flush hook is application code and does not run in migrations, so this revision
writes the audit events itself, one `contact_tracking.status_changed` per converted row (codes
only, no personal data; source `cli`, the same system actor). `ignored` implies do_not_contact;
the mapping only produces `ignored` for prospects that already are, which the upgrade asserts
(nothing to reinforce). Counts before/after are logged (codes and numbers only).

Downgrade is best effort: the appended `system` rows are deleted, states are mapped back
(neutral -> to_contact, r1 -> follow_up_1, r2 -> follow_up_2, failure/ignored -> not_interested),
newer history rows are mapped the same way (a row that would then no longer change status is
deleted), and the legacy CHECKs return. Not restored: the distinction between an appointment and
a quote/win (all stay `appointment_obtained`), cleared next actions of `ignored` rows, and the
audit events (append-only by design).

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-30
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

# Frozen literals: migrations never import application code (ADR-0002).
MIGRATION_ACTOR_ID = "0008_contact_states"
MIGRATION_ACTOR_DISPLAY = "Migration 0008 (états Contact)"
CONTACT_STATES = (
    "neutral",
    "contacted",
    "r1",
    "r2",
    "response_received",
    "appointment_obtained",
    "failure",
    "ignored",
)
LEGACY_STATUSES = (
    "to_contact",
    "contacted",
    "follow_up_1",
    "follow_up_2",
    "response_received",
    "appointment_obtained",
    "quote_sent",
    "quote_follow_up",
    "won",
    "not_interested",
)
HISTORY_STATUSES = (*CONTACT_STATES, *(s for s in LEGACY_STATUSES if s not in CONTACT_STATES))
# Legacy codes that change; `not_interested` depends on the durable opposition.
CONVERSIONS = {
    "to_contact": "neutral",
    "follow_up_1": "r1",
    "follow_up_2": "r2",
    "quote_sent": "appointment_obtained",
    "quote_follow_up": "appointment_obtained",
    "won": "appointment_obtained",
}
REVERSIONS = {
    "neutral": "to_contact",
    "r1": "follow_up_1",
    "r2": "follow_up_2",
    "failure": "not_interested",
    "ignored": "not_interested",
}

TRACKING = "contact_tracking"
HISTORY = "contact_tracking_status_history"


def _in(values: Sequence[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _case(column: str, mapping: dict[str, str]) -> str:
    whens = " ".join(f"WHEN '{old}' THEN '{new}'" for old, new in mapping.items())
    return f"CASE {column} {whens} ELSE {column} END"


def _set_checks(tracking_values: Sequence[str], history_values: Sequence[str]) -> None:
    for table, column, values in (
        (TRACKING, "status", tracking_values),
        (HISTORY, "from_status", history_values),
        (HISTORY, "to_status", history_values),
    ):
        name = op.f(f"ck_{table}_{column}")
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"{column} IN ({_in(values)})")


def _status_counts() -> dict[str, int]:
    rows = op.get_bind().execute(
        sa.text(f"SELECT status, count(*) FROM {TRACKING} GROUP BY status ORDER BY status")
    )
    return {status: count for status, count in rows}


def upgrade() -> None:
    before = _status_counts()
    # Widen first (old + new codes everywhere), convert, then narrow the current status.
    _set_checks(HISTORY_STATUSES, HISTORY_STATUSES)
    new_status = (
        f"CASE WHEN ct.status = 'not_interested' THEN "
        f"CASE WHEN p.contactability_status = 'do_not_contact' THEN 'ignored' ELSE 'failure' END "
        f"ELSE {_case('ct.status', CONVERSIONS)} END"
    )
    converted = (
        op.get_bind()
        .execute(
            sa.text(
                f"""
            WITH converted AS (
                SELECT ct.id, ct.prospect_id, ct.status AS old_status,
                       ct.planned_contact_at, {new_status} AS new_status
                FROM {TRACKING} ct JOIN prospects p ON p.id = ct.prospect_id
                WHERE ct.status IN ({_in([*CONVERSIONS, "not_interested"])})
            ), updated AS (
                UPDATE {TRACKING} t
                SET status = c.new_status,
                    planned_contact_at = CASE WHEN c.new_status = 'ignored' THEN NULL
                                              ELSE t.planned_contact_at END
                FROM converted c WHERE t.id = c.id
                RETURNING t.id
            ), history AS (
                INSERT INTO {HISTORY}
                    (contact_tracking_id, from_status, to_status, actor_type, actor_id,
                     actor_display)
                SELECT id, old_status, new_status, 'system', CAST(:actor_id AS text),
                       CAST(:actor_display AS text)
                FROM converted
                RETURNING id
            ), audit AS (
                INSERT INTO audit_log
                    (actor_type, actor_id, actor_display, entity_type, entity_id, subject_type,
                     subject_id, action, changes, context)
                SELECT 'system', CAST(:actor_id AS text), CAST(:actor_display AS text),
                       'contact_tracking', id, 'prospect', prospect_id,
                       'contact_tracking.status_changed',
                       jsonb_build_object('status', jsonb_build_object(
                           'before', old_status, 'after', new_status))
                       || CASE WHEN new_status = 'ignored' AND planned_contact_at IS NOT NULL
                          THEN jsonb_build_object('planned_contact_at', jsonb_build_object(
                              'before', to_jsonb(planned_contact_at), 'after', NULL))
                          ELSE '{{}}'::jsonb END,
                       jsonb_build_object('source', 'cli', 'reason', CAST(:reason AS text))
                FROM converted
                RETURNING id
            )
            SELECT (SELECT count(*) FROM updated), (SELECT count(*) FROM history),
                   (SELECT count(*) FROM audit)
            """
            ),
            {
                "actor_id": MIGRATION_ACTOR_ID,
                "actor_display": MIGRATION_ACTOR_DISPLAY,
                "reason": "Migration vers les états Contact (0008)",
            },
        )
        .one()
    )
    if len(set(converted)) != 1:
        raise RuntimeError(f"0008: inconsistent conversion counts {tuple(converted)}")
    unprotected = (
        op.get_bind()
        .execute(
            sa.text(
                f"SELECT count(*) FROM {TRACKING} ct JOIN prospects p ON p.id = ct.prospect_id "
                "WHERE ct.status = 'ignored' AND p.contactability_status <> 'do_not_contact'"
            )
        )
        .scalar_one()
    )
    if unprotected:
        raise RuntimeError(f"0008: {unprotected} ignored tracking(s) without do_not_contact")
    _set_checks(CONTACT_STATES, HISTORY_STATUSES)
    op.alter_column(TRACKING, "status", server_default=sa.text("'neutral'"))
    log.info(
        "0008 contact states: %d tracking row(s) converted; before %s; after %s",
        converted[0],
        before,
        _status_counts(),
    )


def downgrade() -> None:
    _set_checks(HISTORY_STATUSES, HISTORY_STATUSES)
    bind = op.get_bind()
    bind.execute(
        sa.text(f"DELETE FROM {HISTORY} WHERE actor_type = 'system' AND actor_id = :actor_id"),
        {"actor_id": MIGRATION_ACTOR_ID},
    )
    # A mapped row that would no longer change status (e.g. failure -> ignored) is deleted first.
    bind.execute(
        sa.text(
            f"DELETE FROM {HISTORY} WHERE {_case('from_status', REVERSIONS)} "
            f"IS NOT DISTINCT FROM {_case('to_status', REVERSIONS)}"
        )
    )
    bind.execute(
        sa.text(
            f"UPDATE {HISTORY} SET from_status = {_case('from_status', REVERSIONS)}, "
            f"to_status = {_case('to_status', REVERSIONS)} "
            f"WHERE from_status IN ({_in(list(REVERSIONS))}) "
            f"OR to_status IN ({_in(list(REVERSIONS))})"
        )
    )
    bind.execute(
        sa.text(
            f"UPDATE {TRACKING} SET status = {_case('status', REVERSIONS)} "
            f"WHERE status IN ({_in(list(REVERSIONS))})"
        )
    )
    op.alter_column(TRACKING, "status", server_default=sa.text("'to_contact'"))
    _set_checks(LEGACY_STATUSES, LEGACY_STATUSES)
