from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine

import app.models  # noqa: F401  (registers ORM models on Base.metadata)
from app.db.base import Base
from tests.support import alembic_config


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def test_migration_history_has_a_single_head(test_database_url: str) -> None:
    script = ScriptDirectory.from_config(alembic_config(test_database_url))

    assert len(script.get_heads()) == 1


def test_migrations_upgrade_downgrade_roundtrip(engine: Engine, test_database_url: str) -> None:
    config = alembic_config(test_database_url)
    head = ScriptDirectory.from_config(config).get_current_head()

    command.downgrade(config, "base")
    assert current_revision(engine) is None

    command.upgrade(config, "head")
    assert current_revision(engine) == head


def test_migrated_schema_matches_orm_models(engine: Engine) -> None:
    with engine.connect() as connection:
        diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)

    assert diff == []
