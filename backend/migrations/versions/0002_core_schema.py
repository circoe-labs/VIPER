"""Core relational schema (Task 03).

Taxonomies, companies, prospects, contact channels, contact tracking, provenance, import metadata
and the append-only audit log.

Hand-written and reviewed against autogenerate. Conventions: ADR-0002. Enum value lists are frozen
here on purpose: migrations never import application code, so later enum edits need a new revision.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-10
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import SchemaItem

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTOR_TYPES = ("human", "import", "system", "agent")
VERIFICATION_STATUSES = ("unverified", "verified", "invalid", "unknown")
ORIGIN_TYPES = ("imported", "manual", "published", "inferred", "other")
CONTACT_TRACKING_STATUSES = (
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

TIMESTAMPED_TABLES = (
    "roles",
    "commercial_segments",
    "activity_categories",
    "internal_referents",
    "companies",
    "establishments",
    "prospects",
    "emails",
    "phones",
    "contact_tracking",
    "import_batches",
    "prospect_sources",
)
TAXONOMY_TABLES = ("roles", "commercial_segments", "activity_categories")


def uuid_pk() -> sa.Column[Any]:
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def pk(table: str) -> sa.PrimaryKeyConstraint:
    return sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}"))


def timestamps() -> list[sa.Column[Any]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def enum_column(name: str, *, nullable: bool = False, default: str | None = None) -> sa.Column[Any]:
    server_default = sa.text(f"'{default}'") if default else None
    return sa.Column(name, sa.String(32), server_default=server_default, nullable=nullable)


def enum_check(table: str, column: str, values: Sequence[str]) -> sa.CheckConstraint:
    allowed = ", ".join(f"'{value}'" for value in values)
    return sa.CheckConstraint(f"{column} IN ({allowed})", name=op.f(f"ck_{table}_{column}"))


def check(table: str, name: str, condition: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(condition, name=op.f(f"ck_{table}_{name}"))


def fk(
    table: str, column: str, target: str, ondelete: str, name: str | None = None
) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column],
        [f"{target}.id"],
        ondelete=ondelete,
        name=op.f(name or f"fk_{table}_{column}_{target}"),
    )


def actor_columns(table: str, *, nullable: bool) -> list[SchemaItem]:
    return [
        enum_column("actor_type", nullable=nullable),
        sa.Column("actor_id", sa.String(128), nullable=True),
        sa.Column("actor_display", sa.String(255), nullable=nullable),
        enum_check(table, "actor_type", ACTOR_TYPES),
    ]


def create_taxonomy(table: str) -> None:
    op.create_table(
        table,
        uuid_pk(),
        sa.Column("label", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        *timestamps(),
        pk(table),
        check(table, "label_not_blank", "btrim(label) <> ''"),
        check(table, "slug_format", "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"),
        sa.UniqueConstraint("slug", name=op.f(f"uq_{table}_slug")),
    )
    op.create_index(
        op.f(f"uq_{table}_lower_label"), table, [sa.literal_column("lower(label)")], unique=True
    )


def create_contact_channel(
    table: str, value: sa.Column[Any], value_format: str, *extra: SchemaItem
) -> None:
    op.create_table(
        table,
        uuid_pk(),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        value,
        *extra,
        sa.Column("is_primary", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        enum_column("verification_status", default="unverified"),
        enum_column("origin_type"),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_reference", sa.Text(), nullable=True),
        *timestamps(),
        pk(table),
        fk(table, "prospect_id", "prospects", "CASCADE"),
        check(table, f"{value.name}_format", value_format),
        check(table, "primary_is_active", "is_active OR NOT is_primary"),
        enum_check(table, "verification_status", VERIFICATION_STATUSES),
        enum_check(table, "origin_type", ORIGIN_TYPES),
    )
    op.create_index(op.f(f"ix_{table}_{value.name}"), table, [value.name])
    op.create_index(
        op.f(f"uq_{table}_prospect_id_{value.name}"),
        table,
        ["prospect_id", value.name],
        unique=True,
    )
    op.create_index(
        op.f(f"uq_{table}_prospect_id_primary"),
        table,
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text("is_primary"),
    )


def upgrade() -> None:
    for table in TAXONOMY_TABLES:
        create_taxonomy(table)

    op.create_table(
        "internal_referents",
        uuid_pk(),
        sa.Column("first_name", sa.String(100), nullable=False),
        sa.Column("last_name", sa.String(100), nullable=False),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        *timestamps(),
        pk("internal_referents"),
        check(
            "internal_referents",
            "name_not_blank",
            "btrim(first_name) <> '' AND btrim(last_name) <> ''",
        ),
        check(
            "internal_referents",
            "email_format",
            "email = lower(email) AND email ~ '^[^@\\s]+@[^@\\s]+$'",
        ),
    )

    op.create_table(
        "companies",
        uuid_pk(),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("legal_name", sa.String(255), nullable=True),
        sa.Column("siren", sa.String(9), nullable=True),
        sa.Column("website_url", sa.Text(), nullable=True),
        sa.Column("email_domain", sa.String(253), nullable=True),
        sa.Column("size_label", sa.String(100), nullable=True),
        sa.Column("commercial_segment_id", sa.Uuid(), nullable=True),
        sa.Column("project_done_with_circoe", sa.Text(), nullable=True),
        sa.Column("project_type", sa.Text(), nullable=True),
        sa.Column("circoe_references", sa.Text(), nullable=True),
        sa.Column("client_approach", sa.Text(), nullable=True),
        *timestamps(),
        pk("companies"),
        fk("companies", "commercial_segment_id", "commercial_segments", "RESTRICT"),
        check("companies", "display_name_not_blank", "btrim(display_name) <> ''"),
        check("companies", "siren_format", "siren ~ '^[0-9]{9}$'"),
        check(
            "companies",
            "email_domain_format",
            "email_domain = lower(email_domain) AND email_domain ~ '^[^@\\s]+\\.[^@\\s]+$'",
        ),
        sa.UniqueConstraint("siren", name=op.f("uq_companies_siren")),
    )
    op.create_index(
        op.f("ix_companies_commercial_segment_id"), "companies", ["commercial_segment_id"]
    )
    op.create_index(op.f("ix_companies_email_domain"), "companies", ["email_domain"])
    op.create_index(
        op.f("ix_companies_lower_display_name"),
        "companies",
        [sa.literal_column("lower(display_name)")],
    )

    op.create_table(
        "company_activity_categories",
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("activity_category_id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint(
            "company_id", "activity_category_id", name=op.f("pk_company_activity_categories")
        ),
        fk("company_activity_categories", "company_id", "companies", "CASCADE"),
        fk(
            "company_activity_categories",
            "activity_category_id",
            "activity_categories",
            "RESTRICT",
            name="fk_company_activity_categories_activity_category_id",
        ),
    )
    op.create_index(
        op.f("ix_company_activity_categories_activity_category_id"),
        "company_activity_categories",
        ["activity_category_id"],
    )

    op.create_table(
        "establishments",
        uuid_pk(),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("siret", sa.String(14), nullable=True),
        sa.Column("address_line1", sa.String(255), nullable=True),
        sa.Column("address_line2", sa.String(255), nullable=True),
        sa.Column("postal_code", sa.String(16), nullable=True),
        sa.Column("city", sa.String(255), nullable=True),
        sa.Column("country", sa.String(100), nullable=True),
        sa.Column("kind", sa.String(100), nullable=True),
        sa.Column("is_primary", sa.Boolean(), server_default=sa.false(), nullable=False),
        *timestamps(),
        pk("establishments"),
        fk("establishments", "company_id", "companies", "CASCADE"),
        check("establishments", "siret_format", "siret ~ '^[0-9]{14}$'"),
        sa.UniqueConstraint("siret", name=op.f("uq_establishments_siret")),
    )
    op.create_index(op.f("ix_establishments_company_id"), "establishments", ["company_id"])
    op.create_index(
        op.f("uq_establishments_company_id_primary"),
        "establishments",
        ["company_id"],
        unique=True,
        postgresql_where=sa.text("is_primary"),
    )

    op.create_table(
        "prospects",
        uuid_pk(),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        enum_column("civility", nullable=True),
        sa.Column("first_name", sa.String(100), nullable=True),
        sa.Column("last_name", sa.String(100), nullable=True),
        sa.Column("role_id", sa.Uuid(), nullable=True),
        sa.Column("exact_job_title", sa.String(255), nullable=True),
        enum_column("activity_status", default="unknown"),
        sa.Column("employment_verified_at", sa.DateTime(timezone=True), nullable=True),
        enum_column("contactability_status", default="contactable"),
        sa.Column("do_not_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("do_not_contact_reason", sa.Text(), nullable=True),
        *timestamps(),
        pk("prospects"),
        fk("prospects", "company_id", "companies", "RESTRICT"),
        fk("prospects", "role_id", "roles", "RESTRICT"),
        enum_check("prospects", "civility", ("mr", "ms")),
        enum_check("prospects", "activity_status", ("active", "inactive", "unknown")),
        enum_check("prospects", "contactability_status", ("contactable", "do_not_contact")),
        check(
            "prospects",
            "has_name",
            "coalesce(btrim(first_name), '') <> '' OR coalesce(btrim(last_name), '') <> ''",
        ),
        check(
            "prospects",
            "do_not_contact_consistency",
            "(contactability_status = 'contactable'"
            " AND do_not_contact_at IS NULL AND do_not_contact_reason IS NULL)"
            " OR (contactability_status = 'do_not_contact' AND do_not_contact_at IS NOT NULL)",
        ),
    )
    op.create_index(op.f("ix_prospects_company_id"), "prospects", ["company_id"])
    op.create_index(op.f("ix_prospects_role_id"), "prospects", ["role_id"])
    op.create_index(
        op.f("ix_prospects_lower_last_name_first_name"),
        "prospects",
        [sa.literal_column("lower(last_name)"), sa.literal_column("lower(first_name)")],
    )

    create_contact_channel(
        "emails",
        sa.Column("address", sa.String(320), nullable=False),
        "address = lower(address) AND address ~ '^[^@\\s]+@[^@\\s]+$'",
    )
    create_contact_channel(
        "phones",
        sa.Column("number", sa.String(21), nullable=False),
        "number ~ '^\\+?[0-9]{4,20}$'",
        enum_column("type"),
        enum_check("phones", "type", ("mobile", "landline", "other")),
    )

    op.create_table(
        "contact_tracking",
        uuid_pk(),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("planned_contact_at", sa.DateTime(timezone=True), nullable=True),
        enum_column("status", default="to_contact"),
        sa.Column("referent_id", sa.Uuid(), nullable=True),
        sa.Column("response_received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("appointment_at", sa.DateTime(timezone=True), nullable=True),
        *timestamps(),
        pk("contact_tracking"),
        fk("contact_tracking", "prospect_id", "prospects", "CASCADE"),
        fk("contact_tracking", "referent_id", "internal_referents", "RESTRICT"),
        enum_check("contact_tracking", "status", CONTACT_TRACKING_STATUSES),
        sa.UniqueConstraint("prospect_id", name=op.f("uq_contact_tracking_prospect_id")),
    )
    op.create_index(op.f("ix_contact_tracking_referent_id"), "contact_tracking", ["referent_id"])

    history = "contact_tracking_status_history"
    op.create_table(
        history,
        uuid_pk(),
        sa.Column("contact_tracking_id", sa.Uuid(), nullable=False),
        enum_column("from_status", nullable=True),
        enum_column("to_status"),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        *actor_columns(history, nullable=False),
        pk(history),
        fk(
            history,
            "contact_tracking_id",
            "contact_tracking",
            "CASCADE",
            name="fk_contact_tracking_status_history_contact_tracking_id",
        ),
        enum_check(history, "from_status", CONTACT_TRACKING_STATUSES),
        enum_check(history, "to_status", CONTACT_TRACKING_STATUSES),
        check(history, "status_changed", "from_status IS DISTINCT FROM to_status"),
    )
    op.create_index(
        op.f("ix_contact_tracking_status_history_tracking_id_changed_at"),
        history,
        ["contact_tracking_id", "changed_at"],
    )

    op.create_table(
        "import_batches",
        uuid_pk(),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column(
            "sheet_names",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("file_fingerprint", sa.String(64), nullable=True),
        enum_column("status", default="pending"),
        sa.Column("rows_total", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("rows_imported", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("rows_skipped", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        *actor_columns("import_batches", nullable=False),
        *timestamps(),
        pk("import_batches"),
        enum_check("import_batches", "status", ("pending", "committed", "failed", "cancelled")),
        check("import_batches", "file_fingerprint_sha256", "file_fingerprint ~ '^[0-9a-f]{64}$'"),
        check(
            "import_batches",
            "row_counts",
            "rows_total >= 0 AND rows_imported >= 0 AND rows_skipped >= 0",
        ),
        check(
            "import_batches",
            "committed_at_consistency",
            "(status = 'committed') = (committed_at IS NOT NULL)",
        ),
    )

    op.create_table(
        "prospect_sources",
        uuid_pk(),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        enum_column("source_type"),
        sa.Column("source_reference", sa.Text(), nullable=True),
        sa.Column("import_batch_id", sa.Uuid(), nullable=True),
        sa.Column(
            "collected_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("legal_basis_or_collection_context", sa.Text(), nullable=True),
        *actor_columns("prospect_sources", nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        *timestamps(),
        pk("prospect_sources"),
        fk("prospect_sources", "prospect_id", "prospects", "CASCADE"),
        fk("prospect_sources", "import_batch_id", "import_batches", "RESTRICT"),
        enum_check(
            "prospect_sources", "source_type", ("excel_import", "manual", "future_agent", "other")
        ),
    )
    op.create_index(op.f("ix_prospect_sources_prospect_id"), "prospect_sources", ["prospect_id"])
    op.create_index(
        op.f("ix_prospect_sources_import_batch_id"), "prospect_sources", ["import_batch_id"]
    )

    op.create_table(
        "import_row_metadata",
        uuid_pk(),
        sa.Column("import_batch_id", sa.Uuid(), nullable=False),
        sa.Column("source_sheet", sa.String(255), nullable=False),
        sa.Column("source_row_number", sa.Integer(), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column(
            "legacy_metadata",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        pk("import_row_metadata"),
        fk("import_row_metadata", "import_batch_id", "import_batches", "CASCADE"),
        fk("import_row_metadata", "prospect_id", "prospects", "CASCADE"),
        fk("import_row_metadata", "company_id", "companies", "SET NULL"),
        check("import_row_metadata", "source_row_number_positive", "source_row_number > 0"),
    )
    op.create_index(
        op.f("uq_import_row_metadata_batch_sheet_row"),
        "import_row_metadata",
        ["import_batch_id", "source_sheet", "source_row_number"],
        unique=True,
    )
    op.create_index(
        op.f("ix_import_row_metadata_prospect_id"), "import_row_metadata", ["prospect_id"]
    )
    op.create_index(
        op.f("ix_import_row_metadata_company_id"), "import_row_metadata", ["company_id"]
    )

    op.create_table(
        "audit_log",
        uuid_pk(),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        *actor_columns("audit_log", nullable=False),
        sa.Column("entity_type", sa.String(64), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column(
            "changes", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column(
            "context", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        pk("audit_log"),
    )
    op.create_index(op.f("ix_audit_log_occurred_at"), "audit_log", ["occurred_at"])
    op.create_index(
        op.f("ix_audit_log_entity_type_entity_id_occurred_at"),
        "audit_log",
        ["entity_type", "entity_id", "occurred_at"],
    )

    create_triggers()


def create_triggers() -> None:
    # updated_at is maintained by the database so every write path (ORM, Core, raw SQL) is covered.
    op.execute(
        """
        CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END $$
        """
    )
    for table in TIMESTAMPED_TABLES:
        op.execute(
            f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
        )

    # A do-not-contact prospect cannot be reactivated by a plain UPDATE (import, generic grid edit)
    # nor deleted (a re-import would recreate it as contactable). Only the dedicated service
    # operation sets the transaction-local flag that allows clearing.
    op.execute(
        """
        CREATE FUNCTION prospects_guard_do_not_contact() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.contactability_status = 'do_not_contact' THEN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'prospect % is do_not_contact and cannot be deleted', OLD.id
                        USING ERRCODE = 'restrict_violation';
                END IF;
                IF NEW.contactability_status <> 'do_not_contact' AND coalesce(
                    current_setting('viper.allow_contactability_clear', true), '') <> 'on'
                THEN
                    RAISE EXCEPTION 'prospect % is do_not_contact; use the clear operation', OLD.id
                        USING ERRCODE = 'restrict_violation';
                END IF;
            END IF;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER guard_do_not_contact BEFORE UPDATE OR DELETE ON prospects "
        "FOR EACH ROW EXECUTE FUNCTION prospects_guard_do_not_contact()"
    )

    op.execute(
        """
        CREATE FUNCTION audit_log_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'audit_log is append-only: % rejected', TG_OP
                USING ERRCODE = 'restrict_violation';
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON audit_log "
        "FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change()"
    )
    op.execute(
        "CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit_log "
        "FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change()"
    )


def downgrade() -> None:
    for table in (
        "audit_log",
        "import_row_metadata",
        "prospect_sources",
        "import_batches",
        "contact_tracking_status_history",
        "contact_tracking",
        "phones",
        "emails",
        "prospects",
        "establishments",
        "company_activity_categories",
        "companies",
        "internal_referents",
        *reversed(TAXONOMY_TABLES),
    ):
        op.drop_table(table)
    for function in ("audit_log_reject_change", "prospects_guard_do_not_contact", "set_updated_at"):
        op.execute(f"DROP FUNCTION {function}()")
