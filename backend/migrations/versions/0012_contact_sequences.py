"""Cohorts and contact sequences (sequences rework, Slice S1; decisions D1-D9).

Schema:

- `cohorts` (`S<n>` code, real start date, `S0` out of campaign without date, `needs_review`);
- `contact_sequences` (prospect, cohort, current/open/closed with an end reason; at most one
  current and one open sequence per prospect);
- `contact_messages` reshaped: `step` and `UNIQUE(prospect_id, step)` become `sequence_id` +
  `rank` (0 = Contact) with `UNIQUE(sequence_id, rank)` and a composite key to the sequence of the
  same prospect; a `sent` row records its `sent_source` (manual/import/migration/worker) and only a
  dispatcher send needs a validation; the immutability trigger of sent rows is kept;
- `contact_tracking`: `planned_contact_at` is dropped (the next due date is derived) and the
  states become `neutral, response_received, appointment_obtained, ignored, disqualified`;
- `quality_alerts` (prospect or company, type, source, open/resolved) and `app_settings` (the
  « max relances » parameter; no row = default 4).

Data (D7): every tracking that is not a plain `neutral` without planned week, and every prospect
with messages, gets one current sequence in a cohort created here from its former planning:
the Monday of the week of its first implied send when it has one, else of its planned week, else
of its first history row. The cohort code is `S<ISO week number>` of that Monday (one cohort per
code, earliest Monday, `needs_review = true`: a person confirms or fixes date and code). Implied
sends become `sent` messages of source `migration` — `contacted` = 1 (Contact), `r1` = 2,
`r2` = 3 — dated by the history row that reached each step (else the next step's, else the last
known change); an existing unsent message at such a rank becomes that send, and a message already
`sent` (only the dispatcher could) gets the source `worker`. `failure` becomes a
sequence closed `completed` (« Relance terminée »). The four former states become `neutral`.

History is never rewritten: each converted tracking gets one appended history row `old -> neutral`
by the actor `system` / `0012_contact_sequences` (the codes `contacted/r1/r2/failure` stay readable
in older rows). Audit events are written here (the ORM hook does not run in migrations): one per
cohort, sequence, migration send, and per tracking whose state or planned week changed (codes and
dates only). Counts are logged. `lock_timeout` is 10 s.

Downgrade is best effort: planned weeks come back from the cohort date (no send yet) or the week
after the last send; states from the sends (1 contacted, 2 r1, 3+ r2), a closed-completed sequence
or `disqualified` -> failure; the appended history rows are deleted and newer `disqualified` rows
map to `failure`; messages of former sequences or beyond R2 are deleted, as are content-less
sends; a send without validation keeps its text as a `cancelled` message (reason
`downgrade_0012`). Cohorts, sequences, alerts and settings are dropped; audit events stay.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-01
"""

import logging
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

# Frozen literals: migrations never import application code (ADR-0002).
ACTOR_ID = "0012_contact_sequences"
ACTOR_DISPLAY = "Migration 0012 (cohortes et séquences)"
REASON = "Migration vers les cohortes et séquences (0012)"
BUSINESS_TZ = "Europe/Paris"
STATES = ("neutral", "response_received", "appointment_obtained", "ignored", "disqualified")
OLD_STATES = (
    "neutral",
    "contacted",
    "r1",
    "r2",
    "response_received",
    "appointment_obtained",
    "failure",
    "ignored",
)
LEGACY_0008 = (
    "to_contact",
    "follow_up_1",
    "follow_up_2",
    "quote_sent",
    "quote_follow_up",
    "won",
    "not_interested",
)
HISTORY_STATES = (*STATES, "contacted", "r1", "r2", "failure", *LEGACY_0008)
OLD_HISTORY_STATES = (*OLD_STATES, *LEGACY_0008)
STEPS = ("contact", "r1", "r2")
SEND_SOURCES = ("manual", "import", "migration", "worker")
END_REASONS = ("cohort_changed", "cohort_removed", "completed")
ALERT_TYPES = (
    "email_error",
    "function_to_check",
    "data_inconsistent",
    "company_to_check",
    "import_conflict",
)
ALERT_SOURCES = ("human", "import", "ai")
ACTOR_TYPES = ("human", "import", "system", "agent")
SETTING_KEYS = ("contact.max_follow_ups",)
# Former state -> number of sends it implies.
IMPLIED_SENDS = {"contacted": 1, "r1": 2, "r2": 3}
# History codes that reached each rank (the 0008 legacy codes included).
RANK_CODES = {0: ("contacted",), 1: ("r1", "follow_up_1"), 2: ("r2", "follow_up_2")}
OLD_VALIDATION = (
    "status NOT IN ('validated', 'scheduled', 'sent') OR (validated_at IS NOT NULL "
    "AND validated_by_actor_id IS NOT NULL AND validated_revision = revision)"
)
NEW_VALIDATION = (
    "status NOT IN ('validated', 'scheduled') AND (status <> 'sent' OR sent_source <> "
    "'worker') OR (validated_at IS NOT NULL AND validated_by_actor_id IS NOT NULL "
    "AND validated_revision = revision)"
)

TRACKING = "contact_tracking"
HISTORY = "contact_tracking_status_history"
MESSAGES = "contact_messages"


def _in(values: Sequence[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _check_in(table: str, column: str, values: Sequence[str]) -> sa.CheckConstraint:
    return sa.CheckConstraint(f"{column} IN ({_in(values)})", name=op.f(f"ck_{table}_{column}"))


def _set_check(table: str, column: str, values: Sequence[str]) -> None:
    name = op.f(f"ck_{table}_{column}")
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, f"{column} IN ({_in(values)})")


def _timestamps() -> list[sa.Column[Any]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def _id() -> sa.Column[Any]:
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def _updated_at_trigger(table: str) -> None:
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def _scalar(sql: str, **params: object) -> Any:
    return op.get_bind().execute(sa.text(sql), params).scalar_one()


def _execute(sql: str, **params: object) -> int:
    return op.get_bind().execute(sa.text(sql), params).rowcount


def _create_tables() -> None:
    op.create_table(
        "app_settings",
        _id(),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(f"key IN ({_in(SETTING_KEYS)})", name=op.f("ck_app_settings_known_key")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_app_settings")),
        sa.UniqueConstraint("key", name=op.f("uq_app_settings_key")),
    )
    op.create_table(
        "cohorts",
        _id(),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("starts_on", sa.Date(), nullable=True),
        sa.Column("needs_review", sa.Boolean(), server_default=sa.false(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint("code ~ '^S(0|[1-9][0-9]{0,5})$'", name=op.f("ck_cohorts_code_format")),
        sa.CheckConstraint(
            "(code = 'S0') = (starts_on IS NULL)", name=op.f("ck_cohorts_date_unless_s0")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cohorts")),
        sa.UniqueConstraint("code", name=op.f("uq_cohorts_code")),
    )
    op.create_table(
        "contact_sequences",
        _id(),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("cohort_id", sa.Uuid(), nullable=False),
        sa.Column("is_current", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(32), nullable=True),
        *_timestamps(),
        _check_in("contact_sequences", "end_reason", END_REASONS),
        sa.CheckConstraint(
            "(closed_at IS NULL) = (end_reason IS NULL)",
            name=op.f("ck_contact_sequences_closed_has_reason"),
        ),
        sa.CheckConstraint(
            "closed_at IS NOT NULL OR is_current",
            name=op.f("ck_contact_sequences_open_is_current"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="CASCADE",
            name=op.f("fk_contact_sequences_prospect_id_prospects"),
        ),
        sa.ForeignKeyConstraint(
            ["cohort_id"],
            ["cohorts.id"],
            ondelete="RESTRICT",
            name=op.f("fk_contact_sequences_cohort_id_cohorts"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contact_sequences")),
        sa.UniqueConstraint("prospect_id", "id", name=op.f("uq_contact_sequences_prospect_id_id")),
    )
    op.create_index(op.f("ix_contact_sequences_cohort_id"), "contact_sequences", ["cohort_id"])
    op.create_index(
        "uq_contact_sequences_current",
        "contact_sequences",
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
    op.create_index(
        "uq_contact_sequences_open",
        "contact_sequences",
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text("closed_at IS NULL"),
    )
    op.create_table(
        "quality_alerts",
        _id(),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "detail",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("raised_by_type", sa.String(32), nullable=False),
        sa.Column("raised_by_id", sa.String(128), nullable=True),
        sa.Column("raised_by_display", sa.String(255), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_id", sa.String(128), nullable=True),
        sa.Column("resolved_by_display", sa.String(255), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        *_timestamps(),
        _check_in("quality_alerts", "type", ALERT_TYPES),
        _check_in("quality_alerts", "source", ALERT_SOURCES),
        _check_in("quality_alerts", "raised_by_type", ACTOR_TYPES),
        sa.CheckConstraint(
            "num_nonnulls(prospect_id, company_id) = 1", name=op.f("ck_quality_alerts_one_subject")
        ),
        sa.CheckConstraint(
            "(resolved_at IS NULL) = (resolved_by_display IS NULL)",
            name=op.f("ck_quality_alerts_resolved_has_actor"),
        ),
        sa.CheckConstraint(
            "type NOT IN ('email_error', 'function_to_check') OR prospect_id IS NOT NULL",
            name=op.f("ck_quality_alerts_prospect_types"),
        ),
        sa.CheckConstraint(
            "type <> 'company_to_check' OR company_id IS NOT NULL",
            name=op.f("ck_quality_alerts_company_types"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="CASCADE",
            name=op.f("fk_quality_alerts_prospect_id_prospects"),
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            ondelete="CASCADE",
            name=op.f("fk_quality_alerts_company_id_companies"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quality_alerts")),
    )
    op.create_index(op.f("ix_quality_alerts_prospect_id"), "quality_alerts", ["prospect_id"])
    op.create_index(op.f("ix_quality_alerts_company_id"), "quality_alerts", ["company_id"])
    op.create_index(
        "uq_quality_alerts_open_email_error",
        "quality_alerts",
        ["prospect_id", "source"],
        unique=True,
        postgresql_where=sa.text("type = 'email_error' AND resolved_at IS NULL"),
    )
    for table in ("app_settings", "cohorts", "contact_sequences", "quality_alerts"):
        _updated_at_trigger(table)


def _rank_date(rank: int) -> str:
    """The moment of the implied send of `rank`: the first history row that reached it, else the
    first that reached a later step, else the tracking's last known change."""
    candidates = [
        f"(SELECT min(h.changed_at) FROM {HISTORY} h WHERE h.contact_tracking_id = ct.id "
        f"AND h.to_status IN ({_in(RANK_CODES[later])}))"
        for later in range(rank, len(RANK_CODES))
    ]
    fallback = f"(SELECT max(h.changed_at) FROM {HISTORY} h WHERE h.contact_tracking_id = ct.id)"
    return f"COALESCE({', '.join(candidates)}, {fallback}, ct.updated_at)"


def _plan() -> None:
    """`m0012_plan`: one row per prospect getting a sequence, with its cohort and sends."""
    sends = "CASE ct.status " + " ".join(
        f"WHEN '{state}' THEN {count}" for state, count in IMPLIED_SENDS.items()
    )
    op.execute(
        f"""
        CREATE TEMPORARY TABLE m0012_plan ON COMMIT DROP AS
        WITH candidates AS (
            SELECT p.id AS prospect_id, ct.id AS tracking_id, ct.status AS old_status,
                   ct.planned_contact_at,
                   COALESCE({sends} ELSE 0 END, 0) AS sends,
                   {_rank_date(0)} AS sent_0, {_rank_date(1)} AS sent_1, {_rank_date(2)} AS sent_2,
                   COALESCE(
                       (SELECT min(h.changed_at) FROM {HISTORY} h
                        WHERE h.contact_tracking_id = ct.id),
                       ct.created_at,
                       (SELECT min(m.created_at) FROM {MESSAGES} m WHERE m.prospect_id = p.id)
                   ) AS first_known
            FROM prospects p
            LEFT JOIN {TRACKING} ct ON ct.prospect_id = p.id
            WHERE (ct.id IS NOT NULL AND (ct.status <> 'neutral'
                                          OR ct.planned_contact_at IS NOT NULL))
               OR EXISTS (SELECT 1 FROM {MESSAGES} m WHERE m.prospect_id = p.id)
        ), anchored AS (
            SELECT c.*,
                   CAST(timezone('{BUSINESS_TZ}', CASE WHEN c.sends > 0 THEN c.sent_0
                        ELSE COALESCE(c.planned_contact_at, c.first_known) END) AS date)
                       AS anchor_day
            FROM candidates c
        )
        SELECT a.*,
               CAST(date_trunc('week', a.anchor_day) AS date) AS monday,
               'S' || CAST(extract(week FROM a.anchor_day) AS integer) AS code,
               CAST(NULL AS uuid) AS sequence_id
        FROM anchored a
        """
    )


def _audit(entity_type: str, action: str, rows_sql: str) -> int:
    """Insert one audit event per row of `rows_sql` (columns: entity_id, subject_type,
    subject_id, changes)."""
    return _execute(
        f"""
        INSERT INTO audit_log (actor_type, actor_id, actor_display, entity_type, entity_id,
                               subject_type, subject_id, action, changes, context)
        SELECT 'system', CAST(:actor_id AS text), CAST(:actor_display AS text),
               CAST(:entity_type AS text), r.entity_id, r.subject_type, r.subject_id,
               CAST(:action AS text), r.changes,
               jsonb_build_object('source', 'cli', 'reason', CAST(:reason AS text))
        FROM ({rows_sql}) r
        """,
        actor_id=ACTOR_ID,
        actor_display=ACTOR_DISPLAY,
        entity_type=entity_type,
        action=action,
        reason=REASON,
    )


def _change(name: str, before: str, after: str) -> str:
    return (
        f"jsonb_build_object('{name}', jsonb_build_object('before', to_jsonb({before}), "
        f"'after', to_jsonb({after})))"
    )


def _migrate_data() -> dict[str, int]:
    counts: dict[str, int] = {}
    _plan()
    counts["s0_cohort"] = _execute("INSERT INTO cohorts (code, starts_on) VALUES ('S0', NULL)")
    counts["cohorts"] = _execute(
        """
        INSERT INTO cohorts (code, starts_on, needs_review)
        SELECT code, min(monday), true FROM m0012_plan GROUP BY code
        """
    )
    counts["codes_over_several_weeks"] = _scalar(
        "SELECT count(*) FROM (SELECT code FROM m0012_plan GROUP BY code "
        "HAVING count(DISTINCT monday) > 1) s"
    )
    counts["sequences"] = _execute(
        """
        INSERT INTO contact_sequences (prospect_id, cohort_id, is_current, closed_at, end_reason)
        SELECT p.prospect_id, c.id, true,
               CASE WHEN p.old_status = 'failure' THEN now() END,
               CASE WHEN p.old_status = 'failure' THEN 'completed' END
        FROM m0012_plan p JOIN cohorts c ON c.code = p.code
        """
    )
    _execute(
        "UPDATE m0012_plan p SET sequence_id = s.id FROM contact_sequences s "
        "WHERE s.prospect_id = p.prospect_id"
    )
    # Existing messages join their prospect's sequence at the rank of their step.
    rank = "CASE m.step " + " ".join(f"WHEN '{s}' THEN {i}" for i, s in enumerate(STEPS))
    counts["messages_attached"] = _execute(
        f"UPDATE {MESSAGES} m SET sequence_id = p.sequence_id, rank = {rank} END "
        "FROM m0012_plan p WHERE p.prospect_id = m.prospect_id"
    )
    rank_date = "CASE m.rank WHEN 0 THEN p.sent_0 WHEN 1 THEN p.sent_1 ELSE p.sent_2 END"
    # A message sent before 0012 could only be the dispatcher's (validated): source `worker`.
    counts["former_sends"] = _execute(
        f"UPDATE {MESSAGES} SET sent_source = 'worker' "
        "WHERE status = 'sent' AND sent_source IS NULL"
    )
    counts["messages_marked_sent"] = _execute(
        f"""
        UPDATE {MESSAGES} m SET status = 'sent', sent_at = {rank_date},
               sent_source = 'migration', cancelled_at = NULL, cancel_reason = NULL
        FROM m0012_plan p
        WHERE p.sequence_id = m.sequence_id AND m.rank < p.sends AND m.status <> 'sent'
        """
    )
    send_date = "CASE r.rank WHEN 0 THEN p.sent_0 WHEN 1 THEN p.sent_1 ELSE p.sent_2 END"
    # `step` is still NOT NULL here (dropped below); implied sends never go beyond R2.
    step = "CASE r.rank " + " ".join(f"WHEN {i} THEN '{s}'" for i, s in enumerate(STEPS))
    counts["sends_created"] = _execute(
        f"""
        INSERT INTO {MESSAGES} (prospect_id, sequence_id, rank, step, status, sent_at,
                                sent_source)
        SELECT p.prospect_id, p.sequence_id, r.rank, {step} END, 'sent', {send_date}, 'migration'
        FROM m0012_plan p CROSS JOIN LATERAL generate_series(0, p.sends - 1) AS r(rank)
        WHERE NOT EXISTS (
            SELECT 1 FROM {MESSAGES} m WHERE m.sequence_id = p.sequence_id AND m.rank = r.rank
        )
        """
    )
    # Audit: cohorts, sequences, migration sends, then the trackings.
    _audit(
        "cohort",
        "cohort.created",
        "SELECT c.id AS entity_id, 'cohort' AS subject_type, c.id AS subject_id, "
        "jsonb_build_object('code', jsonb_build_object('before', NULL, 'after', c.code), "
        "'starts_on', jsonb_build_object('before', NULL, 'after', c.starts_on), "
        "'needs_review', jsonb_build_object('before', NULL, 'after', c.needs_review)) AS changes "
        # S0 is a fixed reference row of the schema, not a change: no event.
        "FROM cohorts c WHERE c.code <> 'S0'",
    )
    _audit(
        "contact_sequence",
        "contact_sequence.created",
        "SELECT s.id AS entity_id, 'prospect' AS subject_type, s.prospect_id AS subject_id, "
        "jsonb_build_object('cohort_id', jsonb_build_object('before', NULL, 'after', s.cohort_id,"
        " 'after_label', c.code)) || CASE WHEN s.closed_at IS NULL THEN '{}'::jsonb ELSE "
        "jsonb_build_object('end_reason', jsonb_build_object('before', NULL, "
        "'after', s.end_reason)) END AS changes "
        "FROM contact_sequences s JOIN cohorts c ON c.id = s.cohort_id",
    )
    _audit(
        "contact_message",
        "contact_message.sent",
        f"SELECT m.id AS entity_id, 'prospect' AS subject_type, m.prospect_id AS subject_id, "
        f"jsonb_build_object('rank', jsonb_build_object('before', NULL, 'after', m.rank), "
        f"'sent_at', jsonb_build_object('before', NULL, 'after', m.sent_at), "
        f"'sent_source', jsonb_build_object('before', NULL, 'after', m.sent_source)) AS changes "
        f"FROM {MESSAGES} m WHERE m.sent_source = 'migration'",
    )
    converted = f"({_in(['contacted', 'r1', 'r2', 'failure'])})"
    to_neutral = _change("status", "ct.status", "CAST('neutral' AS text)")
    planned_dropped = _change("planned_contact_at", "ct.planned_contact_at", "NULL::timestamptz")
    counts["trackings_converted"] = _audit(
        "contact_tracking",
        "contact_tracking.status_changed",
        "SELECT ct.id AS entity_id, 'prospect' AS subject_type, ct.prospect_id AS subject_id, "
        f"{to_neutral} || CASE WHEN ct.planned_contact_at IS NULL THEN '{{}}'::jsonb "
        f"ELSE {planned_dropped} END AS changes FROM {TRACKING} ct WHERE ct.status IN {converted}",
    )
    counts["planned_weeks_dropped"] = _audit(
        "contact_tracking",
        "contact_tracking.updated",
        "SELECT ct.id AS entity_id, 'prospect' AS subject_type, ct.prospect_id AS subject_id, "
        f"{planned_dropped} AS changes FROM {TRACKING} ct WHERE ct.status NOT IN {converted} "
        "AND ct.planned_contact_at IS NOT NULL",
    )
    history = _execute(
        f"""
        INSERT INTO {HISTORY} (contact_tracking_id, from_status, to_status, actor_type, actor_id,
                               actor_display)
        SELECT id, status, 'neutral', 'system', CAST(:actor_id AS text),
               CAST(:actor_display AS text)
        FROM {TRACKING} WHERE status IN {converted}
        """,
        actor_id=ACTOR_ID,
        actor_display=ACTOR_DISPLAY,
    )
    updated = _execute(f"UPDATE {TRACKING} SET status = 'neutral' WHERE status IN {converted}")
    if not history == updated == counts["trackings_converted"]:
        raise RuntimeError(
            f"0012: inconsistent conversion counts {history}, {updated}, "
            f"{counts['trackings_converted']}"
        )
    op.execute("DROP TABLE m0012_plan")
    return counts


def _state_counts() -> dict[str, int]:
    rows = op.get_bind().execute(
        sa.text(f"SELECT status, count(*) FROM {TRACKING} GROUP BY status ORDER BY status")
    )
    return {status: count for status, count in rows}


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '10s'")
    before = _state_counts()
    _create_tables()
    _set_check(HISTORY, "from_status", HISTORY_STATES)
    _set_check(HISTORY, "to_status", HISTORY_STATES)
    _set_check(TRACKING, "status", (*OLD_STATES, "disqualified"))

    op.execute(f"ALTER TABLE {MESSAGES} DISABLE TRIGGER reject_sent_change")
    op.add_column(MESSAGES, sa.Column("sequence_id", sa.Uuid(), nullable=True))
    op.add_column(MESSAGES, sa.Column("rank", sa.Integer(), nullable=True))
    op.add_column(MESSAGES, sa.Column("sent_source", sa.String(32), nullable=True))
    op.drop_constraint(op.f("ck_contact_messages_validation_current"), MESSAGES, type_="check")

    counts = _migrate_data()

    op.drop_constraint(op.f("uq_contact_messages_prospect_id_step"), MESSAGES, type_="unique")
    op.drop_constraint(
        op.f("fk_contact_messages_prospect_id_prospects"), MESSAGES, type_="foreignkey"
    )
    op.drop_constraint(op.f("ck_contact_messages_step"), MESSAGES, type_="check")
    op.drop_column(MESSAGES, "step")
    op.alter_column(MESSAGES, "sequence_id", nullable=False)
    op.alter_column(MESSAGES, "rank", nullable=False)
    op.create_check_constraint(op.f("ck_contact_messages_rank_non_negative"), MESSAGES, "rank >= 0")
    op.create_check_constraint(
        op.f("ck_contact_messages_sent_source"), MESSAGES, f"sent_source IN ({_in(SEND_SOURCES)})"
    )
    op.create_check_constraint(
        op.f("ck_contact_messages_sent_has_source"),
        MESSAGES,
        "(status = 'sent') = (sent_source IS NOT NULL)",
    )
    op.create_check_constraint(
        op.f("ck_contact_messages_validation_current"), MESSAGES, NEW_VALIDATION
    )
    op.create_unique_constraint(
        op.f("uq_contact_messages_sequence_id_rank"), MESSAGES, ["sequence_id", "rank"]
    )
    op.create_index(
        "ix_contact_messages_prospect_id_sequence_id", MESSAGES, ["prospect_id", "sequence_id"]
    )
    op.create_foreign_key(
        "fk_contact_messages_sequence",
        MESSAGES,
        "contact_sequences",
        ["prospect_id", "sequence_id"],
        ["prospect_id", "id"],
        ondelete="CASCADE",
    )
    op.execute(f"ALTER TABLE {MESSAGES} ENABLE TRIGGER reject_sent_change")

    op.drop_column(TRACKING, "planned_contact_at")
    _set_check(TRACKING, "status", STATES)
    log.info(
        "0012 cohorts and sequences: %s; states before %s; after %s",
        counts,
        before,
        _state_counts(),
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '10s'")
    bind = op.get_bind()
    _set_check(TRACKING, "status", (*OLD_STATES, "disqualified"))
    _set_check(HISTORY, "from_status", HISTORY_STATES)
    _set_check(HISTORY, "to_status", HISTORY_STATES)

    # Planned weeks and states back from the current sequences.
    op.add_column(
        TRACKING, sa.Column("planned_contact_at", sa.DateTime(timezone=True), nullable=True)
    )
    progress = f"""
        SELECT s.prospect_id, s.closed_at, s.end_reason, c.code, c.starts_on,
               (SELECT count(*) FROM {MESSAGES} m
                WHERE m.sequence_id = s.id AND m.status = 'sent') AS sent,
               (SELECT max(m.sent_at) FROM {MESSAGES} m
                WHERE m.sequence_id = s.id AND m.status = 'sent') AS last_sent
        FROM contact_sequences s JOIN cohorts c ON c.id = s.cohort_id
        WHERE s.is_current
    """
    bind.execute(
        sa.text(
            f"""
            UPDATE {TRACKING} ct SET planned_contact_at = CASE
                WHEN g.closed_at IS NOT NULL OR g.code = 'S0' OR ct.status <> 'neutral'
                    THEN NULL
                WHEN g.sent = 0 THEN timezone('{BUSINESS_TZ}', CAST(g.starts_on AS timestamp))
                ELSE timezone('{BUSINESS_TZ}', date_trunc('week',
                    timezone('{BUSINESS_TZ}', g.last_sent)) + interval '7 days') END,
                status = CASE
                    WHEN ct.status <> 'neutral' THEN ct.status
                    WHEN g.end_reason = 'completed' THEN 'failure'
                    WHEN g.sent >= 3 THEN 'r2'
                    WHEN g.sent = 2 THEN 'r1'
                    WHEN g.sent = 1 THEN 'contacted'
                    ELSE 'neutral' END
            FROM ({progress}) g WHERE g.prospect_id = ct.prospect_id
            """
        )
    )
    bind.execute(sa.text(f"UPDATE {TRACKING} SET status = 'failure' WHERE status = 'disqualified'"))
    bind.execute(
        sa.text(f"DELETE FROM {HISTORY} WHERE actor_type = 'system' AND actor_id = :actor_id"),
        {"actor_id": ACTOR_ID},
    )
    mapped = "CASE {0} WHEN 'disqualified' THEN 'failure' ELSE {0} END"
    bind.execute(
        sa.text(
            f"DELETE FROM {HISTORY} WHERE {mapped.format('from_status')} "
            f"IS NOT DISTINCT FROM {mapped.format('to_status')}"
        )
    )
    bind.execute(
        sa.text(
            f"UPDATE {HISTORY} SET from_status = {mapped.format('from_status')}, "
            f"to_status = {mapped.format('to_status')} "
            "WHERE from_status = 'disqualified' OR to_status = 'disqualified'"
        )
    )

    # Messages back to one per prospect and step.
    op.execute(f"ALTER TABLE {MESSAGES} DISABLE TRIGGER reject_sent_change")
    bind.execute(
        sa.text(
            f"DELETE FROM {MESSAGES} m USING contact_sequences s "
            "WHERE s.id = m.sequence_id AND (NOT s.is_current OR m.rank > 2)"
        )
    )
    unvalidated_send = (
        "status = 'sent' AND NOT (validated_at IS NOT NULL AND validated_by_actor_id IS NOT NULL "
        "AND validated_revision = revision)"
    )
    bind.execute(
        sa.text(
            f"DELETE FROM {MESSAGES} WHERE {unvalidated_send} AND subject = '' AND body_text = ''"
        )
    )
    bind.execute(
        sa.text(
            f"UPDATE {MESSAGES} SET status = 'cancelled', cancelled_at = sent_at, "
            "cancel_reason = 'downgrade_0012', sent_at = NULL, sent_source = NULL, "
            "validated_revision = NULL, "
            "validated_at = NULL, validated_by_actor_id = NULL, validated_by_display = NULL, "
            "remote_provider = NULL, remote_draft_id = NULL, dispatch_claim_id = NULL, "
            f"dispatch_claimed_at = NULL WHERE {unvalidated_send}"
        )
    )
    op.drop_constraint("fk_contact_messages_sequence", MESSAGES, type_="foreignkey")
    op.drop_index("ix_contact_messages_prospect_id_sequence_id", MESSAGES)
    op.drop_constraint(op.f("uq_contact_messages_sequence_id_rank"), MESSAGES, type_="unique")
    for name in ("rank_non_negative", "sent_source", "sent_has_source", "validation_current"):
        op.drop_constraint(op.f(f"ck_contact_messages_{name}"), MESSAGES, type_="check")
    op.add_column(MESSAGES, sa.Column("step", sa.String(32), nullable=True))
    rank = "CASE rank " + " ".join(f"WHEN {i} THEN '{s}'" for i, s in enumerate(STEPS))
    bind.execute(sa.text(f"UPDATE {MESSAGES} SET step = {rank} END"))
    op.alter_column(MESSAGES, "step", nullable=False)
    op.drop_column(MESSAGES, "sent_source")
    op.drop_column(MESSAGES, "rank")
    op.drop_column(MESSAGES, "sequence_id")
    op.create_check_constraint(
        op.f("ck_contact_messages_step"), MESSAGES, f"step IN ({_in(STEPS)})"
    )
    op.create_check_constraint(
        op.f("ck_contact_messages_validation_current"), MESSAGES, OLD_VALIDATION
    )
    op.create_unique_constraint(
        op.f("uq_contact_messages_prospect_id_step"), MESSAGES, ["prospect_id", "step"]
    )
    op.create_foreign_key(
        op.f("fk_contact_messages_prospect_id_prospects"),
        MESSAGES,
        "prospects",
        ["prospect_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.execute(f"ALTER TABLE {MESSAGES} ENABLE TRIGGER reject_sent_change")

    for table in ("quality_alerts", "contact_sequences", "cohorts", "app_settings"):
        op.drop_table(table)
    _set_check(TRACKING, "status", OLD_STATES)
    _set_check(HISTORY, "from_status", OLD_HISTORY_STATES)
    _set_check(HISTORY, "to_status", OLD_HISTORY_STATES)
