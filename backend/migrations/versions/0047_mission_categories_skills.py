"""Mission categories, instruction skills and mission inheritance state.

`mission_categories` (name, description, icon, colour, general prompt, immutable technical
`mission_type`), `mission_skills` (reusable instruction text), `mission_category_skills` (default
skills of a category) and `mission_skill_links` (a mission's own skills when it overrides them).
`missions` gains `category_id` and `overridden_fields`.

Seeds the five built-in categories (one per `MissionType`, `key` = the type value) for CIRCOE and
backfills every existing mission: it points at the category of its type and keeps its own consigne
(`overridden_fields = ['prompt']`), so a later category edit never rewrites an existing mission.
`missions.type` is untouched: it stays the technical routing discriminator.

Downgrade drops the new tables and columns (the seeded categories and the links go with them);
`missions.type` and `missions.prompt` already hold everything the previous version reads.

Revision ID: 0047
Revises: 0046
"""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None

CIRCOE_ID = "01a00000-0000-7000-8000-00000000c1c0"
MISSION_TYPES = ("prospection", "signals", "enrichment", "verification", "other")

# key, name, description, icon, colour, general prompt, position
SEEDS = (
    (
        "prospection",
        "Prospection",
        "Trouver de nouvelles sociétés ou de nouveaux contacts correspondant à la consigne.",
        "compass",
        "#2563eb",
        "Tu cherches de nouvelles sociétés ou de nouveaux contacts qui correspondent à la "
        "consigne de la mission. Ne propose que des résultats que tu peux sourcer, indique "
        "l’origine de chacun et ignore ceux qui sont déjà connus de VIPER.",
        0,
    ),
    (
        "signals",
        "Signaux",
        "Surveiller des sociétés déjà en base et remonter les événements récents qui comptent.",
        "radar",
        "#d97706",
        "Tu surveilles les sociétés liées à la mission et tu remontes les événements récents "
        "pertinents (recrutement, levée de fonds, ouverture de site…). Chaque signal est daté, "
        "sourcé et formulé factuellement, sans interprétation.",
        1,
    ),
    (
        "enrichment",
        "Enrichissement",
        "Compléter les fiches existantes avec des informations vérifiables.",
        "pencil",
        "#16a34a",
        "Tu complètes les fiches liées à la mission avec des informations vérifiables. Ne "
        "renvoie que ce qui est nouveau ou différent, cite ta source et laisse un champ vide "
        "plutôt que de deviner.",
        2,
    ),
    (
        "verification",
        "Vérification",
        "Contrôler l’exactitude et l’actualité des informations d’une fiche.",
        "shield-check",
        "#7c3aed",
        "Tu contrôles que les informations des fiches liées à la mission sont exactes et à "
        "jour. Signale uniquement les écarts constatés, avec la preuve observée et sa date.",
        3,
    ),
    (
        "other",
        "Autre",
        "Une mission qui ne rentre dans aucune autre catégorie.",
        "sparkles",
        "#0d9488",
        "Tu exécutes la consigne de la mission telle qu’elle est écrite, sans élargir son "
        "périmètre. Si elle est ambiguë, explique ce que tu as compris avant de proposer un "
        "résultat.",
        4,
    ),
)


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


def _organization() -> sa.Column[Any]:
    return sa.Column(
        "organization_id",
        sa.Uuid(),
        server_default=sa.text(f"'{CIRCOE_ID}'::uuid"),
        nullable=False,
    )


def _organization_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["organization_id"],
        ["organizations.id"],
        name=op.f(f"fk_{table}_organization_id_organizations"),
        ondelete="RESTRICT",
    )


def upgrade() -> None:
    types = ", ".join(f"'{value}'" for value in MISSION_TYPES)
    op.create_table(
        "mission_categories",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        _organization(),
        sa.Column("key", sa.String(32), nullable=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("icon", sa.String(40), nullable=False),
        sa.Column("color", sa.String(7), nullable=False),
        sa.Column("general_prompt", sa.Text(), nullable=False),
        sa.Column("mission_type", sa.String(32), nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(name) <> '' AND char_length(name) <= 100",
            name=op.f("ck_mission_categories_name_valid"),
        ),
        sa.CheckConstraint(
            "btrim(general_prompt) <> '' AND char_length(general_prompt) <= 5000",
            name=op.f("ck_mission_categories_prompt_valid"),
        ),
        sa.CheckConstraint(
            "color ~ '^#[0-9a-fA-F]{6}$'", name=op.f("ck_mission_categories_color_format")
        ),
        sa.CheckConstraint(
            "icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'", name=op.f("ck_mission_categories_icon_format")
        ),
        sa.CheckConstraint(
            f"mission_type IN ({types})", name=op.f("ck_mission_categories_mission_type")
        ),
        _organization_fk("mission_categories"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_categories")),
    )
    op.create_index(
        op.f("ix_mission_categories_organization_id"), "mission_categories", ["organization_id"]
    )
    op.create_index(
        "uq_mission_categories_organization_name",
        "mission_categories",
        ["organization_id", sa.text("lower(name)")],
        unique=True,
    )
    op.create_index(
        "uq_mission_categories_organization_key",
        "mission_categories",
        ["organization_id", "key"],
        unique=True,
        postgresql_where=sa.text("key IS NOT NULL"),
    )
    _trigger("mission_categories")

    op.create_table(
        "mission_skills",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        _organization(),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(name) <> '' AND char_length(name) <= 100",
            name=op.f("ck_mission_skills_name_valid"),
        ),
        sa.CheckConstraint(
            "btrim(content) <> '' AND char_length(content) <= 5000",
            name=op.f("ck_mission_skills_content_valid"),
        ),
        _organization_fk("mission_skills"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_skills")),
    )
    op.create_index(
        op.f("ix_mission_skills_organization_id"), "mission_skills", ["organization_id"]
    )
    op.create_index(
        "uq_mission_skills_organization_name",
        "mission_skills",
        ["organization_id", sa.text("lower(name)")],
        unique=True,
    )
    _trigger("mission_skills")

    for table, owner, owner_table in (
        ("mission_category_skills", "category_id", "mission_categories"),
        ("mission_skill_links", "mission_id", "missions"),
    ):
        op.create_table(
            table,
            sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
            sa.Column(owner, sa.Uuid(), nullable=False),
            sa.Column("skill_id", sa.Uuid(), nullable=False),
            sa.Column("position", sa.SmallInteger(), server_default="0", nullable=False),
            *_timestamps(),
            sa.ForeignKeyConstraint(
                [owner],
                [f"{owner_table}.id"],
                name=op.f(f"fk_{table}_{owner}_{owner_table}"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["skill_id"],
                ["mission_skills.id"],
                name=op.f(f"fk_{table}_skill_id_mission_skills"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
        )
        op.create_index(op.f(f"ix_{table}_{owner}"), table, [owner])
        op.create_index(op.f(f"ix_{table}_skill_id"), table, ["skill_id"])
        op.create_index(f"uq_{table}_pair", table, [owner, "skill_id"], unique=True)
        _trigger(table)

    op.add_column("missions", sa.Column("category_id", sa.Uuid(), nullable=True))
    op.add_column(
        "missions",
        sa.Column(
            "overridden_fields",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.create_index(op.f("ix_missions_category_id"), "missions", ["category_id"])
    op.create_foreign_key(
        op.f("fk_missions_category_id_mission_categories"),
        "missions",
        "mission_categories",
        ["category_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    connection = op.get_bind()
    for key, name, description, icon, color, prompt, position in SEEDS:
        connection.execute(
            sa.text(
                "INSERT INTO mission_categories "
                "(key, name, description, icon, color, general_prompt, mission_type, position) "
                "VALUES (:key, :name, :description, :icon, :color, :prompt, :key, :position)"
            ),
            {
                "key": key,
                "name": name,
                "description": description,
                "icon": icon,
                "color": color,
                "prompt": prompt,
                "position": position,
            },
        )
    # Existing missions keep their own consigne: it is an explicit value, not the category's.
    connection.execute(
        sa.text(
            "UPDATE missions SET category_id = c.id, overridden_fields = '[\"prompt\"]'::jsonb "
            "FROM mission_categories c "
            "WHERE c.key = missions.type AND c.organization_id = missions.organization_id"
        )
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_missions_category_id_mission_categories"), "missions", type_="foreignkey"
    )
    op.drop_index(op.f("ix_missions_category_id"), table_name="missions")
    op.drop_column("missions", "overridden_fields")
    op.drop_column("missions", "category_id")
    op.drop_table("mission_skill_links")
    op.drop_table("mission_category_skills")
    op.drop_table("mission_skills")
    op.drop_table("mission_categories")
