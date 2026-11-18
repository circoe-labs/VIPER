"""The internal referents are the members of the organisation.

`contact_tracking.referent_id` and `appointments.referent_id` now point at `users` (SET NULL)
instead of `internal_referents`, which is dropped. Each former referent is matched to a member by
e-mail, else by name; a referent with no member becomes a deactivated member (same id, so history
keeps resolving it; its e-mail or a placeholder `prenom.nom@<domain>`), so no dossier loses its
referent. It also adds what Calendly tells about a booking (`booked_at`, `invitee_answers`).
Downgrade recreates the table from the members that were referenced.

Revision ID: 0053
Revises: 0052
"""

import re
import unicodedata
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0053"
down_revision = "0052"
branch_labels = None
depends_on = None

FKS = (
    ("contact_tracking", "fk_contact_tracking_referent_id_internal_referents", "RESTRICT"),
    ("appointments", "fk_appointments_referent_id_internal_referents", "SET NULL"),
)


def _fold(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", text).strip().lower()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", ".", _fold(value)).strip(".") or "referent"


def upgrade() -> None:
    bind = op.get_bind()
    referents = bind.execute(
        sa.text(
            "SELECT id, organization_id, first_name, last_name, email, created_at "
            "FROM internal_referents ORDER BY created_at, id"
        )
    ).all()
    users = bind.execute(
        sa.text("SELECT id, organization_id, email, display_name FROM users")
    ).all()
    taken_emails = {row.email.lower() for row in users}
    by_email = {row.email.lower(): row.id for row in users}
    by_name = {(row.organization_id, _fold(row.display_name)): row.id for row in users}
    domains = dict(bind.execute(sa.text("SELECT id, email_domain FROM organizations")).all())

    mapping: dict[uuid.UUID, uuid.UUID] = {}
    for referent in referents:
        full_name = f"{referent.first_name} {referent.last_name}"
        member = by_email.get((referent.email or "").lower()) or by_name.get(
            (referent.organization_id, _fold(full_name))
        )
        if member is None:
            email = (referent.email or "").lower()
            if not email or email in taken_emails:
                domain = domains.get(referent.organization_id) or "circoe.com"
                base = _slug(full_name)
                email, counter = f"{base}@{domain}", 1
                while email in taken_emails:
                    counter += 1
                    email = f"{base}.{counter}@{domain}"
            taken_emails.add(email)
            bind.execute(
                sa.text(
                    "INSERT INTO users (id, email, display_name, organization_id, role, "
                    "is_superadmin, is_active, created_at, updated_at) VALUES "
                    "(:id, :email, :name, :org, 'member', false, false, :created, now())"
                ),
                {
                    "id": referent.id,
                    "email": email,
                    "name": full_name,
                    "org": referent.organization_id,
                    "created": referent.created_at,
                },
            )
            member = referent.id
        mapping[referent.id] = member

    op.add_column("appointments", sa.Column("booked_at", sa.DateTime(timezone=True)))
    op.add_column(
        "appointments",
        sa.Column(
            "invitee_answers",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    for table, constraint, _ in FKS:
        op.drop_constraint(constraint, table, type_="foreignkey")
    for old, new in mapping.items():
        if old != new:
            for table, _, _ in FKS:
                bind.execute(
                    sa.text(f"UPDATE {table} SET referent_id = :new WHERE referent_id = :old"),
                    {"old": old, "new": new},
                )
    for table, _, _ in FKS:
        op.create_foreign_key(
            f"fk_{table}_referent_id_users",
            table,
            "users",
            ["referent_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.drop_table("internal_referents")


def downgrade() -> None:
    op.drop_column("appointments", "invitee_answers")
    op.drop_column("appointments", "booked_at")
    op.create_table(
        "internal_referents",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("first_name", sa.String(100), nullable=False),
        sa.Column("last_name", sa.String(100), nullable=False),
        sa.Column("email", sa.String(320)),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_internal_referents")),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name=op.f("fk_internal_referents_organization_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("email", name=op.f("uq_internal_referents_email")),
        sa.CheckConstraint(
            "btrim(first_name) <> '' AND btrim(last_name) <> ''",
            name=op.f("ck_internal_referents_name_not_blank"),
        ),
        sa.CheckConstraint(
            "email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'",
            name=op.f("ck_internal_referents_email_format"),
        ),
    )
    op.create_index(
        op.f("ix_internal_referents_organization_id"), "internal_referents", ["organization_id"]
    )
    op.create_index(
        op.f("uq_internal_referents_name_key"),
        "internal_referents",
        [sa.text("label_key(first_name)"), sa.text("label_key(last_name)")],
        unique=True,
    )
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "INSERT INTO internal_referents "
            "(id, organization_id, first_name, last_name, email, active) "
            "SELECT u.id, u.organization_id, split_part(u.display_name, ' ', 1), "
            "COALESCE(NULLIF(btrim(substr(u.display_name, strpos(u.display_name, ' ') + 1)), ''), "
            "u.display_name), u.email, u.is_active FROM users u WHERE u.id IN ("
            "SELECT referent_id FROM contact_tracking WHERE referent_id IS NOT NULL "
            "UNION SELECT referent_id FROM appointments WHERE referent_id IS NOT NULL)"
        )
    )
    for table, constraint, ondelete in FKS:
        op.drop_constraint(f"fk_{table}_referent_id_users", table, type_="foreignkey")
        op.create_foreign_key(
            constraint, table, "internal_referents", ["referent_id"], ["id"], ondelete=ondelete
        )
