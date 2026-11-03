"""Organisations and roles: `organizations`, the members' role and platform admin, CIRCOE owner.

Creates CIRCOE (fixed id, e-mail domain `circoe.com`) and gives it every existing record: the root
business tables get an `organization_id` defaulting to CIRCOE. Accounts get their organisation, a
role (admin, manager, member), the single platform-admin flag, an active flag, the Infomaniak
`sub` they sign in with, and an optional password (Infomaniak-only accounts have none). The
existing accounts become CIRCOE admins; `e.debazelaire@circoe.com` is the platform admin.

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CIRCOE_ID = "01a00000-0000-7000-8000-00000000c1c0"
PLATFORM_ADMIN = "e.debazelaire@circoe.com"
OWNED_TABLES = (
    "appointments",
    "agent_threads",
    "cohorts",
    "contact_sequences",
    "companies",
    "import_batches",
    "internal_referents",
    "mcp_tokens",
    "missions",
    "prospects",
)


def _owner_column() -> sa.Column[sa.Uuid]:
    return sa.Column(
        "organization_id",
        sa.Uuid(),
        server_default=sa.text(f"'{CIRCOE_ID}'::uuid"),
        nullable=False,
    )


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email_domain", sa.String(255), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "btrim(name) <> '' AND char_length(name) <= 120",
            name=op.f("ck_organizations_name_valid"),
        ),
        sa.CheckConstraint(
            "email_domain IS NULL OR email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'",
            name=op.f("ck_organizations_email_domain_format"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_organizations")),
        sa.UniqueConstraint("name", name=op.f("uq_organizations_name")),
        sa.UniqueConstraint("email_domain", name=op.f("uq_organizations_email_domain")),
    )
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )
    op.execute(
        "INSERT INTO organizations (id, name, email_domain) "
        f"VALUES ('{CIRCOE_ID}', 'CIRCOE', 'circoe.com')"
    )

    for table in OWNED_TABLES:
        op.add_column(table, _owner_column())
        op.create_index(op.f(f"ix_{table}_organization_id"), table, ["organization_id"])
        op.create_foreign_key(
            op.f(f"fk_{table}_organization_id_organizations"),
            table,
            "organizations",
            ["organization_id"],
            ["id"],
            ondelete="RESTRICT",
        )

    op.add_column("users", _owner_column())
    op.add_column(
        "users",
        sa.Column("role", sa.String(32), server_default="member", nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("is_superadmin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column("users", sa.Column("infomaniak_sub", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.alter_column("users", "password_hash", existing_type=sa.String(255), nullable=True)
    op.create_check_constraint(
        op.f("ck_users_role"), "users", "role IN ('admin', 'manager', 'member')"
    )
    op.create_index(op.f("ix_users_organization_id"), "users", ["organization_id"])
    op.create_foreign_key(
        op.f("fk_users_organization_id_organizations"),
        "users",
        "organizations",
        ["organization_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(op.f("uq_users_infomaniak_sub"), "users", ["infomaniak_sub"])
    op.create_index(
        "uq_users_single_superadmin",
        "users",
        ["is_superadmin"],
        unique=True,
        postgresql_where=sa.text("is_superadmin"),
    )
    # The accounts made so far are CIRCOE's own: admins of it; one of them runs the platform.
    op.execute("UPDATE users SET role = 'admin'")
    op.execute(f"UPDATE users SET is_superadmin = true WHERE email = '{PLATFORM_ADMIN}'")


def downgrade() -> None:
    op.drop_index("uq_users_single_superadmin", table_name="users")
    op.drop_constraint(op.f("uq_users_infomaniak_sub"), "users", type_="unique")
    op.drop_constraint(op.f("fk_users_organization_id_organizations"), "users", type_="foreignkey")
    op.drop_index(op.f("ix_users_organization_id"), table_name="users")
    op.drop_constraint(op.f("ck_users_role"), "users", type_="check")
    op.execute("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL")
    op.alter_column("users", "password_hash", existing_type=sa.String(255), nullable=False)
    for column in (
        "last_login_at",
        "infomaniak_sub",
        "is_active",
        "is_superadmin",
        "role",
        "organization_id",
    ):
        op.drop_column("users", column)
    for table in OWNED_TABLES:
        op.drop_constraint(
            op.f(f"fk_{table}_organization_id_organizations"), table, type_="foreignkey"
        )
        op.drop_index(op.f(f"ix_{table}_organization_id"), table_name=table)
        op.drop_column(table, "organization_id")
    op.drop_table("organizations")
