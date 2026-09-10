"""Alembic environment.

Target database, in order: `config.attributes["database_url"]` (set programmatically by tests),
the test database with `alembic -x db=test ...`, otherwise `VIPER_DATABASE_URL`.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

import app.models  # noqa: F401  (registers ORM models on Base.metadata)
from app.core.config import get_settings
from app.db.base import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def database_url() -> str:
    explicit = config.attributes.get("database_url")
    if explicit:
        return str(explicit)
    settings = get_settings()
    target = context.get_x_argument(as_dictionary=True).get("db", "dev")
    if target == "dev":
        return settings.database_url
    if target == "test":
        return settings.test_database_url
    raise ValueError(f"Unknown -x db={target!r}; expected 'dev' or 'test'.")


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
