"""Source library (root / sub-source), category default sources, evidence citations, contribution
ledger and internal context references.

`mission_sources` evolves in place (task `viper_mission_agent_configuration_v2`, Slice 02): it gains
`parent_id`, `description`, `domain`, `path_prefix` and `successful_uses`. Rows keep their id, so
every `mission_source_links` row survives. Existing rows of a domain that holds several of them are
filed under a root of that domain (an existing row with an empty path, else a new
`https://<domain>` root labelled with the domain); a domain with a single row stays top-level.
Every mission that already has links gets `sources` in `overridden_fields`: its own list keeps
winning over category defaults, exactly like the `prompt` backfill of 0047.

New tables: `mission_category_sources` (category defaults), `mission_evidence_citations` (concrete
cited URLs), `mission_source_contributions` (idempotent effectiveness ledger) and
`mission_context_refs` (read-only internal records, distinct from `mission_targets`).

Downgrade drops the new tables and columns, removes `sources` from `overridden_fields` and deletes
the roots this migration created (they carry no links).

Revision ID: 0050
Revises: 0049
"""

from typing import Any
from urllib.parse import urlsplit

import sqlalchemy as sa
from alembic import op

revision = "0050"
down_revision = "0049"
branch_labels = None
depends_on = None

MIGRATION_ACTOR = "VIPER — migration 0050"


def _timestamps() -> list[sa.Column[Any]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def _trigger(table: str) -> None:
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def _split(url: str) -> tuple[str, str]:
    """`(domain, path_prefix)` of a saved URL: the same rule as `mission_sources.split_url`."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    domain = host[4:] if host.startswith("www.") else host
    return domain[:255], parts.path.rstrip("/")[:500]


def _link_table(table: str, owner: str, owner_table: str, *, position: bool) -> None:
    columns: list[Any] = [
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(owner, sa.Uuid(), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
    ]
    if position:
        columns.append(sa.Column("position", sa.SmallInteger(), server_default="0", nullable=False))
    op.create_table(
        table,
        *columns,
        *_timestamps(),
        sa.ForeignKeyConstraint(
            [owner],
            [f"{owner_table}.id"],
            name=op.f(f"fk_{table}_{owner}_{owner_table}"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["mission_sources.id"],
            name=op.f(f"fk_{table}_source_id_mission_sources"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    )
    op.create_index(op.f(f"ix_{table}_{owner}"), table, [owner])
    op.create_index(op.f(f"ix_{table}_source_id"), table, ["source_id"])
    _trigger(table)


def upgrade() -> None:
    op.add_column("mission_sources", sa.Column("description", sa.String(1000), nullable=True))
    op.add_column("mission_sources", sa.Column("parent_id", sa.Uuid(), nullable=True))
    op.add_column("mission_sources", sa.Column("domain", sa.String(255), nullable=True))
    op.add_column(
        "mission_sources",
        sa.Column("path_prefix", sa.String(500), server_default="", nullable=False),
    )
    op.add_column(
        "mission_sources",
        sa.Column("successful_uses", sa.Integer(), server_default="0", nullable=False),
    )

    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, organization_id, url, created_at FROM mission_sources ORDER BY created_at"
        )
    ).all()
    groups: dict[tuple[Any, str], list[tuple[Any, str]]] = {}
    for source_id, organization_id, url, _created_at in rows:
        domain, path_prefix = _split(url)
        connection.execute(
            sa.text(
                "UPDATE mission_sources SET domain = :domain, path_prefix = :path WHERE id = :id"
            ),
            {"domain": domain, "path": path_prefix, "id": source_id},
        )
        groups.setdefault((organization_id, domain), []).append((source_id, path_prefix))

    # A domain with several saved URLs gets a root; a lone URL stays as it is (no library spam,
    # no invented entry).
    for (organization_id, domain), members in groups.items():
        if len(members) < 2:
            continue
        root_id = next((source_id for source_id, path in members if path == ""), None)
        if root_id is None:
            root_id = connection.execute(
                sa.text(
                    "INSERT INTO mission_sources "
                    "(organization_id, url, label, domain, path_prefix, created_by_display) "
                    "VALUES (:org, :url, :label, :domain, '', :actor) RETURNING id"
                ),
                {
                    "org": organization_id,
                    "url": f"https://{domain}",
                    "label": domain,
                    "domain": domain,
                    "actor": MIGRATION_ACTOR,
                },
            ).scalar_one()
        for source_id, _path in members:
            if source_id != root_id:
                connection.execute(
                    sa.text("UPDATE mission_sources SET parent_id = :root WHERE id = :id"),
                    {"root": root_id, "id": source_id},
                )

    op.alter_column("mission_sources", "domain", nullable=False)
    op.create_index(op.f("ix_mission_sources_parent_id"), "mission_sources", ["parent_id"])
    op.create_index("ix_mission_sources_domain", "mission_sources", ["organization_id", "domain"])
    op.create_foreign_key(
        op.f("fk_mission_sources_parent_id_mission_sources"),
        "mission_sources",
        "mission_sources",
        ["parent_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        op.f("ck_mission_sources_not_own_parent"),
        "mission_sources",
        "parent_id IS NULL OR parent_id <> id",
    )
    op.create_check_constraint(
        op.f("ck_mission_sources_uses_positive"), "mission_sources", "successful_uses >= 0"
    )

    # A mission that already has links keeps them as its own list.
    connection.execute(
        sa.text(
            "UPDATE missions SET overridden_fields = overridden_fields || '[\"sources\"]'::jsonb "
            "WHERE EXISTS (SELECT 1 FROM mission_source_links l WHERE l.mission_id = missions.id) "
            "AND NOT (overridden_fields @> '[\"sources\"]'::jsonb)"
        )
    )

    _link_table("mission_category_sources", "category_id", "mission_categories", position=True)
    op.create_index(
        "uq_mission_category_sources_pair",
        "mission_category_sources",
        ["category_id", "source_id"],
        unique=True,
    )

    op.create_table(
        "mission_evidence_citations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("result_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.String(200), nullable=False),
        sa.Column("field", sa.String(100), nullable=True),
        sa.Column("url", sa.String(2000), nullable=False),
        sa.Column("quote", sa.String(1000), nullable=True),
        sa.Column("confidence", sa.SmallInteger(), nullable=True),
        sa.Column("source_published_at", sa.Date(), nullable=True),
        sa.Column("source_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_id", sa.Uuid(), nullable=True),
        sa.Column("mission_id", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(url) <> '' AND char_length(url) <= 2000",
            name=op.f("ck_mission_evidence_citations_url_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["result_id"],
            ["agent_task_results.id"],
            name=op.f("fk_mission_evidence_citations_result_id_agent_task_results"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["mission_sources.id"],
            name=op.f("fk_mission_evidence_citations_source_id_mission_sources"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"],
            ["missions.id"],
            name=op.f("fk_mission_evidence_citations_mission_id_missions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_evidence_citations")),
    )
    for column in ("result_id", "source_id", "mission_id"):
        op.create_index(
            op.f(f"ix_mission_evidence_citations_{column}"), "mission_evidence_citations", [column]
        )
    op.create_index(
        "uq_mission_evidence_citations_item_url",
        "mission_evidence_citations",
        ["result_id", "item_key", "url"],
        unique=True,
    )
    _trigger("mission_evidence_citations")

    op.create_table(
        "mission_source_contributions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("result_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.String(200), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["mission_sources.id"],
            name=op.f("fk_mission_source_contributions_source_id_mission_sources"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["result_id"],
            ["agent_task_results.id"],
            name=op.f("fk_mission_source_contributions_result_id_agent_task_results"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"],
            ["missions.id"],
            name=op.f("fk_mission_source_contributions_mission_id_missions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_source_contributions")),
    )
    for column in ("source_id", "result_id", "mission_id"):
        op.create_index(
            op.f(f"ix_mission_source_contributions_{column}"),
            "mission_source_contributions",
            [column],
        )
    op.create_index(
        "uq_mission_source_contributions_event",
        "mission_source_contributions",
        ["source_id", "result_id", "item_key"],
        unique=True,
    )
    _trigger("mission_source_contributions")

    op.create_table(
        "mission_context_refs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "num_nonnulls(company_id, prospect_id) = 1",
            name=op.f("ck_mission_context_refs_exactly_one_record"),
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"],
            ["missions.id"],
            name=op.f("fk_mission_context_refs_mission_id_missions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f("fk_mission_context_refs_company_id_companies"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            name=op.f("fk_mission_context_refs_prospect_id_prospects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_context_refs")),
    )
    for column in ("mission_id", "company_id", "prospect_id"):
        op.create_index(op.f(f"ix_mission_context_refs_{column}"), "mission_context_refs", [column])
    op.create_index(
        "uq_mission_context_refs_company",
        "mission_context_refs",
        ["mission_id", "company_id"],
        unique=True,
        postgresql_where=sa.text("company_id IS NOT NULL"),
    )
    op.create_index(
        "uq_mission_context_refs_prospect",
        "mission_context_refs",
        ["mission_id", "prospect_id"],
        unique=True,
        postgresql_where=sa.text("prospect_id IS NOT NULL"),
    )
    _trigger("mission_context_refs")


def downgrade() -> None:
    op.drop_table("mission_context_refs")
    op.drop_table("mission_source_contributions")
    op.drop_table("mission_evidence_citations")
    op.drop_table("mission_category_sources")
    connection = op.get_bind()
    connection.execute(
        sa.text("UPDATE missions SET overridden_fields = overridden_fields - 'sources'")
    )
    # Detach children first (the FK is RESTRICT), then drop the roots this migration created.
    connection.execute(sa.text("UPDATE mission_sources SET parent_id = NULL"))
    connection.execute(
        sa.text(
            "DELETE FROM mission_sources WHERE created_by_display = :actor AND NOT EXISTS "
            "(SELECT 1 FROM mission_source_links l WHERE l.source_id = mission_sources.id)"
        ),
        {"actor": MIGRATION_ACTOR},
    )
    op.drop_constraint(op.f("ck_mission_sources_uses_positive"), "mission_sources", type_="check")
    op.drop_constraint(op.f("ck_mission_sources_not_own_parent"), "mission_sources", type_="check")
    op.drop_constraint(
        op.f("fk_mission_sources_parent_id_mission_sources"), "mission_sources", type_="foreignkey"
    )
    op.drop_index("ix_mission_sources_domain", table_name="mission_sources")
    op.drop_index(op.f("ix_mission_sources_parent_id"), table_name="mission_sources")
    for column in ("successful_uses", "path_prefix", "domain", "parent_id", "description"):
        op.drop_column("mission_sources", column)
