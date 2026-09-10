import re

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import CheckConstraint, Engine, Enum, text

import app.models  # noqa: F401  (registers ORM models on Base.metadata)
from app.db.base import Base
from tests.support import alembic_config


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def check_constraints(engine: Engine) -> dict[str, str]:
    """`{constraint name: definition}` for every CHECK constraint in the public schema."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE contype = 'c' AND connamespace = 'public'::regnamespace"
            )
        )
        return {name: definition for name, definition in rows}


def test_migration_history_has_a_single_head(test_database_url: str) -> None:
    script = ScriptDirectory.from_config(alembic_config(test_database_url))

    assert len(script.get_heads()) == 1


def test_migrations_upgrade_downgrade_roundtrip(engine: Engine, test_database_url: str) -> None:
    config = alembic_config(test_database_url)
    head = ScriptDirectory.from_config(config).get_current_head()

    command.downgrade(config, "base")
    assert current_revision(engine) is None
    with engine.connect() as connection:
        leftovers = connection.execute(
            text(
                "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace "
                "AND relkind IN ('r', 'p', 'v', 'm', 'S') AND relname <> 'alembic_version'"
            )
        ).scalar_one()
        functions = connection.execute(
            text("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace")
        ).scalar_one()
    assert (leftovers, functions) == (0, 0)

    command.upgrade(config, "head")
    assert current_revision(engine) == head


def test_migrated_schema_matches_orm_models(engine: Engine) -> None:
    with engine.connect() as connection:
        diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)

    assert diff == []


# Autogenerate ignores CHECK constraints and triggers: the tests below cover that drift.


def test_check_constraints_match_orm_models(engine: Engine) -> None:
    orm_checks = {
        str(constraint.name)
        for table in Base.metadata.tables.values()
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    }

    assert set(check_constraints(engine)) == orm_checks


def test_enum_check_constraints_allow_exactly_the_python_values(engine: Engine) -> None:
    definitions = check_constraints(engine)
    enum_columns = [
        (table.name, column.name, column.type)
        for table in Base.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, Enum)
    ]
    assert enum_columns

    for table_name, column_name, enum_type in enum_columns:
        definition = definitions[f"ck_{table_name}_{column_name}"]
        allowed = re.findall(r"'([^']*)'::character varying", definition)
        assert sorted(allowed) == sorted(enum_type.enums), f"{table_name}.{column_name}"


def test_every_table_with_updated_at_has_the_trigger(engine: Engine) -> None:
    timestamped = {table.name for table in Base.metadata.tables.values() if "updated_at" in table.c}
    with engine.connect() as connection:
        triggered = set(
            connection.execute(
                text(
                    "SELECT event_object_table FROM information_schema.triggers "
                    "WHERE trigger_name = 'set_updated_at' AND event_manipulation = 'UPDATE'"
                )
            ).scalars()
        )

    assert triggered == timestamped


def test_every_foreign_key_is_covered_by_a_full_index(engine: Engine) -> None:
    with engine.connect() as connection:
        foreign_keys = connection.execute(
            text(
                "SELECT conrelid::regclass::text, conname, conkey::int[] FROM pg_constraint "
                "WHERE contype = 'f' AND connamespace = 'public'::regnamespace"
            )
        ).all()
        indexes = connection.execute(
            text(
                "SELECT indrelid::regclass::text, indkey::int[] FROM pg_index "
                "JOIN pg_class ON pg_class.oid = indrelid "
                "WHERE relnamespace = 'public'::regnamespace AND indpred IS NULL"
            )
        ).all()
    assert foreign_keys

    uncovered = [
        name
        for table, name, columns in foreign_keys
        if not any(
            indexed_table == table and keys[: len(columns)] == columns
            for indexed_table, keys in indexes
        )
    ]
    assert uncovered == []
